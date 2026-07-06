import { Router, Request, Response, NextFunction } from "express";
import { eq, and, or, desc, asc, inArray, isNull, sql, gte, count } from "drizzle-orm";
import multer from "multer";
import twilioSdk from "twilio";
import { getAuth } from "@clerk/express";
import { db } from "../db";
import {
  callDispositions,
  voicemailDrops,
  funnelDispositionRules,
  dialerSessions,
  dialerQueueItems,
} from "../db/schema/dialer";
import { funnelSteps, funnels, funnelMembers } from "../db/schema/funnels";
import { leads, leadEvents } from "../db/schema/leads";
import { masterContacts } from "../db/schema/master";
import { callRecords } from "../db/schema/call-records";
import { getOrgId } from "../lib/auth";
import { ApiError, createId } from "../lib/helpers";
import { getPerms, getVisibleFunnelIds } from "../lib/permission-service";
import { hasPerm } from "../lib/permission-catalog";
import { buildLeadFilterWhere } from "../lib/lead-filter";
import { seedSystemDispositions } from "../lib/dialer-seed";
import { flagDoNotCall } from "../lib/dnc";
import {
  saveVoicemailFile,
  deleteVoicemailFile,
  voicemailPlaybackUrl,
} from "../lib/voicemail-storage";
import { getMergedLeadStatuses } from "../lib/lead-status-config";

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB voicemail cap
});

const twilio = twilioSdk(
  process.env.TWILIO_ACCOUNT_SID!,
  process.env.TWILIO_AUTH_TOKEN!,
);

// ── Helpers ──────────────────────────────────────────────────────────

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** How long a lead a rep is "on" (in_progress / awaiting_disposition) stays
 *  reserved against every other rep. Comfortably covers the auto-dial
 *  countdown + a normal call + disposition, but releases a lead whose rep
 *  crashed or closed the tab so it can never be locked away forever. */
const CLAIM_TTL_MS = 3 * 60 * 1000;
const MAX_RECENCY_HOURS = 30 * 24; // clamp the "recently called" window

/** Resolve the "recently called" window (ms) from a session's stored filters,
 *  honouring the new hour-granular field and falling back to the legacy
 *  day-granular one for sessions created before the change. */
function recencyMsFromFilters(f: { recentlyCalledHours?: number; recentlyCalledDays?: number } | null): number {
  const hours =
    f?.recentlyCalledHours && f.recentlyCalledHours > 0
      ? Math.min(Math.floor(f.recentlyCalledHours), MAX_RECENCY_HOURS)
      : f?.recentlyCalledDays && f.recentlyCalledDays > 0
        ? Math.min(Math.floor(f.recentlyCalledDays) * 24, MAX_RECENCY_HOURS)
        : 24;
  return hours * HOUR_MS;
}

/** Canonical phone key for recency matching: digits only, reduced to the last
 *  10 significant digits so UK national (020…) and E.164 (+4420…), and US
 *  national vs +1, compare equal. Short/extension numbers keep their full
 *  digit string. */
function phoneKey(p: string | null | undefined): string {
  const d = (p || "").replace(/[^\d]/g, "");
  return d.length >= 10 ? d.slice(-10) : d;
}

type AsyncHandler<P = Record<string, string>> = (
  req: Request<P>,
  res: Response,
  next: NextFunction,
) => Promise<void>;

function asyncHandler<P = Record<string, string>>(handler: AsyncHandler<P>) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req as Request<P>, res, next)).catch(next);
  };
}

function getUserId(req: Request): string {
  const auth = getAuth(req);
  if (!auth?.userId) throw new ApiError(401, "Unauthorized");
  return auth.userId;
}

const ALLOWED_ACTIONS = new Set(["advance", "retry", "drop", "none"]);
const ALLOWED_BUCKETS = new Set(["contacted", "not_contacted", "negative"]);

function serializeDisposition(d: typeof callDispositions.$inferSelect) {
  return {
    id: d.id,
    slug: d.slug,
    label: d.label,
    outcomeBucket: d.outcomeBucket,
    funnelAction: d.funnelAction,
    retryAfterDays: d.retryAfterDays,
    sortOrder: d.sortOrder,
    hotkey: d.hotkey,
    color: d.color,
    isSystem: d.isSystem,
  };
}

function serializeVoicemail(v: typeof voicemailDrops.$inferSelect) {
  return {
    id: v.id,
    userId: v.userId,
    name: v.name,
    recordingUrl: v.recordingUrl,
    durationSeconds: v.durationSeconds,
    isDefault: v.isDefault,
    createdAt: v.createdAt.toISOString(),
  };
}

// ── Dispositions CRUD ───────────────────────────────────────────────

router.get(
  "/call-dispositions",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    // Lazy-seed: if this org has no dispositions yet (e.g. created before
    // we wired the org.created hook), seed them on first read.
    const existing = await db
      .select()
      .from(callDispositions)
      .where(eq(callDispositions.organizationId, orgId))
      .orderBy(asc(callDispositions.sortOrder));
    if (existing.length === 0) {
      await seedSystemDispositions(orgId);
      const seeded = await db
        .select()
        .from(callDispositions)
        .where(eq(callDispositions.organizationId, orgId))
        .orderBy(asc(callDispositions.sortOrder));
      res.json({ data: seeded.map(serializeDisposition) });
      return;
    }
    res.json({ data: existing.map(serializeDisposition) });
  }),
);

router.post(
  "/call-dispositions",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const { slug, label, outcomeBucket, funnelAction, retryAfterDays, hotkey, color, sortOrder } = req.body;

    if (!slug || !label || !outcomeBucket) {
      throw new ApiError(400, "slug, label, outcomeBucket required");
    }
    if (!ALLOWED_BUCKETS.has(outcomeBucket)) {
      throw new ApiError(400, "Invalid outcomeBucket");
    }
    const action = funnelAction || "none";
    if (!ALLOWED_ACTIONS.has(action)) {
      throw new ApiError(400, "Invalid funnelAction");
    }

    const id = createId("disp");
    const [row] = await db
      .insert(callDispositions)
      .values({
        id,
        organizationId: orgId,
        slug: String(slug).toLowerCase(),
        label,
        outcomeBucket,
        funnelAction: action,
        retryAfterDays: retryAfterDays ?? null,
        hotkey: hotkey || null,
        color: color || null,
        sortOrder: sortOrder ?? 999,
        isSystem: false,
      })
      .returning();
    res.status(201).json({ data: serializeDisposition(row) });
  }),
);

router.patch(
  "/call-dispositions/:id",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const [existing] = await db
      .select()
      .from(callDispositions)
      .where(and(eq(callDispositions.id, req.params.id), eq(callDispositions.organizationId, orgId)));
    if (!existing) throw new ApiError(404, "Disposition not found");

    const allowed = ["label", "outcomeBucket", "funnelAction", "retryAfterDays", "hotkey", "color", "sortOrder"];
    const updates: Record<string, unknown> = {};
    for (const k of allowed) {
      if (k in req.body) updates[k] = req.body[k];
    }
    if (updates.outcomeBucket && !ALLOWED_BUCKETS.has(updates.outcomeBucket as string)) {
      throw new ApiError(400, "Invalid outcomeBucket");
    }
    if (updates.funnelAction && !ALLOWED_ACTIONS.has(updates.funnelAction as string)) {
      throw new ApiError(400, "Invalid funnelAction");
    }

    const [updated] = await db
      .update(callDispositions)
      .set(updates)
      .where(eq(callDispositions.id, req.params.id))
      .returning();
    res.json({ data: serializeDisposition(updated) });
  }),
);

router.delete(
  "/call-dispositions/:id",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const [existing] = await db
      .select()
      .from(callDispositions)
      .where(and(eq(callDispositions.id, req.params.id), eq(callDispositions.organizationId, orgId)));
    if (!existing) throw new ApiError(404, "Disposition not found");
    if (existing.isSystem) throw new ApiError(400, "System dispositions cannot be deleted");

    await db.delete(callDispositions).where(eq(callDispositions.id, req.params.id));
    res.status(204).end();
  }),
);

// ── Voicemail drops ──────────────────────────────────────────────────

router.get(
  "/dialer/voicemail-drops",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const userId = getUserId(req);
    // Return user's own VMs + org-wide VMs
    const rows = await db
      .select()
      .from(voicemailDrops)
      .where(
        and(
          eq(voicemailDrops.organizationId, orgId),
          sql`(${voicemailDrops.userId} = ${userId} OR ${voicemailDrops.userId} IS NULL)`,
        ),
      )
      .orderBy(desc(voicemailDrops.isDefault), desc(voicemailDrops.createdAt));
    res.json({ data: rows.map(serializeVoicemail) });
  }),
);

