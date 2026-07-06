import { Router, Request, Response, NextFunction } from "express";
import { eq, and, or, inArray, isNull, sql, count, asc } from "drizzle-orm";
import { db } from "../db/index";
import { funnels, funnelSteps, funnelMembers } from "../db/schema/funnels";
import { funnelTags, funnelTagAssignments } from "../db/schema/funnel-tags";
import { callRecords } from "../db/schema/call-records";
import { users } from "../db/schema/organizations";
import { leads, leadEvents } from "../db/schema/leads";
import { scraperSignals } from "../db/schema/scrapers";
import { masterCompanies, masterContacts } from "../db/schema/master";
import { imports } from "../db/schema/imports";
import { dialerSessions } from "../db/schema/dialer";

/** Free email providers — never used as a company domain. */
const FREE_EMAIL_DOMAINS = new Set([
  "gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "icloud.com",
  "aol.com", "proton.me", "protonmail.com", "gmx.com", "live.com", "msn.com",
  "me.com", "mac.com", "yandex.com", "zoho.com",
]);

function normalizeDomain(value: string): string {
  let d = (value || "").trim().toLowerCase();
  if (!d) return "";
  d = d.replace(/^https?:\/\//, "").replace(/^www\./, "");
  d = d.split("/")[0].split("?")[0].split("@").pop() || "";
  return d;
}
function domainFromEmail(email: string): string {
  const d = (email.split("@")[1] || "").toLowerCase();
  return d && !FREE_EMAIL_DOMAINS.has(d) ? d : "";
}
/** Best-effort readable name from an email's local part when no name column is
 *  mapped (e.g. "john.smith@acme.com" → "John Smith"). A placeholder until
 *  person-level enrichment fills the real name; returns "" if not sensible. */
function nameFromEmail(email: string): string {
  const local = (email.split("@")[0] || "").trim();
  if (!local) return "";
  const parts = local
    .replace(/\+.*$/, "") // drop +tags
    .split(/[._-]+/)
    .filter((p) => /[a-z]/i.test(p)); // ignore pure-number segments
  if (parts.length === 0) return "";
  return parts
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
    .join(" ");
}
/** Readable company name from a domain ("digital-dust.co.uk" → "Digital Dust").
 *  Used as a placeholder before enrichment and as the fallback when enrichment
 *  can't resolve the company. */
function companyFromDomain(domain: string): string {
  const sld = normalizeDomain(domain).split(".")[0] || "";
  if (!sld) return "";
  return sld
    .split(/[-_]+/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
    .join(" ");
}
import {
  ApiError,
  createId,
  normalizeString,
  clamp,
  scoreLead,
  ALLOWED_CHANNELS,
  ALLOWED_STATUSES,
  ALLOWED_SOURCE_TYPES,
  TERMINAL_STATUSES,
  DAY_MS,
  mappedValue,
  dedupeKey,
  resolveAction,
  formatPct,
  sourceLabel,
  type MappingEntry,
} from "../lib/helpers";
import { getAuth } from "@clerk/express";
import { getPerms, requirePerm } from "../lib/permission-service";
import { scopeOf } from "../lib/permission-catalog";
import { getBalance, deductCredits, InsufficientCreditsError, CREDIT_COSTS } from "../lib/credits";
import {
  buildFunnelPayload,
  computeNextStepSchedule,
  sortLeadsForQueue,
  type Funnel,
  type Lead,
  type Step,
} from "../lib/funnel-service";
import { SmartleadClient, type SmartleadSequence } from "../lib/smartlead-client";
import { pushLeadsToSmartlead } from "../lib/smartlead-sync";
import { resolvePerson, resolvePersonsBulk } from "../lib/person-resolve";
import { getSetting, getSmartleadApiKey } from "../lib/settings-service";
import { getMergedLeadStatuses } from "../lib/lead-status-config";
import { getCustomFieldsForLeads, setLeadCustomFields, setLeadCustomFieldsBatch, ensureFieldDefinition } from "../lib/custom-fields-service";
import { createTtlCache } from "../lib/ttl-cache";
import { fireTrigger } from "../services/workflow-engine";
import { getOrgId } from "../lib/auth";
import { flagDoNotCall } from "../lib/dnc";
import { TheirStackClient, type TheirStackJob, type TheirStackCompanyRecord } from "../lib/theirstack-client";
import { leadHiringRoles } from "../db/schema/hiring-roles";
import { upsertMasterContact, resolveCompanyForLead } from "../lib/master-db";

const router = Router();

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

interface FunnelParams {
  funnelId: string;
}

interface LeadAdvanceParams {
  funnelId: string;
  leadId: string;
}

/** Load a funnel with steps + leads from the DB.
 *  `withEvents: false` (lite) skips the heavy per-lead events + custom-field
 *  joins so a campaign with thousands of leads loads fast; `fullLeadId` then
 *  pulls events + custom fields for just the currently-viewed lead. */
async function loadFunnel(
  orgId: string,
  funnelId: string,
  opts: { withEvents?: boolean; fullLeadId?: string | null } = {},
): Promise<Funnel | null> {
  const withEvents = opts.withEvents !== false;
  const fullLeadId = opts.fullLeadId ?? null;

  const result = await db.query.funnels.findFirst({
    where: and(eq(funnels.id, funnelId), eq(funnels.organizationId, orgId)),
    with: {
      steps: { orderBy: (s, { asc }) => [asc(s.sortOrder)] },
      leads: withEvents
        ? { with: { events: { orderBy: (e, { asc }) => [asc(e.timestamp)] } } }
        : true,
    },
  });

  if (!result) return null;

  // Lazily mint a webhook token for funnels created before this feature.
  let webhookToken = result.webhookToken;
  if (!webhookToken) {
    webhookToken = createId("whk");
    await db.update(funnels).set({ webhookToken }).where(eq(funnels.id, result.id));
  }

  // Everything below depends only on `result` — run it in ONE round of
  // parallel queries. NOTE: per-lead call/email activity counts are NOT
  // computed here anymore — they required org-wide scans on every load and
  // now live behind GET /funnels/:funnelId/activity-counts (deferred, cached);
  // the payload ships callCount/emailCount = 0 with `countsDeferred: true`.
  type EventRow = { id: string; leadId: string; type: string; outcome: string | null; stepIndex: number; meta: Record<string, unknown> | null; timestamp: Date };

  // Events for the focused lead — and every other contact of the SAME COMPANY —
  // when this is a lite load. The lead profile shows one company with all its
  // contacts, so its activity timeline aggregates the whole company's history.
  const loadFocusedEvents = async (): Promise<EventRow[]> => {
    if (withEvents || !fullLeadId) return [];
    const focusLead = result.leads.find((l) => l.id === fullLeadId);
    const companyKey = (focusLead?.company || "").trim().toLowerCase();
    const groupIds = companyKey
      ? result.leads.filter((l) => (l.company || "").trim().toLowerCase() === companyKey).map((l) => l.id)
      : [fullLeadId];
    return db
      .select()
      .from(leadEvents)
      .where(inArray(leadEvents.leadId, groupIds))
      .orderBy(asc(leadEvents.timestamp)) as unknown as Promise<EventRow[]>;
  };

  const [customFieldsByLead, focusedEventRows] = await Promise.all([
    // Custom fields for ALL leads (incl. lite) so the leads list / Smart Views
    // can filter on them. Returns empty cheaply for orgs with no custom fields.
    getCustomFieldsForLeads(result.leads.map((l) => l.id)),
    loadFocusedEvents(),
  ]);

  const focusedEvents = new Map<string, EventRow[]>();
  for (const e of focusedEventRows) {
    const arr = focusedEvents.get(e.leadId);
    if (arr) arr.push(e);
    else focusedEvents.set(e.leadId, [e]);
  }

  return {
    id: result.id,
    name: result.name,
    description: result.description,
    status: result.status,
    visibility: result.visibility,
    config: result.config || {},
    sourceTypes: result.sourceTypes,
    smartleadCampaignId: result.smartleadCampaignId,
    webhookToken,
    webhookEnabled: result.webhookEnabled,
    webhookFieldMap: result.webhookFieldMap || {},
    createdAt: result.createdAt,
    steps: result.steps.map((s) => ({
      id: s.id,
      channel: s.channel,
      label: s.label,
      dayOffset: s.dayOffset,
      sortOrder: s.sortOrder,
      subject: s.subject,
      emailBody: s.emailBody,
      action: s.action,
    })),
    leads: result.leads.map((l) => ({
      id: l.id,
      name: l.name,
      firstName: l.firstName,
      lastName: l.lastName,
      title: l.title,
      company: l.company,
      email: l.email,
      phone: l.phone,
      extraEmails: l.extraEmails ?? [],
      extraPhones: l.extraPhones ?? [],
      linkedinUrl: l.linkedinUrl,
      currentStep: l.currentStep,
      totalSteps: l.totalSteps,
      status: l.status,
      nextAction: l.nextAction,
      nextDate: l.nextDate,
      source: l.source,
      sourceType: l.sourceType,
      score: l.score,
      smartleadLeadId: l.smartleadLeadId,
      unipileProviderId: l.unipileProviderId,
      companyDomain: l.companyDomain,
      companyIndustry: l.companyIndustry,
      companyEmployeeCount: l.companyEmployeeCount,
      companyLocation: l.companyLocation,
      companyDescription: l.companyDescription,
      companyLinkedin: l.companyLinkedin,
      companyAnnualRevenue: l.companyAnnualRevenue,
      companyHiringRoles: l.companyHiringRoles,
      doNotCall: l.doNotCall,
      opportunityId: l.opportunityId,
      notes: l.notes,
      customFields: customFieldsByLead.get(l.id) ?? [],
      createdAt: l.createdAt,
      updatedAt: l.updatedAt,
      events: (withEvents ? ((l as { events?: EventRow[] }).events ?? []) : (focusedEvents.get(l.id) ?? [])).map((e) => ({
        id: e.id,
        type: e.type,
        outcome: e.outcome,
        stepIndex: e.stepIndex,
        meta: e.meta,
        timestamp: e.timestamp,
      })),
    })),
  };
}

function getFunnelOrThrow(funnel: Funnel | null, funnelId: string): Funnel {
  if (!funnel) {
    throw new ApiError(404, "Funnel not found");
  }
  return funnel;
}

// ─── Health ──────────────────────────────────────────────────────────────

router.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "leadey-funnels-api",
    timestamp: new Date().toISOString(),
  });
});

// ─── GET /funnels ────────────────────────────────────────────────────────

router.get(
  "/funnels",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);

    // The campaigns list only needs lightweight per-campaign summaries. Loading
    // every lead (and its full event history) for every campaign just to count
    // them was the source of the slow load on big campaigns — instead we load
    // funnels + steps and derive metrics/sources from grouped COUNT queries.
    const funnelRows = await db.query.funnels.findMany({
      where: eq(funnels.organizationId, orgId),
      with: { steps: { orderBy: (s, { asc }) => [asc(s.sortOrder)] } },
    });

    const ids = funnelRows.map((f) => f.id);
    type StatusRow = { funnelId: string; status: string; n: number };
    type SourceRow = { funnelId: string; sourceType: string; n: number };
    let statusRows: StatusRow[] = [];
    let sourceRows: SourceRow[] = [];
    let memberRows: { funnelId: string; userId: string; role: string; createdAt: Date }[] = [];
    let tagRows: { funnelId: string; id: string; name: string; color: string; sortOrder: number }[] = [];

    if (ids.length > 0) {
      statusRows = await db
        .select({ funnelId: leads.funnelId, status: leads.status, n: count() })
        .from(leads)
        .where(inArray(leads.funnelId, ids))
        .groupBy(leads.funnelId, leads.status);
      sourceRows = await db
        .select({ funnelId: leads.funnelId, sourceType: leads.sourceType, n: count() })
        .from(leads)
        .where(inArray(leads.funnelId, ids))
        .groupBy(leads.funnelId, leads.sourceType);
      memberRows = await db
        .select()
        .from(funnelMembers)
        .where(inArray(funnelMembers.funnelId, ids));
      tagRows = await db
        .select({
          funnelId: funnelTagAssignments.funnelId,
          id: funnelTags.id,
          name: funnelTags.name,
          color: funnelTags.color,
          sortOrder: funnelTags.sortOrder,
        })
        .from(funnelTagAssignments)
        .innerJoin(funnelTags, eq(funnelTagAssignments.tagId, funnelTags.id))
        .where(inArray(funnelTagAssignments.funnelId, ids));
    }

    // Index the count rows by funnel.
    const statusByFunnel = new Map<string, Record<string, number>>();
    for (const r of statusRows) {
      const m = statusByFunnel.get(r.funnelId) ?? {};
      m[r.status] = r.n;
      statusByFunnel.set(r.funnelId, m);
    }
    const sourceByFunnel = new Map<string, Record<string, number>>();
    for (const r of sourceRows) {
      const m = sourceByFunnel.get(r.funnelId) ?? {};
      m[r.sourceType] = r.n;
      sourceByFunnel.set(r.funnelId, m);
    }
    const membersByFunnel = new Map<string, { teamMemberId: string; role: string; addedAt: string }[]>();
    for (const m of memberRows) {
      const list = membersByFunnel.get(m.funnelId) ?? [];
      list.push({ teamMemberId: m.userId, role: m.role, addedAt: m.createdAt.toISOString() });
      membersByFunnel.set(m.funnelId, list);
    }
    const tagsByFunnel = new Map<string, { id: string; name: string; color: string }[]>();
    for (const t of tagRows.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))) {
      const list = tagsByFunnel.get(t.funnelId) ?? [];
      list.push({ id: t.id, name: t.name, color: t.color });
      tagsByFunnel.set(t.funnelId, list);
    }

    const webhookBase = (process.env.WEBHOOK_BASE_URL || "").replace(/\/$/, "");

    const data = funnelRows.map((f) => {
      const byStatus = statusByFunnel.get(f.id) ?? {};
      const total = Object.values(byStatus).reduce((a, n) => a + n, 0);
      const replied = byStatus["replied"] ?? 0;
      const bounced = byStatus["bounced"] ?? 0;
      const completed = byStatus["completed"] ?? 0;
      const terminal = Object.entries(byStatus).reduce(
        (a, [st, n]) => a + (TERMINAL_STATUSES.has(st) ? n : 0),
        0,
      );

      const bySource = sourceByFunnel.get(f.id) ?? {};
      const sources = [...ALLOWED_SOURCE_TYPES]
        .filter((t) => (bySource[t] ?? 0) > 0)
        .map((t) => ({ type: t, label: sourceLabel(t), count: bySource[t] }));

      return {
        id: f.id,
        name: f.name,
        description: f.description,
        status: f.status,
        visibility: f.visibility,
        config: f.config || {},
        steps: f.steps.map((s) => ({
          id: s.id,
          channel: s.channel,
          label: s.label,
          dayOffset: s.dayOffset,
          subject: s.subject,
          emailBody: s.emailBody,
          action: s.action,
        })),
        metrics: {
          total,
          active: total - terminal,
          replied,
          replyRate: formatPct(replied, total),
          bounced,
          completed,
        },
        sources,
        members: membersByFunnel.get(f.id) ?? [],
        tags: tagsByFunnel.get(f.id) ?? [],
        webhookToken: f.webhookToken,
        webhookEnabled: f.webhookEnabled,
        webhookFieldMap: f.webhookFieldMap || {},
        webhookUrl: f.webhookToken && webhookBase ? `${webhookBase}/webhooks/funnels/${f.id}/leads?token=${f.webhookToken}` : null,
        createdAt: f.createdAt.toISOString(),
      };
    });

    // Visibility gate driven by campaigns.access: "all" → everything;
    // "assigned" → public campaigns + private ones they're a member of;
    // "none" → nothing.
    const auth = getAuth(req);
    const perms = await getPerms(req);
    const access = scopeOf(perms.permissions, "campaigns.access");
    const myFunnelIds = new Set(
      memberRows.filter((m) => m.userId === auth?.userId).map((m) => m.funnelId),
    );
    const visible = access === "all"
      ? data
      : access === "none"
        ? []
        : data.filter((f) => f.visibility === "public" || myFunnelIds.has(f.id));

    res.json({ data: visible });
  }),
);

