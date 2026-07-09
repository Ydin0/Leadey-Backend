import { Router, Request, Response, NextFunction } from "express";
import { eq, and, or, ilike, ne, inArray, count, countDistinct, desc, sql, type SQL } from "drizzle-orm";
import { getAuth } from "@clerk/express";
import { db } from "../db/index";
import { leads, leadEvents } from "../db/schema/leads";
import { funnels, funnelSteps, funnelMembers } from "../db/schema/funnels";
import { callRecords } from "../db/schema/call-records";
import { getOrgId } from "../lib/auth";
import { ApiError, createId, dedupeKey } from "../lib/helpers";
import { buildLeadFilterWhere, decodeFilterParam } from "../lib/lead-filter";
import { getPerms, getVisibleFunnelIds, leadVisibilityCondition, requirePerm } from "../lib/permission-service";
import { createTtlCache } from "../lib/ttl-cache";
import { getCustomFieldsForLeads, type LeadCustomField } from "../lib/custom-fields-service";

const router = Router();

function asyncHandler(handler: (req: Request, res: Response, next: NextFunction) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const truthy = (v: unknown): boolean => v === "1" || v === "true";

/** The leads.view visibility predicate for this request (or null = no extra
 *  filter). Returns sql`false` when the user may see nothing. Callers must have
 *  `funnels` joined (for the campaign-scoped case). */
async function leadVisibilityForReq(req: Request): Promise<SQL | null> {
  const orgId = getOrgId(req);
  const userId = getAuth(req)?.userId || "";
  const perms = await getPerms(req);
  const visible = await getVisibleFunnelIds(orgId, userId, perms.permissions);
  return leadVisibilityCondition(perms.permissions, visible);
}

/** Build the WHERE conditions for the org-wide leads query from query params.
 *  Always org-scoped (the caller joins funnels). */
function buildLeadConditions(orgId: string, q: Record<string, unknown>): SQL[] {
  const c: SQL[] = [eq(funnels.organizationId, orgId)];

  const search = str(q.search);
  if (search) {
    const like = `%${search}%`;
    const ors = [
      ilike(leads.name, like),
      ilike(leads.company, like),
      ilike(leads.email, like),
      ilike(leads.title, like),
      ilike(leads.companyLocation, like),
    ].filter(Boolean) as SQL[];
    c.push(or(...ors)!);
  }
  const company = str(q.company);
  if (company) c.push(ilike(leads.company, `%${company}%`));
  const title = str(q.title);
  if (title) c.push(ilike(leads.title, `%${title}%`));
  const location = str(q.location);
  if (location) c.push(ilike(leads.companyLocation, `%${location}%`));
  const industry = str(q.industry);
  if (industry) c.push(ilike(leads.companyIndustry, `%${industry}%`));

  const status = str(q.status);
  if (status) c.push(eq(leads.status, status));
  const sourceType = str(q.sourceType);
  if (sourceType) c.push(eq(leads.sourceType, sourceType));
  const funnelId = str(q.funnelId);
  if (funnelId) c.push(eq(leads.funnelId, funnelId));

  if (truthy(q.hasEmail)) c.push(ne(leads.email, ""));
  if (truthy(q.hasPhone)) c.push(ne(leads.phone, ""));
  if (truthy(q.hasLinkedin)) c.push(ne(leads.linkedinUrl, ""));
  if (truthy(q.doNotCall)) c.push(eq(leads.doNotCall, true));

  const minEmp = Number(q.minEmployees);
  if (Number.isFinite(minEmp) && minEmp > 0) c.push(sql`${leads.companyEmployeeCount} >= ${minEmp}`);
  const maxEmp = Number(q.maxEmployees);
  if (Number.isFinite(maxEmp) && maxEmp > 0) c.push(sql`${leads.companyEmployeeCount} <= ${maxEmp}`);

  // Close-style query builder (Smart Views) — AND its predicate onto the rest.
  const filterWhere = buildLeadFilterWhere(decodeFilterParam(q.filter), { orgId });
  if (filterWhere) c.push(filterWhere);

  return c;
}

function serializeLead(r: typeof leads.$inferSelect & { funnelName?: string | null }) {
  return {
    id: r.id,
    funnelId: r.funnelId,
    funnelName: r.funnelName ?? null,
    name: r.name,
    title: r.title,
    company: r.company,
    email: r.email,
    phone: r.phone,
    linkedinUrl: r.linkedinUrl,
    status: r.status,
    source: r.source,
    sourceType: r.sourceType,
    score: r.score,
    companyDomain: r.companyDomain,
    companyIndustry: r.companyIndustry,
    companyEmployeeCount: r.companyEmployeeCount,
    companyLocation: r.companyLocation,
    doNotCall: r.doNotCall,
    opportunityId: r.opportunityId ?? null,
    createdAt: r.createdAt.toISOString(),
  };
}

/** Full-fat serialization for the org-wide leads TABLE — everything the shared
 *  campaign lead table renders (sequence position, firmographics, custom
 *  fields, extras). Events stay out; activity counts arrive deferred via
 *  GET /leads/activity-counts. */
function serializeLeadFull(
  r: typeof leads.$inferSelect & { funnelName?: string | null },
  customFields: LeadCustomField[],
) {
  return {
    ...serializeLead(r),
    personId: r.masterContactId ?? null,
    firstName: r.firstName,
    lastName: r.lastName,
    extraEmails: r.extraEmails ?? [],
    extraPhones: r.extraPhones ?? [],
    currentStep: r.currentStep,
    totalSteps: r.totalSteps,
    nextAction: r.nextAction,
    nextDate: r.nextDate ? r.nextDate.toISOString() : null,
    companyDescription: r.companyDescription,
    companyLinkedin: r.companyLinkedin,
    companyAnnualRevenue: r.companyAnnualRevenue,
    companyHiringRoles: r.companyHiringRoles,
    notes: r.notes,
    customFields,
  };
}

/** Hard ceiling for the load-all org table — beyond this the response flags
 *  `truncated` and the UI tells the user to refine/export. Raised 20k -> 50k
 *  (Jul 2026, org crossed 23.5k); past ~50k the answer is server-side
 *  pagination/filtering, not a bigger cap — the payload stops being sane. */
const ALL_LEADS_CAP = 50_000;

// ─── GET /leads — every campaign lead across the org, filtered + paginated ──
// `all=1` switches to the load-all mode that feeds the org leads TABLE: full
// lead shape (see serializeLeadFull), newest first, capped at ALL_LEADS_CAP.
router.get(
  "/leads",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const conds = buildLeadConditions(orgId, req.query as Record<string, unknown>);
    const vis = await leadVisibilityForReq(req);
    if (vis) conds.push(vis);

    const [{ total }] = await db
      .select({ total: count() })
      .from(leads)
      .innerJoin(funnels, eq(leads.funnelId, funnels.id))
      .where(and(...conds));

    if (truthy(req.query.all)) {
      const rows = await db
        .select({ lead: leads, funnelName: funnels.name })
        .from(leads)
        .innerJoin(funnels, eq(leads.funnelId, funnels.id))
        .where(and(...conds))
        .orderBy(desc(leads.createdAt))
        .limit(ALL_LEADS_CAP);

      // Custom field values in bounded chunks (org tables can be large).
      const cfByLead = new Map<string, LeadCustomField[]>();
      const ids = rows.map((r) => r.lead.id);
      for (let i = 0; i < ids.length; i += 5000) {
        const part = await getCustomFieldsForLeads(ids.slice(i, i + 5000));
        for (const [k, v] of part) cfByLead.set(k, v);
      }

      res.json({
        data: rows.map((r) => serializeLeadFull({ ...r.lead, funnelName: r.funnelName }, cfByLead.get(r.lead.id) ?? [])),
        meta: { totalCount: Number(total), truncated: Number(total) > ALL_LEADS_CAP },
      });
      return;
    }

    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize) || 50));
    const rows = await db
      .select({ lead: leads, funnelName: funnels.name })
      .from(leads)
      .innerJoin(funnels, eq(leads.funnelId, funnels.id))
      .where(and(...conds))
      .orderBy(sql`lower(${leads.company})`, desc(leads.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    res.json({
      data: rows.map((r) => serializeLead({ ...r.lead, funnelName: r.funnelName })),
      meta: { page, pageSize, totalCount: Number(total), totalPages: Math.ceil(Number(total) / pageSize) },
    });
  }),
);