router.post(
  "/dialer/voicemail-drops",
  upload.single("audio"),
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const userId = getUserId(req);
    const { name, durationSeconds, isDefault, scope } = req.body as {
      name?: string;
      durationSeconds?: string;
      isDefault?: string;
      scope?: "user" | "org";
    };

    if (!name) throw new ApiError(400, "name is required");
    if (!req.file) throw new ApiError(400, "audio file is required");

    const id = createId("vm");
    const { recordingUrl } = await saveVoicemailFile(id, req.file.buffer, req.file.mimetype);

    // If this VM is being marked default, clear other defaults for the same scope.
    if (isDefault === "true") {
      const scopeUserId = scope === "org" ? null : userId;
      await db
        .update(voicemailDrops)
        .set({ isDefault: false })
        .where(
          and(
            eq(voicemailDrops.organizationId, orgId),
            scopeUserId === null
              ? isNull(voicemailDrops.userId)
              : eq(voicemailDrops.userId, scopeUserId),
          ),
        );
    }

    const [row] = await db
      .insert(voicemailDrops)
      .values({
        id,
        organizationId: orgId,
        userId: scope === "org" ? null : userId,
        name,
        recordingUrl,
        durationSeconds: durationSeconds ? Number(durationSeconds) : 0,
        isDefault: isDefault === "true",
      })
      .returning();
    res.status(201).json({ data: serializeVoicemail(row) });
  }),
);

router.delete(
  "/dialer/voicemail-drops/:id",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const userId = getUserId(req);
    const [row] = await db
      .select()
      .from(voicemailDrops)
      .where(
        and(
          eq(voicemailDrops.id, req.params.id),
          eq(voicemailDrops.organizationId, orgId),
          sql`(${voicemailDrops.userId} = ${userId} OR ${voicemailDrops.userId} IS NULL)`,
        ),
      );
    if (!row) throw new ApiError(404, "Voicemail not found");

    await db.delete(voicemailDrops).where(eq(voicemailDrops.id, row.id));
    // best-effort file cleanup
    const filename = row.recordingUrl.split("/").pop();
    if (filename) await deleteVoicemailFile(filename);
    res.status(204).end();
  }),
);

// POST /api/dialer/voicemail-drops/:id/drop — inject VM into a live call
router.post(
  "/dialer/voicemail-drops/:id/drop",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const userId = getUserId(req);
    const { callSid } = req.body as { callSid?: string };
    if (!callSid) throw new ApiError(400, "callSid required");

    const [vm] = await db
      .select()
      .from(voicemailDrops)
      .where(
        and(
          eq(voicemailDrops.id, req.params.id),
          eq(voicemailDrops.organizationId, orgId),
          sql`(${voicemailDrops.userId} = ${userId} OR ${voicemailDrops.userId} IS NULL)`,
        ),
      );
    if (!vm) throw new ApiError(404, "Voicemail not found");

    // Presigned R2 URL when configured — Twilio pulls the audio straight
    // from Cloudflare's edge instead of streaming it through this backend.
    const playUrl = await voicemailPlaybackUrl(vm.recordingUrl);
    const twiml = `<Response><Play>${escapeXml(playUrl)}</Play><Hangup/></Response>`;
    try {
      await twilio.calls(callSid).update({ twiml });
    } catch (err: any) {
      throw new ApiError(400, `Twilio rejected VM drop: ${err?.message || err}`);
    }

    // Dropping a voicemail means the call reached an answering machine — mark
    // the call record so connect-rate excludes it and the voicemail metric
    // counts it. The browser logs the record at hangup, which happens just
    // after this drop, so retry briefly to match (background; don't block).
    void (async () => {
      try {
        for (let attempt = 0; attempt < 20; attempt++) {
          const updated = await db
            .update(callRecords)
            .set({ disposition: "voicemail" })
            .where(and(eq(callRecords.twilioCallSid, callSid), eq(callRecords.organizationId, orgId)))
            .returning({ id: callRecords.id });
          if (updated.length > 0) return;
          await new Promise((r) => setTimeout(r, 1500));
        }
      } catch (err) {
        console.error("[VM drop] failed to mark call record as voicemail:", err);
      }
    })();

    res.json({ data: { ok: true, voicemailId: vm.id } });
  }),
);

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ── Funnel disposition rules ────────────────────────────────────────

router.get(
  "/funnel-steps/:stepId/disposition-rules",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    // Ensure the step belongs to this org
    const [step] = await db
      .select({ id: funnelSteps.id, funnelId: funnelSteps.funnelId })
      .from(funnelSteps)
      .innerJoin(funnels, eq(funnels.id, funnelSteps.funnelId))
      .where(and(eq(funnelSteps.id, req.params.stepId), eq(funnels.organizationId, orgId)));
    if (!step) throw new ApiError(404, "Funnel step not found");

    const rows = await db
      .select()
      .from(funnelDispositionRules)
      .where(eq(funnelDispositionRules.funnelStepId, step.id));
    res.json({
      data: rows.map((r) => ({
        id: r.id,
        funnelStepId: r.funnelStepId,
        dispositionId: r.dispositionId,
        funnelAction: r.funnelAction,
        retryAfterDays: r.retryAfterDays,
      })),
    });
  }),
);

router.patch(
  "/funnel-steps/:stepId/disposition-rules",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const { rules } = req.body as {
      rules: Array<{ dispositionId: string; funnelAction: string; retryAfterDays: number | null }>;
    };
    if (!Array.isArray(rules)) throw new ApiError(400, "rules array required");

    const [step] = await db
      .select({ id: funnelSteps.id })
      .from(funnelSteps)
      .innerJoin(funnels, eq(funnels.id, funnelSteps.funnelId))
      .where(and(eq(funnelSteps.id, req.params.stepId), eq(funnels.organizationId, orgId)));
    if (!step) throw new ApiError(404, "Funnel step not found");

    // Upsert each rule. Easier to just delete + reinsert for v1.
    await db
      .delete(funnelDispositionRules)
      .where(eq(funnelDispositionRules.funnelStepId, step.id));
    if (rules.length > 0) {
      for (const r of rules) {
        if (!ALLOWED_ACTIONS.has(r.funnelAction)) {
          throw new ApiError(400, `Invalid funnelAction: ${r.funnelAction}`);
        }
      }
      await db.insert(funnelDispositionRules).values(
        rules.map((r) => ({
          id: createId("fdr"),
          funnelStepId: step.id,
          dispositionId: r.dispositionId,
          funnelAction: r.funnelAction,
          retryAfterDays: r.retryAfterDays ?? null,
        })),
      );
    }

    const updated = await db
      .select()
      .from(funnelDispositionRules)
      .where(eq(funnelDispositionRules.funnelStepId, step.id));
    res.json({ data: updated });
  }),
);

// ─────────────────────────────────────────────────────────────────────
// Dialer Sessions (Phase 3)
// ─────────────────────────────────────────────────────────────────────

function serializeSession(s: typeof dialerSessions.$inferSelect) {
  return {
    id: s.id,
    userId: s.userId,
    funnelStepId: s.funnelStepId,
    funnelId: s.funnelId,
    status: s.status,
    totalLeads: s.totalLeads,
    completedLeads: s.completedLeads,
    currentLeadIndex: s.currentLeadIndex,
    dispositions: s.dispositionsJson,
    filters: s.filtersJson,
    startedAt: s.startedAt.toISOString(),
    endedAt: s.endedAt?.toISOString() || null,
  };
}

function serializeQueueItem(
  q: typeof dialerQueueItems.$inferSelect,
  lead?: typeof leads.$inferSelect,
  master?: typeof masterContacts.$inferSelect | null,
) {
  return {
    id: q.id,
    sessionId: q.sessionId,
    leadId: q.leadId,
    masterContactId: q.masterContactId,
    leadPhone: q.leadPhone,
    position: q.position,
    status: q.status,
    dispositionId: q.dispositionId,
    callRecordId: q.callRecordId,
    notes: q.notes,
    calledAt: q.calledAt?.toISOString() || null,
    lead: lead
      ? {
          id: lead.id,
          name: lead.name,
          title: lead.title,
          company: lead.company,
          email: lead.email,
          phone: lead.phone,
          linkedinUrl: lead.linkedinUrl,
          status: lead.status,
          currentStep: lead.currentStep,
          totalSteps: lead.totalSteps,
          doNotCall: lead.doNotCall,
        }
      : undefined,
    masterContact: master
      ? {
          id: master.id,
          headline: master.headline,
          location: master.location,
          timezone: master.timezone,
          doNotCall: master.doNotCall,
          lastCalledAt: master.lastCalledAt?.toISOString() || null,
          callAttempts: master.callAttempts,
        }
      : undefined,
  };
}

/** Compute whether a contact is currently within their business-hours
 *  window. If no timezone is set on the master contact, returns true. */
function inBusinessHours(
  tz: string | null | undefined,
  startHHMM: string | null | undefined,
  endHHMM: string | null | undefined,
): boolean {
  if (!tz) return true;
  const start = startHHMM || "09:00";
  const end = endHHMM || "17:00";
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
    });
    const parts = fmt.formatToParts(new Date());
    const hh = parts.find((p) => p.type === "hour")?.value || "00";
    const mm = parts.find((p) => p.type === "minute")?.value || "00";
    const nowMin = parseInt(hh) * 60 + parseInt(mm);
    const startMin = hhmmToMin(start);
    const endMin = hhmmToMin(end);
    return nowMin >= startMin && nowMin <= endMin;
  } catch {
    return true; // bad tz string — don't block
  }
}
function hhmmToMin(s: string): number {
  const [h, m] = s.split(":").map((n) => parseInt(n) || 0);
  return h * 60 + m;
}

