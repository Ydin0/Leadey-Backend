import { Router, Request, Response, NextFunction } from "express";
import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { db } from "../db/index";
import { leads, leadEvents } from "../db/schema/leads";
import { funnels } from "../db/schema/funnels";
import { masterCompanies, masterContacts } from "../db/schema/master";
import { callRecords } from "../db/schema/call-records";
import { emailMessages } from "../db/schema/email-accounts";
import { smsMessages } from "../db/schema/sms";
import { leadHiringRoles } from "../db/schema/hiring-roles";
import { getOrgId } from "../lib/auth";
import { ApiError } from "../lib/helpers";

/**
 * Universal company profile — the org-wide view of ONE company: every contact
 * across every campaign, plus a merged cross-campaign activity timeline where
 * each item carries campaign attribution.
 *
 * Keyed by master_companies.id (leads.master_company_id). A normalized-name /
 * domain fallback keeps leads that predate the company link visible.
 */
const router = Router();

function asyncHandler(handler: (req: Request, res: Response, next: NextFunction) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

const normPhone = (p: string | null | undefined) => (p || "").replace(/[^0-9]/g, "");

async function getCompanyOrThrow(orgId: string, key: string) {
  const [mc] = await db
    .select()
    .from(masterCompanies)
    .where(and(eq(masterCompanies.id, key), eq(masterCompanies.organizationId, orgId)))
    .limit(1);
  if (mc) return mc;
  // Legacy links (scraper company cells, old bookmarks) key the profile by
  // domain / LinkedIn URL / name instead of the canonical id — resolve those
  // too so pre-existing URLs keep working.
  const [legacy] = await db
    .select()
    .from(masterCompanies)
    .where(and(
      eq(masterCompanies.organizationId, orgId),
      or(
        sql`lower(${masterCompanies.domain}) = lower(${key})`,
        sql`lower(${masterCompanies.linkedinUrl}) = lower(${key})`,
        sql`lower(${masterCompanies.name}) = lower(${key})`,
      ),
    ))
    .limit(1);
  if (legacy) return legacy;
  throw new ApiError(404, "Company not found");
}

/** Every lead row at this company across the org's campaigns. Linked rows
 *  match by master_company_id; unlinked rows (pre-backfill or link failures)
 *  fall back to exact domain / normalized-name matching so nothing vanishes.
 *  Synthesized "<slug>.unknown" domains never participate in domain matching. */
async function companyLeadRows(
  orgId: string,
  mc: typeof masterCompanies.$inferSelect,
  funnelId?: string,
) {
  const fallback = [sql`lower(trim(${leads.company})) = lower(trim(${mc.name}))`];
  if (mc.domain && !mc.domain.endsWith(".unknown")) {
    fallback.push(sql`lower(${leads.companyDomain}) = lower(${mc.domain})`);
  }
  const conditions = [
    eq(funnels.organizationId, orgId),
    or(
      eq(leads.masterCompanyId, mc.id),
      and(sql`${leads.masterCompanyId} IS NULL`, or(...fallback)),
    )!,
  ];
  if (funnelId) conditions.push(eq(leads.funnelId, funnelId));

  return db
    .select({
      id: leads.id,
      funnelId: leads.funnelId,
      funnelName: funnels.name,
      funnelStatus: funnels.status,
      masterContactId: leads.masterContactId,
      name: leads.name,
      title: leads.title,
      email: leads.email,
      phone: leads.phone,
      linkedinUrl: leads.linkedinUrl,
      doNotCall: leads.doNotCall,
      status: leads.status,
      currentStep: leads.currentStep,
      totalSteps: leads.totalSteps,
      createdAt: leads.createdAt,
    })
    .from(leads)
    .innerJoin(funnels, eq(leads.funnelId, funnels.id))
    .where(and(...conditions))
    .orderBy(asc(leads.createdAt));
}

type CompanyLeadRow = Awaited<ReturnType<typeof companyLeadRows>>[number];

/** Stable person key: the canonical master contact when linked, else the lead
 *  row itself (a person the identity backfill couldn't resolve). */
const personKeyOf = (r: CompanyLeadRow) => r.masterContactId ?? `lead:${r.id}`;

// ─── GET /companies/:id/profile ────────────────────────────────────────────
// Company header + campaign list + the person layer (contacts grouped by
// canonical person, each with cross-campaign enrollments + activity counts).
router.get(
  "/companies/:id/profile",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const mc = await getCompanyOrThrow(orgId, String(req.params.id));
    const rows = await companyLeadRows(orgId, mc);
    const leadIds = rows.map((r) => r.id);

    // Campaigns present at this company.
    const campaignsByFunnel = new Map<string, { funnelId: string; funnelName: string; funnelStatus: string; leadCount: number }>();
    for (const r of rows) {
      const c = campaignsByFunnel.get(r.funnelId);
      if (c) c.leadCount += 1;
      else campaignsByFunnel.set(r.funnelId, { funnelId: r.funnelId, funnelName: r.funnelName, funnelStatus: r.funnelStatus, leadCount: 1 });
    }

    // Per-lead activity rollups (merged into per-person counts below).
    const eventAgg = new Map<string, { notes: number; emails: number; lastAt: Date | null }>();
    const callByLead = new Map<string, { n: number; lastAt: Date | null }>();
    const callByPhone = new Map<string, { n: number; lastAt: Date | null }>();
    const smsByLead = new Map<string, { n: number; lastAt: Date | null }>();
    const emailMsgByLead = new Map<string, { n: number; lastAt: Date | null }>();

    if (leadIds.length > 0) {
      const [events, callsLead, smsRows, emailRows] = await Promise.all([
        db
          .select({
            leadId: leadEvents.leadId,
            notes: sql<number>`count(*) filter (where ${leadEvents.type} = 'note')::int`,
            emails: sql<number>`count(*) filter (where ${leadEvents.type} IN ('smartlead_webhook','email_sent','reply_handled') OR (${leadEvents.type} = 'step_outcome' AND ${leadEvents.meta} ->> 'channel' = 'email'))::int`,
            lastAt: sql<Date | null>`max(${leadEvents.timestamp})`,
          })
          .from(leadEvents)
          .where(inArray(leadEvents.leadId, leadIds))
          .groupBy(leadEvents.leadId),
        db
          .select({
            leadId: callRecords.leadId,
            n: sql<number>`count(*)::int`,
            lastAt: sql<Date | null>`max(${callRecords.calledAt})`,
          })
          .from(callRecords)
          .where(and(eq(callRecords.organizationId, orgId), inArray(callRecords.leadId, leadIds)))
          .groupBy(callRecords.leadId),
        db
          .select({
            leadId: smsMessages.leadId,
            n: sql<number>`count(*)::int`,
            lastAt: sql<Date | null>`max(${smsMessages.createdAt})`,
          })
          .from(smsMessages)
          .where(and(eq(smsMessages.organizationId, orgId), inArray(smsMessages.leadId, leadIds)))
          .groupBy(smsMessages.leadId),
        db
          .select({
            leadId: emailMessages.leadId,
            n: sql<number>`count(*)::int`,
            lastAt: sql<Date | null>`max(${emailMessages.createdAt})`,
          })
          .from(emailMessages)
          .where(and(eq(emailMessages.organizationId, orgId), inArray(emailMessages.leadId, leadIds)))
          .groupBy(emailMessages.leadId),
      ]);
      for (const e of events) eventAgg.set(e.leadId, { notes: e.notes, emails: e.emails, lastAt: e.lastAt ? new Date(e.lastAt) : null });
      for (const c of callsLead) if (c.leadId) callByLead.set(c.leadId, { n: c.n, lastAt: c.lastAt ? new Date(c.lastAt) : null });
      for (const s of smsRows) if (s.leadId) smsByLead.set(s.leadId, { n: s.n, lastAt: s.lastAt ? new Date(s.lastAt) : null });
      for (const m of emailRows) if (m.leadId) emailMsgByLead.set(m.leadId, { n: m.n, lastAt: m.lastAt ? new Date(m.lastAt) : null });

      // Calls that predate lead stamping match by counterparty phone digits.
      const phoneSet = new Set(rows.map((r) => normPhone(r.phone)).filter((p) => p.length > 5));
      if (phoneSet.size > 0) {
        const counterparty = sql`regexp_replace(case when ${callRecords.direction} = 'outbound' then ${callRecords.toNumber} else ${callRecords.fromNumber} end, '[^0-9]', '', 'g')`;
        const callsPhone = await db
          .select({
            phone: sql<string>`${counterparty}`,
            n: sql<number>`count(*) filter (where ${callRecords.leadId} IS NULL)::int`,
            lastAt: sql<Date | null>`max(${callRecords.calledAt}) filter (where ${callRecords.leadId} IS NULL)`,
          })
          .from(callRecords)
          .where(eq(callRecords.organizationId, orgId))
          .groupBy(counterparty);
        for (const c of callsPhone) {
          if (c.n > 0 && c.phone && phoneSet.has(c.phone)) {
            callByPhone.set(c.phone, { n: c.n, lastAt: c.lastAt ? new Date(c.lastAt) : null });
          }
        }
      }
    }

    // Canonical person records for fallback contact fields + org-level DNC.
    const masterIds = [...new Set(rows.map((r) => r.masterContactId).filter(Boolean) as string[])];
    const masters = masterIds.length
      ? await db.select().from(masterContacts).where(inArray(masterContacts.id, masterIds))
      : [];
    const masterById = new Map(masters.map((m) => [m.id, m]));

    // Group lead rows into people.
    const maxDate = (...ds: (Date | null | undefined)[]) =>
      ds.reduce<Date | null>((acc, d) => (d && (!acc || d > acc) ? d : acc), null);
    const people = new Map<string, CompanyLeadRow[]>();
    for (const r of rows) {
      const key = personKeyOf(r);
      const arr = people.get(key);
      if (arr) arr.push(r);
      else people.set(key, [r]);
    }

    const contacts = [...people.entries()].map(([personKey, personRows]) => {
      const master = personRows[0].masterContactId ? masterById.get(personRows[0].masterContactId) : undefined;
      const first = (f: "name" | "title" | "email" | "phone" | "linkedinUrl") =>
        personRows.map((r) => r[f]).find((v) => !!v) || "";

      // One enrollment per campaign (duplicate rows in one campaign keep the
      // oldest — same rule as findMemberships).
      const byFunnel = new Map<string, CompanyLeadRow>();
      for (const r of personRows) if (!byFunnel.has(r.funnelId)) byFunnel.set(r.funnelId, r);

      let calls = 0, emails = 0, smsCount = 0, notes = 0;
      let lastActivityAt: Date | null = null;
      const personPhones = new Set(personRows.map((r) => normPhone(r.phone)).filter((p) => p.length > 5));
      for (const r of personRows) {
        const ev = eventAgg.get(r.id);
        const cl = callByLead.get(r.id);
        const sm = smsByLead.get(r.id);
        const em = emailMsgByLead.get(r.id);
        notes += ev?.notes ?? 0;
        emails += ev?.emails ?? 0;
        calls += cl?.n ?? 0;
        smsCount += sm?.n ?? 0;
        lastActivityAt = maxDate(lastActivityAt, ev?.lastAt, cl?.lastAt, sm?.lastAt, em?.lastAt);
      }
      for (const p of personPhones) {
        const cp = callByPhone.get(p);
        if (cp) { calls += cp.n; lastActivityAt = maxDate(lastActivityAt, cp.lastAt); }
      }

      const enrollments = [...byFunnel.values()].map((r) => ({
        leadId: r.id,
        funnelId: r.funnelId,
        funnelName: r.funnelName,
        funnelStatus: r.funnelStatus,
        leadStatus: r.status,
        currentStep: r.currentStep,
        totalSteps: r.totalSteps,
        addedAt: r.createdAt.toISOString(),
        lastActivityAt: maxDate(
          eventAgg.get(r.id)?.lastAt,
          callByLead.get(r.id)?.lastAt,
          smsByLead.get(r.id)?.lastAt,
          emailMsgByLead.get(r.id)?.lastAt,
        )?.toISOString() ?? null,
      }));

      return {
        personKey,
        masterContactId: personRows[0].masterContactId,
        name: first("name") || master?.fullName || "Unknown",
        title: first("title") || master?.currentTitle || "",
        email: first("email") || master?.email || "",
        phone: first("phone") || master?.phone || "",
        linkedinUrl: first("linkedinUrl") || master?.linkedinUrl || "",
        doNotCall: master?.doNotCall ?? personRows.some((r) => r.doNotCall),
        enrollments,
        activity: {
          calls,
          emails,
          sms: smsCount,
          notes,
          lastActivityAt: lastActivityAt?.toISOString() ?? null,
        },
      };
    });
    // Most recently active people first.
    contacts.sort((a, b) => (b.activity.lastActivityAt || "").localeCompare(a.activity.lastActivityAt || ""));

    // Hiring roles across the company's leads (deduped by title+url).
    const roleRows = leadIds.length
      ? await db.select().from(leadHiringRoles).where(inArray(leadHiringRoles.leadId, leadIds))
      : [];
    const seenRoles = new Set<string>();
    const hiringRoles = roleRows.filter((r) => {
      const key = `${r.title.toLowerCase()}|${r.url.toLowerCase()}`;
      if (seenRoles.has(key)) return false;
      seenRoles.add(key);
      return true;
    }).map((r) => ({
      id: r.id,
      funnelId: r.funnelId,
      leadId: r.leadId,
      title: r.title,
      description: r.description,
      salaryRange: r.salaryRange,
      location: r.location,
      postedAgo: r.postedAgo,
      seniority: r.seniority,
      url: r.url,
      createdAt: r.createdAt.toISOString(),
    }));

    res.json({
      data: {
        company: {
          id: mc.id,
          name: mc.name,
          // Hide synthesized name-slug domains — they aren't real websites.
          domain: mc.domain && !mc.domain.endsWith(".unknown") ? mc.domain : null,
          linkedinUrl: mc.linkedinUrl,
          industry: mc.industry,
          employeeCount: mc.employeeCount,
          revenue: mc.revenue,
          funding: mc.funding,
          fundingStage: mc.fundingStage,
          country: mc.country,
          city: mc.city,
          logo: mc.logo,
          description: mc.description,
          lastSeenAt: mc.lastSeenAt.toISOString(),
        },
        campaigns: [...campaignsByFunnel.values()],
        contacts,
        hiringRoles,
      },
    });
  }),
);

