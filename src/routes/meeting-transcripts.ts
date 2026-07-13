import { Router, Request, Response, NextFunction } from "express";
import { and, eq, desc } from "drizzle-orm";
import { getAuth } from "@clerk/express";
import { db } from "../db";
import { meetingTranscripts } from "../db/schema/meeting-transcripts";
import { leads } from "../db/schema/leads";
import { funnels } from "../db/schema/funnels";
import { getOrgId } from "../lib/auth";
import { ApiError, createId } from "../lib/helpers";
import { getSetting, upsertSetting, deleteSetting } from "../lib/settings-service";
import { encryptSecret, decryptSecret } from "../lib/crypto";
import { FathomClient } from "../lib/fathom-client";
import { FirefliesClient } from "../lib/fireflies-client";

const router = Router();

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<void>;
function asyncHandler(h: AsyncHandler) {
  return (req: Request, res: Response, next: NextFunction) => Promise.resolve(h(req, res, next)).catch(next);
}

type Provider = "fathom" | "fireflies";
const isProvider = (p: string): p is Provider => p === "fathom" || p === "fireflies";
const keyName = (provider: Provider, userId: string) => `${provider}_transcript_key:${userId}`;

/** The per-rep API key for a provider (decrypted), or null. */
async function getProviderKey(orgId: string, userId: string, provider: Provider): Promise<string | null> {
  const enc = await getSetting(orgId, keyName(provider, userId));
  if (!enc) return null;
  try { return decryptSecret(enc); } catch { return enc; }
}

/** Verify a key by hitting the provider; returns a display account label. */
async function verifyKey(provider: Provider, key: string): Promise<string | null> {
  if (provider === "fireflies") {
    const info = await new FirefliesClient(key).verify();
    return info.email || info.name || "Connected";
  }
  await new FathomClient(key).verify();
  return "Connected";
}

// ─── GET /integrations/transcripts/status — per-rep connection state ────────
router.get(
  "/integrations/transcripts/status",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const userId = getAuth(req)?.userId || "";
    const [fathom, fireflies] = await Promise.all([
      getProviderKey(orgId, userId, "fathom"),
      getProviderKey(orgId, userId, "fireflies"),
    ]);
    res.json({ data: { fathom: { connected: !!fathom }, fireflies: { connected: !!fireflies } } });
  }),
);

// ─── PUT /integrations/transcripts/:provider — connect (paste key) ──────────
router.put(
  "/integrations/transcripts/:provider",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const userId = getAuth(req)?.userId || "";
    const provider = String(req.params.provider);
    if (!isProvider(provider)) throw new ApiError(400, "Unknown provider");
    const apiKey = String(req.body?.apiKey || "").trim();
    if (!apiKey) throw new ApiError(400, "API key is required");

    let account: string | null;
    try {
      account = await verifyKey(provider, apiKey);
    } catch (err) {
      throw new ApiError(400, `Could not connect to ${provider}: ${err instanceof Error ? err.message : "invalid key"}`);
    }
    await upsertSetting(orgId, keyName(provider, userId), encryptSecret(apiKey));
    res.json({ data: { connected: true, account } });
  }),
);

// ─── DELETE /integrations/transcripts/:provider — disconnect ────────────────
router.delete(
  "/integrations/transcripts/:provider",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const userId = getAuth(req)?.userId || "";
    const provider = String(req.params.provider);
    if (!isProvider(provider)) throw new ApiError(400, "Unknown provider");
    await deleteSetting(orgId, keyName(provider, userId));
    res.json({ data: { connected: false } });
  }),
);

// ─── Serialize a stored transcript for the client ───────────────────────────
function serialize(t: typeof meetingTranscripts.$inferSelect, detail = false) {
  return {
    id: t.id,
    provider: t.provider,
    title: t.title,
    heldAt: t.heldAt ? t.heldAt.toISOString() : null,
    durationSec: t.durationSec,
    embedUrl: t.embedUrl,
    recordingUrl: t.recordingUrl,
    hasRecording: !!(t.embedUrl || t.recordingUrl),
    summary: detail ? t.summary : undefined,
    transcript: detail ? t.transcript : undefined,
    sentenceCount: t.transcript?.length ?? 0,
  };
}