// ─── GET /funnels/:funnelId/activity-counts ──────────────────────────────
// Per-lead call/email totals for the leads table, DEFERRED out of the main
// funnel payload: these reflect TOTAL contact across the whole org (the same
// person can be enrolled in several campaigns), which used to require three
// org-wide table scans on every campaign open. Here the queries are scoped to
// this funnel's phone/email keys (index-backed) and cached for 60s per org+
// funnel — the table paints instantly and badges fill in right after.
const activityCountsCache = createTtlCache<Record<string, { calls: number; emails: number }>>(60_000);

router.get(
  "/funnels/:funnelId/activity-counts",
  asyncHandler<FunnelParams>(async (req, res) => {
    const orgId = getOrgId(req);
    const funnelId = req.params.funnelId;
    const cacheKey = `${orgId}:${funnelId}`;
    const cached = activityCountsCache.get(cacheKey);
    if (cached) {
      res.json({ data: { counts: cached } });
      return;
    }

    const [funnelRow] = await db
      .select({ id: funnels.id })
      .from(funnels)
      .where(and(eq(funnels.id, funnelId), eq(funnels.organizationId, orgId)))
      .limit(1);
    if (!funnelRow) throw new ApiError(404, "Funnel not found");

    const funnelLeads = await db
      .select({ id: leads.id, phone: leads.phone, email: leads.email })
      .from(leads)
      .where(eq(leads.funnelId, funnelId));

    const normPhone = (p: string | null | undefined) => (p || "").replace(/[^0-9]/g, "");
    const phoneList = [...new Set(funnelLeads.map((l) => normPhone(l.phone)).filter((p) => p.length > 5))];
    const emailList = [...new Set(funnelLeads.map((l) => (l.email || "").toLowerCase()).filter(Boolean))];

    // The CASE-combined counterparty expression matches no index, so query the
    // two directions separately — each arm rides its own (org, digits)
    // expression index — and sum them.
    const toDigits = sql`regexp_replace(${callRecords.toNumber}, '[^0-9]', '', 'g')`;
    const fromDigits = sql`regexp_replace(${callRecords.fromNumber}, '[^0-9]', '', 'g')`;
    const leadPhoneDigits = sql`regexp_replace(${leads.phone}, '[^0-9]', '', 'g')`;
    const leadEmailLower = sql`lower(${leads.email})`;

    const [outRows, inRows, siblingRows] = await Promise.all([
      phoneList.length
        ? db
            .select({ phone: sql<string>`${toDigits}`, n: sql<number>`count(*)::int` })
            .from(callRecords)
            .where(and(
              eq(callRecords.organizationId, orgId),
              eq(callRecords.direction, "outbound"),
              inArray(toDigits, phoneList),
            ))
            .groupBy(toDigits)
        : Promise.resolve([] as { phone: string; n: number }[]),
      phoneList.length
        ? db
            .select({ phone: sql<string>`${fromDigits}`, n: sql<number>`count(*)::int` })
            .from(callRecords)
            .where(and(
              eq(callRecords.organizationId, orgId),
              sql`${callRecords.direction} <> 'outbound'`,
              inArray(fromDigits, phoneList),
            ))
            .groupBy(fromDigits)
        : Promise.resolve([] as { phone: string; n: number }[]),
      // Every org lead representing the same people (probed by the normalized
      // phone/email expression indexes) — their events carry the history.
      phoneList.length || emailList.length
        ? db
            .select({ id: leads.id, phone: sql<string>`${leadPhoneDigits}`, email: sql<string>`${leadEmailLower}` })
            .from(leads)
            .innerJoin(funnels, eq(leads.funnelId, funnels.id))
            .where(and(
              eq(funnels.organizationId, orgId),
              or(
                phoneList.length ? inArray(leadPhoneDigits, phoneList) : sql`false`,
                emailList.length ? inArray(leadEmailLower, emailList) : sql`false`,
              ),
            ))
        : Promise.resolve([] as { id: string; phone: string; email: string }[]),
    ]);

    // Event buckets for the sibling leads (indexed by lead_id), chunked to
    // keep the parameter count bounded.
    const sibIds = siblingRows.map((r) => r.id);
    const eventRows: { leadId: string; calls: number; emails: number }[] = [];
    for (let i = 0; i < sibIds.length; i += 5000) {
      const chunk = sibIds.slice(i, i + 5000);
      eventRows.push(
        ...(await db
          .select({
            leadId: leadEvents.leadId,
            calls: sql<number>`count(*) filter (where ${leadEvents.type} = 'call' OR (${leadEvents.type} = 'step_outcome' AND ${leadEvents.meta} ->> 'channel' = 'call') OR ${leadEvents.outcome} = 'call_completed')::int`,
            emails: sql<number>`count(*) filter (where ${leadEvents.type} IN ('smartlead_webhook','email_sent','reply_handled') OR (${leadEvents.type} = 'step_outcome' AND ${leadEvents.meta} ->> 'channel' = 'email'))::int`,
          })
          .from(leadEvents)
          .where(inArray(leadEvents.leadId, chunk))
          .groupBy(leadEvents.leadId)),
      );
    }

    // Same merge semantics as the old in-payload counters: calls = MAX of the
    // telephony log and logged call events (never under-count); emails from
    // events only.
    const callsByPhone = new Map<string, number>();
    for (const r of [...outRows, ...inRows]) {
      if (r.phone) callsByPhone.set(r.phone, (callsByPhone.get(r.phone) ?? 0) + Number(r.n));
    }
    const phoneSet = new Set(phoneList);
    const emailSet = new Set(emailList);
    const evByLead = new Map(eventRows.map((r) => [r.leadId, r]));
    const evCallsByPhone = new Map<string, number>();
    const evEmailsByAddr = new Map<string, number>();
    for (const s of siblingRows) {
      const ev = evByLead.get(s.id);
      if (!ev) continue;
      if (s.phone && phoneSet.has(s.phone)) {
        evCallsByPhone.set(s.phone, (evCallsByPhone.get(s.phone) ?? 0) + ev.calls);
      }
      if (s.email && emailSet.has(s.email)) {
        evEmailsByAddr.set(s.email, (evEmailsByAddr.get(s.email) ?? 0) + ev.emails);
      }
    }

    const counts: Record<string, { calls: number; emails: number }> = {};
    for (const l of funnelLeads) {
      const p = normPhone(l.phone);
      const e = (l.email || "").toLowerCase();
      const calls = Math.max(callsByPhone.get(p) ?? 0, evCallsByPhone.get(p) ?? 0);
      const emails = evEmailsByAddr.get(e) ?? 0;
      if (calls || emails) counts[l.id] = { calls, emails };
    }

    activityCountsCache.set(cacheKey, counts);
    res.json({ data: { counts } });
  }),
);

// ─── GET /funnels/:funnelId ──────────────────────────────────────────────

router.get(
  "/funnels/:funnelId",
  asyncHandler<FunnelParams>(async (req, res) => {
    const orgId = getOrgId(req);
    // Lite load: skip the heavy per-lead events/custom-field/description fields
    // for every lead except the one being viewed (`fullLeadId`). Big speed-up
    // for campaigns with thousands of leads.
    const lite = req.query.lite === "1" || req.query.lite === "true";
    const fullLeadId = typeof req.query.fullLeadId === "string" ? req.query.fullLeadId : null;

    // The funnel load, members list and caller role are independent — one
    // parallel round instead of three serial round trips.
    const auth = getAuth(req as unknown as Request);
    const [loadedFunnel, members, perms] = await Promise.all([
      loadFunnel(orgId, req.params.funnelId, { withEvents: !lite, fullLeadId }),
      db.select().from(funnelMembers).where(eq(funnelMembers.funnelId, req.params.funnelId)),
      getPerms(req as unknown as Request),
    ]);
    const funnel = getFunnelOrThrow(loadedFunnel, req.params.funnelId);

    // Visibility gate driven by campaigns.access.
    const access = scopeOf(perms.permissions, "campaigns.access");
    let canView = access === "all" || funnel.visibility === "public";
    if (!canView && access === "assigned") {
      canView = !!auth?.userId && members.some((m) => m.userId === auth.userId);
      // Working a campaign in the power dialer grants access even when Private
      // (sessions can now only be created for permitted funnels — see dialer.ts).
      if (!canView && auth?.userId) {
        const [sess] = await db
          .select({ id: dialerSessions.id })
          .from(dialerSessions)
          .where(and(eq(dialerSessions.userId, auth.userId), eq(dialerSessions.funnelId, req.params.funnelId)))
          .limit(1);
        if (sess) canView = true;
      }
    }
    if (!canView) {
      throw new ApiError(403, "You do not have access to this campaign");
    }
    // One batched lookup instead of a query per member.
    const memberUsers = members.length
      ? await db.select().from(users).where(inArray(users.id, members.map((m) => m.userId)))
      : [];
    const userById = new Map(memberUsers.map((u) => [u.id, u]));
    const memberData = members.map((m) => {
      const user = userById.get(m.userId);
      return {
        teamMemberId: m.userId,
        role: m.role,
        addedAt: m.createdAt.toISOString(),
        email: user?.email || "",
        firstName: user?.firstName || null,
        lastName: user?.lastName || null,
      };
    });
    const payload = buildFunnelPayload(funnel, { includeLeads: true, lite, fullLeadId }) as any;
    payload.members = memberData;
    // Per-lead call/email counts ship as zeros — the client fetches them from
    // GET /funnels/:id/activity-counts and fills the badges in after paint.
    payload.countsDeferred = true;
    res.json({ data: payload });
  }),
);

// ─── GET /funnels/:funnelId/leads ────────────────────────────────────────

router.get(
  "/funnels/:funnelId/leads",
  asyncHandler<FunnelParams>(async (req, res) => {
    const orgId = getOrgId(req);
    const funnel = getFunnelOrThrow(
      await loadFunnel(orgId, req.params.funnelId),
      req.params.funnelId,
    );
    const sorted = sortLeadsForQueue(funnel.leads);
    res.json({
      data: sorted.map((l) => ({
        id: l.id,
        name: l.name,
        title: l.title,
        company: l.company,
        email: l.email,
        phone: l.phone,
        extraEmails: l.extraEmails ?? [],
        extraPhones: l.extraPhones ?? [],
        linkedinUrl: l.linkedinUrl,
        currentStep: l.currentStep,
        totalSteps: l.totalSteps,
        status: l.status,
        nextAction: l.nextAction,
        nextDate: l.nextDate?.toISOString() ?? null,
        source: l.source,
        sourceType: l.sourceType,
        score: l.score,
        notes: l.notes,
        createdAt: l.createdAt.toISOString(),
        updatedAt: l.updatedAt.toISOString(),
        events: l.events.map((e) => ({
          id: e.id,
          type: e.type,
          outcome: e.outcome,
          stepIndex: e.stepIndex,
          meta: e.meta,
          timestamp: e.timestamp.toISOString(),
        })),
      })),
    });
  }),
);

// ─── POST /funnels ───────────────────────────────────────────────────────

