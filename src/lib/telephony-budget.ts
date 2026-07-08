import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/index";
import { organizations } from "../db/schema/organizations";
import { telephonyCreditTransactions } from "../db/schema/telephony-credits";
import { ApiError } from "./helpers";
import { buildTelephonyInvoice, monthRange, getTelephonyBillingConfig } from "../routes/admin";

/**
 * Telephony spend gates, evaluated live (the wallet's stored balance lags
 * the 6h sweep, so blocking on it alone would let an org burn far past its
 * limits):
 *
 *  - Monthly budget (Close-style): this month's billed usage vs the org's
 *    monthly spending limit.
 *  - Balance floor: the LIVE wallet balance vs the org's floor (default
 *    −$100) — the hard "no more credit" cut-off.
 *
 * liveBalance = storedBalance − (liveUsage(current period) − usage already
 * debited to the ledger for that period). When either gate trips, outbound
 * calls, SMS and number purchases are refused until the limit is raised or
 * the balance is topped up.
 *
 * Results are cached briefly per org: the power dialer places calls in
 * bursts and the voice webhook is latency-sensitive.
 */

export interface TelephonyBudgetStatus {
  period: string;
  limitMinor: number | null;
  spentMinor: number;
  budgetBlocked: boolean;
  floorMinor: number;
  liveBalanceMinor: number;
  floorBlocked: boolean;
  /** True when ANY gate trips; floor wins for messaging when both do. */
  blocked: boolean;
  reason: "floor" | "budget" | null;
}

const CACHE_TTL_MS = 60 * 1000;
const cache = new Map<string, { at: number; status: TelephonyBudgetStatus }>();

export function invalidateTelephonyBudgetCache(orgId: string): void {
  cache.delete(orgId);
}

export async function getTelephonyBudgetStatus(
  orgId: string,
  opts: { fresh?: boolean } = {},
): Promise<TelephonyBudgetStatus> {
  const hit = cache.get(orgId);
  if (!opts.fresh && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.status;

  const [org] = await db
    .select({
      limitMinor: organizations.telephonyMonthlyLimitMinor,
      floorMinor: organizations.telephonyFloorMinor,
      balanceMinor: organizations.telephonyCreditBalanceMinor,
    })
    .from(organizations)
    .where(eq(organizations.id, orgId));
  const limitMinor = org?.limitMinor && org.limitMinor > 0 ? org.limitMinor : null;
  const floorMinor = org?.floorMinor ?? -10000;

  const period = monthRange().period;
  const cfg = await getTelephonyBillingConfig(orgId);
  const built = await buildTelephonyInvoice(orgId, period, cfg.multiplier, 0, cfg.roundUp);
  const spentMinor = built.usageMinor;

  // Usage already debited to the wallet ledger for this period — the live
  // remainder hasn't been swept yet and must count against the balance.
  const [debitedRow] = await db
    .select({ n: sql<number>`COALESCE(SUM(${telephonyCreditTransactions.amountMinor}), 0)::int` })
    .from(telephonyCreditTransactions)
    .where(
      and(
        eq(telephonyCreditTransactions.organizationId, orgId),
        eq(telephonyCreditTransactions.kind, "usage"),
        eq(telephonyCreditTransactions.period, period),
      ),
    );
  const debitedMinor = -(debitedRow?.n ?? 0);
  const liveBalanceMinor = (org?.balanceMinor ?? 0) - Math.max(0, spentMinor - debitedMinor);

  const budgetBlocked = limitMinor !== null && spentMinor >= limitMinor;
  const floorBlocked = liveBalanceMinor <= floorMinor;

  const status: TelephonyBudgetStatus = {
    period,
    limitMinor,
    spentMinor,
    budgetBlocked,
    floorMinor,
    liveBalanceMinor,
    floorBlocked,
    blocked: budgetBlocked || floorBlocked,
    reason: floorBlocked ? "floor" : budgetBlocked ? "budget" : null,
  };
  cache.set(orgId, { at: Date.now(), status });
  return status;
}

/** Route guard: 403 with a user-facing message when a spend gate is
 *  tripped. The "out of calling credit" phrase is matched client-side. */
export async function assertTelephonyNotBlocked(orgId: string): Promise<void> {
  const status = await getTelephonyBudgetStatus(orgId);
  if (!status.blocked) return;
  throw new ApiError(
    403,
    status.reason === "floor"
      ? "Out of calling credit — your telephony balance has reached its floor. Top up in Settings → Credits to continue."
      : "Your monthly telephony budget has been reached — raise the limit in Settings → Credits to continue.",
  );
}
