/**
 * Twilio cost sync — pulls the EXACT billed price off each Twilio Call and
 * Message resource and writes it onto our own `call_records` / `sms_messages`
 * rows (matched by SID), plus refreshes per-line monthly rental prices from the
 * Pricing API. This is what makes per-organization cost reporting use real
 * Twilio data rather than estimates.
 *
 * We run a single master Twilio account (no per-org subaccounts), so Twilio
 * can't break spend down by org — but each Call/Message carries `price`, and we
 * already store `twilioCallSid` / `twilioSid` with an `organizationId` FK, so
 * summing those per org gives genuinely exact figures.
 *
 * Twilio finalizes `price` only after a call/message completes (and it's a
 * negative string, e.g. "-0.0085"), so this is a pull-based sync rather than
 * something captured on the status webhook. There's no cron infra, so it runs
 * admin-triggered and lazily when the data is stale.
 */
import twilioSdk from "twilio";
import { and, eq, gte, lte, isNotNull } from "drizzle-orm";
import { db } from "../db";
import { callRecords } from "../db/schema/call-records";
import { smsMessages } from "../db/schema/sms";
import { phoneLines } from "../db/schema/phone-lines";

const client = twilioSdk(
  process.env.TWILIO_ACCOUNT_SID!,
  process.env.TWILIO_AUTH_TOKEN!,
);

// Cap a single sync pass so an admin click can't fan out unbounded API calls.
// The call list is account-wide and includes child (PSTN) legs, so this must
// comfortably exceed a month's total legs across all orgs.
const MAX_RESOURCES = 20000;
const DAY_MS = 24 * 60 * 60 * 1000;

let cachedCurrency: string | null = null;
let lastSyncedAt: Date | null = null;
let syncInProgress = false;

export function getLastSyncedAt(): Date | null {
  return lastSyncedAt;
}
export function isSyncInProgress(): boolean {
  return syncInProgress;
}

/** The currency Twilio bills this account in (e.g. "USD"). Cached for the
 *  process — it never changes for a given account. */
export async function getAccountCurrency(): Promise<string> {
  if (cachedCurrency) return cachedCurrency;
  try {
    const bal = await client.balance.fetch();
    cachedCurrency = bal.currency || "USD";
  } catch {
    cachedCurrency = "USD";
  }
  return cachedCurrency;
}

/** Sync the exact billed price onto our call_records for calls in the window. */
export async function syncCallPrices(since: Date, until: Date): Promise<number> {
  // Only touch calls we actually own that lack a synced price (or are in-window).
  const ours = await db
    .select({ sid: callRecords.twilioCallSid })
    .from(callRecords)
    .where(
      and(
        isNotNull(callRecords.twilioCallSid),
        gte(callRecords.calledAt, since),
        lte(callRecords.calledAt, until),
      ),
    );
  const ourSids = new Set(ours.map((r) => r.sid).filter(Boolean) as string[]);
  if (ourSids.size === 0) return 0;

  // Pad the Twilio query window by a day each side to absorb start-time vs
  // logged-at skew.
  const calls = await client.calls.list({
    startTimeAfter: new Date(since.getTime() - DAY_MS),
    startTimeBefore: new Date(until.getTime() + DAY_MS),
    limit: MAX_RESOURCES,
  });

  // The REAL cost of a browser-placed outbound call lives on the CHILD leg:
  // we dial via <Dial><Number>, so the parent (client) leg we store as
  // twilioCallSid is ~$0 and the per-minute PSTN charge sits on the child leg
  // (child.parentCallSid === our SID). So we sum each leg's price onto the
  // parent SID we own — the parent's own price PLUS all its children's.
  // Only legs whose price Twilio has FINALIZED (non-null) are counted; calls
  // still settling are skipped and picked up on the next sync (rather than
  // stamping a premature $0).
  const totalBySid = new Map<string, { price: number; unit: string | null }>();
  const add = (key: string, price: number, unit: string | null) => {
    const cur = totalBySid.get(key) || { price: 0, unit: null };
    cur.price += price;
    if (!cur.unit && unit) cur.unit = unit;
    totalBySid.set(key, cur);
  };
  for (const c of calls) {
    if (c.price == null || c.price === "") continue;
    const price = Math.abs(Number(c.price));
    if (!Number.isFinite(price)) continue;
    // Attribute this leg to the parent SID we own — either this leg IS ours,
    // or it's a child of one of ours.
    if (ourSids.has(c.sid)) add(c.sid, price, c.priceUnit || null);
    else if (c.parentCallSid && ourSids.has(c.parentCallSid))
      add(c.parentCallSid, price, c.priceUnit || null);
  }

  let updated = 0;
  const now = new Date();
  for (const [sid, { price, unit }] of totalBySid) {
    const rows = await db
      .update(callRecords)
      .set({ twilioPrice: price, twilioPriceUnit: unit, twilioPriceSyncedAt: now })
      .where(eq(callRecords.twilioCallSid, sid))
      .returning({ id: callRecords.id });
    updated += rows.length;
  }
  return updated;
}