router.post(
  "/funnels",
  requirePerm("campaigns.create"),
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const { name, description, status, steps, sourceTypes, visibility, audience, exit, emailAutomation, members } = req.body || {};

    if (!normalizeString(name)) {
      throw new ApiError(400, "Funnel name is required");
    }

    // Sequence steps are OPTIONAL. A campaign with no steps is a manual
    // campaign: leads stay in "pending", are worked via calls/statuses, and
    // are never auto-advanced or auto-completed by a sequence.
    const stepsInput: Array<{ channel?: string; label?: string; dayOffset?: number; subject?: string; emailBody?: string; action?: string }> =
      Array.isArray(steps) ? steps : [];

    const normalizedSteps = stepsInput
      .map(
        (
          step: { channel?: string; label?: string; dayOffset?: number; subject?: string; emailBody?: string; action?: string },
          index: number,
        ) => {
          const channel = normalizeString(step.channel).toLowerCase();
          const label = normalizeString(step.label) || `Step ${index + 1}`;
          const dayOffset = Number(step.dayOffset);
          const subject = normalizeString(step.subject) || null;
          const emailBody = normalizeString(step.emailBody) || null;
          const action = resolveAction(channel, step.action || null);

          if (!ALLOWED_CHANNELS.has(channel)) {
            throw new ApiError(400, `Invalid channel for step ${index + 1}`);
          }

          if (!Number.isFinite(dayOffset) || dayOffset < 0) {
            throw new ApiError(400, `Invalid dayOffset for step ${index + 1}`);
          }

          return { id: createId("step"), channel, label, dayOffset, subject, emailBody, action };
        },
      )
      .sort(
        (a: { dayOffset: number }, b: { dayOffset: number }) =>
          a.dayOffset - b.dayOffset,
      );

    const normalizedStatus =
      normalizeString(status).toLowerCase() || "draft";
    if (!ALLOWED_STATUSES.has(normalizedStatus)) {
      throw new ApiError(400, "Invalid funnel status");
    }

    const normalizedSourceTypes = Array.isArray(sourceTypes)
      ? sourceTypes
          .map((st: string) => normalizeString(st).toLowerCase())
          .filter((st: string) => ALLOWED_SOURCE_TYPES.has(st))
      : [];

    const normalizedVisibility =
      normalizeString(visibility).toLowerCase() === "public" ? "public" : "private";

    // Campaign builder settings that live in the `config` jsonb. Stored as-is so
    // the full wizard setup round-trips; the runtime engines read these later.
    const config: Record<string, unknown> = {};
    if (audience && typeof audience === "object") config.audience = audience;
    if (exit && typeof exit === "object") config.exit = exit;
    if (emailAutomation && typeof emailAutomation === "object") config.emailAutomation = emailAutomation;

    const funnelId = createId("funnel");
    const now = new Date();

    await db.transaction(async (tx) => {
      await tx.insert(funnels).values({
        id: funnelId,
        organizationId: orgId,
        name: normalizeString(name),
        description: normalizeString(description),
        status: normalizedStatus,
        visibility: normalizedVisibility,
        config,
        sourceTypes: normalizedSourceTypes,
        webhookToken: createId("whk"),
        createdAt: now,
      });

      if (normalizedSteps.length > 0) {
        await tx.insert(funnelSteps).values(
          normalizedSteps.map(
            (
              step: {
                id: string;
                channel: string;
                label: string;
                dayOffset: number;
                subject: string | null;
                emailBody: string | null;
                action: string;
              },
              index: number,
            ) => ({
              id: step.id,
              funnelId,
              channel: step.channel,
              label: step.label,
              dayOffset: step.dayOffset,
              sortOrder: index,
              subject: step.subject,
              emailBody: step.emailBody,
              action: step.action,
            }),
          ),
        );
      }
    });

    // Auto-assign creator as funnel owner
    const auth = getAuth(req);
    if (auth?.userId) {
      await db.insert(funnelMembers).values({
        id: createId("fm"),
        funnelId,
        userId: auth.userId,
        role: "owner",
      }).onConflictDoNothing();
    }

    // Assign any additional members chosen in the wizard as contributors
    // (the creator/owner is skipped — they're already the owner above).
    if (Array.isArray(members) && members.length > 0) {
      const extraIds = [
        ...new Set(
          members
            .map((m: unknown) => (typeof m === "string" ? m : normalizeString((m as { userId?: string })?.userId)))
            .filter((id: string) => id && id !== auth?.userId),
        ),
      ];
      if (extraIds.length > 0) {
        await db
          .insert(funnelMembers)
          .values(
            extraIds.map((userId: string) => ({
              id: createId("fm"),
              funnelId,
              userId,
              role: "contributor",
            })),
          )
          .onConflictDoNothing();
      }
    }

    // Smartlead integration: create campaign if email steps have content
    const emailStepsWithContent = normalizedSteps.filter(
      (s: { channel: string; subject: string | null; emailBody: string | null }) =>
        s.channel === "email" && s.subject && s.emailBody,
    );

    if (emailStepsWithContent.length > 0) {
      try {
        const apiKey = await getSmartleadApiKey(orgId);
        if (apiKey) {
          const client = new SmartleadClient(apiKey);
          const campaign = await client.createCampaign(normalizeString(name));

          // Build sequences from email steps
          const sequences: SmartleadSequence[] = emailStepsWithContent.map(
            (step: { subject: string | null; emailBody: string | null; dayOffset: number }, seqIdx: number) => ({
              seq_number: seqIdx + 1,
              seq_type: "EMAIL",
              seq_delay_details: {
                delay_in_days: seqIdx === 0 ? 0 : step.dayOffset,
              },
              seq_variants: [
                {
                  subject: step.subject!,
                  email_body: step.emailBody!,
                  variant_label: "A",
                  variant_distribution_percentage: 100,
                },
              ],
            }),
          );

          await client.saveSequences(campaign.id, sequences);

          // Store campaign ID on funnel
          await db
            .update(funnels)
            .set({ smartleadCampaignId: String(campaign.id) })
            .where(eq(funnels.id, funnelId));

          // Attach email accounts if configured
          const emailAccountIdsRaw = await getSetting(orgId, "smartlead_email_account_ids");
          if (emailAccountIdsRaw) {
            const emailAccountIds: number[] = JSON.parse(emailAccountIdsRaw);
            if (emailAccountIds.length > 0) {
              await client.addEmailAccountsToCampaign(campaign.id, emailAccountIds);
            }
          }

          // Configure webhook if base URL is set
          const webhookBaseUrl = process.env.WEBHOOK_BASE_URL;
          if (webhookBaseUrl) {
            await client.configureWebhook(
              campaign.id,
              `${webhookBaseUrl.replace(/\/$/, "")}/webhooks/smartlead`,
            );
          }
        }
      } catch (err) {
        console.error("Smartlead campaign creation failed (non-blocking):", err);
      }
    }

    const funnel = await loadFunnel(orgId, funnelId);
    res
      .status(201)
      .json({ data: buildFunnelPayload(funnel!, { includeLeads: true }) });
  }),
);

// ─── PATCH /funnels/:funnelId ─────────────────────────────────────────────

router.patch(
  "/funnels/:funnelId",
  requirePerm("campaigns.edit"),
  asyncHandler<FunnelParams>(async (req, res) => {
    const orgId = getOrgId(req);
    const body = req.body || {};
    const hasStatus = body.status !== undefined;
    const hasName = body.name !== undefined;
    const hasDescription = body.description !== undefined;
    const hasSteps = Array.isArray(body.steps);
    const hasVisibility = body.visibility !== undefined;
    const hasMembers = Array.isArray(body.members);
    const hasConfig =
      body.audience !== undefined ||
      body.exit !== undefined ||
      body.emailAutomation !== undefined ||
      body.leadFilters !== undefined;

    const funnel = getFunnelOrThrow(
      await loadFunnel(orgId, req.params.funnelId),
      req.params.funnelId,
    );

    // Unified update — the create-campaign wizard's "edit" mode can change any
    // of: name, description, status, visibility, sequence steps, builder config
    // (audience / exit / email automation) and the assigned members, in one call.
    const funnelUpdates: Record<string, unknown> = {};

    if (hasName) {
      const name = normalizeString(body.name);
      if (!name) throw new ApiError(400, "Funnel name cannot be empty");
      funnelUpdates.name = name;
    }
    if (hasDescription) {
      funnelUpdates.description = normalizeString(body.description);
    }
    if (hasVisibility) {
      funnelUpdates.visibility =
        normalizeString(body.visibility).toLowerCase() === "public" ? "public" : "private";
    }

    let normalizedStatus = "";
    if (hasStatus) {
      normalizedStatus = normalizeString(body.status).toLowerCase();
      if (!normalizedStatus || !ALLOWED_STATUSES.has(normalizedStatus)) {
        throw new ApiError(400, "Invalid funnel status");
      }
      funnelUpdates.status = normalizedStatus;
    }
    if (hasConfig) {
      const cfg: Record<string, unknown> = { ...(funnel.config || {}) };
      if (body.audience !== undefined) cfg.audience = body.audience;
      if (body.exit !== undefined) cfg.exit = body.exit;
      if (body.emailAutomation !== undefined) cfg.emailAutomation = body.emailAutomation;
      // Shared per-campaign lead filters — persisted so the filtered view is the
      // same for every rep and survives a page refresh.
      if (body.leadFilters !== undefined) cfg.leadFilters = body.leadFilters;
      funnelUpdates.config = cfg;
    }

    let normalizedSteps: Array<{
      id: string;
      channel: string;
      label: string;
      dayOffset: number;
      subject: string | null;
      emailBody: string | null;
      action: string;
    }> | null = null;

    if (hasSteps) {
      // An empty steps array is valid — it removes the sequence, turning this
      // into a manual campaign (leads keep their current position/status).
      normalizedSteps = body.steps
        .map(
          (
            step: { channel?: string; label?: string; dayOffset?: number; subject?: string; emailBody?: string; action?: string },
            index: number,
          ) => {
            const channel = normalizeString(step.channel).toLowerCase();
            const label = normalizeString(step.label) || `Step ${index + 1}`;
            const dayOffset = Number(step.dayOffset);
            const subject = normalizeString(step.subject) || null;
            const emailBody = normalizeString(step.emailBody) || null;
            const action = resolveAction(channel, step.action || null);
            if (!ALLOWED_CHANNELS.has(channel)) {
              throw new ApiError(400, `Invalid channel for step ${index + 1}`);
            }
            if (!Number.isFinite(dayOffset) || dayOffset < 0) {
              throw new ApiError(400, `Invalid dayOffset for step ${index + 1}`);
            }
            return { id: createId("step"), channel, label, dayOffset, subject, emailBody, action };
          },
        )
        .sort((a: { dayOffset: number }, b: { dayOffset: number }) => a.dayOffset - b.dayOffset);
    }

    if (
      Object.keys(funnelUpdates).length === 0 &&
      !normalizedSteps &&
      !hasMembers
    ) {
      throw new ApiError(400, "Nothing to update");
    }

    // Resolve the owner so member sync never drops the campaign owner.
    const auth = getAuth(req as unknown as Request);

    await db.transaction(async (tx) => {
      if (Object.keys(funnelUpdates).length > 0) {
        await tx.update(funnels).set(funnelUpdates).where(eq(funnels.id, funnel.id));
      }

      if (normalizedSteps) {
        // Replace the step set, then clamp every lead's progress to the new
        // length so currentStep can't point past the end of the sequence.
        // An empty set removes the sequence entirely (drizzle's values()
        // rejects an empty array, so only insert when there are steps).
        await tx.delete(funnelSteps).where(eq(funnelSteps.funnelId, funnel.id));
        if (normalizedSteps.length > 0) {
          await tx.insert(funnelSteps).values(
            normalizedSteps.map((step, index) => ({
              id: step.id,
              funnelId: funnel.id,
              channel: step.channel,
              label: step.label,
              dayOffset: step.dayOffset,
              sortOrder: index,
              subject: step.subject,
              emailBody: step.emailBody,
              action: step.action,
            })),
          );
        }
        const newLen = normalizedSteps.length;
        // currentStep is 1-based — keep it at ≥1 even for sequence-less
        // campaigns so the row stays consistent with freshly-added leads.
        await tx
          .update(leads)
          .set({
            totalSteps: newLen,
            currentStep: sql`GREATEST(LEAST(${leads.currentStep}, ${newLen}), 1)`,
            updatedAt: new Date(),
          })
          .where(eq(leads.funnelId, funnel.id));
      }

      // Sync assigned members to exactly `body.members` (contributors), while
      // never touching the owner row.
      if (hasMembers) {
        const desired = new Set(
          (body.members as unknown[])
            .map((m) => (typeof m === "string" ? m : normalizeString((m as { userId?: string })?.userId)))
            .filter((id: string) => !!id),
        );
        const existing = await tx
          .select()
          .from(funnelMembers)
          .where(eq(funnelMembers.funnelId, funnel.id));
        const ownerIds = new Set(existing.filter((m) => m.role === "owner").map((m) => m.userId));
        const existingIds = new Set(existing.map((m) => m.userId));

        const toRemove = existing
          .filter((m) => m.role !== "owner" && !desired.has(m.userId))
          .map((m) => m.userId);
        if (toRemove.length > 0) {
          await tx
            .delete(funnelMembers)
            .where(and(eq(funnelMembers.funnelId, funnel.id), inArray(funnelMembers.userId, toRemove)));
        }

        const toAdd = [...desired].filter(
          (id) => !existingIds.has(id) && !ownerIds.has(id) && id !== auth?.userId,
        );
        if (toAdd.length > 0) {
          await tx
            .insert(funnelMembers)
            .values(
              toAdd.map((userId) => ({
                id: createId("fm"),
                funnelId: funnel.id,
                userId,
                role: "contributor",
              })),
            )
            .onConflictDoNothing();
        }
      }
    });

    // Sync campaign status with Smartlead when it changed.
    if (hasStatus && funnel.smartleadCampaignId) {
      try {
        const apiKey = await getSmartleadApiKey(orgId);
        if (apiKey) {
          const client = new SmartleadClient(apiKey);
          const campaignId = Number(funnel.smartleadCampaignId);
          if (normalizedStatus === "active") {
            await client.setCampaignStatus(campaignId, "START");
          } else if (normalizedStatus === "paused") {
            await client.setCampaignStatus(campaignId, "PAUSED");
          }
        }
      } catch (err) {
        console.error("Smartlead campaign status sync failed (non-blocking):", err);
      }
    }

    const reloaded = await loadFunnel(orgId, req.params.funnelId);
    const payload = buildFunnelPayload(reloaded!, { includeLeads: true }) as Record<string, unknown>;
    const memberRows = await db
      .select()
      .from(funnelMembers)
      .where(eq(funnelMembers.funnelId, funnel.id));
    payload.members = memberRows.map((m) => ({
      teamMemberId: m.userId,
      role: m.role,
      addedAt: m.createdAt.toISOString(),
    }));
    res.json({ data: payload });
  }),
);

// ─── PATCH /funnels/:funnelId/webhook ────────────────────────────────────
// Manage the inbound lead-ingestion webhook: enable/disable, rotate the
// secret token, and update the payload→field mapping.

router.patch(
  "/funnels/:funnelId/webhook",
  requirePerm("campaigns.edit"),
  asyncHandler<FunnelParams>(async (req, res) => {
    const orgId = getOrgId(req);
    const funnel = getFunnelOrThrow(
      await loadFunnel(orgId, req.params.funnelId),
      req.params.funnelId,
    );

    const { enabled, rotateToken, fieldMap } = req.body || {};
    const patch: Partial<typeof funnels.$inferInsert> = {};

    if (typeof enabled === "boolean") {
      patch.webhookEnabled = enabled;
    }

    if (rotateToken === true) {
      patch.webhookToken = createId("whk");
    }

    if (fieldMap && typeof fieldMap === "object" && !Array.isArray(fieldMap)) {
      // Sanitise: keep only string→string entries.
      const clean: Record<string, string> = {};
      for (const [key, value] of Object.entries(fieldMap)) {
        const k = normalizeString(key);
        const v = normalizeString(value);
        if (k && v) clean[k] = v;
      }
      patch.webhookFieldMap = clean;
      // Auto-create any mapped custom field so it's usable immediately (shows in
      // Settings + lead profiles) without a separate Settings trip.
      await Promise.all(
        Object.values(clean)
          .filter((t) => t.startsWith("custom:"))
          .map((t) => ensureFieldDefinition(orgId, t.slice("custom:".length))),
      );
    }

    if (Object.keys(patch).length > 0) {
      await db.update(funnels).set(patch).where(eq(funnels.id, funnel.id));
    }

    const updated = await loadFunnel(orgId, req.params.funnelId);
    res.json({ data: buildFunnelPayload(updated!, { includeLeads: false }) });
  }),
);

// ─── DELETE /funnels/:funnelId ────────────────────────────────────────────

router.delete(
  "/funnels/:funnelId",
  requirePerm("campaigns.delete"),
  asyncHandler<FunnelParams>(async (req, res) => {
    const orgId = getOrgId(req);
    const funnel = getFunnelOrThrow(
      await loadFunnel(orgId, req.params.funnelId),
      req.params.funnelId,
    );

    await db.delete(funnels).where(eq(funnels.id, funnel.id));

    res.json({ data: { id: funnel.id, deleted: true } });
  }),
);

// ─── POST /funnels/:funnelId/imports/csv ─────────────────────────────────