// ─── GET /companies/:id/timeline ───────────────────────────────────────────
// Merged cross-campaign activity feed, keyset-paginated by (timestamp, id)
// descending. Four sources — lead_events (notes, status changes, steps,
// meetings…), call_records, email_messages, sms_messages — each fetches its
// own top-N below the cursor; merging the sorted prefixes and taking the top
// N is exactly the global page (no gaps, no dupes).
//
// lead_events rows that MIRROR an authoritative channel table are excluded,
// matching the campaign lead view's dedupe exactly: call touches (dialer +
// log-call events), 1:1/workflow email mirrors and Smartlead webhook rows
// (email_messages is authoritative), and SMS mirrors (sms_messages is
// authoritative).
// NULL-safe: outcome / meta->>'channel' are often NULL, and `NOT (… OR NULL)`
// is NULL in SQL — IS NOT TRUE keeps those rows instead of dropping them.
const EVENT_MIRROR_EXCLUSION = sql`(
  ${leadEvents.type} = 'call'
  OR ${leadEvents.outcome} = 'call_completed'
  OR (${leadEvents.type} = 'step_outcome' AND ${leadEvents.meta} ->> 'channel' IN ('call','email','sms'))
  OR ${leadEvents.type} = 'smartlead_webhook'
  OR ${leadEvents.type} = 'email_sent'
) IS NOT TRUE`;