// ─── GET /leads/activity-counts — per-lead call/email totals, org-wide ──────
// Same semantics as the per-funnel deferred endpoint (api.ts): calls = MAX of
// the telephony log (matched by phone digits) and logged call events; emails
// from events. Aggregated org-wide (the org table IS the full set, so there is
// no key list to scope by) and cached for 60s per org.
const orgActivityCache = createTtlCache<Record<string, { calls: number; emails: number }>>(60_000);

router.get(
  "/leads/activity-counts",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const cached = orgActivityCache.get(orgId);
    if (cached) {
      res.json({ data: { counts: cached } });
      return;
    }

    const normPhone = (p: string | null | undefined) => (p || "").replace(/[^0-9]/g, "");
    const toDigits = sql`regexp_replace(${callRecords.toNumber}, '[^0-9]', '', 'g')`;
    const fromDigits = sql`regexp_replace(${callRecords.fromNumber}, '[^0-9]', '', 'g')`;

    const [orgLeads, outRows, inRows, eventRows] = await Promise.all([
      db
        .select({ id: leads.id, phone: leads.phone, email: leads.email })
        .from(leads)
        .innerJoin(funnels, eq(leads.funnelId, funnels.id))
        .where(eq(funnels.organizationId, orgId)),
      db
        .select({ phone: sql<string>`${toDigits}`, n: sql<number>`count(*)::int` })
        .from(callRecords)
        .where(and(eq(callRecords.organizationId, orgId), eq(callRecords.direction, "outbound")))
        .groupBy(toDigits),
      db
        .select({ phone: sql<string>`${fromDigits}`, n: sql<number>`count(*)::int` })
        .from(callRecords)
        .where(and(eq(callRecords.organizationId, orgId), sql`${callRecords.direction} <> 'outbound'`))
        .groupBy(fromDigits),
      db
        .select({
          leadId: leadEvents.leadId,
          calls: sql<number>`count(*) filter (where ${leadEvents.type} = 'call' OR (${leadEvents.type} = 'step_outcome' AND ${leadEvents.meta} ->> 'channel' = 'call') OR ${leadEvents.outcome} = 'call_completed')::int`,
          emails: sql<number>`count(*) filter (where ${leadEvents.type} IN ('smartlead_webhook','email_sent','reply_handled') OR (${leadEvents.type} = 'step_outcome' AND ${leadEvents.meta} ->> 'channel' = 'email'))::int`,
        })
        .from(leadEvents)
        .innerJoin(leads, eq(leadEvents.leadId, leads.id))
        .innerJoin(funnels, eq(leads.funnelId, funnels.id))
        .where(eq(funnels.organizationId, orgId))
        .groupBy(leadEvents.leadId),
    ]);

    const callsByPhone = new Map<string, number>();
    for (const r of [...outRows, ...inRows]) {
      if (r.phone) callsByPhone.set(r.phone, (callsByPhone.get(r.phone) ?? 0) + Number(r.n));
    }

    // Event totals per person key: the same person appears in several
    // campaigns, so counts roll up by phone/email across all their rows.
    const evByLead = new Map(eventRows.map((r) => [r.leadId, r]));
    const evCallsByPhone = new Map<string, number>();
    const evEmailsByAddr = new Map<string, number>();
    for (const l of orgLeads) {
      const ev = evByLead.get(l.id);
      if (!ev) continue;
      const p = normPhone(l.phone);
      const e = (l.email || "").toLowerCase();
      if (p.length > 5) evCallsByPhone.set(p, (evCallsByPhone.get(p) ?? 0) + ev.calls);
      if (e) evEmailsByAddr.set(e, (evEmailsByAddr.get(e) ?? 0) + ev.emails);
    }

    const counts: Record<string, { calls: number; emails: number }> = {};
    for (const l of orgLeads) {
      const p = normPhone(l.phone);
      const e = (l.email || "").toLowerCase();
      const calls = Math.max(p.length > 5 ? callsByPhone.get(p) ?? 0 : 0, evCallsByPhone.get(p) ?? 0);
      const emails = evEmailsByAddr.get(e) ?? 0;
      if (calls || emails) counts[l.id] = { calls, emails };
    }

    orgActivityCache.set(orgId, counts);
    res.json({ data: { counts } });
  }),
);

