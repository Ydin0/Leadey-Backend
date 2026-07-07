import { and, or, sql, type SQL } from "drizzle-orm";
import { leads } from "../db/schema/leads";

// ─── Server-side lead filter engine ──────────────────────────────────
// Turns a query-builder FilterGroup (shared with the frontend) into a Drizzle
// SQL predicate over the `leads` table, mirroring the client evaluator's
// operator semantics. Supports lead/company columns, the hiring-roles jsonb,
// org custom fields (custom:<key>) and activity-derived counts.

type Op =
  | "is" | "is_not" | "contains" | "not_contains" | "is_empty" | "is_set"
  | "gt" | "gte" | "lt" | "lte" | "between" | "before" | "after";

interface Condition { field: string; op: Op; value?: unknown }
interface Group { match: "and" | "or"; conditions: Condition[] }
export interface FilterCtx { orgId: string }

const COL: Record<string, SQL> = {
  name: sql`${leads.name}`,
  firstName: sql`${leads.firstName}`,
  lastName: sql`${leads.lastName}`,
  title: sql`${leads.title}`,
  company: sql`${leads.company}`,
  email: sql`${leads.email}`,
  phone: sql`${leads.phone}`,
  linkedinUrl: sql`${leads.linkedinUrl}`,
  // The UI shows the DB default "pending" (and blank) as "new" (see the
  // frontend's asLeadStatus). Filters are authored against that displayed
  // value, so normalize the same way here — otherwise a "status is New"
  // Smart View matches ZERO rows server-side (they're stored "pending"),
  // which silently emptied the power-dialer queue.
  status: sql`(case when coalesce(${leads.status}, '') in ('', 'pending') then 'new' else ${leads.status} end)`,
  source: sql`${leads.source}`,
  score: sql`${leads.score}`,
  companyDomain: sql`${leads.companyDomain}`,
  companyIndustry: sql`${leads.companyIndustry}`,
  companyEmployeeCount: sql`${leads.companyEmployeeCount}`,
  companyLocation: sql`${leads.companyLocation}`,
  companyAnnualRevenue: sql`${leads.companyAnnualRevenue}`,
  createdAt: sql`${leads.createdAt}`,
};

const TEXT_FIELDS = new Set(["name", "firstName", "lastName", "title", "company", "email", "phone", "linkedinUrl", "companyDomain", "companyAnnualRevenue"]);
const ENUM_FIELDS = new Set(["status", "source", "companyIndustry", "companyLocation"]);
const NUM_FIELDS = new Set(["score", "companyEmployeeCount"]);
const DATE_FIELDS = new Set(["createdAt"]);

const asArray = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : v == null ? [] : [String(v)]);
const hasVal = (v: unknown) => !(v == null || v === "" || (Array.isArray(v) && v.length === 0));

// Generic operator application against a text/enum value expression.
function applyText(expr: SQL, op: Op, value: unknown, isEnum: boolean): SQL | null {
  if (op === "is_set") return sql`(${expr} is not null and ${expr} <> '')`;
  if (op === "is_empty") return sql`(${expr} is null or ${expr} = '')`;
  if (!hasVal(value)) return null;
  if (isEnum && (op === "is" || op === "is_not")) {
    const arr = asArray(value).map((s) => s.toLowerCase());
    const inList = sql.join(arr.map((s) => sql`${s}`), sql`, `);
    return op === "is" ? sql`lower(coalesce(${expr}, '')) in (${inList})` : sql`lower(coalesce(${expr}, '')) not in (${inList})`;
  }
  const s = String(Array.isArray(value) ? value[0] : value);
  if (op === "contains") return sql`coalesce(${expr}, '') ilike ${`%${s}%`}`;
  if (op === "not_contains") return sql`coalesce(${expr}, '') not ilike ${`%${s}%`}`;
  if (op === "is") return sql`lower(coalesce(${expr}, '')) = lower(${s})`;
  if (op === "is_not") return sql`lower(coalesce(${expr}, '')) <> lower(${s})`;
  return null;
}

// Generic operator application against a numeric value expression.
function applyNum(expr: SQL, op: Op, value: unknown): SQL | null {
  if (op === "is_set") return sql`${expr} is not null`;
  if (op === "is_empty") return sql`${expr} is null`;
  if (!hasVal(value)) return null;
  if (op === "between" && Array.isArray(value)) {
    const a = Number(value[0]); const b = Number(value[1]);
    return Number.isFinite(a) && Number.isFinite(b) ? sql`${expr} between ${a} and ${b}` : null;
  }
  const n = Number(Array.isArray(value) ? value[0] : value);
  if (!Number.isFinite(n)) return null;
  if (op === "is") return sql`${expr} = ${n}`;
  if (op === "gt") return sql`${expr} > ${n}`;
  if (op === "gte") return sql`${expr} >= ${n}`;
  if (op === "lt") return sql`${expr} < ${n}`;
  if (op === "lte") return sql`${expr} <= ${n}`;
  return null;
}