const TIMELINE_TYPES = ["call", "email", "sms", "note", "status", "step", "meeting", "other"] as const;
type TimelineType = (typeof TIMELINE_TYPES)[number];

/** Predicate for the lead_events source given the requested type buckets. */
function eventTypePredicate(types: Set<TimelineType>) {
  const parts: ReturnType<typeof sql>[] = [];
  if (types.has("note")) parts.push(sql`${leadEvents.type} = 'note'`);
  if (types.has("status")) parts.push(sql`${leadEvents.type} IN ('status_change','reply_handled')`);
  if (types.has("step")) parts.push(sql`${leadEvents.type} = 'step_outcome'`);
  if (types.has("meeting")) parts.push(sql`${leadEvents.type} IN ('meeting_scheduled','meeting_canceled')`);
  if (types.has("other")) {
    parts.push(sql`${leadEvents.type} NOT IN ('note','status_change','reply_handled','step_outcome','meeting_scheduled','meeting_canceled')`);
  }
  if (parts.length === 0) return null;
  return sql.join([sql`(`, sql.join(parts, sql` OR `), sql`)`]);
}

/** Cursor carries the boundary row's timestamp as Postgres `::text` (full
 *  microsecond precision) — a JS Date/ISO string truncates to milliseconds,
 *  and a strict (ts,id) < cursor over truncated values silently skips every
 *  other row sharing the boundary's millisecond (e.g. one bulk import). */