// ─── GET /leads/export — CSV of every lead matching the (Smart View) filter ──
router.get(
  "/leads/export",
  requirePerm("leads.export"),
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const conds = buildLeadConditions(orgId, req.query as Record<string, unknown>);
    const vis = await leadVisibilityForReq(req);
    if (vis) conds.push(vis);
    const rows = await db
      .select({ lead: leads, funnelName: funnels.name })
      .from(leads)
      .innerJoin(funnels, eq(leads.funnelId, funnels.id))
      .where(and(...conds))
      .orderBy(sql`lower(${leads.company})`, desc(leads.createdAt))
      .limit(50000);

    const headers = ["Name", "First Name", "Last Name", "Title", "Company", "Email", "Phone", "LinkedIn", "Status", "Source", "Score", "Domain", "Industry", "Employees", "Location", "Campaign", "Created"];
    const esc = (v: unknown) => {
      const s = v == null ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [headers.join(",")];
    for (const { lead: l, funnelName } of rows) {
      lines.push([
        l.name, l.firstName, l.lastName, l.title, l.company, l.email, l.phone, l.linkedinUrl,
        l.status, l.source, l.score, l.companyDomain, l.companyIndustry, l.companyEmployeeCount,
        l.companyLocation, funnelName, l.createdAt?.toISOString(),
      ].map(esc).join(","));
    }
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="leads-export.csv"');
    res.send(lines.join("\n"));
  }),
);