router.post(
  "/funnels/:funnelId/imports/csv",
  requirePerm("campaigns.addLeads"),
  asyncHandler<FunnelParams>(async (req, res) => {
    const orgId = getOrgId(req);
    const { fileName, mappings, rows, groupBy: groupByRaw, dryRun, enrichCompanies } = req.body || {};
    // When company enrichment is requested, a row identified only by an email is
    // valid: the lead name falls back to the email and the company to the email
    // domain (a placeholder the enrichment step replaces with the real name).
    const enrichMode = enrichCompanies === true;
    const normalizedFileName = normalizeString(fileName) || "uploaded.csv";
    const groupBy: "domain" | "name" | "linkedin" =
      groupByRaw === "name" || groupByRaw === "linkedin" ? groupByRaw : "domain";

    if (!Array.isArray(mappings) || mappings.length === 0) {
      throw new ApiError(400, "CSV mappings are required");
    }
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new ApiError(400, "CSV rows are required");
    }
    if (rows.length > 10000) {
      throw new ApiError(400, "CSV import limit is 10,000 rows per upload");
    }

    const allMappings: MappingEntry[] = mappings
      .map((entry: { csvColumn?: string; mappedField?: string }) => ({
        csvColumn: normalizeString(entry.csvColumn),
        mappedField: normalizeString(entry.mappedField),
      }))
      .filter((e: MappingEntry) => e.csvColumn && e.mappedField && e.mappedField !== "--- Skip ---");

    const notesMappings = allMappings.filter((e) => e.mappedField === "Notes");
    // Custom field columns map to "custom:<key>" (same convention as webhooks).
    const customMappings = allMappings.filter((e) => e.mappedField.startsWith("custom:"));
    // Standard lead/company columns — everything that isn't Notes or a custom field.
    const fieldMappings = allMappings.filter(
      (e) => e.mappedField !== "Notes" && !e.mappedField.startsWith("custom:"),
    );
    if (fieldMappings.length === 0 && notesMappings.length === 0 && customMappings.length === 0) {
      throw new ApiError(400, "At least one valid field mapping is required");
    }

    const funnel = getFunnelOrThrow(
      await loadFunnel(orgId, req.params.funnelId),
      req.params.funnelId,
    );

    // Resolve a value by any of the accepted field labels (back-compat aware).
    const getField = (row: Record<string, unknown>, labels: string[]): string => {
      for (const m of fieldMappings) {
        if (labels.includes(m.mappedField)) {
          const v = normalizeString(row[m.csvColumn]);
          if (v) return v;
        }
      }
      return "";
    };
    const LBL = {
      name: ["Lead Name", "Name", "Full Name"],
      firstName: ["Lead First Name", "First Name", "Given Name"],
      lastName: ["Lead Last Name", "Last Name", "Surname", "Family Name"],
      email: ["Lead Email", "Email", "Work Email"],
      title: ["Lead Title", "Title", "Job Title"],
      phone: ["Lead Phone", "Phone", "Mobile"],
      linkedin: ["Lead LinkedIn", "LinkedIn URL", "LinkedIn"],
      cName: ["Company Name", "Company"],
      cDomain: ["Company Domain", "Domain", "Website"],
      cLinkedin: ["Company LinkedIn"],
      cIndustry: ["Company Industry", "Industry"],
      cLocation: ["Company Location", "Location"],
      cSize: ["Company Size", "Employees", "Employee Count"],
      cDescription: ["Company Description", "Description", "About"],
      cRevenue: ["Company Annual Revenue", "Annual Revenue", "Revenue"],
      cHiring: ["Company Hiring Roles", "Hiring Roles", "Hiring For", "Open Roles", "Job Titles"],
    };

    // Hiring roles arrive as one delimited cell ("CTO; VP Sales, Account Exec").
    const parseRoles = (raw: string): string[] =>
      raw
        .split(/[;|\n]|,(?![^(]*\))/)
        .map((r) => r.trim())
        .filter(Boolean)
        .slice(0, 50);

    // Existing funnel leads → dedupe.
    const existingKeys = new Set(funnel.leads.map((l) => dedupeKey(l.name, l.company, l.email)));

    // Preload org master companies for "already exists" detection.
    const masterRows = await db
      .select()
      .from(masterCompanies)
      .where(eq(masterCompanies.organizationId, orgId));
    const masterByDomain = new Map<string, (typeof masterRows)[number]>();
    const masterByName = new Map<string, (typeof masterRows)[number]>();
    const masterByLinkedin = new Map<string, (typeof masterRows)[number]>();
    for (const mc of masterRows) {
      if (mc.domain) masterByDomain.set(mc.domain.toLowerCase(), mc);
      masterByName.set(mc.name.toLowerCase(), mc);
      if (mc.linkedinUrl) masterByLinkedin.set(mc.linkedinUrl.toLowerCase(), mc);
    }

    interface CompanyAgg {
      key: string; name: string; domain: string; linkedin: string;
      industry: string; location: string; size: number | null;
      description: string; revenue: string; hiringRoles: string[];
      existing: (typeof masterRows)[number] | null; leadCount: number;
      /** Canonical master_companies.id, resolved during the upsert loop and
       *  stamped onto every lead in this aggregate (leads.masterCompanyId). */
      masterId?: string | null;
    }
    const companyMap = new Map<string, CompanyAgg>();

    const now = Date.now();
    const importId = createId("import");
    const errors: Array<{ row: number; reason: string }> = [];
    let importedRows = 0, skippedRows = 0, duplicateLeads = 0, invalidRows = 0;
    const addedLeadIds: string[] = [];
    const newLeads: Array<typeof leads.$inferInsert> = [];
    // Each new lead's company aggregate, aligned by index — used to backfill
    // company fields AFTER all rows are processed so every lead in a company
    // gets the full, unioned company data (e.g. all hiring roles).
    const newLeadAggs: CompanyAgg[] = [];
    const newEvents: Array<typeof leadEvents.$inferInsert> = [];
    // Mapped custom field values per new lead, keyed by lead id — written after
    // the transaction commits (see setLeadCustomFieldsBatch below).
    const customByLeadId = new Map<string, Record<string, string>>();
    const firstStep = funnel.steps[0];

    rows.forEach((rawRow: unknown, index: number) => {
      const row = rawRow && typeof rawRow === "object" ? (rawRow as Record<string, unknown>) : {};

      const firstName = getField(row, LBL.firstName);
      const lastName = getField(row, LBL.lastName);
      // Full name comes from a mapped "Lead Name" column, else compose it from
      // the separate first/last columns so either mapping style works.
      let name = getField(row, LBL.name) || [firstName, lastName].filter(Boolean).join(" ");
      let cName = getField(row, LBL.cName);
      const email = getField(row, LBL.email).toLowerCase();
      const cDomainRaw = normalizeDomain(getField(row, LBL.cDomain)) || domainFromEmail(email);

      if (enrichMode) {
        // No name column → derive a readable name from the email (placeholder
        // until person-enrichment); fall back to the raw email.
        if (!name) name = nameFromEmail(email) || email;
        // A corporate domain becomes a readable placeholder company that
        // enrichment replaces with the real name (and which stays as a sensible
        // fallback if enrichment can't resolve it). Personal emails
        // (gmail/outlook/…) aren't a company — treat the lead as an individual
        // whose company is their own name, so each is its own single-contact
        // account (never lumped under "gmail.com" or a blank company).
        if (!cName) cName = cDomainRaw ? companyFromDomain(cDomainRaw) : name;
      }
      const cLinkedin = getField(row, LBL.cLinkedin);
      const cIndustry = getField(row, LBL.cIndustry);
      const cLocation = getField(row, LBL.cLocation);
      const cSizeStr = getField(row, LBL.cSize);
      const cSize = cSizeStr ? parseInt(cSizeStr.replace(/[^0-9]/g, ""), 10) || null : null;
      const cDescription = getField(row, LBL.cDescription);
      const cRevenue = getField(row, LBL.cRevenue);
      const cHiringRoles = parseRoles(getField(row, LBL.cHiring));

      // In enrich mode a company isn't required (personal-email leads import with
      // a blank company); otherwise both name and company are required.
      if (!name || (!cName && !enrichMode)) {
        skippedRows += 1; invalidRows += 1;
        errors.push({ row: index + 2, reason: enrichMode ? "Missing required Email" : "Missing required Lead Name or Company Name" });
        return;
      }
      if (email && !/^\S+@\S+\.\S+$/.test(email)) {
        skippedRows += 1; invalidRows += 1;
        errors.push({ row: index + 2, reason: "Invalid email format" });
        return;
      }

      // Group key for the company. Enrich-mode leads with no corporate domain are
      // individuals (personal email) — group each on its OWN email so it becomes a
      // single-contact company named after the person, instead of collapsing all
      // of them under the email provider or one blank company. Everything else
      // groups by the chosen key (domain / name / linkedin).
      const isIndividual = enrichMode && !cDomainRaw;
      const groupVal = isIndividual
        ? (email || cName.toLowerCase())
        : ((groupBy === "domain" ? (cDomainRaw || cName.toLowerCase())
          : groupBy === "linkedin" ? (cLinkedin.toLowerCase() || cDomainRaw || cName.toLowerCase())
          : cName.toLowerCase()) || email);

      let agg = companyMap.get(groupVal);
      if (!agg) {
        const existing =
          (cDomainRaw && masterByDomain.get(cDomainRaw)) ||
          masterByName.get(cName.toLowerCase()) ||
          (cLinkedin && masterByLinkedin.get(cLinkedin.toLowerCase())) ||
          null;
        agg = {
          key: groupVal,
          name: existing?.name || cName,
          domain: cDomainRaw || existing?.domain || "",
          linkedin: cLinkedin || existing?.linkedinUrl || "",
          industry: cIndustry || existing?.industry || "",
          location: cLocation || [existing?.city, existing?.country].filter(Boolean).join(", "),
          size: cSize ?? existing?.employeeCount ?? null,
          description: cDescription,
          revenue: cRevenue,
          hiringRoles: [...cHiringRoles],
          existing,
          leadCount: 0,
        };
        companyMap.set(groupVal, agg);
      } else {
        if (!agg.domain && cDomainRaw) agg.domain = cDomainRaw;
        if (!agg.linkedin && cLinkedin) agg.linkedin = cLinkedin;
        if (!agg.industry && cIndustry) agg.industry = cIndustry;
        if (!agg.location && cLocation) agg.location = cLocation;
        if (agg.size == null && cSize != null) agg.size = cSize;
        if (!agg.description && cDescription) agg.description = cDescription;
        if (!agg.revenue && cRevenue) agg.revenue = cRevenue;
        // Union the hiring roles seen across this company's rows.
        for (const role of cHiringRoles) {
          if (!agg.hiringRoles.some((r) => r.toLowerCase() === role.toLowerCase())) {
            agg.hiringRoles.push(role);
          }
        }
      }
      const canonicalCompany = agg.name; // nest under existing company name when matched

      const key = dedupeKey(name, canonicalCompany, email);
      if (existingKeys.has(key)) {
        skippedRows += 1; duplicateLeads += 1;
        errors.push({ row: index + 2, reason: "Duplicate lead already in this campaign" });
        return;
      }
      existingKeys.add(key);
      agg.leadCount += 1;

      let notes: Record<string, string> | null = null;
      if (notesMappings.length > 0) {
        const built: Record<string, string> = {};
        for (const nm of notesMappings) {
          const val = normalizeString(row[nm.csvColumn]);
          if (val) built[nm.csvColumn] = val;
        }
        if (Object.keys(built).length > 0) notes = built;
      }

      const title = getField(row, LBL.title);
      const phone = getField(row, LBL.phone);
      const linkedinUrl = getField(row, LBL.linkedin);
      const leadId = createId("lead");
      // Prefer the explicitly-mapped first/last; otherwise split the full name so
      // {{first_name}}/{{last_name}} email variables still resolve.
      const nameParts = name.split(" ").filter(Boolean);
      const fnFinal = firstName || nameParts[0] || null;
      const lnFinal = lastName || nameParts.slice(1).join(" ") || null;
      newLeads.push({
        id: leadId, funnelId: funnel.id, importId, name, firstName: fnFinal, lastName: lnFinal, title, company: canonicalCompany, email, phone, linkedinUrl,
        currentStep: 1, totalSteps: funnel.steps.length, status: "pending",
        // Sequence-less campaigns have no first step — leads land workable
        // with no scheduled action instead of being rejected (or completed).
        nextAction: firstStep?.label ?? "", nextDate: firstStep ? new Date(now + firstStep.dayOffset * DAY_MS) : null,
        source: "CSV Import", sourceType: "csv",
        score: scoreLead({ name, title, company: canonicalCompany, email, phone, linkedinUrl }),
        // Company fields backfilled after the loop from the final aggregate.
        notes, createdAt: new Date(now), updatedAt: new Date(now),
      });
      newLeadAggs.push(agg);
      newEvents.push({ id: createId("event"), leadId, type: "imported", outcome: null, stepIndex: 0, meta: { importId }, timestamp: new Date(now) });
      // Collect mapped custom field values for this row (custom:<key> → value).
      if (customMappings.length > 0) {
        const cv: Record<string, string> = {};
        for (const cm of customMappings) {
          const v = normalizeString(row[cm.csvColumn]);
          if (v) cv[cm.mappedField.slice("custom:".length)] = v;
        }
        if (Object.keys(cv).length > 0) customByLeadId.set(leadId, cv);
      }
      importedRows += 1;
      addedLeadIds.push(leadId);
    });

    // Backfill company fields onto each new lead from its (now-complete)
    // company aggregate so leads at the same company share consistent data.
    newLeads.forEach((lead, i) => {
      const agg = newLeadAggs[i];
      lead.companyDomain = agg.domain || null;
      lead.companyIndustry = agg.industry || null;
      lead.companyEmployeeCount = agg.size;
      lead.companyLocation = agg.location || null;
      lead.companyDescription = agg.description || null;
      lead.companyLinkedin = agg.linkedin || null;
      lead.companyAnnualRevenue = agg.revenue || null;
      lead.companyHiringRoles = agg.hiringRoles.length ? agg.hiringRoles : null;
    });

    const companies = [...companyMap.values()].filter((c) => c.leadCount > 0);
    // Blank-named aggregates (personal-email leads with no company) aren't real
    // companies — exclude them from the counts and the master-company upsert.
    const namedCompanies = companies.filter((c) => c.name.trim());
    const existingCompanies = namedCompanies.filter((c) => c.existing).length;
    const newCompanies = namedCompanies.length - existingCompanies;
    const summary = {
      totalRows: rows.length, importedRows, skippedRows, duplicateLeads, invalidRows,
      companiesTotal: namedCompanies.length, existingCompanies, newCompanies, groupBy,
    };

    // Dry run → return the review preview without writing anything.
    if (dryRun) {
      res.json({ data: { dryRun: true, ...summary, errors: errors.slice(0, 20) } });
      return;
    }

    // Final lead/event sets to write — narrowed inside the transaction once we
    // hold the per-funnel lock and can see any concurrent import's rows.
    let leadsToInsert = newLeads;
    let eventsToInsert = newEvents;

    await db.transaction(async (tx) => {
      // Serialize imports for THIS funnel. A double-submit (two requests fired
      // near-simultaneously) would otherwise each read the pre-insert state and
      // both write the full set — duplicating every contact. The advisory lock
      // makes the second import wait for the first to commit; we then re-check
      // against the now-committed rows and drop anything already imported.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${funnel.id}))`);

      const committed = await tx
        .select({ name: leads.name, company: leads.company, email: leads.email })
        .from(leads)
        .where(eq(leads.funnelId, funnel.id));
      const committedKeys = new Set(committed.map((l) => dedupeKey(l.name, l.company, l.email)));
      if (committedKeys.size) {
        const survivors = newLeads.filter((l) => !committedKeys.has(dedupeKey(l.name ?? "", l.company ?? "", l.email ?? "")));
        const dropped = newLeads.length - survivors.length;
        if (dropped > 0) {
          const keep = new Set(survivors.map((l) => l.id));
          leadsToInsert = survivors;
          eventsToInsert = newEvents.filter((e) => e.leadId && keep.has(e.leadId));
          // Reflect the concurrent-dup drop in the counts + returned ids.
          importedRows -= dropped;
          duplicateLeads += dropped;
          summary.importedRows = importedRows;
          summary.duplicateLeads = duplicateLeads;
          for (let i = addedLeadIds.length - 1; i >= 0; i--) {
            if (!keep.has(addedLeadIds[i])) addedLeadIds.splice(i, 1);
          }
        }
      }

      // Insert the import record FIRST — leads carry a FK to imports.id, and
      // Postgres checks foreign keys per-statement, so the parent row must
      // already exist before the leads that reference it are inserted.
      await tx.insert(imports).values({
        id: importId, funnelId: funnel.id, fileName: normalizedFileName,
        totalRows: rows.length, importedRows, skippedRows,
        mappings: [...fieldMappings, ...customMappings], errors: errors.slice(0, 100), createdAt: new Date(now),
      });

      // Upsert master companies so "company already exists" works across imports.
      for (const c of companies) {
        if (!c.name.trim()) continue; // skip blank-company (personal-email) leads
        if (c.existing) {
          await tx.update(masterCompanies)
            .set({
              lastSeenAt: new Date(now), updatedAt: new Date(now),
              domain: c.existing.domain || c.domain || null,
              linkedinUrl: c.existing.linkedinUrl || c.linkedin || null,
              industry: c.existing.industry || c.industry || null,
              employeeCount: c.existing.employeeCount ?? c.size,
            })
            .where(eq(masterCompanies.id, c.existing.id));
          c.masterId = c.existing.id;
        } else {
          const inserted = await tx.insert(masterCompanies).values({
            id: createId("company"), organizationId: orgId, name: c.name,
            domain: c.domain || null, linkedinUrl: c.linkedin || null,
            industry: c.industry || null, employeeCount: c.size,
            lastSeenAt: new Date(now), createdAt: new Date(now), updatedAt: new Date(now),
          }).onConflictDoNothing({ target: [masterCompanies.organizationId, masterCompanies.domain] })
            .returning({ id: masterCompanies.id });
          if (inserted.length > 0) {
            c.masterId = inserted[0].id;
          } else if (c.domain) {
            // Conflict: a concurrent import won the (org, domain) race — link
            // to the committed winner instead of leaving the leads unlinked.
            const winner = await tx
              .select({ id: masterCompanies.id })
              .from(masterCompanies)
              .where(and(
                eq(masterCompanies.organizationId, orgId),
                sql`lower(${masterCompanies.domain}) = lower(${c.domain})`,
              ))
              .limit(1);
            c.masterId = winner[0]?.id ?? null;
          }
        }
      }
      // Stamp the canonical company link onto every surviving lead row.
      const aggByLeadId = new Map(newLeads.map((l, i) => [l.id as string, newLeadAggs[i]]));
      for (const l of leadsToInsert) {
        l.masterCompanyId = aggByLeadId.get(l.id as string)?.masterId ?? null;
      }
      // Resolve every row to its canonical person (bulk: 3 indexed queries,
      // in-memory matching, one insert batch for missing masters) so each
      // enrollment lands linked to its master contact from birth.
      const personIds = await resolvePersonsBulk(orgId, leadsToInsert);
      for (let i = 0; i < leadsToInsert.length; i++) {
        leadsToInsert[i].masterContactId = personIds[i];
      }

      // Batch inserts — Postgres caps a single statement at 65534 bind
      // parameters, so a large import (thousands of rows × ~30 cols) must be
      // chunked or it errors with MAX_PARAMETERS_EXCEEDED.
      const INSERT_CHUNK = 500;
      for (let i = 0; i < leadsToInsert.length; i += INSERT_CHUNK) {
        await tx.insert(leads).values(leadsToInsert.slice(i, i + INSERT_CHUNK));
      }
      for (let i = 0; i < eventsToInsert.length; i += INSERT_CHUNK) {
        await tx.insert(leadEvents).values(eventsToInsert.slice(i, i + INSERT_CHUNK));
      }
    });

    // Persist mapped custom field values for the leads that were actually
    // inserted (concurrent-dup survivors). Auto-provision any mapped custom
    // field so a value is never silently dropped.
    if (customMappings.length > 0 && leadsToInsert.length > 0) {
      const customKeys = Array.from(
        new Set(customMappings.map((cm) => cm.mappedField.slice("custom:".length)).filter(Boolean)),
      );
      await Promise.all(customKeys.map((k) => ensureFieldDefinition(orgId, k)));
      await setLeadCustomFieldsBatch(
        orgId,
        leadsToInsert
          .map((l) => ({ leadId: l.id!, values: customByLeadId.get(l.id!) || {} }))
          .filter((e) => Object.keys(e.values).length > 0),
      );
    }

    // Push leads to Smartlead if campaign exists
    if (funnel.smartleadCampaignId && leadsToInsert.length > 0) {
      await pushLeadsToSmartlead(
        Number(funnel.smartleadCampaignId),
        orgId,
        leadsToInsert.map((l) => ({
          id: l.id,
          name: l.name,
          email: l.email,
          company: l.company,
          phone: l.phone,
          linkedinUrl: l.linkedinUrl,
        })),
      );
    }

    // Enroll the freshly-imported leads into any active "lead enters campaign"
    // workflows (one batched call; fire-and-forget).
    if (leadsToInsert.length > 0) {
      void fireTrigger(orgId, funnel.id, leadsToInsert.map((l) => l.id), "lead_enters_campaign");
    }

    res.status(201).json({
      data: {
        importId,
        funnelId: funnel.id,
        fileName: normalizedFileName,
        ...summary,
        errors: errors.slice(0, 20),
        addedLeadIds,
      },
    });
  }),
);

