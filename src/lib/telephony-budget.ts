import { eq } from "drizzle-orm";
import { db } from "../db/index";
import { organizations } from "../db/schema/organizations";
import { buildTelephonyInvoice, monthRange, INVOICE_MULTIPLIER_DEFAULT } from "../routes/admin";

/**
 * Monthly telephony spending limit (Close-style). "Spend" is this month's
 * billed usage at the invoice multiplier — the exact figure the telephony
 * invoice would bill, buffer excluded — computed live from call/SMS/rental
 * aggregates. When spend ≥ limit, outbound calls and SMS are blocked until
 * the limit is raised or the month rolls over.
 *
 * Results are cached briefly per org: the power dialer places calls in
 * bursts and the voice webhook is latency-sensitive.
 */

export interface TelephonyBudgetStatus {
  period: string;
  limitMinor: number | null;
  spentMinor: number;
  blocked: boolean;
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
    .select({ limitMinor: organizations.telephonyMonthlyLimitMinor })
    .from(organizations)
    .where(eq(organizations.id, orgId));
  const limitMinor = org?.limitMinor && org.limitMinor > 0 ? org.limitMinor : null;

  const period = monthRange().period;
  const built = await buildTelephonyInvoice(orgId, period, INVOICE_MULTIPLIER_DEFAULT, 0);
  const spentMinor = built.usageMinor;

  const status: TelephonyBudgetStatus = {
    period,
    limitMinor,
    spentMinor,
    blocked: limitMinor !== null && spentMinor >= limitMinor,
  };
  cache.set(orgId, { at: Date.now(), status });
  return status;
}