// ─── GET /leads/companies — the same leads grouped by company (companies-first)
router.get(
  "/leads/companies",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 25));
    const conds = buildLeadConditions(orgId, req.query as Record<string, unknown>);
    const vis = await leadVisibilityForReq(req);
    if (vis) conds.push(vis);

    const grouped = db
      .select({
        company: leads.company,
        leadCount: count(leads.id).as("lead_count"),
        campaigns: countDistinct(leads.funnelId).as("campaigns"),
        withEmail: sql<number>`count(*) filter (where ${leads.email} <> '')`.as("with_email"),
        withPhone: sql<number>`count(*) filter (where ${leads.phone} <> '')`.as("with_phone"),
        domain: sql<string | null>`max(${leads.companyDomain})`.as("domain"),
        industry: sql<string | null>`max(${leads.companyIndustry})`.as("industry"),
        location: sql<string | null>`max(${leads.companyLocation})`.as("location"),
        employees: sql<number | null>`max(${leads.companyEmployeeCount})`.as("employees"),
        statuses: sql<string[]>`array_agg(distinct ${leads.status})`.as("statuses"),
        // Universal-profile deep link for the Companies tab.
        masterCompanyId: sql<string | null>`max(${leads.masterCompanyId})`.as("master_company_id"),
      })
      .from(leads)
      .innerJoin(funnels, eq(leads.funnelId, funnels.id))
      .where(and(...conds))
      .groupBy(leads.company)
      .as("g");

    const [{ total }] = await db.select({ total: count() }).from(grouped);

    const rows = await db
      .select()
      .from(grouped)
      .orderBy(desc(grouped.leadCount))
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    // Activity totals for this page's companies. Calls come from call_records
    // matched by PHONE (every rep + channel, org-wide), emails from email events
    // — the same "total times contacted" basis as the per-lead counter.
    const norm = (p: string | null | undefined) => (p || "").replace(/[^0-9]/g, "");
    const pageCompanies = rows.map((r) => r.company).filter(Boolean) as string[];
    const activityByCompany = new Map<string, { calls: number; emails: number }>();
    if (pageCompanies.length) {
      // Phones per company (for the call-by-phone match).
      const leadPhones = await db
        .select({ company: leads.company, phone: leads.phone })
        .from(leads)
        .innerJoin(funnels, eq(leads.funnelId, funnels.id))
        .where(and(eq(funnels.organizationId, orgId), inArray(leads.company, pageCompanies)));
      const phonesByCompany = new Map<string, Set<string>>();
      const allPhones = new Set<string>();
      for (const lp of leadPhones) {
        const d = norm(lp.phone);
        if (d.length <= 5) continue;
        if (!phonesByCompany.has(lp.company)) phonesByCompany.set(lp.company, new Set());
        phonesByCompany.get(lp.company)!.add(d);
        allPhones.add(d);
      }
      // Org calls grouped by normalized phone — constrained to this page's
      // phone set so the digit expression index serves it (previously this
      // aggregated the org's ENTIRE call log on every page).
      const callsByPhone = new Map<string, number>();
      if (allPhones.size) {
        const toDigits = sql`regexp_replace(${callRecords.toNumber}, '[^0-9]', '', 'g')`;
        const callRows = await db
          .select({
            phone: sql<string>`${toDigits}`,
            n: sql<number>`count(*)::int`,
          })
          .from(callRecords)
          .where(and(
            eq(callRecords.organizationId, orgId),
            eq(callRecords.direction, "outbound"),
            inArray(toDigits, [...allPhones]),
          ))
          .groupBy(toDigits);
        for (const r of callRows) if (r.phone && allPhones.has(r.phone)) callsByPhone.set(r.phone, r.n);
      }
      // Email events per company (matched on the company's lead rows).
      const emailRows = await db
        .select({
          company: leads.company,
          emails: sql<number>`count(*) filter (where ${leadEvents.type} IN ('smartlead_webhook','email_sent','reply_handled') OR (${leadEvents.type} = 'step_outcome' AND ${leadEvents.meta} ->> 'channel' = 'email'))::int`,
        })
        .from(leadEvents)
        .innerJoin(leads, eq(leadEvents.leadId, leads.id))
        .innerJoin(funnels, eq(leads.funnelId, funnels.id))
        .where(and(eq(funnels.organizationId, orgId), inArray(leads.company, pageCompanies)))
        .groupBy(leads.company);
      const emailByCompany = new Map(emailRows.map((e) => [e.company, e.emails]));
      for (const company of pageCompanies) {
        let calls = 0;
        for (const d of phonesByCompany.get(company) ?? []) calls += callsByPhone.get(d) ?? 0;
        activityByCompany.set(company, { calls, emails: emailByCompany.get(company) ?? 0 });
      }
    }

    // Representative status: first non-new/pending status, else any, else "new".
    const repStatus = (statuses: string[] | null): string => {
      const list = (statuses || []).filter(Boolean);
      return list.find((s) => s !== "new" && s !== "pending") || list[0] || "new";
    };

    res.json({
      data: rows.map((r) => ({
        company: r.company,
        leadCount: Number(r.leadCount),
        campaigns: Number(r.campaigns),
        withEmail: Number(r.withEmail),
        withPhone: Number(r.withPhone),
        domain: r.domain,
        industry: r.industry,
        location: r.location,
        employees: r.employees,
        status: repStatus(r.statuses),
        callCount: activityByCompany.get(r.company)?.calls ?? 0,
        emailCount: activityByCompany.get(r.company)?.emails ?? 0,
        masterCompanyId: r.masterCompanyId,
      })),
      meta: { page, pageSize, totalCount: Number(total), totalPages: Math.ceil(Number(total) / pageSize) },
    });
  }),
);