// POST /api/dialer/sessions — create session + snapshot queue
router.post(
  "/dialer/sessions",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const userId = getUserId(req);
    const { funnelStepId, funnelId, filters } = req.body as {
      funnelStepId?: string;
      funnelId?: string;
      filters?: {
        excludeDoNotCall?: boolean;
        excludeRecentlyCalled?: boolean;
        /** Don't re-queue anyone called within the last N HOURS (default 24). */
        recentlyCalledHours?: number;
        /** Legacy day-granular field — still accepted from older clients. */
        recentlyCalledDays?: number;
        /** Skip leads in a terminal status (Not Interested, DNC, Qualified…). */
        excludeClosed?: boolean;
        respectTimezone?: boolean;
      };
    };
    if (!funnelStepId && !funnelId) {
      throw new ApiError(400, "funnelStepId or funnelId required");
    }

    // Must be allowed to use the dialer at all.
    const perms = await getPerms(req);
    if (!hasPerm(perms.permissions, "calling.useDialer")) {
      throw new ApiError(403, "You don't have permission to use the dialer");
    }
    // And must be able to see the campaign being dialed (closes the loophole
    // where creating a session granted funnel access — see api.ts GET funnel).
    const visible = await getVisibleFunnelIds(orgId, userId, perms.permissions);
    const canDialFunnel = (fid: string) => visible.mode === "all" || (visible.mode === "ids" && visible.ids.includes(fid));

    const recentlyCalledHours = Math.round(recencyMsFromFilters(filters ?? null) / HOUR_MS);
    const resolvedFilters = {
      excludeDoNotCall: filters?.excludeDoNotCall ?? true,
      excludeRecentlyCalled: filters?.excludeRecentlyCalled ?? true,
      recentlyCalledHours,
      excludeClosed: filters?.excludeClosed ?? true,
      respectTimezone: filters?.respectTimezone ?? false,
    };

    // The dialer is CAMPAIGN-scoped only — it is intentionally NOT linked to
    // sequence steps. Starting it queues every lead in the campaign that has a
    // phone number, regardless of which step they're on. (A legacy client may
    // still send funnelStepId; we resolve its campaign and otherwise ignore it,
    // storing no step link so nothing ties calls to the sequence.)
    const sessionStepId: string | null = null;
    let targetFunnelId = funnelId || "";
    if (!targetFunnelId && funnelStepId) {
      const [step] = await db
        .select({ funnelId: funnelSteps.funnelId })
        .from(funnelSteps)
        .innerJoin(funnels, eq(funnels.id, funnelSteps.funnelId))
        .where(and(eq(funnelSteps.id, funnelStepId), eq(funnels.organizationId, orgId)));
      if (!step) throw new ApiError(404, "Campaign not found");
      targetFunnelId = step.funnelId;
    }

    const [funnel] = await db
      .select({ id: funnels.id, config: funnels.config })
      .from(funnels)
      .where(and(eq(funnels.id, targetFunnelId), eq(funnels.organizationId, orgId)));
    if (!funnel) throw new ApiError(404, "Campaign not found");
    if (!canDialFunnel(funnel.id)) throw new ApiError(403, "You don't have access to this campaign");
    const sessionFunnelId = funnel.id;

    // Respect the campaign's active Smart View / filter: the leads table
    // persists its selected FilterGroup to config.leadFilters, so the dialer
    // queues exactly the same set the rep is looking at (or every phone-having
    // lead when no filter is active). Derived fields (callCount, custom:*, …)
    // are handled by the shared server-side evaluator.
    const filterWhere = buildLeadFilterWhere(
      (funnel.config as Record<string, unknown> | null)?.leadFilters,
      { orgId },
    );
    const candidateLeads = await db
      .select()
      .from(leads)
      .where(and(eq(leads.funnelId, funnel.id), sql`${leads.phone} <> ''`, ...(filterWhere ? [filterWhere] : [])))
      .orderBy(asc(leads.createdAt));

    // Canonical person link first (leads.master_contact_id, one indexed
    // fetch); the linkedin/email maps below remain as the fallback for rows
    // the identity backfill couldn't resolve.
    const linkedMasterIds = [...new Set(candidateLeads.map((l) => l.masterContactId).filter(Boolean) as string[])];
    const linkedMasters = linkedMasterIds.length
      ? await db.select().from(masterContacts).where(inArray(masterContacts.id, linkedMasterIds))
      : [];
    const masterById = new Map(linkedMasters.map((m) => [m.id, m]));

    // Resolve master contacts by linkedinUrl (preferred) then email.
    const unlinked = candidateLeads.filter((l) => !l.masterContactId);
    const linkedinUrls = unlinked.map((l) => l.linkedinUrl).filter(Boolean) as string[];
    const emails = unlinked.map((l) => l.email).filter(Boolean) as string[];

    // Build the OR match conditions, skipping any empty side — passing an empty
    // array to `= ANY()` makes Postgres throw "op ANY/ALL (array) requires array
    // on right side", which is what blocked the dialer from starting.
    const matchConds = [];
    if (linkedinUrls.length) {
      matchConds.push(inArray(masterContacts.linkedinUrl, linkedinUrls));
    }
    if (emails.length) {
      matchConds.push(
        inArray(
          sql`LOWER(${masterContacts.email})`,
          emails.map((e) => e.toLowerCase()),
        ),
      );
    }
    const masterRows = matchConds.length
      ? await db
          .select()
          .from(masterContacts)
          .where(and(eq(masterContacts.organizationId, orgId), or(...matchConds)))
      : [];
    const masterByUrl = new Map<string, typeof masterContacts.$inferSelect>();
    const masterByEmail = new Map<string, typeof masterContacts.$inferSelect>();
    for (const m of masterRows) {
      if (m.linkedinUrl) masterByUrl.set(m.linkedinUrl, m);
      if (m.email) masterByEmail.set(m.email.toLowerCase(), m);
    }

    const now = Date.now();
    const recentMs = recentlyCalledHours * HOUR_MS; // "recently called" floor

    // Terminal lead statuses (Not Interested, DNC, Qualified, Bounced, …) — used
    // to skip closed leads so the dialer only works new & follow-up contacts.
    const terminalStatusKeys = new Set(
      (await getMergedLeadStatuses(orgId)).filter((s) => s.isTerminal).map((s) => s.key),
    );

    // Disposition rules (retryAfterDays + outcomeBucket) keyed by id, so a lead's
    // LAST outcome decides whether its retry window has elapsed.
    const dispoRows = await db
      .select({
        id: callDispositions.id,
        retryAfterDays: callDispositions.retryAfterDays,
        outcomeBucket: callDispositions.outcomeBucket,
      })
      .from(callDispositions)
      .where(eq(callDispositions.organizationId, orgId));
    const dispoById = new Map(dispoRows.map((d) => [d.id, d]));

    // Last DIALER disposition per lead (dispositions live on queue items, not
    // call_records) — drives the per-disposition retry window. Look back far
    // enough to cover any retry window; retry windows are 1–3 days, 30 is ample.
    const lastDispoByLead = new Map<string, { calledAt: number; dispositionId: string | null }>();
    {
      const since = new Date(now - Math.max(recentMs, 30 * DAY_MS));
      const calledRows = await db
        .select({
          leadId: dialerQueueItems.leadId,
          calledAt: dialerQueueItems.calledAt,
          dispositionId: dialerQueueItems.dispositionId,
        })
        .from(dialerQueueItems)
        .innerJoin(dialerSessions, eq(dialerQueueItems.sessionId, dialerSessions.id))
        .where(
          and(
            eq(dialerSessions.organizationId, orgId),
            eq(dialerQueueItems.status, "completed"),
            gte(dialerQueueItems.calledAt, since),
          ),
        )
        .orderBy(desc(dialerQueueItems.calledAt));
      for (const r of calledRows) {
        if (!r.calledAt) continue;
        if (!lastDispoByLead.has(r.leadId)) {
          lastDispoByLead.set(r.leadId, { calledAt: r.calledAt.getTime(), dispositionId: r.dispositionId });
        }
      }
    }

    // call_records is the SUPERSET of every call (dialer auto-dials AND manual
    // dial-pad / lead-row calls), so it is the authoritative "recently called"
    // signal. Bucket recent org calls by leadId AND by normalized phone so a
    // contact is recognised however the call was placed.
    const recentCallByLead = new Map<string, number>(); // leadId -> latest calledAt ms
    const recentCallByPhone = new Map<string, number>(); // phoneKey -> latest calledAt ms
    {
      const since = new Date(now - recentMs);
      const crRows = await db
        .select({ leadId: callRecords.leadId, toNumber: callRecords.toNumber, fromNumber: callRecords.fromNumber, calledAt: callRecords.calledAt })
        .from(callRecords)
        .where(and(eq(callRecords.organizationId, orgId), gte(callRecords.calledAt, since)));
      for (const r of crRows) {
        if (!r.calledAt) continue;
        const t = r.calledAt.getTime();
        if (r.leadId && (recentCallByLead.get(r.leadId) ?? 0) < t) recentCallByLead.set(r.leadId, t);
        // A lead's number is the counterparty — toNumber on outbound,
        // fromNumber on inbound — so register BOTH columns. (Our own line in
        // the other column is harmless: no lead has it as their number.)
        const d = phoneKey(r.toNumber);
        const df = phoneKey(r.fromNumber);
        if (d && (recentCallByPhone.get(d) ?? 0) < t) recentCallByPhone.set(d, t);
        if (df && df !== d && (recentCallByPhone.get(df) ?? 0) < t) recentCallByPhone.set(df, t);
      }
    }

    type QueueEntry = { lead: typeof leads.$inferSelect; master: typeof masterContacts.$inferSelect | null };
    const queue: QueueEntry[] = [];
    let excludedDnc = 0;
    let excludedClosed = 0;
    let excludedRetry = 0;
    let excludedRecent = 0;
    let excludedTimezone = 0;

    for (const lead of candidateLeads) {
      const master =
        (lead.masterContactId && masterById.get(lead.masterContactId)) ||
        (lead.linkedinUrl && masterByUrl.get(lead.linkedinUrl)) ||
        (lead.email && masterByEmail.get(lead.email.toLowerCase())) ||
        null;

      // Check BOTH the person flag and the lead row's own flag — a phone-only
      // person whose master couldn't be matched used to slip through here and
      // stay dialable after being marked DNC.
      if (resolvedFilters.excludeDoNotCall && (master?.doNotCall || lead.doNotCall)) {
        excludedDnc++;
        continue;
      }
      // Closed/terminal lead (Not Interested, DNC, Qualified, Bounced, …) —
      // never re-dial unless the rep explicitly opts to include closed leads.
      if (resolvedFilters.excludeClosed && terminalStatusKeys.has(lead.status)) {
        excludedClosed++;
        continue;
      }

      const lastDispo = lastDispoByLead.get(lead.id);
      // Per-disposition retry window: a lead whose last outcome was negative
      // (e.g. Not Interested) stays out for good; one with a retry delay
      // (No Answer 1d, Voicemail 2d, Gatekeeper 3d, …) waits out that window.
      if (lastDispo?.dispositionId) {
        const dispo = dispoById.get(lastDispo.dispositionId);
        if (dispo) {
          if (dispo.outcomeBucket === "negative") {
            excludedRetry++;
            continue;
          }
          if (
            dispo.retryAfterDays != null &&
            now - lastDispo.calledAt < dispo.retryAfterDays * DAY_MS
          ) {
            excludedRetry++;
            continue;
          }
        }
      }

      // Recency from call_records (every call, any channel) plus the
      // master-contact mirror — the lead is "recently called" if ANY source saw
      // a call within the window.
      const key = phoneKey(lead.phone);
      const lastCalledMs = Math.max(
        master?.lastCalledAt ? master.lastCalledAt.getTime() : 0,
        recentCallByLead.get(lead.id) ?? 0,
        key ? recentCallByPhone.get(key) ?? 0 : 0,
      );
      if (resolvedFilters.excludeRecentlyCalled && lastCalledMs && now - lastCalledMs < recentMs) {
        excludedRecent++;
        continue;
      }
      if (
        resolvedFilters.respectTimezone &&
        !inBusinessHours(master?.timezone, master?.bestTimeStart, master?.bestTimeEnd)
      ) {
        excludedTimezone++;
        continue;
      }
      queue.push({ lead, master });
    }

    if (queue.length === 0) {
      // A campaign Smart View / filter with no matching leads is the most
      // common cause of a mysteriously-empty queue — call it out explicitly.
      if (filterWhere && candidateLeads.length === 0) {
        throw new ApiError(
          400,
          "No leads match this campaign's active Smart View filter. Clear or change the filter on the campaign's leads list, then start the dialer again.",
        );
      }
      throw new ApiError(
        400,
        `No dialable leads found${filterWhere ? " (a Smart View filter is active on this campaign)" : ""}. Excluded — DNC:${excludedDnc} closed:${excludedClosed} retry:${excludedRetry} recent:${excludedRecent} timezone:${excludedTimezone}`,
      );
    }

    // Insert session + queue items, then claim the FIRST lead through the SAME
    // locked path every advance uses (findNextDialable: per-org advisory lock +
    // cross-session ownership + recency). Critically we do NOT pre-mark
    // position 0 in_progress here — that bypassed every concurrency guard and
    // was the main reason N reps starting the same campaign all dialed the same
    // top lead. With the claim inside the lock, simultaneous starts serialize
    // and each rep gets a distinct lead. The partial unique index on (user_id)
    // WHERE status='active' still rejects a second active session per user.
    // Working a campaign in the dialer grants access to it: add the rep as a
    // member so they can open its lead profiles even when the campaign is
    // Private (idempotent — the (funnel_id,user_id) unique index dedupes).
    await db
      .insert(funnelMembers)
      .values({ id: createId("fm"), funnelId: sessionFunnelId, userId, role: "contributor" })
      .onConflictDoNothing();

    const sessionId = createId("dlr");
    let firstItem: typeof dialerQueueItems.$inferSelect | null = null;
    try {
      firstItem = await db.transaction(async (tx) => {
        await tx.insert(dialerSessions).values({
          id: sessionId,
          organizationId: orgId,
          userId,
          funnelStepId: sessionStepId,
          funnelId: sessionFunnelId,
          status: "active",
          totalLeads: queue.length,
          completedLeads: 0,
          currentLeadIndex: 0,
          dispositionsJson: {},
          filtersJson: resolvedFilters,
        });
        await tx.insert(dialerQueueItems).values(
          queue.map((q, i) => ({
            id: createId("dqi"),
            sessionId,
            leadId: q.lead.id,
            masterContactId: q.master?.id ?? null,
            leadPhone: q.lead.phone,
            position: i,
            status: "pending" as const,
          })),
        );
        const [created] = await tx.select().from(dialerSessions).where(eq(dialerSessions.id, sessionId));
        return findNextDialable(tx, created);
      });
    } catch (err: any) {
      // Likely the partial unique index — they already have an active
      // session. Surface a 409 the frontend can use to offer "take over".
      if (String(err?.message).includes("dialer_sessions_one_active_per_user")) {
        throw new ApiError(409, "You already have an active dialer session. Abandon it before starting a new one.");
      }
      throw err;
    }

    if (firstItem) {
      await db
        .update(dialerSessions)
        .set({ currentLeadIndex: firstItem.position })
        .where(eq(dialerSessions.id, sessionId));
    }

    const [session] = await db
      .select()
      .from(dialerSessions)
      .where(eq(dialerSessions.id, sessionId));

    const firstLead = firstItem ? (await db.select().from(leads).where(eq(leads.id, firstItem.leadId)))[0] : null;
    const firstMaster = firstItem?.masterContactId
      ? (await db.select().from(masterContacts).where(eq(masterContacts.id, firstItem.masterContactId)))[0]
      : null;

    res.status(201).json({
      data: {
        session: serializeSession(session),
        // The lead the rep should open on — already claimed under the lock.
        current: firstItem ? serializeQueueItem(firstItem, firstLead ?? undefined, firstMaster ?? null) : null,
        excluded: {
          dnc: excludedDnc,
          recent: excludedRecent,
          timezone: excludedTimezone,
        },
      },
    });
  }),
);