/** Sync the exact billed price onto our sms_messages for messages in the window. */
export async function syncMessagePrices(since: Date, until: Date): Promise<number> {
  const ours = await db
    .select({ sid: smsMessages.twilioSid })
    .from(smsMessages)
    .where(
      and(
        isNotNull(smsMessages.twilioSid),
        gte(smsMessages.createdAt, since),
        lte(smsMessages.createdAt, until),
      ),
    );
  const ourSids = new Set(ours.map((r) => r.sid).filter(Boolean) as string[]);
  if (ourSids.size === 0) return 0;

  const messages = await client.messages.list({
    dateSentAfter: new Date(since.getTime() - DAY_MS),
    dateSentBefore: new Date(until.getTime() + DAY_MS),
    limit: MAX_RESOURCES,
  });
  const priceBySid = new Map<string, { price: number; unit: string | null }>();
  for (const m of messages) {
    if (m.price == null || m.price === "") continue;
    const price = Math.abs(Number(m.price));
    if (!Number.isFinite(price)) continue;
    priceBySid.set(m.sid, { price, unit: m.priceUnit || null });
  }

  let updated = 0;
  for (const sid of ourSids) {
    const p = priceBySid.get(sid);
    if (!p) continue;
    const rows = await db
      .update(smsMessages)
      .set({ twilioPrice: p.price, twilioPriceUnit: p.unit })
      .where(eq(smsMessages.twilioSid, sid))
      .returning({ id: smsMessages.id });
    updated += rows.length;
  }
  return updated;
}

/** Normalise a number type for matching ("toll-free" / "toll free" → "tollfree"). */
function normType(t: string): string {
  return (t || "").toLowerCase().replace(/[^a-z]/g, "");
}

/** Refresh each phone line's monthly rental from Twilio's live Pricing API so
 *  `monthly_cost` reflects the real number-rental price, not the 1.15 default. */
export async function syncNumberRentals(): Promise<number> {
  const lines = await db
    .select({
      id: phoneLines.id,
      countryCode: phoneLines.countryCode,
      type: phoneLines.type,
    })
    .from(phoneLines);
  if (lines.length === 0) return 0;

  // Cache pricing per ISO country (one fetch each).
  const pricingByCountry = new Map<
    string,
    { prices: { type: string; price: number }[] } | null
  >();
  async function loadCountry(iso: string) {
    if (pricingByCountry.has(iso)) return pricingByCountry.get(iso)!;
    try {
      const c = await client.pricing.v1.phoneNumbers.countries(iso).fetch();
      const prices = (c.phoneNumberPrices || []).map((p) => ({
        type: normType(String(p.numberType || "")),
        price: Number(p.currentPrice ?? p.basePrice ?? 0),
      }));
      const entry = { prices };
      pricingByCountry.set(iso, entry);
      return entry;
    } catch {
      pricingByCountry.set(iso, null);
      return null;
    }
  }

  let updated = 0;
  for (const line of lines) {
    const iso = (line.countryCode || "").toUpperCase();
    if (!iso) continue;
    const entry = await loadCountry(iso);
    if (!entry) continue;
    const want = normType(line.type);
    const match =
      entry.prices.find((p) => p.type === want) ||
      entry.prices.find((p) => p.type === "local"); // sensible fallback
    if (!match || !Number.isFinite(match.price) || match.price <= 0) continue;
    const rows = await db
      .update(phoneLines)
      .set({ monthlyCost: match.price, updatedAt: new Date() })
      .where(eq(phoneLines.id, line.id))
      .returning({ id: phoneLines.id });
    updated += rows.length;
  }
  return updated;
}

export interface SyncResult {
  calls: number;
  messages: number;
  rentals: number;
  currency: string;
  lastSyncedAt: string;
  skipped?: boolean;
}

/**
 * Run a full cost sync for a window. `full` widens the window for a historical
 * backfill. Guards against concurrent runs (returns `skipped` if one is live).
 */
export async function runCostSync(opts: {
  since: Date;
  until: Date;
  full?: boolean;
}): Promise<SyncResult> {
  const currency = await getAccountCurrency();
  if (syncInProgress) {
    return {
      calls: 0,
      messages: 0,
      rentals: 0,
      currency,
      lastSyncedAt: (lastSyncedAt ?? new Date()).toISOString(),
      skipped: true,
    };
  }
  syncInProgress = true;
  try {
    const calls = await syncCallPrices(opts.since, opts.until);
    const messages = await syncMessagePrices(opts.since, opts.until);
    const rentals = await syncNumberRentals();
    lastSyncedAt = new Date();
    return {
      calls,
      messages,
      rentals,
      currency,
      lastSyncedAt: lastSyncedAt.toISOString(),
    };
  } finally {
    syncInProgress = false;
  }
}