// ─── GET /leads/filter-insights — per-lead derived filter values ─────────────
// Sparse map used by the client-side filter evaluator for fields the lead
// rows don't carry: opportunity stage + AI call outcomes. Fetched only while
// a filter actually uses those fields. ?funnelId= scopes to one campaign.
router.get(
  "/leads/filter-insights",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const funnelId = typeof req.query.funnelId === "string" ? req.query.funnelId : null;
    const leadScope = and(
      eq(funnels.organizationId, orgId),
      funnelId ? eq(leads.funnelId, funnelId) : undefined,
    );

    const [stageRows, outcomeRows] = await Promise.all([
      db
        .select({ leadId: leads.id, stage: sql<string>`ps.label` })
        .from(leads)
        .innerJoin(funnels, eq(leads.funnelId, funnels.id))
        .innerJoin(sql`opportunities o`, sql`o.id = ${leads.opportunityId}`)
        .innerJoin(sql`pipeline_stages ps`, sql`ps.id = o.stage_id`)
        .where(leadScope),
      db
        .select({ leadId: leads.id, outcome: sql<string>`cr.outcome` })
        .from(leads)
        .innerJoin(funnels, eq(leads.funnelId, funnels.id))
        .innerJoin(
          sql`call_records cr`,
          sql`cr.organization_id = ${orgId} and cr.outcome is not null and (cr.lead_id = ${leads.id} or (${leads.phone} <> '' and regexp_replace(coalesce(cr.to_number, ''), '[^0-9]', '', 'g') = regexp_replace(${leads.phone}, '[^0-9]', '', 'g')))`,
        )
        .where(leadScope),
    ]);

    const insights: Record<string, { oppStage: string | null; callOutcomes: string[] }> = {};
    const entry = (id: string) => (insights[id] ??= { oppStage: null, callOutcomes: [] });
    for (const r of stageRows) entry(r.leadId).oppStage = r.stage;
    for (const r of outcomeRows) {
      const e = entry(r.leadId);
      if (!e.callOutcomes.includes(r.outcome)) e.callOutcomes.push(r.outcome);
    }
    res.json({ data: { insights } });
  }),
);