function decodeCursor(raw: string | undefined): { ts: string; id: string } | null {
  if (!raw) return null;
  try {
    const [ts, id] = Buffer.from(raw, "base64").toString("utf8").split("|");
    if (!ts || !id || !/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(ts)) return null;
    return { ts, id };
  } catch {
    return null;
  }
}

const encodeCursor = (ts: string, id: string) =>
  Buffer.from(`${ts}|${id}`).toString("base64");

router.get(
  "/companies/:id/timeline",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const mc = await getCompanyOrThrow(orgId, String(req.params.id));

    const funnelId = req.query.funnelId ? String(req.query.funnelId) : undefined;
    const contactId = req.query.contactId ? String(req.query.contactId) : undefined;
    const limit = Math.min(Math.max(parseInt(String(req.query.limit)) || 50, 1), 100);
    const cursor = decodeCursor(req.query.cursor ? String(req.query.cursor) : undefined);
    const typesParam = req.query.types ? String(req.query.types) : "";
    const types = new Set<TimelineType>(
      typesParam
        ? (typesParam.split(",").map((t) => t.trim()).filter((t): t is TimelineType => (TIMELINE_TYPES as readonly string[]).includes(t)))
        : TIMELINE_TYPES,
    );

    let rows = await companyLeadRows(orgId, mc, funnelId);
    if (contactId) rows = rows.filter((r) => personKeyOf(r) === contactId);

    type LeadInfo = {
      leadId: string; funnelId: string; funnelName: string;
      personKey: string; masterContactId: string | null; name: string;
    };
    const leadInfo = new Map<string, LeadInfo>();
    const phoneOwners = new Map<string, LeadInfo[]>();
    for (const r of rows) {
      const info: LeadInfo = {
        leadId: r.id, funnelId: r.funnelId, funnelName: r.funnelName,
        personKey: personKeyOf(r), masterContactId: r.masterContactId, name: r.name,
      };
      leadInfo.set(r.id, info);
      const p = normPhone(r.phone);
      if (p.length > 5) phoneOwners.set(p, [...(phoneOwners.get(p) || []), info]);
    }
    const leadIds = rows.map((r) => r.id);
    const phoneList = [...phoneOwners.keys()];

    if (leadIds.length === 0 && phoneList.length === 0) {
      res.json({ data: [], meta: { nextCursor: null, hasMore: false } });
      return;
    }

    // Keyset predicate per source: (ts, id) strictly below the cursor.
    const below = (ts: typeof leadEvents.timestamp | typeof callRecords.calledAt | typeof emailMessages.createdAt | typeof smsMessages.createdAt, id: typeof leadEvents.id | typeof callRecords.id | typeof emailMessages.id | typeof smsMessages.id) =>
      cursor ? sql`(${ts}, ${id}) < (${cursor.ts}::timestamptz, ${cursor.id})` : sql`true`;

    const wantEvents = eventTypePredicate(types);

    const [eventRows, callRows, emailRows, smsRows] = await Promise.all([
      // 1) lead_events — notes, status changes, sequence steps, meetings, imports…
      wantEvents && leadIds.length
        ? db
            .select({
              id: leadEvents.id,
              leadId: leadEvents.leadId,
              type: leadEvents.type,
              outcome: leadEvents.outcome,
              stepIndex: leadEvents.stepIndex,
              meta: leadEvents.meta,
              timestamp: leadEvents.timestamp,
              sortKey: sql<string>`${leadEvents.timestamp}::text`,
            })
            .from(leadEvents)
            .where(and(
              inArray(leadEvents.leadId, leadIds),
              EVENT_MIRROR_EXCLUSION,
              wantEvents,
              below(leadEvents.timestamp, leadEvents.id),
            ))
            .orderBy(sql`${leadEvents.timestamp} DESC, ${leadEvents.id} DESC`)
            .limit(limit)
        : Promise.resolve([]),
      // 2) call_records — by stamped leadId OR counterparty phone digits.
      types.has("call")
        ? (async () => {
            const counterparty = sql`regexp_replace(case when ${callRecords.direction} = 'outbound' then ${callRecords.toNumber} else ${callRecords.fromNumber} end, '[^0-9]', '', 'g')`;
            const match: ReturnType<typeof sql>[] = [];
            if (leadIds.length) match.push(sql`${callRecords.leadId} IN (${sql.join(leadIds.map((i) => sql`${i}`), sql`, `)})`);
            // Phone matching is only for UNSTAMPED calls (leadId IS NULL):
            // a call stamped to another campaign's (or company's) lead must
            // not leak into this feed, and the profile's per-contact counts
            // use the same rule so feed and counts agree. Under a campaign
            // filter, an unstamped call may still carry a funnel stamp —
            // honor it.
            if (phoneList.length) {
              const phoneArm = [
                sql`${callRecords.leadId} IS NULL`,
                sql`${counterparty} IN (${sql.join(phoneList.map((p) => sql`${p}`), sql`, `)})`,
              ];
              if (funnelId) {
                phoneArm.push(sql`(${callRecords.funnelId} = ${funnelId} OR ${callRecords.funnelId} IS NULL)`);
              }
              match.push(sql.join([sql`(`, sql.join(phoneArm, sql` AND `), sql`)`]));
            }
            if (!match.length) return [];
            return db
              .select({
                record: callRecords,
                funnelName: funnels.name,
                counterparty: sql<string>`${counterparty}`,
                sortKey: sql<string>`${callRecords.calledAt}::text`,
              })
              .from(callRecords)
              .leftJoin(funnels, eq(callRecords.funnelId, funnels.id))
              .where(and(
                eq(callRecords.organizationId, orgId),
                sql.join([sql`(`, sql.join(match, sql` OR `), sql`)`]),
                below(callRecords.calledAt, callRecords.id),
              ))
              .orderBy(sql`${callRecords.calledAt} DESC, ${callRecords.id} DESC`)
              .limit(limit);
          })()
        : Promise.resolve([]),
      // 3) email_messages — 1:1 and workflow sends + captured replies.
      types.has("email") && leadIds.length
        ? db
            .select({
              message: emailMessages,
              sortKey: sql<string>`${emailMessages.createdAt}::text`,
            })
            .from(emailMessages)
            .where(and(
              eq(emailMessages.organizationId, orgId),
              inArray(emailMessages.leadId, leadIds),
              below(emailMessages.createdAt, emailMessages.id),
            ))
            .orderBy(sql`${emailMessages.createdAt} DESC, ${emailMessages.id} DESC`)
            .limit(limit)
        : Promise.resolve([]),
      // 4) sms_messages — the SMS system of record.
      types.has("sms") && leadIds.length
        ? db
            .select({
              message: smsMessages,
              sortKey: sql<string>`${smsMessages.createdAt}::text`,
            })
            .from(smsMessages)
            .where(and(
              eq(smsMessages.organizationId, orgId),
              inArray(smsMessages.leadId, leadIds),
              below(smsMessages.createdAt, smsMessages.id),
            ))
            .orderBy(sql`${smsMessages.createdAt} DESC, ${smsMessages.id} DESC`)
            .limit(limit)
        : Promise.resolve([]),
    ]);

    type Item = {
      id: string;
      kind: "event" | "call" | "email" | "sms";
      timestamp: string;
      funnelId: string | null;
      funnelName: string | null;
      leadId: string | null;
      contact: { personKey: string; masterContactId: string | null; name: string } | null;
      sortTs: Date;
      /** Full-precision `timestamp::text` — the cursor boundary (see decodeCursor). */
      sortKey: string;
      [k: string]: unknown;
    };

    const contactOf = (info: LeadInfo | undefined | null) =>
      info ? { personKey: info.personKey, masterContactId: info.masterContactId, name: info.name } : null;

    const items: Item[] = [];

    for (const e of eventRows) {
      const info = leadInfo.get(e.leadId)!;
      items.push({
        id: e.id,
        kind: "event",
        timestamp: e.timestamp.toISOString(),
        sortTs: e.timestamp,
        sortKey: e.sortKey,
        funnelId: info.funnelId,
        funnelName: info.funnelName,
        leadId: e.leadId,
        contact: contactOf(info),
        event: { type: e.type, outcome: e.outcome, stepIndex: e.stepIndex, meta: e.meta || {} },
      });
    }

    for (const c of callRows) {
      const r = c.record;
      // Attribute by the stamped lead when it's one of this company's rows,
      // else by the unique owner of the counterparty number.
      const stamped = r.leadId ? leadInfo.get(r.leadId) : undefined;
      const owners = phoneOwners.get(c.counterparty) || [];
      const uniquePerson = new Set(owners.map((o) => o.personKey)).size === 1 ? owners[0] : undefined;
      const info = stamped ?? uniquePerson;
      items.push({
        id: r.id,
        kind: "call",
        timestamp: r.calledAt.toISOString(),
        sortTs: r.calledAt,
        sortKey: c.sortKey,
        funnelId: r.funnelId ?? info?.funnelId ?? null,
        funnelName: (r.funnelId ? c.funnelName : null) ?? info?.funnelName ?? null,
        leadId: r.leadId ?? info?.leadId ?? null,
        contact: contactOf(info),
        // Same shape the recordings/lead views consume (CallRecord).
        call: {
          id: r.id,
          direction: r.direction,
          from: r.fromNumber,
          to: r.toNumber,
          contactName: r.contactName || info?.name || null,
          companyName: r.companyName || mc.name,
          leadId: r.leadId ?? info?.leadId ?? null,
          funnelId: r.funnelId ?? info?.funnelId ?? null,
          lineId: r.lineId,
          duration: r.duration,
          disposition: r.disposition,
          outcome: r.outcome ?? null,
          outcomeManual: r.outcomeManual ?? false,
          recordingUrl: r.recordingUrl,
          recordingSid: r.recordingSid,
          recordingDuration: r.recordingDuration,
          transcript: r.transcript,
          summary: r.summary,
          transcriptSegments: r.transcriptSegments ?? null,
          speakers: r.speakers ?? null,
          summaryStructured: r.summaryStructured ?? null,
          userId: r.userId,
          userName: r.userName,
          timestamp: r.calledAt.toISOString(),
        },
      });
    }

    for (const row of emailRows) {
      const m = row.message;
      const info = m.leadId ? leadInfo.get(m.leadId) : undefined;
      items.push({
        id: m.id,
        kind: "email",
        timestamp: m.createdAt.toISOString(),
        sortTs: m.createdAt,
        sortKey: row.sortKey,
        funnelId: m.funnelId ?? info?.funnelId ?? null,
        funnelName: info?.funnelName ?? null,
        leadId: m.leadId,
        contact: contactOf(info),
        // Same shape the lead email thread returns (LeadEmailMessage).
        email: {
          id: m.id,
          direction: m.direction,
          fromEmail: m.fromEmail,
          fromName: m.fromName,
          toEmail: m.toEmail,
          subject: m.subject,
          bodyHtml: m.bodyHtml,
          bodyText: m.bodyText,
          status: m.status,
          openedAt: m.openedAt ? m.openedAt.toISOString() : null,
          openCount: m.openCount,
          userId: m.userId,
          attachments: m.attachments ?? [],
          createdAt: m.createdAt.toISOString(),
        },
      });
    }

    for (const row of smsRows) {
      const s = row.message;
      const info = s.leadId ? leadInfo.get(s.leadId) : undefined;
      items.push({
        id: s.id,
        kind: "sms",
        timestamp: s.createdAt.toISOString(),
        sortTs: s.createdAt,
        sortKey: row.sortKey,
        funnelId: s.funnelId ?? info?.funnelId ?? null,
        funnelName: info?.funnelName ?? null,
        leadId: s.leadId,
        contact: contactOf(info),
        sms: {
          id: s.id,
          direction: s.direction,
          fromNumber: s.fromNumber,
          toNumber: s.toNumber,
          body: s.body,
          status: s.status,
          userId: s.userId,
          createdAt: s.createdAt.toISOString(),
        },
      });
    }

    // Merge the per-source sorted prefixes → exact global page. Order must
    // mirror Postgres's (timestamp, id) DESC: millisecond Date first, then the
    // full-precision text key breaks microsecond ties (its lexical order is
    // chronological within one millisecond), then id.
    items.sort((a, b) => {
      const dt = b.sortTs.getTime() - a.sortTs.getTime();
      if (dt !== 0) return dt;
      if (a.sortKey !== b.sortKey) return b.sortKey.localeCompare(a.sortKey);
      return b.id.localeCompare(a.id);
    });
    const anySourceFull =
      eventRows.length === limit || callRows.length === limit ||
      emailRows.length === limit || smsRows.length === limit;
    const page = items.slice(0, limit);
    const hasMore = items.length > limit || (anySourceFull && page.length === limit);
    const last = page[page.length - 1];

    res.json({
      data: page.map(({ sortTs: _sortTs, sortKey: _sortKey, ...item }) => item),
      meta: {
        nextCursor: hasMore && last ? encodeCursor(last.sortKey, last.id) : null,
        hasMore,
      },
    });
  }),
);

export default router;
