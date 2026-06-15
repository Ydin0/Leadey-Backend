import { Router, Request, Response, NextFunction } from "express";
import { eq, and, or, desc, asc, inArray, notInArray, isNull, sql, gte, count } from "drizzle-orm";
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
import { funnelSteps, funnels } from "../db/schema/funnels";
import { leads, leadEvents } from "../db/schema/leads";
import { masterContacts } from "../db/schema/master";
import { callRecords } from "../db/schema/call-records";
import { getOrgId } from "../lib/auth";
import { ApiError, createId } from "../lib/helpers";
import { seedSystemDispositions } from "../lib/dialer-seed";
import { flagDoNotCall } from "../lib/dnc";
import {
  saveVoicemailFile,
  deleteVoicemailFile,
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

    const twiml = `<Response><Play>${escapeXml(vm.recordingUrl)}</Play><Hangup/></Response>`;
    try {
      await twilio.calls(callSid).update({ twiml });
    } catch (err: any) {
      throw new ApiError(400, `Twilio rejected VM drop: ${err?.message || err}`);
    }
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
        /** Don't re-queue anyone called within the last N days (default 2). */
        recentlyCalledDays?: number;
        /** Skip leads in a terminal status (Not Interested, DNC, Qualified…). */
        excludeClosed?: boolean;
        respectTimezone?: boolean;
        maxAttempts?: number | null;
      };
    };
    if (!funnelStepId && !funnelId) {
      throw new ApiError(400, "funnelStepId or funnelId required");
    }

    const resolvedFilters = {
      excludeDoNotCall: filters?.excludeDoNotCall ?? true,
      excludeRecentlyCalled: filters?.excludeRecentlyCalled ?? true,
      recentlyCalledDays:
        filters?.recentlyCalledDays && filters.recentlyCalledDays > 0
          ? Math.min(Math.floor(filters.recentlyCalledDays), 30)
          : 2,
      excludeClosed: filters?.excludeClosed ?? true,
      respectTimezone: filters?.respectTimezone ?? false,
      maxAttempts: filters?.maxAttempts ?? 3,
    };

    // Resolve the target. Two modes:
    //   1. Step mode — a call-channel step; queue leads sitting on that step.
    //   2. Campaign mode — no call step; queue every lead in the funnel that
    //      has a phone number, regardless of which step they're on.
    let sessionStepId: string | null = null;
    let sessionFunnelId: string;
    let candidateLeads: (typeof leads.$inferSelect)[];

    if (funnelStepId) {
      const [step] = await db
        .select({ id: funnelSteps.id, channel: funnelSteps.channel, funnelId: funnelSteps.funnelId, sortOrder: funnelSteps.sortOrder })
        .from(funnelSteps)
        .innerJoin(funnels, eq(funnels.id, funnelSteps.funnelId))
        .where(and(eq(funnelSteps.id, funnelStepId), eq(funnels.organizationId, orgId)));
      if (!step) throw new ApiError(404, "Funnel step not found");
      if (step.channel !== "call") {
        throw new ApiError(400, `Dialer requires a call-channel step (got ${step.channel})`);
      }
      sessionStepId = step.id;
      sessionFunnelId = step.funnelId;

      // Leads on this step (currentStep is 1-indexed) with a phone.
      const stepNumber = step.sortOrder + 1;
      candidateLeads = await db
        .select()
        .from(leads)
        .where(
          and(
            eq(leads.funnelId, step.funnelId),
            eq(leads.currentStep, stepNumber),
            sql`${leads.phone} <> ''`,
          ),
        )
        .orderBy(asc(leads.createdAt));
    } else {
      // Campaign mode — verify the funnel belongs to the org.
      const [funnel] = await db
        .select({ id: funnels.id })
        .from(funnels)
        .where(and(eq(funnels.id, funnelId!), eq(funnels.organizationId, orgId)));
      if (!funnel) throw new ApiError(404, "Campaign not found");
      sessionFunnelId = funnel.id;

      // Every lead in the funnel with a phone number, any step.
      candidateLeads = await db
        .select()
        .from(leads)
        .where(and(eq(leads.funnelId, funnel.id), sql`${leads.phone} <> ''`))
        .orderBy(asc(leads.createdAt));
    }

    // Resolve master contacts by linkedinUrl (preferred) then email.
    const linkedinUrls = candidateLeads.map((l) => l.linkedinUrl).filter(Boolean) as string[];
    const emails = candidateLeads.map((l) => l.email).filter(Boolean) as string[];

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
    const DAY_MS = 24 * 60 * 60 * 1000;
    const RECENT_MS = DAY_MS; // 24h — the window for "max attempts per contact"
    const recentMs = resolvedFilters.recentlyCalledDays * DAY_MS; // "recently called" floor

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

    // One pass over recent completed calls (org-wide) gives us both:
    //   • the LAST disposition + when, per lead (recency + retry-window check)
    //   • the count in the last 24h, per lead (max-attempts check)
    // Look back far enough to cover any retry window (capped) and the recency
    // floor — retry windows are 1–3 days, so 30 days is generous.
    const lookbackMs = Math.max(recentMs, 30 * DAY_MS);
    const lastCallByLead = new Map<string, { calledAt: number; dispositionId: string | null }>();
    const recentAttemptsByLead = new Map<string, number>();
    {
      const since = new Date(now - lookbackMs);
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
        const t = r.calledAt.getTime();
        // Rows are newest-first, so the first one seen per lead is the latest.
        if (!lastCallByLead.has(r.leadId)) {
          lastCallByLead.set(r.leadId, { calledAt: t, dispositionId: r.dispositionId });
        }
        if (now - t < RECENT_MS) {
          recentAttemptsByLead.set(r.leadId, (recentAttemptsByLead.get(r.leadId) ?? 0) + 1);
        }
      }
    }

    type QueueEntry = { lead: typeof leads.$inferSelect; master: typeof masterContacts.$inferSelect | null };
    const queue: QueueEntry[] = [];
    let excludedDnc = 0;
    let excludedClosed = 0;
    let excludedRetry = 0;
    let excludedRecent = 0;
    let excludedAttempts = 0;
    let excludedTimezone = 0;

    for (const lead of candidateLeads) {
      const master =
        (lead.linkedinUrl && masterByUrl.get(lead.linkedinUrl)) ||
        (lead.email && masterByEmail.get(lead.email.toLowerCase())) ||
        null;

      if (resolvedFilters.excludeDoNotCall && master?.doNotCall) {
        excludedDnc++;
        continue;
      }
      // Closed/terminal lead (Not Interested, DNC, Qualified, Bounced, …) —
      // never re-dial unless the rep explicitly opts to include closed leads.
      if (resolvedFilters.excludeClosed && terminalStatusKeys.has(lead.status)) {
        excludedClosed++;
        continue;
      }

      const lastCall = lastCallByLead.get(lead.id);
      // Per-disposition retry window: a lead whose last outcome was negative
      // (e.g. Not Interested) stays out for good; one with a retry delay
      // (No Answer 1d, Voicemail 2d, Gatekeeper 3d, …) waits out that window.
      if (lastCall?.dispositionId) {
        const dispo = dispoById.get(lastCall.dispositionId);
        if (dispo) {
          if (dispo.outcomeBucket === "negative") {
            excludedRetry++;
            continue;
          }
          if (
            dispo.retryAfterDays != null &&
            now - lastCall.calledAt < dispo.retryAfterDays * DAY_MS
          ) {
            excludedRetry++;
            continue;
          }
        }
      }

      const recentAttempts = recentAttemptsByLead.get(lead.id) ?? 0;
      if (
        resolvedFilters.excludeRecentlyCalled &&
        ((master?.lastCalledAt && now - master.lastCalledAt.getTime() < recentMs) ||
          (lastCall && now - lastCall.calledAt < recentMs))
      ) {
        excludedRecent++;
        continue;
      }
      if (
        resolvedFilters.maxAttempts !== null &&
        // Real dialer attempts on this lead in the last 24h (works for every
        // lead) — OR the master-contact counter for cross-source dedup.
        (recentAttempts >= resolvedFilters.maxAttempts ||
          (master !== null &&
            master.callAttempts >= resolvedFilters.maxAttempts &&
            master.lastCalledAt !== null &&
            now - master.lastCalledAt.getTime() < RECENT_MS))
      ) {
        excludedAttempts++;
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
      throw new ApiError(
        400,
        `No dialable leads found. Excluded — DNC:${excludedDnc} closed:${excludedClosed} retry:${excludedRetry} recent:${excludedRecent} attempts:${excludedAttempts} timezone:${excludedTimezone}`,
      );
    }

    // Open on the first lead and progress strictly forward by position. Two
    // reps sharing a campaign are de-conflicted at advance time (the next-lead
    // pick skips whoever another rep is currently on) — opening at position 0
    // keeps the in_progress item always at the front, which the current/advance/
    // skip logic relies on.
    const inProgressIdx = 0;

    // Insert session + queue items in a transaction. The partial unique
    // index on (user_id) WHERE status='active' will reject if the user has
    // an active session already.
    const sessionId = createId("dlr");
    try {
      await db.transaction(async (tx) => {
        await tx.insert(dialerSessions).values({
          id: sessionId,
          organizationId: orgId,
          userId,
          funnelStepId: sessionStepId,
          funnelId: sessionFunnelId,
          status: "active",
          totalLeads: queue.length,
          completedLeads: 0,
          currentLeadIndex: inProgressIdx,
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
            status: i === inProgressIdx ? "in_progress" : "pending",
          })),
        );
      });
    } catch (err: any) {
      // Likely the partial unique index — they already have an active
      // session. Surface a 409 the frontend can use to offer "take over".
      if (String(err?.message).includes("dialer_sessions_one_active_per_user")) {
        throw new ApiError(409, "You already have an active dialer session. Abandon it before starting a new one.");
      }
      throw err;
    }

    const [session] = await db
      .select()
      .from(dialerSessions)
      .where(eq(dialerSessions.id, sessionId));

    res.status(201).json({
      data: {
        session: serializeSession(session),
        excluded: {
          dnc: excludedDnc,
          recent: excludedRecent,
          attempts: excludedAttempts,
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

router.post(
  "/dialer/sessions/:id/end",
  asyncHandler(async (req, res) => {
    const s = await loadSessionOr404(req, req.params.id as string);
    const [updated] = await db
      .update(dialerSessions)
      .set({
        status: s.completedLeads >= s.totalLeads ? "completed" : "abandoned",
        endedAt: new Date(),
      })
      .where(eq(dialerSessions.id, s.id))
      .returning();
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
    if (!currentItem) {
      const [firstPending] = await db
        .select()
        .from(dialerQueueItems)
        .where(and(eq(dialerQueueItems.sessionId, s.id), eq(dialerQueueItems.status, "pending")))
        .orderBy(asc(dialerQueueItems.position))
        .limit(1);
      if (firstPending) {
        await db.update(dialerQueueItems).set({ status: "in_progress" }).where(eq(dialerQueueItems.id, firstPending.id));
        currentItem = { ...firstPending, status: "in_progress" };
      }
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

      // Find the next dialable lead, skipping any another rep is currently on
      // (in_progress in another live session) or — when this session excludes
      // recently-called — one another session already completed in the last 24h.
      // Collided leads are left PENDING (retried on a later advance once the
      // collision clears), so two reps sharing a campaign split the leads
      // dynamically instead of double-dialing the same people.
      const recentSkip =
        (s.filtersJson as { excludeRecentlyCalled?: boolean } | null)?.excludeRecentlyCalled !== false;
      const collidedRows = await tx
        .select({ leadId: dialerQueueItems.leadId })
        .from(dialerQueueItems)
        .innerJoin(dialerSessions, eq(dialerQueueItems.sessionId, dialerSessions.id))
        .where(
          and(
            eq(dialerSessions.organizationId, s.organizationId),
            sql`${dialerQueueItems.sessionId} <> ${s.id}`,
            or(
              and(
                inArray(dialerQueueItems.status, ["in_progress", "awaiting_disposition"]),
                inArray(dialerSessions.status, ["active", "paused"]),
              ),
              ...(recentSkip
                ? [
                    and(
                      eq(dialerQueueItems.status, "completed"),
                      gte(dialerQueueItems.calledAt, new Date(Date.now() - 24 * 60 * 60 * 1000)),
                    ),
                  ]
                : []),
            ),
          ),
        );
      const collidedLeadIds = [...new Set(collidedRows.map((r) => r.leadId))];

      // First pending lead that isn't collided. Collided leads are simply not
      // picked now — they stay pending and get retried on a later advance once
      // the other rep is off them.
      const nextConds = [
        eq(dialerQueueItems.sessionId, s.id),
        eq(dialerQueueItems.status, "pending"),
      ];
      if (collidedLeadIds.length) {
        nextConds.push(notInArray(dialerQueueItems.leadId, collidedLeadIds));
      }
      let [next] = await tx
        .select()
        .from(dialerQueueItems)
        .where(and(...nextConds))
        .orderBy(asc(dialerQueueItems.position))
        .limit(1);
      // If every remaining lead is momentarily collided, still continue with the
      // next pending one — never strand the rep / falsely "complete" the session.
      // Avoiding the same person twice is best-effort, not a hard stop.
      if (!next) {
        [next] = await tx
          .select()
          .from(dialerQueueItems)
          .where(and(eq(dialerQueueItems.sessionId, s.id), eq(dialerQueueItems.status, "pending")))
          .orderBy(asc(dialerQueueItems.position))
          .limit(1);
      }
      if (next) {
        await tx
          .update(dialerQueueItems)
          .set({ status: "in_progress" })
          .where(eq(dialerQueueItems.id, next.id));
      }

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

      const [next] = await tx
        .select()
        .from(dialerQueueItems)
        .where(and(eq(dialerQueueItems.sessionId, s.id), eq(dialerQueueItems.status, "pending")))
        .orderBy(asc(dialerQueueItems.position))
        .limit(1);
      if (next) {
        await tx
          .update(dialerQueueItems)
          .set({ status: "in_progress" })
          .where(eq(dialerQueueItems.id, next.id));
      }
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
      // Find the most recently-completed item
      const [prev] = await tx
        .select()
        .from(dialerQueueItems)
        .where(
          and(
            eq(dialerQueueItems.sessionId, s.id),
            sql`${dialerQueueItems.status} IN ('completed', 'skipped')`,
          ),
        )
        .orderBy(desc(dialerQueueItems.position))
        .limit(1);
      if (!prev) throw new ApiError(400, "No completed item to back to");

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
      // Re-open the previous item.
      await tx
        .update(dialerQueueItems)
        .set({
          status: "in_progress",
          dispositionId: null,
          callRecordId: null,
          notes: null,
          calledAt: null,
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