// ─── GET /leads/transcript-matches — leads whose calls mention a phrase ──────
// ?q=<keyword>[&funnelId=] → lead ids with any call transcript containing it.
router.get(
  "/leads/transcript-matches",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const funnelId = typeof req.query.funnelId === "string" ? req.query.funnelId : null;
    if (!q) {
      res.json({ data: { leadIds: [] } });
      return;
    }

    const rows = await db
      .selectDistinct({ id: leads.id })
      .from(leads)
      .innerJoin(funnels, eq(leads.funnelId, funnels.id))
      .where(
        and(
          eq(funnels.organizationId, orgId),
          funnelId ? eq(leads.funnelId, funnelId) : undefined,
          sql`exists (select 1 from call_records cr where cr.organization_id = ${orgId} and (cr.lead_id = ${leads.id} or (${leads.phone} <> '' and regexp_replace(coalesce(cr.to_number, ''), '[^0-9]', '', 'g') = regexp_replace(${leads.phone}, '[^0-9]', '', 'g'))) and cr.transcript ilike ${`%${q}%`})`,
        ),
      );
    res.json({ data: { leadIds: rows.map((r) => r.id) } });
  }),
);

// ─── POST /leads/bulk-delete — org-wide permanent delete ────────────────────
// The org Leads page shows every enrollment row across campaigns; deleting a
// selection removes exactly those rows (events/tasks/docs cascade). Behind a
// typed confirmation client-side.
router.post(
  "/leads/bulk-delete",
  requirePerm("leads.delete"),
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const leadIds: string[] = Array.isArray(req.body?.leadIds)
      ? (req.body.leadIds as unknown[]).map(String).filter(Boolean)
      : [];
    if (leadIds.length === 0) throw new ApiError(400, "leadIds is required");
    if (leadIds.length > 5000) throw new ApiError(400, "Too many leads in one request (max 5000)");

    // Only rows that genuinely belong to this org count as targets.
    const targets = await db
      .select({ id: leads.id })
      .from(leads)
      .innerJoin(funnels, eq(leads.funnelId, funnels.id))
      .where(and(eq(funnels.organizationId, orgId), inArray(leads.id, leadIds)));

    const ids = targets.map((t) => t.id);
    for (let i = 0; i < ids.length; i += 500) {
      await db.delete(leads).where(inArray(leads.id, ids.slice(i, i + 500)));
    }
    res.json({ data: { deleted: ids.length } });
  }),
);