// ─── PATCH /funnels/:funnelId/leads/:leadId/status ───────────────────────
// Manually set a lead's status (built-in or custom) and record the change.

router.patch(
  "/funnels/:funnelId/leads/:leadId/status",
  asyncHandler<LeadAdvanceParams>(async (req, res) => {
    const orgId = getOrgId(req);
    const status = normalizeString(req.body && req.body.status).toLowerCase();

    const statuses = await getMergedLeadStatuses(orgId);
    // "pending" is the operational in-sequence status (not part of the org's
    // display list) — allowing it here lets a rep pull a lead back out of a
    // terminal state like "completed" and make it workable again.
    const isKnown = status === "pending" || statuses.some((s) => s.key === status);
    if (!status || !isKnown) {
      throw new ApiError(400, "Invalid lead status");
    }

    const funnel = getFunnelOrThrow(
      await loadFunnel(orgId, req.params.funnelId),
      req.params.funnelId,
    );
    const lead = funnel.leads.find((l) => l.id === req.params.leadId);
    if (!lead) {
      throw new ApiError(404, "Lead not found in funnel");
    }

    const now = Date.now();
    await db.insert(leadEvents).values({
      id: createId("event"),
      leadId: lead.id,
      type: "status_change",
      outcome: status,
      stepIndex: Math.max((lead.currentStep || 1) - 1, 0),
      // `from` renders the "Status changed from X → Y" transition pills.
      meta: { manual: true, from: lead.status, userId: getAuth(req as unknown as Request)?.userId ?? null },
      timestamp: new Date(now),
    });

    // Reverting to "pending" puts the lead back in the working queue — point
    // it at its current step again (if the campaign has one) so the cockpit
    // picks it up instead of leaving a stale "Sequence complete" next action.
    const revertStep = funnel.steps[clamp((lead.currentStep || 1) - 1, 0, Math.max(funnel.steps.length - 1, 0))];
    const revertFields =
      status === "pending" ? { nextAction: revertStep?.label ?? "", nextDate: new Date(now) } : {};

    // Status is company-level: apply to EVERY contact at this company in the
    // funnel so the company reads as one status.
    await db
      .update(leads)
      .set({ status, ...revertFields, updatedAt: new Date(now) })
      .where(
        and(
          eq(leads.funnelId, funnel.id),
          sql`lower(${leads.company}) = lower(${lead.company})`,
        ),
      );

    // Enroll into any active "status changes" workflows (fire-and-forget) —
    // pass the new status so a "changes to X" trigger only fires on a match.
    void fireTrigger(orgId, funnel.id, lead.id, "status_changed", { status });

    res.json({ data: { id: lead.id, status, company: lead.company } });
  }),
);

// ─── POST /funnels/:funnelId/leads/:leadId/advance ───────────────────────

router.post(
  "/funnels/:funnelId/leads/:leadId/advance",
  asyncHandler<LeadAdvanceParams>(async (req, res) => {
    const orgId = getOrgId(req);
    const outcome =
      normalizeString(req.body && req.body.outcome).toLowerCase() || "sent";
    const allowedOutcomes = new Set([
      "sent",
      "opened",
      "clicked",
      "replied",
      "bounced",
      "completed",
    ]);

    if (!allowedOutcomes.has(outcome)) {
      throw new ApiError(400, "Invalid lead outcome");
    }

    const funnel = getFunnelOrThrow(
      await loadFunnel(orgId, req.params.funnelId),
      req.params.funnelId,
    );

    const lead = funnel.leads.find((l) => l.id === req.params.leadId);
    if (!lead) {
      throw new ApiError(404, "Lead not found in funnel");
    }

    const now = Date.now();
    const currentStepIndex = clamp(
      (lead.currentStep || 1) - 1,
      0,
      Math.max(funnel.steps.length - 1, 0),
    );

    // Insert the event
    const step = funnel.steps[currentStepIndex];
    const eventId = createId("event");
    await db.insert(leadEvents).values({
      id: eventId,
      leadId: lead.id,
      type: "step_outcome",
      outcome,
      stepIndex: currentStepIndex,
      meta: {
        channel: step?.channel ?? null,
        action: step?.action ?? null,
      },
      timestamp: new Date(now),
    });

    // Determine new lead state
    let newStatus: string;
    let newNextAction: string;
    let newNextDate: Date;
    let newCurrentStep = lead.currentStep;

    if (TERMINAL_STATUSES.has(outcome)) {
      newStatus = outcome;
      newNextDate = new Date(now);

      if (outcome === "replied") {
        newNextAction = "Review reply and route to owner";
      } else if (outcome === "bounced") {
        newNextAction = "Fix contact data and retry";
      } else {
        newNextAction = "Sequence complete";
      }
    } else if (funnel.steps.length === 0) {
      // Sequence-less campaign: log the touch but never auto-advance or
      // auto-complete — the lead stays workable until a rep sets a status.
      newStatus = "pending";
      newNextAction = "";
      newNextDate = new Date(now);
    } else {
      const schedule = computeNextStepSchedule(
        funnel.steps,
        currentStepIndex,
        now,
      );

      if (schedule.completed) {
        newStatus = "completed";
        newNextAction = schedule.nextAction;
        newNextDate = new Date(schedule.nextDate);
        newCurrentStep = funnel.steps.length;
      } else {
        newCurrentStep = clamp(
          (lead.currentStep || 1) + 1,
          1,
          funnel.steps.length,
        );
        newStatus = "pending";
        newNextAction = schedule.nextAction;
        newNextDate = new Date(schedule.nextDate);
      }
    }

    await db
      .update(leads)
      .set({
        status: newStatus,
        nextAction: newNextAction,
        nextDate: newNextDate,
        currentStep: newCurrentStep,
        updatedAt: new Date(now),
      })
      .where(eq(leads.id, lead.id));

    // Reload the full funnel to build the response payload
    const updatedFunnel = await loadFunnel(orgId, req.params.funnelId);
    const updatedLead = updatedFunnel!.leads.find(
      (l) => l.id === req.params.leadId,
    );

    res.json({
      data: {
        lead: updatedLead
          ? {
              id: updatedLead.id,
              name: updatedLead.name,
              title: updatedLead.title,
              company: updatedLead.company,
              email: updatedLead.email,
              phone: updatedLead.phone,
              linkedinUrl: updatedLead.linkedinUrl,
              currentStep: updatedLead.currentStep,
              totalSteps: updatedLead.totalSteps,
              status: updatedLead.status,
              nextAction: updatedLead.nextAction,
              nextDate: updatedLead.nextDate?.toISOString() ?? null,
              source: updatedLead.source,
              sourceType: updatedLead.sourceType,
              score: updatedLead.score,
              notes: updatedLead.notes,
              createdAt: updatedLead.createdAt.toISOString(),
              updatedAt: updatedLead.updatedAt.toISOString(),
              events: updatedLead.events.map((e) => ({
                id: e.id,
                type: e.type,
                outcome: e.outcome,
                stepIndex: e.stepIndex,
                meta: e.meta,
                timestamp: e.timestamp.toISOString(),
              })),
            }
          : null,
        funnel: buildFunnelPayload(updatedFunnel!, { includeLeads: true }),
      },
    });
  }),
);

// ─── POST /funnels/:funnelId/leads/:leadId/log-call ──────────────────────
// Records a real phone call against a lead. Always logs a call touch (so the
// call counter increments), and ticks the step forward ONLY when the lead's
// current step is a call-channel step — so repeat calls on a later step don't
// over-advance the sequence.
router.post(
  "/funnels/:funnelId/leads/:leadId/log-call",
  asyncHandler<LeadAdvanceParams>(async (req, res) => {
    const orgId = getOrgId(req);
    const outcome =
      normalizeString(req.body && req.body.outcome).toLowerCase() || "completed";

    const funnel = getFunnelOrThrow(
      await loadFunnel(orgId, req.params.funnelId),
      req.params.funnelId,
    );

    const lead = funnel.leads.find((l) => l.id === req.params.leadId);
    if (!lead) {
      throw new ApiError(404, "Lead not found in funnel");
    }

    const now = Date.now();
    const currentStepIndex = clamp(
      (lead.currentStep || 1) - 1,
      0,
      Math.max(funnel.steps.length - 1, 0),
    );
    const step = funnel.steps[currentStepIndex];
    const isCallStep = (step?.channel ?? "").toLowerCase() === "call";

    // Always log the call as a call-channel touch so it counts toward the
    // lead's call activity, regardless of which step they're on.
    await db.insert(leadEvents).values({
      id: createId("event"),
      leadId: lead.id,
      type: "step_outcome",
      outcome,
      stepIndex: currentStepIndex,
      meta: { channel: "call", action: step?.action ?? "call" },
      timestamp: new Date(now),
    });

    // Tick the step forward only when the current step is a call step and the
    // lead isn't already in a terminal state.
    let newCurrentStep = lead.currentStep;
    let newStatus = lead.status;
    let newNextAction = lead.nextAction;
    let newNextDate = lead.nextDate ?? new Date(now);

    if (isCallStep && !TERMINAL_STATUSES.has(lead.status)) {
      const schedule = computeNextStepSchedule(funnel.steps, currentStepIndex, now);
      if (schedule.completed) {
        newStatus = "completed";
        newNextAction = schedule.nextAction;
        newNextDate = new Date(schedule.nextDate);
        newCurrentStep = funnel.steps.length;
      } else {
        newCurrentStep = clamp((lead.currentStep || 1) + 1, 1, funnel.steps.length);
        newStatus = "pending";
        newNextAction = schedule.nextAction;
        newNextDate = new Date(schedule.nextDate);
      }
    }

    await db
      .update(leads)
      .set({
        status: newStatus,
        nextAction: newNextAction,
        nextDate: newNextDate,
        currentStep: newCurrentStep,
        updatedAt: new Date(now),
      })
      .where(eq(leads.id, lead.id));

    const updatedFunnel = await loadFunnel(orgId, req.params.funnelId);
    const updatedLead = updatedFunnel!.leads.find((l) => l.id === req.params.leadId);

    res.json({
      data: {
        lead: updatedLead
          ? {
              id: updatedLead.id,
              name: updatedLead.name,
              title: updatedLead.title,
              company: updatedLead.company,
              email: updatedLead.email,
              phone: updatedLead.phone,
              linkedinUrl: updatedLead.linkedinUrl,
              currentStep: updatedLead.currentStep,
              totalSteps: updatedLead.totalSteps,
              status: updatedLead.status,
              nextAction: updatedLead.nextAction,
              nextDate: updatedLead.nextDate?.toISOString() ?? null,
              source: updatedLead.source,
              sourceType: updatedLead.sourceType,
              score: updatedLead.score,
              notes: updatedLead.notes,
              createdAt: updatedLead.createdAt.toISOString(),
              updatedAt: updatedLead.updatedAt.toISOString(),
              events: updatedLead.events.map((e) => ({
                id: e.id,
                type: e.type,
                outcome: e.outcome,
                stepIndex: e.stepIndex,
                meta: e.meta,
                timestamp: e.timestamp.toISOString(),
              })),
            }
          : null,
        funnel: buildFunnelPayload(updatedFunnel!, { includeLeads: true }),
      },
    });
  }),
);

