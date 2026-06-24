import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "../db/index";
import { phoneLines } from "../db/schema/phone-lines";
import { callRecords } from "../db/schema/call-records";
import { getSetting, upsertSetting } from "./settings-service";
import { areaInfoOf } from "./us-area-codes";

export interface LocalPresenceConfig {
  /** Master switch — when off, calls use the rep's selected/assigned line. */
  enabled: boolean;
  /** Max outbound calls per owned number per day before rotating off it. */
  perNumberDailyCap: number;
  /** Hard ceiling on auto-provisioned numbers (bounds spend). */
  maxNumbers: number;
  /** Who may purchase new local numbers. */
  whoCanProvision: "admin" | "anyone";
}

const CONFIG_KEY = "local_presence_config";
const DEFAULTS: LocalPresenceConfig = {
  enabled: false,
  perNumberDailyCap: 50,
  maxNumbers: 100,
  whoCanProvision: "admin",
};

export async function getLocalPresenceConfig(orgId: string): Promise<LocalPresenceConfig> {
  const raw = await getSetting(orgId, CONFIG_KEY);
  if (!raw) return { ...DEFAULTS };
  try {
    const p = JSON.parse(raw);
    return {
      enabled: typeof p.enabled === "boolean" ? p.enabled : DEFAULTS.enabled,
      perNumberDailyCap: Number.isFinite(p.perNumberDailyCap) ? Math.max(1, Math.floor(p.perNumberDailyCap)) : DEFAULTS.perNumberDailyCap,
      maxNumbers: Number.isFinite(p.maxNumbers) ? Math.max(0, Math.floor(p.maxNumbers)) : DEFAULTS.maxNumbers,
      whoCanProvision: p.whoCanProvision === "anyone" ? "anyone" : "admin",
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export async function saveLocalPresenceConfig(
  orgId: string,
  patch: Partial<LocalPresenceConfig>,
): Promise<LocalPresenceConfig> {
  const next = { ...(await getLocalPresenceConfig(orgId)), ...patch };
  await upsertSetting(orgId, CONFIG_KEY, JSON.stringify(next));
  return next;
}

const digits = (s: string | null | undefined) => (s || "").replace(/[^\d]/g, "");

interface OwnedLine {
  id: string;
  number: string;
  areaCode: string | null;
  state: string;
  timezone: string;
}

/** The org's active, US local phone lines, annotated with area-code info. */
export async function ownedUsLines(orgId: string): Promise<OwnedLine[]> {
  const rows = await db
    .select({ id: phoneLines.id, number: phoneLines.number, type: phoneLines.type, countryCode: phoneLines.countryCode, status: phoneLines.status })
    .from(phoneLines)
    .where(and(eq(phoneLines.organizationId, orgId), eq(phoneLines.status, "active")));
  return rows
    .filter((r) => r.type !== "toll-free")
    .map((r) => {
      const info = areaInfoOf(r.number);
      return info ? { id: r.id, number: r.number, areaCode: digits(r.number).slice(-10, -7) || null, state: info.state, timezone: info.timezone } : null;
    })
    .filter((x): x is OwnedLine => x !== null);
}

/** Today's outbound call count per owned number (org-scoped, UTC day). */
async function todayCountByNumber(orgId: string): Promise<Map<string, number>> {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const rows = await db
    .select({ from: callRecords.fromNumber, n: sql<number>`count(*)::int` })
    .from(callRecords)
    .where(and(eq(callRecords.organizationId, orgId), eq(callRecords.direction, "outbound"), gte(callRecords.calledAt, start)))
    .groupBy(callRecords.fromNumber);
  const map = new Map<string, number>();
  for (const r of rows) map.set(digits(r.from), Number(r.n));
  return map;
}

export interface PickedLine {
  lineId: string;
  number: string;
  state: string;
  source: "match";
}

/**
 * Pick the best owned caller-ID line for a destination number (match-only — it
 * never provisions). Returns null when the destination isn't US NANP or the
 * org owns no usable US line, so the caller falls back to its default line.
 *
 * Ranking: exact area code → same state → same timezone → any US local. Within
 * the chosen tier, prefer numbers under the daily cap, then least-used today
 * (rotation). A tiny cap overshoot under concurrency is acceptable — a call is
 * never blocked on cap accounting.
 */
export async function pickCallerLine(orgId: string, toNumber: string): Promise<PickedLine | null> {
  const dest = areaInfoOf(toNumber);
  if (!dest) return null;
  const destAc = digits(toNumber).slice(-10, -7);

  const [lines, counts] = await Promise.all([ownedUsLines(orgId), todayCountByNumber(orgId)]);
  if (!lines.length) return null;

  const cfg = await getLocalPresenceConfig(orgId);
  const tierOf = (l: OwnedLine): number => {
    if (l.areaCode && l.areaCode === destAc) return 0;
    if (l.state === dest.state) return 1;
    if (l.timezone === dest.timezone) return 2;
    return 3;
  };

  const ranked = lines
    .map((l) => {
      const count = counts.get(digits(l.number)) ?? 0;
      return { l, tier: tierOf(l), atCap: count >= cfg.perNumberDailyCap ? 1 : 0, count };
    })
    .sort((a, b) => a.tier - b.tier || a.atCap - b.atCap || a.count - b.count);

  const best = ranked[0];
  if (!best) return null;
  return { lineId: best.l.id, number: best.l.number, state: best.l.state ?? dest.state, source: "match" };
}
