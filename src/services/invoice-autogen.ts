import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "../db/index";
import { invoices, type InvoiceLineItem } from "../db/schema/invoices";
import { organizations } from "../db/schema/organizations";
import { callRecords } from "../db/schema/call-records";
import { smsMessages } from "../db/schema/sms";
import { phoneLines } from "../db/schema/phone-lines";
import { getAccountCurrency } from "../lib/twilio-cost-sync";
import { getPlanConfig } from "../lib/stripe";
import { createId } from "../lib/helpers";
import { applyUsageDelta, maybeAutoTopup } from "../lib/telephony-credits";
import {
  buildTelephonyInvoice,
  nextInvoiceNumber,
  monthRange,
  PLAN_PRICES_PENCE,
  INVOICE_MULTIPLIER_DEFAULT,
} from "../routes/admin";

/**
 * Automatic invoicing sweeper.
 *
 * Telephony: every run, each org with telephony activity gets ONE auto
 * invoice per month, regenerated in place so it always reflects the month's
 * usage-to-date at 2× the real Twilio charges. The previous month keeps
 * refreshing too (Twilio price syncs land late), so its final state settles
 * to the full billed month. An invoice is frozen — never regenerated — once
 * it is paid/void or has a Stripe payment link (the link's amount is fixed).
 *
 * Seats: orgs on an active paid plan get one auto seat invoice per month
 * (seats × plan price, GBP), created on first run of the month and kept in
 * step with seat changes under the same freeze rules.
 */

const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 4×/day comfortably covers "daily"
const BOOT_DELAY_MS = 45 * 1000; // let migrations/boot settle first