// ─── POST /funnels/:funnelId/leads/:leadId/notes ─────────────────────────
// Persists a free-text note as a lead event so it survives reloads and shows
// in the lead's activity timeline.
router.post(
  "/funnels/:funnelId/leads/:leadId/notes",
  asyncHandler<LeadAdvanceParams>(async (req, res) => {
    const orgId = getOrgId(req);
    const text = normalizeString(req.body && req.body.text);
    if (!text) {
      throw new ApiError(400, "text is required");
    }

    const funnel = getFunnelOrThrow(
      await loadFunnel(orgId, req.params.funnelId),
      req.params.funnelId,
    );
    const lead = funnel.leads.find((l) => l.id === req.params.leadId);
    if (!lead) {
      throw new ApiError(404, "Lead not found in funnel");
    }

    const id = createId("event");
    const stepIndex = clamp(
      (lead.currentStep || 1) - 1,
      0,
      Math.max(funnel.steps.length - 1, 0),
    );
    const timestamp = new Date();
    const noteMeta = { text, userId: getAuth(req as unknown as Request)?.userId ?? null };
    await db.insert(leadEvents).values({
      id,
      leadId: lead.id,
      type: "note",
      outcome: null,
      stepIndex,
      meta: noteMeta,
      timestamp,
    });

    res.status(201).json({
      data: {
        id,
        type: "note",
        outcome: null,
        stepIndex,
        meta: noteMeta,
        timestamp: timestamp.toISOString(),
      },
    });
  }),
);

// ─── PATCH /funnels/:funnelId/leads/:leadId/notes/:eventId ────────────────
// Edits a previously-saved note. Verifies the note belongs to this lead/org.
router.patch(
  "/funnels/:funnelId/leads/:leadId/notes/:eventId",
  asyncHandler<{ funnelId: string; leadId: string; eventId: string }>(async (req, res) => {
    const orgId = getOrgId(req);
    const text = normalizeString(req.body && req.body.text);
    if (!text) throw new ApiError(400, "text is required");

    const [ev] = await db
      .select({ id: leadEvents.id, type: leadEvents.type, meta: leadEvents.meta })
      .from(leadEvents)
      .innerJoin(leads, eq(leadEvents.leadId, leads.id))
      .innerJoin(funnels, eq(leads.funnelId, funnels.id))
      .where(
        and(
          eq(leadEvents.id, req.params.eventId),
          eq(leads.id, req.params.leadId),
          eq(funnels.organizationId, orgId),
        ),
      )
      .limit(1);
    if (!ev || ev.type !== "note") throw new ApiError(404, "Note not found");

    // Preserve the original author (and any other meta) when editing the text.
    const mergedMeta = { ...(ev.meta || {}), text };
    await db
      .update(leadEvents)
      .set({ meta: mergedMeta })
      .where(eq(leadEvents.id, req.params.eventId));

    res.json({ data: { id: req.params.eventId, meta: mergedMeta } });
  }),
);

// ─── DELETE /funnels/:funnelId/leads/:leadId/notes/:eventId ───────────────
router.delete(
  "/funnels/:funnelId/leads/:leadId/notes/:eventId",
  asyncHandler<{ funnelId: string; leadId: string; eventId: string }>(async (req, res) => {
    const orgId = getOrgId(req);

    const [ev] = await db
      .select({ id: leadEvents.id, type: leadEvents.type })
      .from(leadEvents)
      .innerJoin(leads, eq(leadEvents.leadId, leads.id))
      .innerJoin(funnels, eq(leads.funnelId, funnels.id))
      .where(
        and(
          eq(leadEvents.id, req.params.eventId),
          eq(leads.id, req.params.leadId),
          eq(funnels.organizationId, orgId),
        ),
      )
      .limit(1);
    if (!ev || ev.type !== "note") throw new ApiError(404, "Note not found");

    await db.delete(leadEvents).where(eq(leadEvents.id, req.params.eventId));
    res.status(204).end();
  }),
);

// ─── POST /funnels/:funnelId/leads/:leadId/dnc ───────────────────────────
// Toggles a single PERSON's Do-Not-Contact flag (compliance). NON-DESTRUCTIVE:
// the person STAYS in every campaign — their lead rows just get flagged (shown
// in red, with a confirm before any call). Matched by email/linkedin/phone so
// the flag follows the person everywhere; mirrored onto the master contact.
// Body: { value?: boolean } (default true).
router.post(
  "/funnels/:funnelId/leads/:leadId/dnc",
  asyncHandler<LeadAdvanceParams>(async (req, res) => {
    const orgId = getOrgId(req);
    const value = req.body?.value === undefined ? true : !!req.body.value;

    const funnel = getFunnelOrThrow(
      await loadFunnel(orgId, req.params.funnelId),
      req.params.funnelId,
    );
    const lead = funnel.leads.find((l) => l.id === req.params.leadId);
    if (!lead) throw new ApiError(404, "Lead not found in funnel");

    const result = await db.transaction((tx) =>
      flagDoNotCall(tx, orgId, lead, value),
    );

    const refreshed = await loadFunnel(orgId, req.params.funnelId);
    res.json({
      data: {
        name: lead.name,
        doNotCall: value,
        flaggedLeads: result.flaggedLeads,
        funnel: buildFunnelPayload(refreshed!, { includeLeads: true }),
      },
    });
  }),
);

// ─── PATCH /funnels/:funnelId/leads/:leadId/contact ──────────────────────
// Edit a contact's details (name / title / email / phone / LinkedIn) from the
// lead profile view. Updates the lead row and mirrors to the master contact so
// the change follows the person across campaigns.
router.patch(
  "/funnels/:funnelId/leads/:leadId/contact",
  requirePerm("leads.edit"),
  asyncHandler<LeadAdvanceParams>(async (req, res) => {
    const orgId = getOrgId(req);
    const funnel = getFunnelOrThrow(
      await loadFunnel(orgId, req.params.funnelId),
      req.params.funnelId,
    );
    const lead = funnel.leads.find((l) => l.id === req.params.leadId);
    if (!lead) throw new ApiError(404, "Lead not found in funnel");

    const body = (req.body || {}) as Partial<Record<"name" | "title" | "email" | "phone" | "linkedinUrl", string>> &
      Partial<Record<"extraEmails" | "extraPhones", unknown>>;
    const updates: Record<string, unknown> = {};
    if (body.name !== undefined) {
      const name = normalizeString(body.name);
      if (!name) throw new ApiError(400, "Name cannot be empty");
      updates.name = name;
    }
    if (body.title !== undefined) updates.title = normalizeString(body.title);
    if (body.email !== undefined) updates.email = normalizeString(body.email).toLowerCase();
    if (body.phone !== undefined) updates.phone = normalizeString(body.phone);
    if (body.linkedinUrl !== undefined) updates.linkedinUrl = normalizeString(body.linkedinUrl);
    // Additional labeled emails/phones — replaced wholesale (the edit form
    // sends the full list). Entries without a value are dropped; capped at 10.
    const sanitizeExtras = (raw: unknown, lowercase: boolean) => {
      if (!Array.isArray(raw)) return [];
      const out: { label: string; value: string }[] = [];
      for (const item of raw) {
        if (!item || typeof item !== "object") continue;
        let value = normalizeString((item as Record<string, unknown>).value as string).slice(0, 200);
        if (lowercase) value = value.toLowerCase();
        const label = normalizeString((item as Record<string, unknown>).label as string).slice(0, 40);
        if (!value) continue;
        out.push({ label, value });
        if (out.length >= 10) break;
      }
      return out;
    };
    if (body.extraEmails !== undefined) updates.extraEmails = sanitizeExtras(body.extraEmails, true);
    if (body.extraPhones !== undefined) updates.extraPhones = sanitizeExtras(body.extraPhones, false);
    if (Object.keys(updates).length === 0) throw new ApiError(400, "Nothing to update");
    updates.updatedAt = new Date();

    // Editing a name keeps the split first/last in step on this row and its
    // siblings (email templates field-map {{first_name}}/{{last_name}}).
    if (updates.name !== undefined) {
      const [firstName, ...rest] = (updates.name as string).split(" ");
      updates.firstName = firstName || null;
      updates.lastName = rest.join(" ") || null;
    }

    await db.update(leads).set(updates).where(eq(leads.id, lead.id));

    // A contact edit is a PERSON edit: overwrite the canonical master contact
    // (explicit edits clobber, unlike discovery upserts) and fan the person
    // fields out to this person's other enrollments org-wide. Best-effort —
    // never blocks the lead update itself.
    try {
      const [fresh] = await db.select().from(leads).where(eq(leads.id, lead.id));
      if (fresh) {
        const { resolvePerson, emailKeyOf, linkedinKeyOf, phoneKeyOf } = await import("../lib/person-resolve");
        let personId = fresh.masterContactId;
        if (!personId) {
          personId = await resolvePerson(orgId, fresh);
          if (personId) await db.update(leads).set({ masterContactId: personId }).where(eq(leads.id, fresh.id));
        }
        if (personId) {
          const masterUpdates: Record<string, unknown> = { updatedAt: new Date() };
          if (updates.name !== undefined) {
            masterUpdates.fullName = updates.name;
            masterUpdates.firstName = updates.firstName;
            masterUpdates.lastName = updates.lastName;
          }
          if (updates.title !== undefined) masterUpdates.currentTitle = updates.title || null;
          if (updates.email !== undefined) {
            masterUpdates.email = (updates.email as string) || null;
            masterUpdates.emailKey = emailKeyOf(updates.email as string);
          }
          if (updates.phone !== undefined) {
            masterUpdates.phone = (updates.phone as string) || null;
            masterUpdates.phoneKey = phoneKeyOf(updates.phone as string);
          }
          if (updates.linkedinUrl !== undefined) {
            masterUpdates.linkedinUrl = (updates.linkedinUrl as string) || null;
            masterUpdates.linkedinKey = linkedinKeyOf(updates.linkedinUrl as string);
          }
          if (updates.extraEmails !== undefined) masterUpdates.extraEmails = updates.extraEmails;
          if (updates.extraPhones !== undefined) masterUpdates.extraPhones = updates.extraPhones;
          await db
            .update(masterContacts)
            .set(masterUpdates)
            .where(and(eq(masterContacts.id, personId), eq(masterContacts.organizationId, orgId)));

          // Sibling enrollments: sync person fields. Email is skipped on rows
          // already pushed to Smartlead — its webhooks correlate by the email
          // we sent, so rewriting it would orphan those events.
          const siblingSync: Record<string, unknown> = {};
          for (const key of ["name", "firstName", "lastName", "title", "phone", "linkedinUrl", "extraEmails", "extraPhones"] as const) {
            if (updates[key] !== undefined) siblingSync[key] = updates[key];
          }
          if (Object.keys(siblingSync).length > 0) {
            await db
              .update(leads)
              .set({ ...siblingSync, updatedAt: new Date() })
              .where(and(eq(leads.masterContactId, personId), sql`${leads.id} <> ${lead.id}`));
          }
          if (updates.email !== undefined) {
            await db
              .update(leads)
              .set({ email: updates.email as string, updatedAt: new Date() })
              .where(and(eq(leads.masterContactId, personId), sql`${leads.id} <> ${lead.id}`, isNull(leads.smartleadLeadId)));
          }
        }
      }
    } catch (err) {
      console.warn("[lead-contact] person sync failed:", err instanceof Error ? err.message : err);
    }

    res.json({
      data: {
        id: lead.id,
        name: (updates.name as string) ?? lead.name,
        title: (updates.title as string) ?? lead.title,
        email: (updates.email as string) ?? lead.email,
        phone: (updates.phone as string) ?? lead.phone,
        linkedinUrl: (updates.linkedinUrl as string) ?? lead.linkedinUrl,
        extraEmails: (updates.extraEmails as { label: string; value: string }[]) ?? lead.extraEmails ?? [],
        extraPhones: (updates.extraPhones as { label: string; value: string }[]) ?? lead.extraPhones ?? [],
      },
    });
  }),
);

// ─── DELETE /funnels/:funnelId/leads/:leadId ─────────────────────────────
// Remove a contact (lead row) from this campaign — the trash action in the
// lead profile's Contacts section. Deletes only this enrollment: the person's
// master contact and any enrollments in other campaigns are untouched.
// Related rows (events, tasks, documents, custom-field values, workflow
// enrollments) cascade; an opportunity sourced from this lead survives.
router.delete(
  "/funnels/:funnelId/leads/:leadId",
  requirePerm("leads.delete"),
  asyncHandler<LeadAdvanceParams>(async (req, res) => {
    const orgId = getOrgId(req);
    const funnel = getFunnelOrThrow(
      await loadFunnel(orgId, req.params.funnelId),
      req.params.funnelId,
    );
    const lead = funnel.leads.find((l) => l.id === req.params.leadId);
    if (!lead) throw new ApiError(404, "Lead not found in funnel");

    await db.delete(leads).where(eq(leads.id, lead.id));
    res.status(204).end();
  }),
);