// ─── GET /leads/:id/funnel — resolve a lead's campaign id (standalone profile)
// Lets the org-wide Leads page open a lead's full profile without already
// knowing which campaign owns it (e.g. a pasted /dashboard/leads/:id link).
router.get(
  "/leads/:id/funnel",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const [row] = await db
      .select({ funnelId: leads.funnelId })
      .from(leads)
      .innerJoin(funnels, eq(leads.funnelId, funnels.id))
      .where(and(eq(leads.id, req.params.id as string), eq(funnels.organizationId, orgId)))
      .limit(1);
    if (!row) throw new ApiError(404, "Lead not found");
    res.json({ data: { funnelId: row.funnelId } });
  }),
);

// ─── GET /leads/facets — KPI counts + filter option lists ───────────────────
router.get(
  "/leads/facets",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const vis = await leadVisibilityForReq(req);
    const scope = (base: SQL) => (vis ? and(base, vis)! : base);

    const [agg] = await db
      .select({
        total: count(),
        companies: countDistinct(leads.company),
        withEmail: sql<number>`count(*) filter (where ${leads.email} <> '')`,
        withPhone: sql<number>`count(*) filter (where ${leads.phone} <> '')`,
        dnc: sql<number>`count(*) filter (where ${leads.doNotCall})`,
      })
      .from(leads)
      .innerJoin(funnels, eq(leads.funnelId, funnels.id))
      .where(scope(eq(funnels.organizationId, orgId)));

    const campaigns = await db
      .select({ id: funnels.id, name: funnels.name })
      .from(funnels)
      .where(eq(funnels.organizationId, orgId))
      .orderBy(funnels.name);

    const sourceRows = await db
      .select({ sourceType: leads.sourceType })
      .from(leads)
      .innerJoin(funnels, eq(leads.funnelId, funnels.id))
      .where(scope(eq(funnels.organizationId, orgId)))
      .groupBy(leads.sourceType);

    const statusRows = await db
      .select({ status: leads.status })
      .from(leads)
      .innerJoin(funnels, eq(leads.funnelId, funnels.id))
      .where(scope(eq(funnels.organizationId, orgId)))
      .groupBy(leads.status);

    res.json({
      data: {
        total: Number(agg?.total ?? 0),
        companies: Number(agg?.companies ?? 0),
        withEmail: Number(agg?.withEmail ?? 0),
        withPhone: Number(agg?.withPhone ?? 0),
        doNotCall: Number(agg?.dnc ?? 0),
        campaigns: campaigns.map((c) => ({ id: c.id, name: c.name })),
        sources: sourceRows.map((s) => s.sourceType).filter(Boolean),
        statuses: statusRows.map((s) => s.status).filter(Boolean),
      },
    });
  }),
);

