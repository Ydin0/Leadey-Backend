import { Router, Request, Response, NextFunction } from "express";
import { and, eq, desc, gte } from "drizzle-orm";
import { getAuth } from "@clerk/express";
import { db } from "../db";
import { meetingTranscripts } from "../db/schema/meeting-transcripts";
import { leads } from "../db/schema/leads";
import { funnels } from "../db/schema/funnels";
import { scheduledMeetings } from "../db/schema/scheduled-meetings";
import { calendarEvents } from "../db/schema/calendar";
import { getOrgId } from "../lib/auth";
import { ApiError, createId } from "../lib/helpers";
import { getSetting, upsertSetting, deleteSetting } from "../lib/settings-service";
import { encryptSecret, decryptSecret } from "../lib/crypto";
import { FathomClient } from "../lib/fathom-client";
import { FirefliesClient } from "../lib/fireflies-client";
import { scoreCall } from "../lib/call-scoring";

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
    meetingId: t.meetingId,
    title: t.title,
    heldAt: t.heldAt ? t.heldAt.toISOString() : null,
    durationSec: t.durationSec,
    embedUrl: t.embedUrl,
    recordingUrl: t.recordingUrl,
    hasRecording: !!(t.embedUrl || t.recordingUrl),
    scored: !!t.score,
    summary: detail ? t.summary : undefined,
    transcript: detail ? t.transcript : undefined,
    score: detail ? t.score : undefined,
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
      .select({ id: leads.id, name: leads.name, email: leads.email, extraEmails: leads.extraEmails })
      .from(leads)
      .innerJoin(funnels, eq(leads.funnelId, funnels.id))
      .where(and(eq(leads.id, leadId), eq(funnels.organizationId, orgId)));
    if (!lead) throw new ApiError(404, "Lead not found");

    const candidates = new Set<string>();
    const add = (e?: string | null) => { const n = (e || "").trim().toLowerCase(); if (n) candidates.add(n); };
    add(lead.email);
    for (const x of lead.extraEmails || []) add(x.value);

    // Broaden matching beyond attendee-email overlap so a recording whose
    // invitee emails Fathom/Fireflies didn't capture (a common reason a recent
    // meeting silently fails to match) is still linked: also match the lead's
    // name as a WHOLE WORD in the recording title (meeting titles are commonly
    // "<First> and <Rep>"). Time-proximity is deliberately NOT a match trigger —
    // it caught unrelated back-to-back meetings (an internal standup 30m before
    // the real call) and attached them to the lead. Match must be on identity
    // (email or the lead's own name), never merely "happened around the same time".
    const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const nameTokens = (lead.name || "")
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length >= 4) // skip initials / ultra-common short tokens
      .map((t) => new RegExp(`\\b${escapeRe(t)}\\b`, "i"));
    const nameHit = (title: string): boolean => !!title && nameTokens.some((re) => re.test(title));

    // Known meeting times are used ONLY to link a matched recording to a calendar
    // row (meetingId), never to decide the match itself.
    const sinceWindow = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000);
    const knownMeetings: { id: string; t: number }[] = [];
    const sched = await db
      .select({ id: scheduledMeetings.id, t: scheduledMeetings.startTime })
      .from(scheduledMeetings)
      .where(and(eq(scheduledMeetings.organizationId, orgId), eq(scheduledMeetings.leadId, lead.id)));
    for (const s of sched) if (s.t) knownMeetings.push({ id: s.id, t: s.t.getTime() });
    if (candidates.size > 0) {
      const evs = await db
        .select({ id: calendarEvents.id, t: calendarEvents.startTime, emails: calendarEvents.attendeeEmails })
        .from(calendarEvents)
        .where(and(eq(calendarEvents.organizationId, orgId), gte(calendarEvents.startTime, sinceWindow)));
      for (const e of evs) if (e.t && (e.emails || []).some((x) => candidates.has(x))) knownMeetings.push({ id: e.id, t: e.t.getTime() });
    }
    const NEAR_MS = 90 * 60 * 1000;
    const nearestMeetingId = (h: Date | null): string | null => {
      if (!h) return null;
      let best: { id: string; d: number } | null = null;
      for (const k of knownMeetings) {
        const d = Math.abs(k.t - h.getTime());
        if (d < NEAR_MS && (!best || d < best.d)) best = { id: k.id, d };
      }
      return best?.id ?? null;
    };
    const matches = (parts: string[], title: string): boolean =>
      parts.some((p) => candidates.has(p)) || nameHit(title);

    if (candidates.size === 0) {
      res.json({ data: { linked: 0, checked: 0, connected: false, reason: "This lead has no email to match recordings against." } });
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
        const meetings = await new FathomClient(fathomKey).listRecent(100);
        checked += meetings.length;
        for (const m of meetings) {
          if (!m.externalId || !matches(m.participants, m.title)) continue;
          const meetingId = nearestMeetingId(m.heldAt);
          await db.insert(meetingTranscripts).values({
            id: createId("mtr"), organizationId: orgId, provider: "fathom", externalId: m.externalId,
            leadId: lead.id, meetingId, fetchedByUserId: userId, title: m.title, heldAt: m.heldAt, durationSec: m.durationSec,
            summary: m.summary, transcript: m.transcript, recordingUrl: m.recordingUrl, embedUrl: m.embedUrl,
            createdAt: now, updatedAt: now,
          }).onConflictDoUpdate({
            target: [meetingTranscripts.organizationId, meetingTranscripts.provider, meetingTranscripts.externalId],
            set: { leadId: lead.id, meetingId, title: m.title, heldAt: m.heldAt, durationSec: m.durationSec, summary: m.summary, transcript: m.transcript, recordingUrl: m.recordingUrl, embedUrl: m.embedUrl, updatedAt: now },
          });
          linked++;
        }
      } catch (err) { console.warn("[pull-transcripts] fathom failed:", err instanceof Error ? err.message : err); }
    }

    // Fireflies — list is light; fetch full sentences only for matches.
    if (firefliesKey) {
      try {
        const client = new FirefliesClient(firefliesKey);
        const recents = await client.listRecent(100);
        checked += recents.length;
        for (const r of recents) {
          if (!r.externalId || !matches(r.participants, r.title)) continue;
          const full = await client.getTranscript(r.externalId).catch(() => r);
          const t = full || r;
          const meetingId = nearestMeetingId(t.heldAt);
          await db.insert(meetingTranscripts).values({
            id: createId("mtr"), organizationId: orgId, provider: "fireflies", externalId: t.externalId,
            leadId: lead.id, meetingId, fetchedByUserId: userId, title: t.title, heldAt: t.heldAt, durationSec: t.durationSec,
            summary: t.summary, transcript: t.transcript, recordingUrl: t.recordingUrl, embedUrl: null,
            createdAt: now, updatedAt: now,
          }).onConflictDoUpdate({
            target: [meetingTranscripts.organizationId, meetingTranscripts.provider, meetingTranscripts.externalId],
            set: { leadId: lead.id, meetingId, title: t.title, heldAt: t.heldAt, durationSec: t.durationSec, summary: t.summary, transcript: t.transcript, recordingUrl: t.recordingUrl, updatedAt: now },
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

// ─── DELETE /meeting-transcripts/:id — remove a recording from the lead ─────
// Unlinks a wrongly-matched (or unwanted) recording. Hard-deletes the row; a
// re-pull for the correct lead will re-create it.
router.delete(
  "/meeting-transcripts/:id",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    await db
      .delete(meetingTranscripts)
      .where(and(eq(meetingTranscripts.id, String(req.params.id)), eq(meetingTranscripts.organizationId, orgId)));
    res.status(204).end();
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

// ─── POST /meeting-transcripts/:id/score — AI call scoring (cached) ──────────
// Scores the call against the closing framework. Cached on the row; pass
// { force: true } to re-score.
router.post(
  "/meeting-transcripts/:id/score",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const force = !!req.body?.force;
    const [row] = await db
      .select()
      .from(meetingTranscripts)
      .where(and(eq(meetingTranscripts.id, String(req.params.id)), eq(meetingTranscripts.organizationId, orgId)));
    if (!row) throw new ApiError(404, "Transcript not found");

    if (row.score && !force) {
      res.json({ data: row.score });
      return;
    }
    if (!row.transcript || row.transcript.length === 0) {
      throw new ApiError(422, "This meeting has no transcript to score yet.");
    }
    const score = await scoreCall(row.transcript, { title: row.title });
    if (!score) throw new ApiError(422, "Couldn't score this call — the transcript is too short or scoring is unavailable.");
    await db
      .update(meetingTranscripts)
      .set({ score, updatedAt: new Date() })
      .where(eq(meetingTranscripts.id, row.id));
    res.json({ data: score });
  }),
);

export default router;