// GET /api/dialer/sessions/active — the current user's in-progress session
router.get(
  "/dialer/sessions/active",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const userId = getUserId(req);
    // Return the in-progress session whether it's running OR paused. Pausing
    // must not make the session "disappear" — otherwise re-opening the app
    // shows the launcher again, the rep starts a brand-new session, and the
    // queue restarts from the top (re-including everyone called today).
    const rows = await db
      .select()
      .from(dialerSessions)
      .where(
        and(
          eq(dialerSessions.organizationId, orgId),
          eq(dialerSessions.userId, userId),
          inArray(dialerSessions.status, ["active", "paused"]),
        ),
      )
      .orderBy(desc(dialerSessions.startedAt));
    // Prefer an active session if one exists, otherwise the most recent paused.
    const row = rows.find((r) => r.status === "active") ?? rows[0] ?? null;
    res.json({ data: row ? serializeSession(row) : null });
  }),
);

async function loadSessionOr404(
  req: Request,
  sessionId: string,
): Promise<typeof dialerSessions.$inferSelect> {
  const orgId = getOrgId(req);
  const userId = getUserId(req);
  const [row] = await db
    .select()
    .from(dialerSessions)
    .where(
      and(
        eq(dialerSessions.id, sessionId),
        eq(dialerSessions.organizationId, orgId),
        eq(dialerSessions.userId, userId),
      ),
    );
  if (!row) throw new ApiError(404, "Session not found");
  return row;
}

type DialerTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * The single source of truth for "what to dial next" — used by session create,
 * advance, skip and getCurrent, so EVERY claim runs under one per-org advisory
 * lock. Walks the session's pending queue in position order and LIVE-checks each
 * candidate against the recency signal (call_records across every channel +
 * other sessions' completed queue items), DNC and closed status. Blocked items
 * are marked `skipped` (with a reason) so a stale snapshot can NEVER re-dial
 * someone already called. A lead another rep is actively on right now (a fresh
 * in_progress/awaiting claim within CLAIM_TTL) is passed over (left pending),
 * not skipped. The chosen item is claimed (in_progress + claimedAt) before the
 * lock releases. Returns it, or null when nothing dialable remains.
 */
export async function findNextDialable(
  tx: DialerTx,
  session: typeof dialerSessions.$inferSelect,
): Promise<typeof dialerQueueItems.$inferSelect | null> {
  const orgId = session.organizationId;
  // Serialize "pick next" across every rep in this org. Without this, two reps
  // advancing at the same instant both read the queue before either marks a
  // lead in_progress, so both grab the SAME lead and dial it simultaneously
  // (the "we called the same lead at the same time" complaint). The lock is
  // released automatically when the transaction commits.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${orgId}))`);

  const f = (session.filtersJson as {
    excludeDoNotCall?: boolean;
    excludeClosed?: boolean;
    excludeRecentlyCalled?: boolean;
    recentlyCalledHours?: number;
    recentlyCalledDays?: number;
  } | null) || {};
  const excludeDoNotCall = f.excludeDoNotCall !== false;
  const excludeClosed = f.excludeClosed !== false;
  const excludeRecentlyCalled = f.excludeRecentlyCalled !== false;

  const now = Date.now();
  const recentMs = recencyMsFromFilters(f);
  const claimFloor = new Date(now - CLAIM_TTL_MS);

  const pending = await tx
    .select({
      id: dialerQueueItems.id,
      leadId: dialerQueueItems.leadId,
      leadPhone: dialerQueueItems.leadPhone,
      masterContactId: dialerQueueItems.masterContactId,
      position: dialerQueueItems.position,
    })
    .from(dialerQueueItems)
    .where(and(eq(dialerQueueItems.sessionId, session.id), eq(dialerQueueItems.status, "pending")))
    .orderBy(asc(dialerQueueItems.position));
  if (pending.length === 0) return null;

  const leadIds = [...new Set(pending.map((p) => p.leadId))];
  const leadRows = leadIds.length
    ? await tx.select({ id: leads.id, status: leads.status, doNotCall: leads.doNotCall }).from(leads).where(inArray(leads.id, leadIds))
    : [];
  const leadById = new Map(leadRows.map((l) => [l.id, l]));

  const terminalKeys = excludeClosed
    ? new Set((await getMergedLeadStatuses(orgId)).filter((s) => s.isTerminal).map((s) => s.key))
    : new Set<string>();

  // Recency from call_records (every channel), by leadId + phone.
  const recentByLead = new Map<string, number>();
  const recentByPhone = new Map<string, number>();
  {
    const since = new Date(now - recentMs);
    const crRows = await tx
      .select({ leadId: callRecords.leadId, toNumber: callRecords.toNumber, fromNumber: callRecords.fromNumber, calledAt: callRecords.calledAt })
      .from(callRecords)
      .where(and(eq(callRecords.organizationId, orgId), gte(callRecords.calledAt, since)));
    for (const r of crRows) {
      if (!r.calledAt) continue;
      const t = r.calledAt.getTime();
      if (r.leadId && (recentByLead.get(r.leadId) ?? 0) < t) recentByLead.set(r.leadId, t);
      // Counterparty number = toNumber (outbound) or fromNumber (inbound).
      const d = phoneKey(r.toNumber);
      const df = phoneKey(r.fromNumber);
      if (d && (recentByPhone.get(d) ?? 0) < t) recentByPhone.set(d, t);
      if (df && df !== d && (recentByPhone.get(df) ?? 0) < t) recentByPhone.set(df, t);
    }
  }

  // Person-level recency from master_contacts.lastCalledAt — bumped the moment
  // a dial is PLACED (dial-started endpoint) and again at hangup, so a person
  // another rep is on the phone with RIGHT NOW is "recently called" org-wide
  // immediately, not only after the browser writes the call_records row at
  // hangup. Also covers duplicate lead rows for the same person.
  const recentByMaster = new Map<string, number>();
  {
    const masterIds = [...new Set(pending.map((p) => p.masterContactId).filter(Boolean) as string[])];
    if (masterIds.length) {
      const rows = await tx
        .select({ id: masterContacts.id, lastCalledAt: masterContacts.lastCalledAt })
        .from(masterContacts)
        .where(inArray(masterContacts.id, masterIds));
      for (const r of rows) {
        if (r.lastCalledAt) recentByMaster.set(r.id, r.lastCalledAt.getTime());
      }
    }
  }

  // Server-authoritative recency from OTHER sessions' COMPLETED queue items —
  // a lead any rep in the org dispositioned within the window. This does NOT
  // depend on the browser having written the call_records row yet, so it closes
  // the "rep finished them 90s ago but the record hadn't landed" gap. (Live
  // in_progress/awaiting claims are intentionally NOT included here — they are
  // protected by the short-TTL collision set below; folding them into the
  // hours-long recency set would lock an abandoned claim away for hours.)
  {
    const since = new Date(now - recentMs);
    const qiRows = await tx
      .select({
        leadId: dialerQueueItems.leadId,
        leadPhone: dialerQueueItems.leadPhone,
        masterContactId: dialerQueueItems.masterContactId,
        calledAt: dialerQueueItems.calledAt,
      })
      .from(dialerQueueItems)
      .innerJoin(dialerSessions, eq(dialerQueueItems.sessionId, dialerSessions.id))
      .where(
        and(
          eq(dialerSessions.organizationId, orgId),
          eq(dialerQueueItems.status, "completed"),
          gte(dialerQueueItems.calledAt, since),
        ),
      );
    for (const r of qiRows) {
      const t = r.calledAt?.getTime() ?? 0;
      if (!t) continue;
      if ((recentByLead.get(r.leadId) ?? 0) < t) recentByLead.set(r.leadId, t);
      const k = phoneKey(r.leadPhone);
      if (k && (recentByPhone.get(k) ?? 0) < t) recentByPhone.set(k, t);
      if (r.masterContactId && (recentByMaster.get(r.masterContactId) ?? 0) < t)
        recentByMaster.set(r.masterContactId, t);
    }
  }

  // Leads another rep is ACTIVELY on right now — pass over (don't double-ring).
  // Active OR paused sessions count (a rep who paused mid-lead still owns it),
  // but only while the claim is fresh: a claim older than CLAIM_TTL is treated
  // as abandoned (crashed/closed tab) and released so the lead is never locked
  // away forever.
  const collidedRows = await tx
    .select({
      leadId: dialerQueueItems.leadId,
      leadPhone: dialerQueueItems.leadPhone,
      masterContactId: dialerQueueItems.masterContactId,
    })
    .from(dialerQueueItems)
    .innerJoin(dialerSessions, eq(dialerQueueItems.sessionId, dialerSessions.id))
    .where(
      and(
        eq(dialerSessions.organizationId, orgId),
        sql`${dialerQueueItems.sessionId} <> ${session.id}`,
        inArray(dialerSessions.status, ["active", "paused"]),
        inArray(dialerQueueItems.status, ["in_progress", "awaiting_disposition"]),
        gte(dialerQueueItems.claimedAt, claimFloor),
      ),
    );
  const collided = new Set(collidedRows.map((r) => r.leadId));
  // Also key the collision by phone + person, so a duplicate lead row for the
  // same human (same number, different leadId) can't be double-rung mid-call.
  const collidedPhones = new Set(collidedRows.map((r) => phoneKey(r.leadPhone)).filter(Boolean));
  const collidedMasters = new Set(
    collidedRows.map((r) => r.masterContactId).filter(Boolean) as string[],
  );

  const skipByReason = new Map<string, string[]>();
  const skip = (id: string, reason: string) => {
    const arr = skipByReason.get(reason) ?? [];
    arr.push(id);
    skipByReason.set(reason, arr);
  };

  let chosen: (typeof pending)[number] | null = null;
  for (const item of pending) {
    const lead = leadById.get(item.leadId);
    const key = phoneKey(item.leadPhone);
    if (excludeDoNotCall && lead?.doNotCall) { skip(item.id, "dnc"); continue; }
    if (excludeClosed && lead && terminalKeys.has(lead.status)) { skip(item.id, "closed"); continue; }
    if (excludeRecentlyCalled) {
      const last = Math.max(
        recentByLead.get(item.leadId) ?? 0,
        key ? recentByPhone.get(key) ?? 0 : 0,
        item.masterContactId ? recentByMaster.get(item.masterContactId) ?? 0 : 0,
      );
      if (last && now - last < recentMs) { skip(item.id, "recently_called"); continue; }
    }
    if (
      collided.has(item.leadId) ||
      (key && collidedPhones.has(key)) ||
      (item.masterContactId && collidedMasters.has(item.masterContactId))
    )
      continue; // another rep is on this person right now — try later
    chosen = item;
    break;
  }

  for (const [reason, ids] of skipByReason) {
    await tx
      .update(dialerQueueItems)
      .set({ status: "skipped", notes: `auto:${reason}`, calledAt: new Date() })
      .where(inArray(dialerQueueItems.id, ids));
  }

  if (!chosen) return null;
  // Claim it: in_progress + a fresh claimedAt so every other rep's pick sees it
  // owned (and it auto-releases after CLAIM_TTL if this rep crashes).
  await tx
    .update(dialerQueueItems)
    .set({ status: "in_progress", claimedAt: new Date() })
    .where(eq(dialerQueueItems.id, chosen.id));
  const [fresh] = await tx.select().from(dialerQueueItems).where(eq(dialerQueueItems.id, chosen.id));
  return fresh ?? null;
}

router.post(
  "/dialer/sessions/:id/pause",
  asyncHandler(async (req, res) => {
    const s = await loadSessionOr404(req, req.params.id as string);
    if (s.status !== "active") throw new ApiError(400, `Cannot pause a ${s.status} session`);
    const [updated] = await db
      .update(dialerSessions)
      .set({ status: "paused" })
      .where(eq(dialerSessions.id, s.id))
      .returning();
    res.json({ data: serializeSession(updated) });
  }),
);

router.post(
  "/dialer/sessions/:id/resume",
  asyncHandler(async (req, res) => {
    const s = await loadSessionOr404(req, req.params.id as string);
    if (s.status !== "paused") throw new ApiError(400, `Cannot resume a ${s.status} session`);
    const [updated] = await db
      .update(dialerSessions)
      .set({ status: "active" })
      .where(eq(dialerSessions.id, s.id))
      .returning();
    res.json({ data: serializeSession(updated) });
  }),
);

// POST /api/dialer/sessions/:id/dial-started — { itemId, stage? }
// Called by the browser the moment a dial is placed and every 60s while the
// call is live (heartbeat). Two effects, one tx:
//   1. Refreshes the item's claim (claimedAt=now) so the CLAIM_TTL collision
//      guard covers the true call duration, not just the 3 min after pick.
//   2. Bumps master_contacts.lastCalledAt so the person is "recently called"
//      org-wide at DIAL time — the call_records row doesn't exist until the
//      browser logs it at hangup. (callAttempts is NOT touched — advance and
//      the hangup call-record sync already count attempts.)
//
// stage="preflight" (new clients, sent BEFORE placing the call) additionally
// RE-VALIDATES the item at dial time. All pick-time guards (findNextDialable)
// only run when a lead becomes `current` — an item a rep then sits on for an
// hour is never re-vetted, its claim expires, another rep legitimately takes
// and calls the person, and the first rep's stale `current` dials them again
// minutes later (the Betsey/Yididya incident, Jul 3). Preflight blocks when,
// since our claim, ANOTHER user called this person (call_records by lead or
// phone), another session completed them inside this session's recency
// window, or another session holds a live claim on them right now. The
// requesting rep's OWN prior calls never block (explicit re-dials via Back
// stay possible). Blocked items are marked skipped and the client advances.
// Without stage (legacy clients, fire-and-forget after dial) and for
// stage="heartbeat", behavior is refresh-only — never blocks a live call.
// Idempotent; safe to repeat. Accepts active AND paused sessions (a rep whose
// session auto-paused mid-call still owns the lead) and both open item states.
router.post(
  "/dialer/sessions/:id/dial-started",
  asyncHandler(async (req, res) => {
    const s = await loadSessionOr404(req, req.params.id as string);
    if (s.status !== "active" && s.status !== "paused") {
      throw new ApiError(400, `Session is ${s.status}`);
    }
    const { itemId, stage } = (req.body ?? {}) as { itemId?: string; stage?: string };
    if (!itemId) throw new ApiError(400, "itemId required");

    if (stage === "preflight") {
      const userId = getUserId(req);
      const [item] = await db
        .select()
        .from(dialerQueueItems)
        .where(and(eq(dialerQueueItems.id, itemId), eq(dialerQueueItems.sessionId, s.id)));
      if (!item || (item.status !== "in_progress" && item.status !== "awaiting_disposition")) {
        throw new ApiError(404, "No open queue item to dial");
      }

      const now = Date.now();
      const key = phoneKey(item.leadPhone);
      const f = (s.filtersJson as { excludeRecentlyCalled?: boolean; recentlyCalledHours?: number; recentlyCalledDays?: number } | null) || {};
      const recencyOn = f.excludeRecentlyCalled !== false;
      const recentMs = recencyMsFromFilters(f);
      let blockedReason: string | null = null;

      // (a) Someone ELSE is live on this person right now (fresh claim in
      // another active/paused session) — applies even with recency off.
      const [liveClaim] = await db
        .select({ id: dialerQueueItems.id })
        .from(dialerQueueItems)
        .innerJoin(dialerSessions, eq(dialerQueueItems.sessionId, dialerSessions.id))
        .where(
          and(
            eq(dialerSessions.organizationId, s.organizationId),
            sql`${dialerQueueItems.sessionId} <> ${s.id}`,
            inArray(dialerSessions.status, ["active", "paused"]),
            inArray(dialerQueueItems.status, ["in_progress", "awaiting_disposition"]),
            gte(dialerQueueItems.claimedAt, new Date(now - CLAIM_TTL_MS)),
            or(
              eq(dialerQueueItems.leadId, item.leadId),
              key ? sql`RIGHT(regexp_replace(${dialerQueueItems.leadPhone}, '[^0-9]', '', 'g'), 10) = ${key}` : sql`FALSE`,
              item.masterContactId ? eq(dialerQueueItems.masterContactId, item.masterContactId) : sql`FALSE`,
            ),
          ),
        )
        .limit(1);
      if (liveClaim) blockedReason = "in_call";

      // (b) Another USER already called this person inside the recency window.
      if (!blockedReason && recencyOn) {
        const since = new Date(now - recentMs);
        const [recentCall] = await db
          .select({ id: callRecords.id })
          .from(callRecords)
          .where(
            and(
              eq(callRecords.organizationId, s.organizationId),
              sql`${callRecords.userId} IS DISTINCT FROM ${userId}`,
              gte(callRecords.calledAt, since),
              or(
                eq(callRecords.leadId, item.leadId),
                key ? sql`RIGHT(regexp_replace(${callRecords.toNumber}, '[^0-9]', '', 'g'), 10) = ${key}` : sql`FALSE`,
              ),
            ),
          )
          .limit(1);
        if (recentCall) blockedReason = "recently_called";

        if (!blockedReason) {
          const [recentDone] = await db
            .select({ id: dialerQueueItems.id })
            .from(dialerQueueItems)
            .innerJoin(dialerSessions, eq(dialerQueueItems.sessionId, dialerSessions.id))
            .where(
              and(
                eq(dialerSessions.organizationId, s.organizationId),
                sql`${dialerQueueItems.sessionId} <> ${s.id}`,
                eq(dialerQueueItems.status, "completed"),
                gte(dialerQueueItems.calledAt, since),
                or(
                  eq(dialerQueueItems.leadId, item.leadId),
                  key ? sql`RIGHT(regexp_replace(${dialerQueueItems.leadPhone}, '[^0-9]', '', 'g'), 10) = ${key}` : sql`FALSE`,
                  item.masterContactId ? eq(dialerQueueItems.masterContactId, item.masterContactId) : sql`FALSE`,
                ),
              ),
            )
            .limit(1);
          if (recentDone) blockedReason = "recently_called";
        }
      }

      if (blockedReason) {
        // Release the stale current so the queue moves on cleanly.
        await db
          .update(dialerQueueItems)
          .set({ status: "skipped", notes: `auto:${blockedReason}`, calledAt: new Date() })
          .where(eq(dialerQueueItems.id, item.id));
        res.json({ data: { ok: false, blocked: true, reason: blockedReason } });
        return;
      }
    }

    await db.transaction(async (tx) => {
      const [item] = await tx
        .update(dialerQueueItems)
        .set({ claimedAt: new Date() })
        .where(
          and(
            eq(dialerQueueItems.id, itemId),
            eq(dialerQueueItems.sessionId, s.id),
            inArray(dialerQueueItems.status, ["in_progress", "awaiting_disposition"]),
          ),
        )
        .returning({ masterContactId: dialerQueueItems.masterContactId });
      if (!item) throw new ApiError(404, "No open queue item to mark dialed");
      if (item.masterContactId) {
        await tx
          .update(masterContacts)
          .set({ lastCalledAt: new Date(), updatedAt: new Date() })
          .where(eq(masterContacts.id, item.masterContactId));
      }
    });
    res.json({ data: { ok: true } });
  }),
);

router.post(
  "/dialer/sessions/:id/end",
  asyncHandler(async (req, res) => {
    const s = await loadSessionOr404(req, req.params.id as string);
    const updated = await db.transaction(async (tx) => {
      const [u] = await tx
        .update(dialerSessions)
        .set({
          status: s.completedLeads >= s.totalLeads ? "completed" : "abandoned",
          endedAt: new Date(),
        })
        .where(eq(dialerSessions.id, s.id))
        .returning();
      // Release the session's own open claim — an ended session no longer owns
      // any lead, so don't leave an in_progress row lingering.
      await tx
        .update(dialerQueueItems)
        .set({ status: "pending", claimedAt: null })
        .where(
          and(
            eq(dialerQueueItems.sessionId, s.id),
            inArray(dialerQueueItems.status, ["in_progress", "awaiting_disposition"]),
          ),
        );
      return u;
    });
    res.json({ data: serializeSession(updated) });
  }),
);

// GET /api/dialer/sessions/:id/current — current item + 5-lookahead
router.get(
  "/dialer/sessions/:id/current",
  asyncHandler(async (req, res) => {
    const s = await loadSessionOr404(req, req.params.id as string);

    // Self-heal: a session should have exactly ONE in_progress item while leads
    // remain. Find it directly (no positional window — the in_progress lead can
    // sit anywhere, e.g. when the session opened past a few busy leads). Collapse
    // any duplicate in_progress rows, and if none is in_progress but pending
    // remain, promote the lowest-position pending — so a session can never get
    // stuck reporting "complete" while it still has leads to dial.
    const live = await db
      .select()
      .from(dialerQueueItems)
      .where(
        and(
          eq(dialerQueueItems.sessionId, s.id),
          inArray(dialerQueueItems.status, ["in_progress", "awaiting_disposition"]),
        ),
      )
      .orderBy(asc(dialerQueueItems.position));

    let currentItem: typeof dialerQueueItems.$inferSelect | null = live[0] ?? null;
    if (live.length > 1) {
      const extra = live.slice(1).filter((r) => r.status === "in_progress").map((r) => r.id);
      if (extra.length) {
        await db.update(dialerQueueItems).set({ status: "pending" }).where(inArray(dialerQueueItems.id, extra));
      }
    }
    // Stale-claim self-heal: if the open item was claimed more than CLAIM_TTL
    // ago AND no call was ever actually placed for it (rep claimed it then
    // closed the tab / walked away without dialing), it's been released to the
    // rest of the org and another rep may have taken it. Drop it back to
    // pending and re-pick through the locked path so we never resume onto a
    // lead now owned/called by someone else. A lead the rep *did* dial is left
    // alone — its call_records row protects it and advance() will dispose it.
    if (currentItem && (!currentItem.claimedAt || currentItem.claimedAt.getTime() < Date.now() - CLAIM_TTL_MS)) {
      const since = new Date(Date.now() - CLAIM_TTL_MS);
      const [dialed] = await db
        .select({ id: callRecords.id })
        .from(callRecords)
        .where(and(eq(callRecords.organizationId, s.organizationId), eq(callRecords.leadId, currentItem.leadId), gte(callRecords.calledAt, since)))
        .limit(1);
      if (!dialed) {
        await db.update(dialerQueueItems).set({ status: "pending" }).where(eq(dialerQueueItems.id, currentItem.id));
        currentItem = null;
      }
    }
    if (!currentItem) {
      // Promote the next LIVE-vetted pending lead (recency / DNC / closed /
      // collision) — never re-surface someone already called.
      currentItem = await db.transaction(async (tx) => findNextDialable(tx, s));
    }

    const upcoming = currentItem
      ? await db
          .select()
          .from(dialerQueueItems)
          .where(
            and(
              eq(dialerQueueItems.sessionId, s.id),
              eq(dialerQueueItems.status, "pending"),
              sql`${dialerQueueItems.position} > ${currentItem.position}`,
            ),
          )
          .orderBy(asc(dialerQueueItems.position))
          .limit(5)
      : [];

    const allItems = [...(currentItem ? [currentItem] : []), ...upcoming];
    const leadIds = allItems.map((r) => r.leadId);
    const masterIds = allItems.map((r) => r.masterContactId).filter(Boolean) as string[];
    const leadRows = leadIds.length ? await db.select().from(leads).where(inArray(leads.id, leadIds)) : [];
    const leadById = new Map(leadRows.map((l) => [l.id, l]));
    const masterRows = masterIds.length ? await db.select().from(masterContacts).where(inArray(masterContacts.id, masterIds)) : [];
    const masterById = new Map(masterRows.map((m) => [m.id, m]));

    res.json({
      data: {
        session: serializeSession(s),
        current: currentItem
          ? serializeQueueItem(currentItem, leadById.get(currentItem.leadId), currentItem.masterContactId ? masterById.get(currentItem.masterContactId) : null)
          : null,
        upcoming: upcoming.map((u) =>
          serializeQueueItem(u, leadById.get(u.leadId), u.masterContactId ? masterById.get(u.masterContactId) : null),
        ),
      },
    });
  }),
);

// POST /api/dialer/sessions/:id/advance — atomic dispose+advance
router.post(
  "/dialer/sessions/:id/advance",
  asyncHandler(async (req, res) => {
    const s = await loadSessionOr404(req, req.params.id as string);
    const { dispositionSlug, notes, callRecordId } = req.body as {
      dispositionSlug?: string;
      notes?: string;
      callRecordId?: string;
    };

    // Auto mode (Close-style dialer): no disposition picked. Dialing the lead
    // simply ticks off the call step. With a disposition, the legacy behaviour
    // (funnel rules, lead-status, DNC) still applies.
    const auto = !dispositionSlug;

    // Resolve disposition (only when one was provided).
    const disposition = dispositionSlug
      ? (
          await db
            .select()
            .from(callDispositions)
            .where(
              and(
                eq(callDispositions.organizationId, s.organizationId),
                eq(callDispositions.slug, dispositionSlug),
              ),
            )
        )[0]
      : null;
    if (dispositionSlug && !disposition) {
      throw new ApiError(400, `Unknown disposition: ${dispositionSlug}`);
    }

    // Resolve action — a step-specific funnel rule overrides the disposition
    // default. In auto mode we advance the lead past the call step (step mode)
    // or do nothing (campaign mode, no step to tick).
    const [rule] = disposition && s.funnelStepId
      ? await db
          .select()
          .from(funnelDispositionRules)
          .where(
            and(
              eq(funnelDispositionRules.funnelStepId, s.funnelStepId),
              eq(funnelDispositionRules.dispositionId, disposition.id),
            ),
          )
      : [];
    const action = disposition
      ? rule?.funnelAction || disposition.funnelAction
      : s.funnelStepId
        ? "advance"
        : "none";
    const retryDays = rule?.retryAfterDays ?? disposition?.retryAfterDays ?? null;

    // For auto-mode step ticking we need the call step's position so the tick
    // is idempotent across back→re-advance (set to one past the call step
    // rather than blindly incrementing).
    const callStepSortOrder =
      auto && s.funnelStepId
        ? (
            await db
              .select({ sortOrder: funnelSteps.sortOrder })
              .from(funnelSteps)
              .where(eq(funnelSteps.id, s.funnelStepId))
          )[0]?.sortOrder ?? null
        : null;

    // Begin transaction.
    const result = await db.transaction(async (tx) => {
      // Find the current queue item.
      const [current] = await tx
        .select()
        .from(dialerQueueItems)
        .where(
          and(
            eq(dialerQueueItems.sessionId, s.id),
            sql`${dialerQueueItems.status} IN ('in_progress', 'awaiting_disposition')`,
          ),
        )
        .orderBy(asc(dialerQueueItems.position))
        .limit(1);
      if (!current) throw new ApiError(400, "No active queue item to advance");

      // Mark completed
      await tx
        .update(dialerQueueItems)
        .set({
          status: "completed",
          dispositionId: disposition?.id ?? null,
          notes: notes || null,
          callRecordId: callRecordId || null,
          calledAt: new Date(),
        })
        .where(eq(dialerQueueItems.id, current.id));

      // A voicemail disposition marks the CALL RECORD too, so connect-rate
      // excludes it and the Team page's voicemail counter counts it.
      // (Previously only the VM-drop button set this — a hotkey'd "Voicemail"
      // disposition never showed up in the analytics.)
      const isVoicemail = !!disposition && /voicemail/i.test(`${disposition.slug} ${disposition.label}`);
      if (isVoicemail && callRecordId) {
        await tx
          .update(callRecords)
          .set({ disposition: "voicemail" })
          .where(and(eq(callRecords.id, callRecordId), eq(callRecords.organizationId, s.organizationId)));
      }

      // Bump master_contacts counters
      if (current.masterContactId) {
        await tx
          .update(masterContacts)
          .set({
            callAttempts: sql`${masterContacts.callAttempts} + 1`,
            lastCalledAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(masterContacts.id, current.masterContactId));
      }

      // Apply funnel action to the lead
      const [lead] = await tx.select().from(leads).where(eq(leads.id, current.leadId));
      if (lead) {
        const leadStatus = disposition?.leadStatus ?? null;

        // 1) Step / schedule movement for the dialed contact.
        if (action === "advance") {
          // Auto step-tick uses an absolute target (one past the call step) so
          // it's idempotent under back→re-advance; the disposition path keeps
          // the legacy relative increment.
          const target =
            callStepSortOrder !== null
              ? Math.min(callStepSortOrder + 2, lead.totalSteps)
              : Math.min(lead.currentStep + 1, lead.totalSteps);
          await tx
            .update(leads)
            .set({
              currentStep: target,
              nextDate: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(leads.id, lead.id));
        } else if (action === "retry") {
          const nextDate = retryDays ? new Date(Date.now() + retryDays * 86400000) : new Date();
          await tx
            .update(leads)
            .set({ nextDate, updatedAt: new Date() })
            .where(eq(leads.id, lead.id));
        }

        // 2) Company-shared status — apply to EVERY contact at this company in
        //    the funnel so status reads as a company-level state.
        if (leadStatus) {
          await tx
            .update(leads)
            .set({ status: leadStatus, updatedAt: new Date() })
            .where(
              and(
                eq(leads.funnelId, lead.funnelId),
                sql`lower(${leads.company}) = lower(${lead.company})`,
              ),
            );
          // Record the transition on the dialed lead so the timeline shows
          // "Status changed from X → Y" (dialer dispositions included).
          if (leadStatus !== lead.status) {
            await tx.insert(leadEvents).values({
              id: createId("le"),
              leadId: lead.id,
              type: "status_change",
              outcome: leadStatus,
              stepIndex: lead.currentStep,
              meta: { source: "dialer", from: lead.status, dispositionId: disposition?.id ?? null, userId: s.userId ?? null },
            });
          }
        }

        // 3) Do-Not-Contact — flag the PERSON (non-destructive). They stay in
        //    the campaign; the UI shows them red + confirms before calling.
        if (action === "dnc" || dispositionSlug === "do-not-call") {
          await flagDoNotCall(tx, s.organizationId, lead, true);
        }

        // 4) Log the call touch (counts toward the campaign call counter).
        await tx.insert(leadEvents).values({
          id: createId("le"),
          leadId: lead.id,
          type: "call",
          outcome: dispositionSlug || "dialed",
          stepIndex: lead.currentStep,
          meta: { dispositionId: disposition?.id ?? null, callRecordId: callRecordId || null, action, leadStatus, retryDays, auto },
        });
      }

      // Pick the next dialable lead — LIVE-checked against recency
      // (any channel), DNC, closed status and cross-rep collision.
      // This is what guarantees the dialer never re-dials someone already called
      // and never serves a stale snapshot lead. Blocked items are auto-skipped.
      const next = await findNextDialable(tx, s);

      // Update session counters
      const newDispoCounts = { ...(s.dispositionsJson || {}) };
      if (dispositionSlug) {
        newDispoCounts[dispositionSlug] = (newDispoCounts[dispositionSlug] || 0) + 1;
      }
      const completedLeads = s.completedLeads + 1;
      const isLast = !next;
      await tx
        .update(dialerSessions)
        .set({
          completedLeads,
          currentLeadIndex: next ? next.position : s.totalLeads,
          dispositionsJson: newDispoCounts,
          status: isLast ? "completed" : s.status,
          endedAt: isLast ? new Date() : null,
        })
        .where(eq(dialerSessions.id, s.id));

      return { nextId: next?.id ?? null, ruleApplied: action };
    });

    if (!result.nextId) {
      res.json({ data: { next: null, ruleApplied: result.ruleApplied, sessionComplete: true } });
      return;
    }

    // Hydrate next item with lead + master for the response
    const [nextRow] = await db
      .select()
      .from(dialerQueueItems)
      .where(eq(dialerQueueItems.id, result.nextId));
    const [nextLead] = await db.select().from(leads).where(eq(leads.id, nextRow.leadId));
    const nextMaster = nextRow.masterContactId
      ? (await db.select().from(masterContacts).where(eq(masterContacts.id, nextRow.masterContactId)))[0]
      : null;
    res.json({
      data: {
        next: serializeQueueItem(nextRow, nextLead, nextMaster),
        ruleApplied: result.ruleApplied,
        sessionComplete: false,
      },
    });
  }),
);

// POST /api/dialer/sessions/:id/skip — mark skipped, no disposition
router.post(
  "/dialer/sessions/:id/skip",
  asyncHandler(async (req, res) => {
    const s = await loadSessionOr404(req, req.params.id as string);
    const { reason } = req.body as { reason?: string };
    const result = await db.transaction(async (tx) => {
      // Skip the lead the rep is actually on — the in_progress/awaiting item,
      // NOT the lowest-position pending (which would skip the wrong contact).
      // Fall back to the first pending only if nothing is open (self-heal).
      let [current] = await tx
        .select()
        .from(dialerQueueItems)
        .where(
          and(
            eq(dialerQueueItems.sessionId, s.id),
            sql`${dialerQueueItems.status} IN ('in_progress', 'awaiting_disposition')`,
          ),
        )
        .orderBy(asc(dialerQueueItems.position))
        .limit(1);
      if (!current) {
        [current] = await tx
          .select()
          .from(dialerQueueItems)
          .where(and(eq(dialerQueueItems.sessionId, s.id), eq(dialerQueueItems.status, "pending")))
          .orderBy(asc(dialerQueueItems.position))
          .limit(1);
      }
      if (!current) throw new ApiError(400, "No queue item to skip");

      await tx
        .update(dialerQueueItems)
        .set({ status: "skipped", notes: reason || null, calledAt: new Date() })
        .where(eq(dialerQueueItems.id, current.id));

      // Live-vetted next lead (recency / DNC / closed / collision).
      const next = await findNextDialable(tx, s);
      await tx
        .update(dialerSessions)
        .set({
          currentLeadIndex: next ? next.position : s.totalLeads,
          completedLeads: s.completedLeads + 1,
          status: next ? s.status : "completed",
          endedAt: next ? null : new Date(),
        })
        .where(eq(dialerSessions.id, s.id));
      return next?.id ?? null;
    });

    if (!result) {
      res.json({ data: { next: null, sessionComplete: true } });
      return;
    }
    const [nextRow] = await db.select().from(dialerQueueItems).where(eq(dialerQueueItems.id, result));
    const [nextLead] = await db.select().from(leads).where(eq(leads.id, nextRow.leadId));
    res.json({ data: { next: serializeQueueItem(nextRow, nextLead, null), sessionComplete: false } });
  }),
);

// POST /api/dialer/sessions/:id/back — undo the most recent completion
router.post(
  "/dialer/sessions/:id/back",
  asyncHandler(async (req, res) => {
    const s = await loadSessionOr404(req, req.params.id as string);
    const result = await db.transaction(async (tx) => {
      // Find the lead the rep LAST ACTUALLY WORKED — by when it was handled
      // (calledAt), not by position. Exclude auto-skipped items (recency / DNC /
      // closed, flagged `auto:…`) so Previous lands on a real prior
      // lead rather than a machine-skipped one.
      const [prev] = await tx
        .select()
        .from(dialerQueueItems)
        .where(
          and(
            eq(dialerQueueItems.sessionId, s.id),
            sql`(${dialerQueueItems.status} = 'completed' OR (${dialerQueueItems.status} = 'skipped' AND (${dialerQueueItems.notes} IS NULL OR ${dialerQueueItems.notes} NOT LIKE 'auto:%')))`,
          ),
        )
        .orderBy(sql`${dialerQueueItems.calledAt} DESC NULLS LAST`, desc(dialerQueueItems.position))
        .limit(1);
      if (!prev) throw new ApiError(400, "No previous lead to go back to");

      // Demote the current in-progress item back to pending.
      await tx
        .update(dialerQueueItems)
        .set({ status: "pending" })
        .where(
          and(
            eq(dialerQueueItems.sessionId, s.id),
            sql`${dialerQueueItems.status} IN ('in_progress', 'awaiting_disposition')`,
          ),
        );
      // Re-open the previous item (fresh claim so it's owned again).
      await tx
        .update(dialerQueueItems)
        .set({
          status: "in_progress",
          dispositionId: null,
          callRecordId: null,
          notes: null,
          calledAt: null,
          claimedAt: new Date(),
        })
        .where(eq(dialerQueueItems.id, prev.id));

      // Un-tick the call step for the re-opened lead (step mode only). The
      // auto step-tick set currentStep to one past the call step; reset it
      // back to the call step so re-dialing behaves the same as the first time.
      if (s.funnelStepId) {
        const [fs] = await tx
          .select({ sortOrder: funnelSteps.sortOrder })
          .from(funnelSteps)
          .where(eq(funnelSteps.id, s.funnelStepId));
        if (fs) {
          await tx
            .update(leads)
            .set({ currentStep: fs.sortOrder + 1, updatedAt: new Date() })
            .where(eq(leads.id, prev.leadId));
        }
      }
      // Decrement counters (best-effort: dispositions counts left as-is —
      // a back+advance will inflate counts, acceptable for v1).
      await tx
        .update(dialerSessions)
        .set({
          completedLeads: Math.max(0, s.completedLeads - 1),
          currentLeadIndex: prev.position,
          status: "active",
          endedAt: null,
        })
        .where(eq(dialerSessions.id, s.id));
      return prev.id;
    });

    const [row] = await db.select().from(dialerQueueItems).where(eq(dialerQueueItems.id, result));
    const [lead] = await db.select().from(leads).where(eq(leads.id, row.leadId));
    res.json({ data: { current: serializeQueueItem(row, lead, null) } });
  }),
);

// GET /api/dialer/sessions/:id/events — SSE stream for async events
// (recording-complete, amd-detected, vm-dropped). Frontend subscribes per
// active call SID rather than per session so we don't fan-out unrelated
// noise; the dialer context wires this up while a call is in flight.
//
// Note: this is `/calls/:callSid/events` instead of `/sessions/:id/events`
// because Twilio identifies events by CallSid, and dialer state is tracked
// client-side per call anyway.
router.get(
  "/dialer/calls/:callSid/events",
  asyncHandler(async (req, res) => {
    // Auth check via getOrgId — we don't verify the callSid belongs to this
    // user here because callSids are unguessable random strings from Twilio
    // and we only publish events to subscribers of that exact channel.
    getOrgId(req);
    const callSid = req.params.callSid as string;

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no"); // disable Nginx/proxy buffering
    res.flushHeaders?.();

    const { subscribeToCall } = await import("../lib/dialer-event-bus");
    const unsubscribe = subscribeToCall(callSid, (event) => {
      res.write(`event: ${event.type}\n`);
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    });

    // Heartbeat every 25s so proxies don't kill the idle connection.
    const heartbeat = setInterval(() => {
      res.write(`: heartbeat\n\n`);
    }, 25000);

    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  }),
);

export default router;