// ─── POST /leads/campaign-from-filter — new campaign from the filtered set ───
router.post(
  "/leads/campaign-from-filter",
  requirePerm("campaigns.create"),
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const body = (req.body || {}) as {
      name?: string;
      description?: string;
      status?: string;
      leadIds?: string[];
      filters?: Record<string, unknown>;
    };
    const name = str(body.name);
    if (!name) throw new ApiError(400, "Campaign name is required");

    // Only build from leads the caller may actually see.
    const vis = await leadVisibilityForReq(req);

    // Resolve the source leads — explicit selection, or everything matching the
    // current filters.
    let sourceRows: (typeof leads.$inferSelect)[];
    if (Array.isArray(body.leadIds) && body.leadIds.length > 0) {
      const conds = [eq(funnels.organizationId, orgId), inArray(leads.id, body.leadIds)];
      if (vis) conds.push(vis);
      sourceRows = await db
        .select({ lead: leads })
        .from(leads)
        .innerJoin(funnels, eq(leads.funnelId, funnels.id))
        .where(and(...conds))
        .then((r) => r.map((x) => x.lead));
    } else {
      const conds = buildLeadConditions(orgId, body.filters || {});
      if (vis) conds.push(vis);
      sourceRows = await db
        .select({ lead: leads })
        .from(leads)
        .innerJoin(funnels, eq(leads.funnelId, funnels.id))
        .where(and(...conds))
        .limit(50000)
        .then((r) => r.map((x) => x.lead));
    }
    if (sourceRows.length === 0) throw new ApiError(400, "No leads match — nothing to add");

    // Dedupe within the new campaign by name+company+email.
    const seen = new Set<string>();
    const unique = sourceRows.filter((l) => {
      const key = dedupeKey(l.name, l.company, l.email);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const funnelId = createId("funnel");
    const now = new Date();
    const status = str(body.status).toLowerCase() === "active" ? "active" : "draft";

    await db.transaction(async (tx) => {
      await tx.insert(funnels).values({
        id: funnelId,
        organizationId: orgId,
        name,
        description: str(body.description),
        status,
        sourceTypes: ["companies"],
        webhookToken: createId("whk"),
        createdAt: now,
      });
      // Seed a single call step so the campaign is valid; the rep edits the
      // sequence in the campaign editor.
      await tx.insert(funnelSteps).values({
        id: createId("step"),
        funnelId,
        channel: "call",
        label: "Cold call",
        dayOffset: 0,
        sortOrder: 0,
        action: "make_call",
      });

      // Carry each source row's canonical person; resolve any not yet linked
      // (pre-backfill rows) so the copies land person-linked either way.
      const { resolvePersonsBulk } = await import("../lib/person-resolve");
      const unlinked = unique.filter((l) => !l.masterContactId);
      const resolvedIds = await resolvePersonsBulk(orgId, unlinked);
      const resolvedByRow = new Map(unlinked.map((l, i) => [l.id, resolvedIds[i]]));

      // Same for the canonical company link.
      const { resolveCompaniesForLeadsBulk } = await import("../lib/master-db");
      const companyUnlinked = unique.filter((l) => !l.masterCompanyId);
      const companyIds = await resolveCompaniesForLeadsBulk(orgId, companyUnlinked);
      const companyByRow = new Map(companyUnlinked.map((l, i) => [l.id, companyIds[i]]));

      const newLeads = unique.map((l) => ({
        id: createId("lead"),
        funnelId,
        masterContactId: l.masterContactId ?? resolvedByRow.get(l.id) ?? null,
        masterCompanyId: l.masterCompanyId ?? companyByRow.get(l.id) ?? null,
        name: l.name,
        title: l.title,
        company: l.company,
        email: l.email,
        phone: l.phone,
        linkedinUrl: l.linkedinUrl,
        currentStep: 1,
        totalSteps: 1,
        status: "pending",
        source: "From Leads",
        sourceType: "companies",
        score: l.score,
        companyDomain: l.companyDomain,
        companyIndustry: l.companyIndustry,
        companyEmployeeCount: l.companyEmployeeCount,
        companyLocation: l.companyLocation,
        companyDescription: l.companyDescription,
        companyLinkedin: l.companyLinkedin,
        companyAnnualRevenue: l.companyAnnualRevenue,
        companyHiringRoles: l.companyHiringRoles,
        doNotCall: l.doNotCall,
        createdAt: now,
        updatedAt: now,
      }));
      const CHUNK = 500;
      for (let i = 0; i < newLeads.length; i += CHUNK) {
        await tx.insert(leads).values(newLeads.slice(i, i + CHUNK));
      }
      const events = newLeads.map((l) => ({
        id: createId("le"),
        leadId: l.id,
        type: "imported",
        outcome: null,
        stepIndex: 0,
        meta: { source: "leads-filter" },
        timestamp: now,
      }));
      for (let i = 0; i < events.length; i += CHUNK) {
        await tx.insert(leadEvents).values(events.slice(i, i + CHUNK));
      }
    });

    // Owner = creator.
    const auth = getAuth(req as unknown as Request);
    if (auth?.userId) {
      await db
        .insert(funnelMembers)
        .values({ id: createId("fm"), funnelId, userId: auth.userId, role: "owner" })
        .onConflictDoNothing();
    }

    res.status(201).json({ data: { funnelId, leadsAdded: unique.length } });
  }),
);

export default router;