function buildCondition(c: Condition, ctx: FilterCtx): SQL | null {
  const { field, op } = c;

  // Org custom fields — scalar subquery on lead_field_values by definition key.
  if (field.startsWith("custom:")) {
    const key = field.slice("custom:".length);
    const expr = sql`(select v.value from lead_field_values v join lead_field_definitions d on v.field_definition_id = d.id where v.lead_id = ${leads.id} and d.organization_id = ${ctx.orgId} and d.key = ${key} limit 1)`;
    return applyText(expr, op, c.value, false);
  }

  // Activity-derived counts (org-scoped, correlated subqueries).
  if (field === "leadsInCompany") {
    const expr = sql`(select count(*) from leads l2 join funnels f2 on l2.funnel_id = f2.id where f2.organization_id = ${ctx.orgId} and lower(l2.company) = lower(${leads.company}))`;
    return applyNum(expr, op, c.value);
  }
  if (field === "callCount") {
    const expr = sql`(select count(*) from call_records cr where cr.organization_id = ${ctx.orgId} and cr.direction = 'outbound' and ${leads.phone} <> '' and regexp_replace(coalesce(cr.to_number, ''), '[^0-9]', '', 'g') = regexp_replace(${leads.phone}, '[^0-9]', '', 'g'))`;
    return applyNum(expr, op, c.value);
  }
  if (field === "emailCount") {
    const expr = sql`(select count(*) from lead_events le join leads l3 on le.lead_id = l3.id join funnels f3 on l3.funnel_id = f3.id where f3.organization_id = ${ctx.orgId} and ${leads.email} <> '' and lower(l3.email) = lower(${leads.email}) and (le.type in ('smartlead_webhook','email_sent','reply_handled') or (le.type = 'step_outcome' and le.meta->>'channel' = 'email')))`;
    return applyNum(expr, op, c.value);
  }

  // Has an opportunity — mirrors the client (leads.opportunityId, set on
  // conversion). Boolean "is" yes/no, plus presence operators.
  if (field === "hasOpportunity") {
    const present = sql`${leads.opportunityId} is not null`;
    const absent = sql`${leads.opportunityId} is null`;
    if (op === "is") return String(c.value) === "true" ? present : absent;
    if (op === "is_set") return present;
    if (op === "is_empty") return absent;
    return null;
  }

  // Campaign membership (org all-leads page). A lead belongs to exactly one
  // funnel; "is any of" matches per enrollment. Ids are org-scoped upstream.
  if (field === "funnelId") {
    const ids = asArray(c.value);
    if (ids.length === 0) return null;
    const inList = sql.join(ids.map((v) => sql`${v}`), sql`, `);
    if (op === "is") return sql`${leads.funnelId} in (${inList})`;
    if (op === "is_not") return sql`${leads.funnelId} not in (${inList})`;
    return null;
  }

  if (field === "companyHiringRoles") {
    const len = sql`jsonb_array_length(coalesce(${leads.companyHiringRoles}, '[]'::jsonb))`;
    if (op === "is_set") return sql`${len} > 0`;
    if (op === "is_empty") return sql`${len} = 0`;
    if (op === "contains" && c.value) return sql`${leads.companyHiringRoles}::text ilike ${`%${String(c.value)}%`}`;
    return null;
  }

  if (field === "doNotCall") {
    return op === "is" ? sql`${leads.doNotCall} = ${String(c.value) === "true"}` : null;
  }

  const col = COL[field];
  if (!col) return null;

  if (NUM_FIELDS.has(field)) return applyNum(col, op, c.value);
  if (DATE_FIELDS.has(field)) {
    if (op === "is_set") return sql`${col} is not null`;
    if (op === "is_empty") return sql`${col} is null`;
    if (!hasVal(c.value)) return null;
    if (op === "before") return sql`${col} < ${new Date(String(c.value))}`;
    if (op === "after") return sql`${col} > ${new Date(String(c.value))}`;
    if (op === "between" && Array.isArray(c.value)) return sql`${col} between ${new Date(String(c.value[0]))} and ${new Date(String(c.value[1]))}`;
    return null;
  }
  return applyText(col, op, c.value, ENUM_FIELDS.has(field));
}

/** Build a single SQL predicate for a FilterGroup (or null if no usable
 *  conditions). Unsupported fields are ignored, never silently excluding rows. */
export function buildLeadFilterWhere(group: unknown, ctx: FilterCtx): SQL | null {
  if (!group || typeof group !== "object") return null;
  const g = group as Group;
  if (!Array.isArray(g.conditions) || g.conditions.length === 0) return null;
  const parts = g.conditions.map((c) => buildCondition(c, ctx)).filter((p): p is SQL => p != null);
  if (parts.length === 0) return null;
  return g.match === "or" ? or(...parts)! : and(...parts)!;
}

/** Decode a `filter` query param (base64-encoded JSON FilterGroup). */
export function decodeFilterParam(raw: unknown): unknown {
  if (typeof raw !== "string" || !raw) return null;
  try {
    return JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
  } catch {
    try { return JSON.parse(raw); } catch { return null; }
  }
}