function prevPeriod(period: string): string {
  const [y, m] = period.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** End of a YYYY-MM period + N days — the due date for auto invoices. */
function dueAfterPeriod(period: string, days = 14): Date {
  const [y, m] = period.split("-").map(Number);
  return new Date(Date.UTC(y, m, 1) + days * 24 * 60 * 60 * 1000);
}

async function findAutoInvoice(orgId: string, type: string, period: string) {
  const [row] = await db
    .select()
    .from(invoices)
    .where(
      and(
        eq(invoices.organizationId, orgId),
        eq(invoices.type, type),
        eq(invoices.period, period),
        sql`${invoices.meta}->>'auto' = 'true'`,
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Insert with the unique-number retry (mirrors the admin create route). */
async function insertAutoInvoice(values: {
  organizationId: string;
  type: string;
  period: string;
  currency: string;
  lineItems: InvoiceLineItem[];
  totalMinor: number;
  meta: Record<string, unknown>;
  dueAt: Date;
}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const number = await nextInvoiceNumber(attempt);
    try {
      await db.insert(invoices).values({
        id: createId("inv"),
        organizationId: values.organizationId,
        number,
        type: values.type,
        period: values.period,
        currency: values.currency,
        lineItems: values.lineItems,
        subtotalMinor: values.totalMinor,
        totalMinor: values.totalMinor,
        meta: { ...values.meta, auto: true },
        notes: "Automatically generated.",
        dueAt: values.dueAt,
      });
      return;
    } catch (err: any) {
      if (attempt === 2 || !String(err?.message ?? "").includes("unique")) throw err;
    }
  }
}

/** Regenerate-or-create one org's auto telephony invoice for a period, and
 *  bring the telephony credit ledger's usage draw-down in line with the
 *  period's billed usage. */
async function upsertTelephonyInvoice(
  orgId: string,
  period: string,
  currency: string,
  bufferPct: number,
  autoTopupEnabled: boolean,
) {
  const built = await buildTelephonyInvoice(orgId, period, INVOICE_MULTIPLIER_DEFAULT, bufferPct);

  // Wallet draw-down FIRST — before any early return. Usage keeps accruing
  // after a payment link freezes the invoice, and a period whose usage was
  // revised down still needs its refund delta. usageMinor excludes the buffer.
  await applyUsageDelta(orgId, period, built.usageMinor);

  // Prepaid mode: with auto top-up on, the org's card is charged whenever the
  // wallet dips below its threshold — that IS the telephony billing. Creating
  // or refreshing a monthly usage invoice on top would charge the same usage
  // twice, so invoices are suppressed while enabled (existing open invoices
  // are left as-is for the admin to settle or void).
  if (autoTopupEnabled) return;

  const existing = await findAutoInvoice(orgId, "telephony", period);

  if (!existing) {
    if (!built.lineItems.length || built.totalMinor <= 0) return;
    await insertAutoInvoice({
      organizationId: orgId,
      type: "telephony",
      period,
      currency,
      lineItems: built.lineItems,
      totalMinor: built.totalMinor,
      meta: built.meta,
      dueAt: dueAfterPeriod(period),
    });
    return;
  }

  // Frozen: paid/void, or a payment link exists (its amount is fixed).
  if (existing.status !== "open" || existing.stripePaymentLinkId) return;
  // A buffer-% change can leave the total coincidentally unchanged while the
  // line items are stale — compare both before short-circuiting.
  if (
    existing.totalMinor === built.totalMinor &&
    (existing.meta as Record<string, unknown>)?.bufferPct === bufferPct
  )
    return;
  await db
    .update(invoices)
    .set({
      lineItems: built.lineItems,
      subtotalMinor: built.totalMinor,
      totalMinor: built.totalMinor,
      meta: { ...built.meta, auto: true },
    })
    .where(eq(invoices.id, existing.id));
}

/** One auto seat invoice per org per month while the plan is active. */
async function upsertSeatInvoice(
  org: { id: string; plan: string; seatsIncluded: number },
  period: string,
) {
  const unitPence = PLAN_PRICES_PENCE[org.plan] || 0;
  const seats = org.seatsIncluded || 0;
  if (!unitPence || !seats) return;

  const planName = getPlanConfig(org.plan).name;
  const lineItems: InvoiceLineItem[] = [
    {
      description: `${planName} plan — ${seats} seat${seats === 1 ? "" : "s"} × £${(unitPence / 100).toFixed(2)}/mo`,
      quantity: seats,
      unit: "seat",
      amountMinor: seats * unitPence,
    },
  ];
  const totalMinor = seats * unitPence;
  const existing = await findAutoInvoice(org.id, "seats", period);

  if (!existing) {
    await insertAutoInvoice({
      organizationId: org.id,
      type: "seats",
      period,
      currency: "gbp",
      lineItems,
      totalMinor,
      meta: { seats, unitPricePence: unitPence, plan: org.plan },
      dueAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
    });
    return;
  }

  if (existing.status !== "open" || existing.stripePaymentLinkId) return;
  if (existing.totalMinor === totalMinor) return;
  await db
    .update(invoices)
    .set({
      lineItems,
      subtotalMinor: totalMinor,
      totalMinor,
      meta: { seats, unitPricePence: unitPence, plan: org.plan, auto: true },
    })
    .where(eq(invoices.id, existing.id));
}

export async function runInvoiceAutogen(): Promise<void> {
  const current = monthRange().period;
  const previous = prevPeriod(current);
  const currency = (await getAccountCurrency()).toLowerCase();

  // Telephony: orgs with any activity in either month, or active rented lines.
  const orgIds = new Set<string>();
  const since = monthRange(previous).start;
  const [callOrgs, smsOrgs, lineOrgs] = await Promise.all([
    db
      .selectDistinct({ orgId: callRecords.organizationId })
      .from(callRecords)
      .where(gte(callRecords.calledAt, since)),
    db
      .selectDistinct({ orgId: smsMessages.organizationId })
      .from(smsMessages)
      .where(gte(smsMessages.createdAt, since)),
    db
      .selectDistinct({ orgId: phoneLines.organizationId })
      .from(phoneLines)
      .where(eq(phoneLines.status, "active")),
  ]);
  for (const r of [...callOrgs, ...smsOrgs, ...lineOrgs]) if (r.orgId) orgIds.add(r.orgId);

  // Per-org buffer % + auto top-up flag (configurable in admin / settings).
  const orgConfig = new Map<string, { bufferPct: number; autoTopup: boolean }>();
  if (orgIds.size) {
    const rows = await db
      .select({
        id: organizations.id,
        bufferPct: organizations.telephonyBufferPct,
        autoTopup: organizations.telephonyAutoTopupEnabled,
      })
      .from(organizations)
      .where(inArray(organizations.id, [...orgIds]));
    for (const r of rows) orgConfig.set(r.id, { bufferPct: r.bufferPct ?? 0, autoTopup: r.autoTopup });
  }

  let processed = 0;
  for (const orgId of orgIds) {
    try {
      const cfg = orgConfig.get(orgId) ?? { bufferPct: 0, autoTopup: false };
      await upsertTelephonyInvoice(orgId, previous, currency, cfg.bufferPct, cfg.autoTopup);
      await upsertTelephonyInvoice(orgId, current, currency, cfg.bufferPct, cfg.autoTopup);
      // After the draw-downs land: recharge the wallet if it fell below the
      // org's auto top-up threshold.
      if (cfg.autoTopup) await maybeAutoTopup(orgId);
      processed++;
    } catch (err) {
      console.error(`[InvoiceAutogen] telephony failed for org ${orgId}:`, err);
    }
  }

  // Seats: active paid plans get this month's seat invoice.
  const paidOrgs = await db
    .select({
      id: organizations.id,
      plan: organizations.plan,
      seatsIncluded: organizations.seatsIncluded,
    })
    .from(organizations)
    .where(and(eq(organizations.planStatus, "active"), sql`${organizations.plan} IN ('starter','growth','scale')`));
  let seatCount = 0;
  for (const org of paidOrgs) {
    try {
      await upsertSeatInvoice(org, current);
      seatCount++;
    } catch (err) {
      console.error(`[InvoiceAutogen] seats failed for org ${org.id}:`, err);
    }
  }

  console.log(
    `[InvoiceAutogen] swept ${processed} telephony org(s), ${seatCount} seat org(s) for ${previous}+${current}`,
  );
}

export function startInvoiceAutogen(): void {
  setTimeout(() => {
    void runInvoiceAutogen().catch((err) => console.error("[InvoiceAutogen] boot run failed:", err));
  }, BOOT_DELAY_MS);
  setInterval(() => {
    void runInvoiceAutogen().catch((err) => console.error("[InvoiceAutogen] sweep failed:", err));
  }, SWEEP_INTERVAL_MS);
  console.log("[InvoiceAutogen] scheduled (boot +45s, then every 6h)");
}