// ─── POST /funnels/:funnelId/leads/:leadId/pull-transcripts ─────────────────
// Match the caller's Fathom/Fireflies recordings to this lead (by attendee
// email overlap) and attach them.
router.post(
  "/funnels/:funnelId/leads/:leadId/pull-transcripts",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const userId = getAuth(req)?.userId || "";
    const leadId = String(req.params.leadId);

    const [lead] = await db
      .select({ id: leads.id, email: leads.email, extraEmails: leads.extraEmails })
      .from(leads)
      .innerJoin(funnels, eq(leads.funnelId, funnels.id))
      .where(and(eq(leads.id, leadId), eq(funnels.organizationId, orgId)));
    if (!lead) throw new ApiError(404, "Lead not found");

    const candidates = new Set<string>();
    const add = (e?: string | null) => { const n = (e || "").trim().toLowerCase(); if (n) candidates.add(n); };
    add(lead.email);
    for (const x of lead.extraEmails || []) add(x.value);
    if (candidates.size === 0) {
      res.json({ data: { linked: 0, checked: 0, connected: false, reason: "This lead has no email to match against." } });
      return;
    }

    const [fathomKey, firefliesKey] = await Promise.all([
      getProviderKey(orgId, userId, "fathom"),
      getProviderKey(orgId, userId, "fireflies"),
    ]);
    if (!fathomKey && !firefliesKey) {
      res.json({ data: { linked: 0, checked: 0, connected: false, reason: "Connect Fathom or Fireflies in Settings → Integrations first." } });
      return;
    }

    let checked = 0;
    let linked = 0;
    const now = new Date();

    // Fathom — recordings include transcript + summary inline.
    if (fathomKey) {
      try {
        const meetings = await new FathomClient(fathomKey).listRecent(50);
        checked += meetings.length;
        for (const m of meetings) {
          if (!m.externalId || !m.participants.some((p) => candidates.has(p))) continue;
          await db.insert(meetingTranscripts).values({
            id: createId("mtr"), organizationId: orgId, provider: "fathom", externalId: m.externalId,
            leadId: lead.id, fetchedByUserId: userId, title: m.title, heldAt: m.heldAt, durationSec: m.durationSec,
            summary: m.summary, transcript: m.transcript, recordingUrl: m.recordingUrl, embedUrl: m.embedUrl,
            createdAt: now, updatedAt: now,
          }).onConflictDoUpdate({
            target: [meetingTranscripts.organizationId, meetingTranscripts.provider, meetingTranscripts.externalId],
            set: { leadId: lead.id, title: m.title, heldAt: m.heldAt, durationSec: m.durationSec, summary: m.summary, transcript: m.transcript, recordingUrl: m.recordingUrl, embedUrl: m.embedUrl, updatedAt: now },
          });
          linked++;
        }
      } catch (err) { console.warn("[pull-transcripts] fathom failed:", err instanceof Error ? err.message : err); }
    }

    // Fireflies — list is light; fetch full sentences only for matches.
    if (firefliesKey) {
      try {
        const client = new FirefliesClient(firefliesKey);
        const recents = await client.listRecent(50);
        checked += recents.length;
        for (const r of recents) {
          if (!r.externalId || !r.participants.some((p) => candidates.has(p))) continue;
          const full = await client.getTranscript(r.externalId).catch(() => r);
          const t = full || r;
          await db.insert(meetingTranscripts).values({
            id: createId("mtr"), organizationId: orgId, provider: "fireflies", externalId: t.externalId,
            leadId: lead.id, fetchedByUserId: userId, title: t.title, heldAt: t.heldAt, durationSec: t.durationSec,
            summary: t.summary, transcript: t.transcript, recordingUrl: t.recordingUrl, embedUrl: null,
            createdAt: now, updatedAt: now,
          }).onConflictDoUpdate({
            target: [meetingTranscripts.organizationId, meetingTranscripts.provider, meetingTranscripts.externalId],
            set: { leadId: lead.id, title: t.title, heldAt: t.heldAt, durationSec: t.durationSec, summary: t.summary, transcript: t.transcript, recordingUrl: t.recordingUrl, updatedAt: now },
          });
          linked++;
        }
      } catch (err) { console.warn("[pull-transcripts] fireflies failed:", err instanceof Error ? err.message : err); }
    }

    res.json({ data: { linked, checked, connected: true } });
  }),
);

// ─── GET /meeting-transcripts/lead/:leadId — list for a lead ────────────────
router.get(
  "/meeting-transcripts/lead/:leadId",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const leadId = String(req.params.leadId);
    const rows = await db
      .select()
      .from(meetingTranscripts)
      .where(and(eq(meetingTranscripts.organizationId, orgId), eq(meetingTranscripts.leadId, leadId)))
      .orderBy(desc(meetingTranscripts.heldAt), desc(meetingTranscripts.createdAt));
    res.json({ data: rows.map((r) => serialize(r)) });
  }),
);

// ─── GET /meeting-transcripts/:id — full detail ─────────────────────────────
router.get(
  "/meeting-transcripts/:id",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const [row] = await db
      .select()
      .from(meetingTranscripts)
      .where(and(eq(meetingTranscripts.id, String(req.params.id)), eq(meetingTranscripts.organizationId, orgId)));
    if (!row) throw new ApiError(404, "Transcript not found");
    res.json({ data: serialize(row, true) });
  }),
);

export default router;
