import { and, or, sql, type SQL } from "drizzle-orm";
import { leads } from "../db/schema/leads";

// ─── Server-side lead filter engine ──────────────────────────────────
// Turns a query-builder FilterGroup (shared with the frontend) into a Drizzle
// SQL predicate over the `leads` table. Mirrors the client evaluator's operator
// semantics so the campaign (client) and org (server) surfaces filter alike.

type Op =
  | "is" | "is_not" | "contains" | "not_contains" | "is_empty" | "is_set"
  | "gt" | "gte" | "lt" | "lte" | "between" | "before" | "after";

interface Condition { field: string; op: Op; value?: unknown }
interface Group { match: "and" | "or"; conditions: Condition[] }

// fieldKey → the SQL column expression on `leads`.
const COL: Record<string, SQL> = {
  name: sql`${leads.name}`,
  firstName: sql`${leads.firstName}`,
  lastName: sql`${leads.lastName}`,
  title: sql`${leads.title}`,
  company: sql`${leads.company}`,
  email: sql`${leads.email}`,
  phone: sql`${leads.phone}`,
  linkedinUrl: sql`${leads.linkedinUrl}`,
  status: sql`${leads.status}`,
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

function asArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String) : v == null ? [] : [String(v)];
}

function buildCondition(c: Condition): SQL | null {
  const { field, op } = c;

  // Special: companyHiringRoles (jsonb array).
  if (field === "companyHiringRoles") {
    const len = sql`jsonb_array_length(coalesce(${leads.companyHiringRoles}, '[]'::jsonb))`;
    if (op === "is_set") return sql`${len} > 0`;
    if (op === "is_empty") return sql`${len} = 0`;
    if (op === "contains" && c.value) return sql`${leads.companyHiringRoles}::text ilike ${`%${String(c.value)}%`}`;
    return null;
  }

  if (field === "doNotCall") {
    if (op !== "is") return null;
    return sql`${leads.doNotCall} = ${String(c.value) === "true"}`;
  }

  const col = COL[field];
  if (!col) return null; // unsupported (callCount/emailCount/leadsInCompany/custom → P4)

  // Presence
  if (op === "is_set") {
    return TEXT_FIELDS.has(field) || ENUM_FIELDS.has(field)
      ? sql`(${col} is not null and ${col} <> '')`
      : sql`${col} is not null`;
  }
  if (op === "is_empty") {
    return TEXT_FIELDS.has(field) || ENUM_FIELDS.has(field)
      ? sql`(${col} is null or ${col} = '')`
      : sql`${col} is null`;
  }

  const val = c.value;
  if (val == null || val === "" || (Array.isArray(val) && val.length === 0)) return null;

  if (NUM_FIELDS.has(field)) {
    const n = Number(Array.isArray(val) ? val[0] : val);
    if (op === "is") return sql`${col} = ${n}`;
    if (op === "gt") return sql`${col} > ${n}`;
    if (op === "gte") return sql`${col} >= ${n}`;
    if (op === "lt") return sql`${col} < ${n}`;
    if (op === "lte") return sql`${col} <= ${n}`;
    if (op === "between" && Array.isArray(val)) {
      const a = Number(val[0]); const b = Number(val[1]);
      if (Number.isFinite(a) && Number.isFinite(b)) return sql`${col} between ${a} and ${b}`;
    }
    return null;
  }

  if (DATE_FIELDS.has(field)) {
    if (op === "before") return sql`${col} < ${new Date(String(val))}`;
    if (op === "after") return sql`${col} > ${new Date(String(val))}`;
    if (op === "between" && Array.isArray(val)) return sql`${col} between ${new Date(String(val[0]))} and ${new Date(String(val[1]))}`;
    return null;
  }

  if (ENUM_FIELDS.has(field)) {
    const arr = asArray(val).map((s) => s.toLowerCase());
    if (arr.length === 0) return null;
    const inList = sql.join(arr.map((s) => sql`${s}`), sql`, `);
    if (op === "is") return sql`lower(coalesce(${col}, '')) in (${inList})`;
    if (op === "is_not") return sql`lower(coalesce(${col}, '')) not in (${inList})`;
    return null;
  }

  // text
  const s = String(Array.isArray(val) ? val[0] : val);
  if (op === "contains") return sql`coalesce(${col}, '') ilike ${`%${s}%`}`;
  if (op === "not_contains") return sql`coalesce(${col}, '') not ilike ${`%${s}%`}`;
  if (op === "is") return sql`lower(coalesce(${col}, '')) = lower(${s})`;
  if (op === "is_not") return sql`lower(coalesce(${col}, '')) <> lower(${s})`;
  return null;
}

/** Build a single SQL predicate for a FilterGroup, or null if it has no usable
 *  conditions. Unsupported fields are ignored (never silently exclude rows). */
export function buildLeadFilterWhere(group: unknown): SQL | null {
  if (!group || typeof group !== "object") return null;
  const g = group as Group;
  if (!Array.isArray(g.conditions) || g.conditions.length === 0) return null;
  const parts = g.conditions.map(buildCondition).filter((p): p is SQL => p != null);
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