// ─── POST /funnels/:funnelId/leads ───────────────────────────────────────
// Create a single lead manually from the campaign (the "Individual contact"
// flow + "Add contact" on a lead profile). Only name + company required — the
// rest is filled in from the now-fully-editable lead profile.
router.post(
  "/funnels/:funnelId/leads",
  requirePerm("campaigns.addLeads"),
  asyncHandler<FunnelParams>(async (req, res) => {
    const orgId = getOrgId(req);
    const funnel = getFunnelOrThrow(await loadFunnel(orgId, req.params.funnelId), req.params.funnelId);

    const body = (req.body || {}) as Record<string, unknown>;
    const name = normalizeString(body.name as string);
    const company = normalizeString(body.company as string);
    if (!name) throw new ApiError(400, "Contact name is required");
    if (!company) throw new ApiError(400, "Company name is required");

    const id = createId("lead");
    const email = normalizeString(body.email as string).toLowerCase();
    const phone = normalizeString(body.phone as string);
    const title = normalizeString(body.title as string);
    const linkedinUrl = normalizeString(body.linkedinUrl as string);

    const masterContactId = await resolvePerson(orgId, { name, title, company, email, phone, linkedinUrl });

    // Dedupe against this campaign: the same PERSON must not enrol twice.
    // Match on the resolved master contact, else the import's email-first key
    // (so "Add contact"/individual-add can't recreate a row a CSV already made).
    // Returns the existing lead's profile with alreadyExists:true rather than
    // inserting a duplicate.
    const dupe = funnel.leads.find((l) =>
      (masterContactId && l.masterContactId === masterContactId) ||
      dedupeKey(l.name, l.company, l.email) === dedupeKey(name, company, email),
    );
    if (dupe) {
      const refreshed = getFunnelOrThrow(
        await loadFunnel(orgId, funnel.id, { withEvents: true, fullLeadId: dupe.id }),
        funnel.id,
      );
      res.status(200).json({
        data: {
          leadId: dupe.id,
          alreadyExists: true,
          funnel: buildFunnelPayload(refreshed, { includeLeads: true, fullLeadId: dupe.id }),
        },
      });
      return;
    }
    const masterCompanyId = await resolveCompanyForLead(orgId, {
      company,
      companyDomain: domainFromEmail(email) || null,
    }).catch(() => null);

    await db.insert(leads).values({
      id,
      funnelId: funnel.id,
      masterContactId,
      masterCompanyId,
      name,
      company,
      title,
      email,
      phone,
      linkedinUrl,
      source: "Manual",
      sourceType: "manual",
      status: "pending",
      currentStep: 1,
      totalSteps: funnel.steps.length || 1,
    });

    // Mirror to the org-wide master contact (keyed by LinkedIn) so it follows
    // the person across campaigns — same as the contact PATCH.
    if (linkedinUrl) {
      const [firstName, ...rest] = name.split(" ");
      try {
        await upsertMasterContact(orgId, {
          linkedinUrl,
          fullName: name,
          firstName: firstName || null,
          lastName: rest.join(" ") || null,
          currentTitle: title || null,
          email: email || null,
          phone: phone || null,
        });
      } catch (err) {
        console.warn("[lead-create] master mirror failed:", err instanceof Error ? err.message : err);
      }
    }

    // Enroll into any active "lead enters campaign" workflows (fire-and-forget).
    void fireTrigger(orgId, funnel.id, id, "lead_enters_campaign");

    const refreshed = getFunnelOrThrow(
      await loadFunnel(orgId, funnel.id, { withEvents: true, fullLeadId: id }),
      funnel.id,
    );
    res.status(201).json({
      data: { leadId: id, funnel: buildFunnelPayload(refreshed, { includeLeads: true, fullLeadId: id }) },
    });
  }),
);

// ─── PATCH /funnels/:funnelId/leads/:leadId/company ───────────────────────
// Edit company/About info. Company fields are shared, so they fan out to ALL
// contacts at the same company in this funnel — including a `company` rename,
// which renames the company for every contact currently under it.
router.patch(
  "/funnels/:funnelId/leads/:leadId/company",
  asyncHandler<LeadAdvanceParams>(async (req, res) => {
    const orgId = getOrgId(req);
    const funnel = getFunnelOrThrow(await loadFunnel(orgId, req.params.funnelId), req.params.funnelId);
    const lead = funnel.leads.find((l) => l.id === req.params.leadId);
    if (!lead) throw new ApiError(404, "Lead not found in funnel");

    const body = (req.body || {}) as Record<string, unknown>;
    const updates: Record<string, unknown> = {};
    const strField = (k: string, col: string) => {
      if (body[k] !== undefined) updates[col] = normalizeString(body[k] as string) || null;
    };
    strField("companyDomain", "companyDomain");
    strField("companyIndustry", "companyIndustry");
    strField("companyLocation", "companyLocation");
    strField("companyDescription", "companyDescription");
    strField("companyLinkedin", "companyLinkedin");
    strField("companyAnnualRevenue", "companyAnnualRevenue");
    if (body.companyEmployeeCount !== undefined) {
      const n = Number(body.companyEmployeeCount);
      updates.companyEmployeeCount = Number.isFinite(n) && n > 0 ? Math.round(n) : null;
    }
    const renameCompany = body.company !== undefined ? normalizeString(body.company as string) : null;
    if (Object.keys(updates).length === 0 && !renameCompany) throw new ApiError(400, "Nothing to update");

    if (Object.keys(updates).length > 0) {
      updates.updatedAt = new Date();
      // Fan out shared company fields to every contact at this company.
      await db.update(leads).set(updates).where(and(eq(leads.funnelId, funnel.id), eq(leads.company, lead.company)));
    }
    if (renameCompany && renameCompany !== lead.company) {
      await db
        .update(leads)
        .set({ company: renameCompany, updatedAt: new Date() })
        .where(and(eq(leads.funnelId, funnel.id), eq(leads.company, lead.company)));
    }

    // Re-resolve the canonical company link — a rename or domain edit can point
    // this company at a different master_companies row (or create one).
    if (renameCompany || updates.companyDomain !== undefined) {
      try {
        // `in updates` (not ??): an explicit clear stores null, and nullish
        // coalescing would resurrect the old value the user just removed.
        const effective = <T>(col: string, current: T): T =>
          col in updates ? (updates[col] as T) : current;
        const masterCompanyId = await resolveCompanyForLead(orgId, {
          company: renameCompany || lead.company,
          companyDomain: effective("companyDomain", lead.companyDomain),
          companyLinkedin: effective("companyLinkedin", lead.companyLinkedin),
          companyIndustry: effective("companyIndustry", lead.companyIndustry),
          companyEmployeeCount: effective("companyEmployeeCount", lead.companyEmployeeCount),
        });
        await db
          .update(leads)
          .set({ masterCompanyId })
          .where(and(eq(leads.funnelId, funnel.id), eq(leads.company, renameCompany || lead.company)));
      } catch (err) {
        console.warn("[lead-company] master company re-link failed:", err instanceof Error ? err.message : err);
      }
    }

    const refreshed = getFunnelOrThrow(
      await loadFunnel(orgId, funnel.id, { withEvents: true, fullLeadId: lead.id }),
      funnel.id,
    );
    res.json({ data: { funnel: buildFunnelPayload(refreshed, { includeLeads: true, fullLeadId: lead.id }) } });
  }),
);

// ─── PATCH /funnels/:funnelId/leads/:leadId/custom-fields ─────────────────
// Set this lead's custom-field VALUES (keyed by field key; "" clears).
router.patch(
  "/funnels/:funnelId/leads/:leadId/custom-fields",
  asyncHandler<LeadAdvanceParams>(async (req, res) => {
    const orgId = getOrgId(req);
    const funnel = getFunnelOrThrow(await loadFunnel(orgId, req.params.funnelId), req.params.funnelId);
    const lead = funnel.leads.find((l) => l.id === req.params.leadId);
    if (!lead) throw new ApiError(404, "Lead not found in funnel");

    const values = (req.body?.values || {}) as Record<string, string>;
    await setLeadCustomFields(orgId, lead.id, values);

    const refreshed = getFunnelOrThrow(
      await loadFunnel(orgId, funnel.id, { withEvents: true, fullLeadId: lead.id }),
      funnel.id,
    );
    res.json({ data: { funnel: buildFunnelPayload(refreshed, { includeLeads: true, fullLeadId: lead.id }) } });
  }),
);

// ─── API Error Handler ───────────────────────────────────────────────────

router.use(
  (err: ApiError, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || 500;
    const message = err.message || "Unexpected server error";

    res.status(status).json({
      error: {
        message,
        details: err.details || null,
      },
    });
  },
);

// ─── Funnel Members ─────────────────────────────────────────────────────

// GET /funnels/:funnelId/members — list funnel members
router.get(
  "/funnels/:funnelId/members",
  asyncHandler<FunnelParams>(async (req, res) => {
    const orgId = getOrgId(req);
    const funnelId = req.params.funnelId;

    const funnel = getFunnelOrThrow(
      await loadFunnel(orgId, funnelId),
      funnelId,
    );

    const members = await db.select().from(funnelMembers)
      .where(eq(funnelMembers.funnelId, funnelId));

    // Enrich with user data
    const memberData = [];
    for (const m of members) {
      const [user] = await db.select().from(users).where(eq(users.id, m.userId));
      memberData.push({
        id: m.id,
        userId: m.userId,
        role: m.role,
        email: user?.email || "",
        firstName: user?.firstName || null,
        lastName: user?.lastName || null,
        imageUrl: user?.imageUrl || null,
        createdAt: m.createdAt.toISOString(),
      });
    }

    res.json({ data: memberData });
  }),
);

// POST /funnels/:funnelId/members — add member to funnel
router.post(
  "/funnels/:funnelId/members",
  asyncHandler<FunnelParams>(async (req, res) => {
    const orgId = getOrgId(req);
    const funnelId = req.params.funnelId;
    const { userId, role } = req.body;

    if (!userId) throw new ApiError(400, "userId is required");

    getFunnelOrThrow(await loadFunnel(orgId, funnelId), funnelId);

    // Check if already a member
    const existing = await db.query.funnelMembers.findFirst({
      where: and(eq(funnelMembers.funnelId, funnelId), eq(funnelMembers.userId, userId)),
    });
    if (existing) throw new ApiError(400, "User is already a member of this funnel");

    const id = createId("fm");
    const [member] = await db.insert(funnelMembers).values({
      id,
      funnelId,
      userId,
      role: role || "contributor",
    }).returning();

    const [user] = await db.select().from(users).where(eq(users.id, userId));

    res.status(201).json({
      data: {
        id: member.id,
        userId: member.userId,
        role: member.role,
        email: user?.email || "",
        firstName: user?.firstName || null,
        lastName: user?.lastName || null,
        imageUrl: user?.imageUrl || null,
        createdAt: member.createdAt.toISOString(),
      },
    });
  }),
);

// PATCH /funnels/:funnelId/members/:userId — update member role
router.patch(
  "/funnels/:funnelId/members/:userId",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const funnelId = req.params.funnelId as string;
    const userId = req.params.userId as string;
    const { role } = req.body;

    if (!role) throw new ApiError(400, "role is required");

    const [updated] = await db.update(funnelMembers)
      .set({ role })
      .where(and(eq(funnelMembers.funnelId, funnelId), eq(funnelMembers.userId, userId)))
      .returning();

    if (!updated) throw new ApiError(404, "Member not found");

    res.json({ data: { id: updated.id, userId: updated.userId, role: updated.role } });
  }),
);

// DELETE /funnels/:funnelId/members/:userId — remove member
router.delete(
  "/funnels/:funnelId/members/:userId",
  asyncHandler(async (req, res) => {
    const funnelId = req.params.funnelId as string;
    const userId = req.params.userId as string;

    await db.delete(funnelMembers)
      .where(and(eq(funnelMembers.funnelId, funnelId), eq(funnelMembers.userId, userId)));

    res.json({ data: { userId, removed: true } });
  }),
);

// ─── POST /funnels/backfill-company-data ─────────────────────────────────
// One-time backfill: populate company metadata on leads from scraper signals
router.post(
  "/funnels/backfill-company-data",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);

    // Fast exit: this backfill only sources data from scraper signals. If the
    // org has none (e.g. CSV-only), skip the expensive lead scan + fuzzy LIKE
    // lookups entirely.
    const [{ signalCount } = { signalCount: 0 }] = await db
      .select({ signalCount: count() })
      .from(scraperSignals)
      .where(eq(scraperSignals.organizationId, orgId));
    if (Number(signalCount) === 0) {
      res.json({ data: { total: 0, updated: 0 } });
      return;
    }

    // Get all leads missing company data
    const leadsToFix = await db
      .select({ id: leads.id, company: leads.company })
      .from(leads)
      .innerJoin(funnels, eq(leads.funnelId, funnels.id))
      .where(
        and(
          eq(funnels.organizationId, orgId),
          isNull(leads.companyDomain),
        ),
      );

    let updated = 0;
    const seen = new Map<string, { domain?: string; industry?: string; employeeCount?: number; location?: string }>();

    for (const lead of leadsToFix) {
      const key = lead.company.toLowerCase();

      if (!seen.has(key)) {
        // Try exact match first, then fuzzy (LIKE %name%)
        let signal = await db.query.scraperSignals.findFirst({
          where: and(
            eq(scraperSignals.organizationId, orgId),
            sql`lower(${scraperSignals.company}) = lower(${lead.company})`,
          ),
          columns: { companyDomain: true, companyIndustry: true, companyEmployeeCount: true, location: true },
        });
        if (!signal) {
          signal = await db.query.scraperSignals.findFirst({
            where: and(
              eq(scraperSignals.organizationId, orgId),
              sql`lower(${scraperSignals.company}) LIKE '%' || lower(${lead.company}) || '%'`,
            ),
            columns: { companyDomain: true, companyIndustry: true, companyEmployeeCount: true, location: true },
          });
        }
        seen.set(key, signal ? {
          domain: signal.companyDomain || undefined,
          industry: signal.companyIndustry || undefined,
          employeeCount: signal.companyEmployeeCount || undefined,
          location: signal.location || undefined,
        } : {});
      }

      const meta = seen.get(key)!;
      if (meta.domain || meta.industry || meta.employeeCount || meta.location) {
        await db
          .update(leads)
          .set({
            companyDomain: meta.domain || null,
            companyIndustry: meta.industry || null,
            companyEmployeeCount: meta.employeeCount || null,
            companyLocation: meta.location || null,
            updatedAt: new Date(),
          })
          .where(eq(leads.id, lead.id));
        updated++;
      }
    }

    console.log(`[Backfill] Updated ${updated}/${leadsToFix.length} leads with company data`);
    res.json({ data: { total: leadsToFix.length, updated } });
  }),
);

// ─── POST /funnels/:funnelId/enrich-job-posts ───────────────────────────
// "Magic Enrich → Find job posts": for each selected company, search TheirStack
// for its recent open jobs and add them as hiring roles on every lead at that
// company in this funnel. Idempotent (dedupes by role title per lead).
function jobRelTime(d: string | null): string {
  if (!d) return "";
  const t = new Date(d).getTime();
  if (!Number.isFinite(t)) return "";
  const days = Math.floor((Date.now() - t) / DAY_MS);
  if (days <= 0) return "today";
  if (days === 1) return "1 day ago";
  if (days < 7) return `${days} days ago`;
  if (days < 30) { const w = Math.floor(days / 7); return `${w} week${w > 1 ? "s" : ""} ago`; }
  const m = Math.floor(days / 30);
  return `${m} month${m > 1 ? "s" : ""} ago`;
}

function jobToRole(job: TheirStackJob) {
  let salary = job.salary_string || "";
  if (!salary && (job.min_annual_salary_usd || job.max_annual_salary_usd)) {
    const min = job.min_annual_salary_usd ? `$${Math.round(job.min_annual_salary_usd / 1000)}k` : "";
    const max = job.max_annual_salary_usd ? `$${Math.round(job.max_annual_salary_usd / 1000)}k` : "";
    salary = min && max ? `${min} - ${max}` : min || max;
  }
  return {
    title: (job.job_title || "").trim(),
    description: (job.description || "").slice(0, 800),
    salaryRange: salary,
    location: job.short_location || job.location || job.long_location || "",
    postedAgo: jobRelTime(job.date_posted || null),
    seniority: job.seniority || "",
    url: job.final_url || job.url || "",
  };
}

router.post(
  "/funnels/:funnelId/enrich-job-posts",
  requirePerm("leads.enrich"),
  asyncHandler<{ funnelId: string }>(async (req, res) => {
    const orgId = getOrgId(req);
    const funnelId = req.params.funnelId;
    const body = req.body as { companies?: { name: string; domain?: string | null; linkedinUrl?: string | null }[] };
    // Each company is a separate TheirStack lookup, so a single synchronous
    // request is capped to keep it well under the HTTP timeout (and bound the
    // credit spend). When more are selected we process the first ENRICH_CAP and
    // report the truncation so the UI can prompt to run again for the rest.
    const ENRICH_CAP = 150;
    const requestedCompanies = (body.companies || []).filter((c) => c && c.name);
    const companies = requestedCompanies.slice(0, ENRICH_CAP);
    if (companies.length === 0) throw new ApiError(400, "companies is required");

    const [funnel] = await db
      .select({ id: funnels.id })
      .from(funnels)
      .where(and(eq(funnels.id, funnelId), eq(funnels.organizationId, orgId)))
      .limit(1);
    if (!funnel) throw new ApiError(404, "Campaign not found");

    const token = process.env.THEIRSTACK_API_KEY;
    if (!token) throw new ApiError(500, "THEIRSTACK_API_KEY is not configured");
    const client = new TheirStackClient(token);
    const userId = getAuth(req)?.userId || null;

    // Credit pre-flight: job scraping costs 1 credit per job found. Block up
    // front if the org has no credits at all (actuals billed after the search).
    {
      const bal = await getBalance(orgId);
      if (bal < 1) throw new InsufficientCreditsError(1, bal);
    }

    // Search each company (small concurrency cap) → recent open jobs.
    const CONCURRENCY = 5;
    const jobsByCompany = new Map<string, TheirStackJob[]>();
    for (let i = 0; i < companies.length; i += CONCURRENCY) {
      const batch = companies.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        batch.map((c) => {
          const params: Record<string, unknown> = { posted_at_max_age_days: 30, limit: 20 };
          const domain = (c.domain || "").trim();
          if (domain) params.company_domain_or = [domain];
          else if (c.linkedinUrl) params.company_linkedin_url_or = [c.linkedinUrl];
          else params.company_name_or = [c.name];
          return client
            .searchJobs(params)
            .then((r) => ({ name: c.name, jobs: r.data || [] }))
            .catch((err) => {
              console.warn(`[enrich-job-posts] ${c.name} failed:`, err instanceof Error ? err.message : err);
              return { name: c.name, jobs: [] as TheirStackJob[] };
            });
        }),
      );
      for (const r of results) jobsByCompany.set(r.name.toLowerCase(), r.jobs);
    }

    // Bill 1 credit per job found (across all companies), before any DB writes
    // so an out-of-credits org is hard-blocked rather than getting free roles.
    const totalJobsFound = [...jobsByCompany.values()].reduce((s, arr) => s + arr.length, 0);
    if (totalJobsFound > 0) {
      await deductCredits({
        orgId,
        action: "job_scraping",
        quantity: totalJobsFound,
        userId,
        description: "Magic Enrich — find job posts",
        metadata: { funnelId },
      });
    }

    let jobsFound = 0;
    let rolesCreated = 0;
    const leadsEnriched = new Set<string>();
    const newRoles: Array<typeof leadHiringRoles.$inferInsert> = [];

    for (const c of companies) {
      const jobs = jobsByCompany.get(c.name.toLowerCase()) || [];
      if (jobs.length === 0) continue;
      jobsFound += jobs.length;

      // Leads at this company in the funnel (by name, or domain).
      const domain = (c.domain || "").trim();
      const companyLeads = await db
        .select({ id: leads.id })
        .from(leads)
        .where(
          and(
            eq(leads.funnelId, funnelId),
            domain
              ? or(sql`lower(${leads.company}) = lower(${c.name})`, eq(leads.companyDomain, domain))!
              : sql`lower(${leads.company}) = lower(${c.name})`,
          ),
        );
      if (companyLeads.length === 0) continue;

      // Distinct roles from the jobs.
      const roles = jobs.map(jobToRole).filter((r) => r.title);
      const titleSet = new Set<string>();
      const distinctRoles = roles.filter((r) => {
        const k = r.title.toLowerCase();
        if (titleSet.has(k)) return false;
        titleSet.add(k);
        return true;
      });
      if (distinctRoles.length === 0) continue;

      for (const lead of companyLeads) {
        // Dedupe against existing role titles for this lead.
        const existing = await db
          .select({ title: leadHiringRoles.title })
          .from(leadHiringRoles)
          .where(eq(leadHiringRoles.leadId, lead.id));
        const have = new Set(existing.map((e) => e.title.toLowerCase()));
        for (const r of distinctRoles) {
          if (have.has(r.title.toLowerCase())) continue;
          have.add(r.title.toLowerCase());
          newRoles.push({
            id: createId("hrole"),
            organizationId: orgId,
            funnelId,
            leadId: lead.id,
            title: r.title,
            description: r.description,
            salaryRange: r.salaryRange,
            location: r.location,
            postedAgo: r.postedAgo,
            seniority: r.seniority,
            url: r.url,
            createdBy: userId,
          });
        }
        leadsEnriched.add(lead.id);
        // Keep the lead's simple hiring-roles title list in sync.
        await db
          .update(leads)
          .set({ companyHiringRoles: distinctRoles.map((r) => r.title), updatedAt: new Date() })
          .where(eq(leads.id, lead.id));
      }
    }

    for (let i = 0; i < newRoles.length; i += 500) {
      await db.insert(leadHiringRoles).values(newRoles.slice(i, i + 500));
    }
    rolesCreated = newRoles.length;

    res.json({
      data: {
        companiesSearched: companies.length,
        companiesRequested: requestedCompanies.length,
        capped: requestedCompanies.length > companies.length,
        jobsFound,
        rolesCreated,
        leadsEnriched: leadsEnriched.size,
      },
    });
  }),
);

// ─── POST /funnels/:funnelId/enrich-companies ───────────────────────────
// "Magic Enrich → Company data from domain": for each lead's domain (from its
// company domain, else its business email), look up firmographics on TheirStack
// and fill the company fields. Bills CREDIT_COSTS.company_enrichment per DISTINCT
// company resolved. Pass leadIds to target a specific set (e.g. a fresh import),
// or omit to enrich the whole campaign.
const EMPLOYEE_CAP = 2_000_000_000;
function formatRevenueUsd(n: number | null | undefined): string | null {
  if (!n || !Number.isFinite(n) || n <= 0) return null;
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${Math.round(n / 1_000)}K`;
  return `$${Math.round(n)}`;
}

router.post(
  "/funnels/:funnelId/enrich-companies",
  requirePerm("leads.enrich"),
  asyncHandler<{ funnelId: string }>(async (req, res) => {
    const orgId = getOrgId(req);
    const funnelId = req.params.funnelId;
    const body = req.body as { leadIds?: string[] };

    const [funnel] = await db
      .select({ id: funnels.id })
      .from(funnels)
      .where(and(eq(funnels.id, funnelId), eq(funnels.organizationId, orgId)))
      .limit(1);
    if (!funnel) throw new ApiError(404, "Campaign not found");

    const token = process.env.THEIRSTACK_API_KEY;
    if (!token) throw new ApiError(500, "THEIRSTACK_API_KEY is not configured");

    // Target leads: the passed ids (scoped to this funnel) or the whole funnel.
    const leadRows = await db
      .select()
      .from(leads)
      .where(
        Array.isArray(body.leadIds) && body.leadIds.length > 0
          ? and(eq(leads.funnelId, funnelId), inArray(leads.id, body.leadIds))
          : eq(leads.funnelId, funnelId),
      );

    // Resolve each lead's domain (explicit company domain, else business email).
    const domainByLead = new Map<string, string>();
    for (const l of leadRows) {
      const d = normalizeDomain(l.companyDomain || "") || domainFromEmail(l.email || "");
      if (d) domainByLead.set(l.id, d);
    }
    const distinctDomains = Array.from(new Set(domainByLead.values()));
    const ENRICH_CAP = 200;
    const capped = distinctDomains.length > ENRICH_CAP;
    let domains = distinctDomains.slice(0, ENRICH_CAP);

    if (domains.length === 0) {
      res.json({
        data: { domainsQueried: 0, companiesEnriched: 0, leadsUpdated: 0, capped: false, creditsCharged: 0 },
      });
      return;
    }

    // Credit pre-flight — need at least one company's worth. Then cap the domains
    // we query to what the balance can actually pay for (3 credits per company).
    const unit = CREDIT_COSTS.company_enrichment;
    const balance = await getBalance(orgId);
    if (balance < unit) throw new InsufficientCreditsError(unit, balance);
    const affordable = Math.floor(balance / unit);
    if (domains.length > affordable) domains = domains.slice(0, affordable);

    const client = new TheirStackClient(token);
    const userId = getAuth(req)?.userId || null;

    // Query in chunks; limit must be >= chunk size so every domain can resolve.
    const CHUNK = 25;
    const byDomain = new Map<string, TheirStackCompanyRecord>();
    for (let i = 0; i < domains.length; i += CHUNK) {
      const chunk = domains.slice(i, i + CHUNK);
      try {
        const resp = await client.searchCompanies({ company_domain_or: chunk, limit: chunk.length });
        for (const c of resp.data || []) {
          const keys = [c.domain, ...(c.possible_domains || [])]
            .map((d) => normalizeDomain(d || ""))
            .filter(Boolean);
          for (const k of keys) if (!byDomain.has(k)) byDomain.set(k, c);
        }
      } catch (err) {
        console.warn(`[enrich-companies] chunk failed:`, err instanceof Error ? err.message : err);
      }
    }

    const uniqueCompanies = new Map([...byDomain.values()].map((c) => [c.id, c]));
    const companiesEnriched = uniqueCompanies.size;

    // Bill BEFORE writes so an out-of-credits org can't get free enrichment.
    if (companiesEnriched > 0) {
      await deductCredits({
        orgId,
        action: "company_enrichment",
        quantity: companiesEnriched,
        userId,
        description: "Company enrichment from domain",
        metadata: { funnelId },
      });
    }

    // Back-fill each lead's company fields from its matched company. Only fill
    // blanks (never clobber user-provided data); replace the placeholder company
    // name (equal to the domain) with the real one.
    const now = new Date();
    let leadsUpdated = 0;
    for (const l of leadRows) {
      const d = domainByLead.get(l.id);
      if (!d) continue;
      const c = byDomain.get(d);
      if (!c) continue;
      const patch: Partial<typeof leads.$inferInsert> = {};
      const realName = (c.name || "").trim();
      // Replace the company only when it's still a placeholder — blank, the raw
      // domain, or the readable-from-domain name we set at import.
      const isPlaceholder =
        !l.company ||
        l.company.toLowerCase() === d ||
        l.company === companyFromDomain(d);
      if (realName && isPlaceholder) patch.company = realName;
      if (!l.companyDomain) patch.companyDomain = normalizeDomain(c.domain || d) || null;
      if (!l.companyIndustry && c.industry) patch.companyIndustry = c.industry;
      if (l.companyEmployeeCount == null && c.employee_count) {
        patch.companyEmployeeCount = Math.min(Math.round(c.employee_count), EMPLOYEE_CAP);
      }
      const loc = [c.city, c.country].filter(Boolean).join(", ");
      if (!l.companyLocation && loc) patch.companyLocation = loc;
      if (!l.companyDescription && c.long_description) patch.companyDescription = c.long_description.slice(0, 1000);
      if (!l.companyLinkedin && c.linkedin_url) patch.companyLinkedin = c.linkedin_url;
      if (!l.companyAnnualRevenue) {
        const rev = formatRevenueUsd(c.annual_revenue_usd);
        if (rev) patch.companyAnnualRevenue = rev;
      }
      if (Object.keys(patch).length > 0) {
        patch.updatedAt = now;
        await db.update(leads).set(patch).where(eq(leads.id, l.id));
        leadsUpdated += 1;
      }
    }

    // Upsert the resolved companies into the org's master company DB.
    for (const c of uniqueCompanies.values()) {
      const dom = normalizeDomain(c.domain || "");
      if (!c.name || !dom) continue;
      await db
        .insert(masterCompanies)
        .values({
          id: createId("company"),
          organizationId: orgId,
          name: c.name.trim(),
          domain: dom,
          linkedinUrl: c.linkedin_url || null,
          industry: c.industry || null,
          employeeCount: c.employee_count ? Math.min(Math.round(c.employee_count), EMPLOYEE_CAP) : null,
          revenue: c.annual_revenue_usd ? Math.round(c.annual_revenue_usd) : null,
          fundingStage: c.funding_stage || null,
          country: c.country || null,
          city: c.city || null,
          logo: c.logo || null,
          description: c.long_description ? c.long_description.slice(0, 2000) : null,
          lastSeenAt: now,
          createdAt: now,
          updatedAt: now,
        })
        // The import may have created a placeholder company for this domain —
        // correct it with the enriched firmographics.
        .onConflictDoUpdate({
          target: [masterCompanies.organizationId, masterCompanies.domain],
          set: {
            name: c.name.trim(),
            linkedinUrl: c.linkedin_url || null,
            industry: c.industry || null,
            employeeCount: c.employee_count ? Math.min(Math.round(c.employee_count), EMPLOYEE_CAP) : null,
            revenue: c.annual_revenue_usd ? Math.round(c.annual_revenue_usd) : null,
            fundingStage: c.funding_stage || null,
            country: c.country || null,
            city: c.city || null,
            logo: c.logo || null,
            description: c.long_description ? c.long_description.slice(0, 2000) : null,
            lastSeenAt: now,
            updatedAt: now,
          },
        });
    }

    res.json({
      data: {
        domainsQueried: domains.length,
        companiesEnriched,
        leadsUpdated,
        creditsCharged: companiesEnriched * unit,
        capped: capped || distinctDomains.length > domains.length,
      },
    });
  }),
);

export default router;
