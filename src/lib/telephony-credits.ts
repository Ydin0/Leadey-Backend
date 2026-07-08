import { eq, and, sql } from "drizzle-orm";
import { db } from "../db/index";
import { organizations } from "../db/schema/organizations";
import { telephonyCreditTransactions } from "../db/schema/telephony-credits";
import { invoices } from "../db/schema/invoices";
import { getAccountCurrency } from "./twilio-cost-sync";
import { createId } from "./helpers";

/**
 * Telephony credit wallet — money (account-currency minor units) that paid
 * telephony invoices add and billed usage (2× Twilio) removes. Mirrors the
 * generic wallet in credits.ts (denormalized org balance + append-only
 * ledger, both mutated in one transaction), with two differences:
 *
 *  1. Every mutation takes a PER-ORG ADVISORY LOCK. The autogen sweeper can
 *     run on two instances at once during a Railway deploy overlap, and the
 *     usage-delta / net-credit computations are SUM-then-insert — racy
 *     without serialization.
 *  2. Balances may go NEGATIVE (track-only wallet: usage accrues whether or
 *     not the org has prepaid; the invoice buffer % is what keeps it
 *     positive in steady state).
 *
 * Accounting note: a payment link freezes an invoice while usage keeps
 * accruing, so a fully-paid period can net less than the full buffer — that
 * is correct (money-in = what was paid, money-out = actual usage).
 */

/** Ledger starts at this period. Earlier months were billed/paid before the
 *  wallet existed — debiting them (or crediting their late payments) would
 *  start every org at a meaningless negative/positive number.
 *  Moved back to 2026-06 (Jul 2026): June invoices are still OPEN, so their
 *  usage must show as owing in the wallet and their payments must credit it.
 *  The sweeper covers previous+current period, so June backfills on the next
 *  sweep automatically. */
export const TELEPHONY_LEDGER_EPOCH = "2026-06";

type TelephonyKind = "topup" | "usage" | "adjustment";
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Serialize all telephony-ledger mutations for one org. */
async function lockOrg(tx: Tx, orgId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('telcred'), hashtext(${orgId}))`);
}

/** Apply one signed ledger row + the matching balance change. Assumes the
 *  caller's transaction already holds the org lock. Returns balanceAfter. */
async function applyLedgerRow(
  tx: Tx,
  args: {
    orgId: string;
    kind: TelephonyKind;
    amountMinor: number;
    invoiceId?: string | null;
    stripeSessionId?: string | null;
    period?: string | null;
    userId?: string | null;
    description?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<number> {
  const [row] = await tx
    .update(organizations)
    .set({
      telephonyCreditBalanceMinor: sql`${organizations.telephonyCreditBalanceMinor} + ${args.amountMinor}`,
      updatedAt: new Date(),
    })
    .where(eq(organizations.id, args.orgId))
    .returning({ balance: organizations.telephonyCreditBalanceMinor });
  if (!row) throw new Error(`Organization ${args.orgId} not found`);

  await tx.insert(telephonyCreditTransactions).values({
    id: createId("teltx"),
    organizationId: args.orgId,
    userId: args.userId ?? null,
    kind: args.kind,
    amountMinor: args.amountMinor,
    balanceAfterMinor: row.balance,
    invoiceId: args.invoiceId ?? null,
    stripeSessionId: args.stripeSessionId ?? null,
    period: args.period ?? null,
    description: args.description ?? null,
    metadata: args.metadata ?? null,
  });
  return row.balance;
}

export async function getTelephonyBalance(orgId: string): Promise<number> {
  const [row] = await db
    .select({ balance: organizations.telephonyCreditBalanceMinor })
    .from(organizations)
    .where(eq(organizations.id, orgId));
  return row?.balance ?? 0;
}

/** Net amount already credited to the wallet for an invoice (topups minus
 *  reversals — all rows carrying this invoiceId). */
async function creditedForInvoice(tx: Tx, invoiceId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`COALESCE(SUM(${telephonyCreditTransactions.amountMinor}), 0)::int` })
    .from(telephonyCreditTransactions)
    .where(eq(telephonyCreditTransactions.invoiceId, invoiceId));
  return row?.n ?? 0;
}

/**
 * Credit the wallet for a paid telephony invoice. NET-BASED: credits
 * `totalMinor − alreadyCredited`, so Stripe webhook replays, a concurrent
 * manual mark-paid, and pay→open→pay flip-flops all converge with no double
 * credit and no lost re-credit.
 */
export async function creditInvoicePayment(
  inv: typeof invoices.$inferSelect,
  opts: { stripeSessionId?: string | null } = {},
): Promise<void> {
  if (inv.type !== "telephony" || inv.totalMinor <= 0) return;
  if ((inv.period ?? TELEPHONY_LEDGER_EPOCH) < TELEPHONY_LEDGER_EPOCH) return;

  // Ops tripwire: the wallet is denominated in the account currency — a
  // mismatched invoice currency means the Twilio account changed currency.
  try {
    const accountCurrency = (await getAccountCurrency()).toLowerCase();
    if (inv.currency !== accountCurrency) {
      console.warn(
        `[TelephonyCredits] invoice ${inv.number} currency ${inv.currency} != account ${accountCurrency} — crediting anyway`,
      );
    }
  } catch {
    /* currency check is best-effort */
  }

  await db.transaction(async (tx) => {
    await lockOrg(tx, inv.organizationId);
    const credited = await creditedForInvoice(tx, inv.id);
    const toCredit = inv.totalMinor - credited;
    if (toCredit <= 0) return;
    await applyLedgerRow(tx, {
      orgId: inv.organizationId,
      kind: "topup",
      amountMinor: toCredit,
      invoiceId: inv.id,
      stripeSessionId: opts.stripeSessionId ?? null,
      period: inv.period,
      description: `Invoice ${inv.number} paid`,
      metadata: { currency: inv.currency },
    });
  });
}

/** Claw back whatever an invoice has net-credited (used when an invoice is
 *  un-paid: paid → open/void). Net-based, so replays converge to zero. */
export async function reverseInvoiceCredit(inv: typeof invoices.$inferSelect): Promise<void> {
  if (inv.type !== "telephony") return;
  await db.transaction(async (tx) => {
    await lockOrg(tx, inv.organizationId);
    const credited = await creditedForInvoice(tx, inv.id);
    if (credited <= 0) return;
    await applyLedgerRow(tx, {
      orgId: inv.organizationId,
      kind: "adjustment",
      amountMinor: -credited,
      invoiceId: inv.id,
      period: inv.period,
      description: `Invoice ${inv.number} un-paid — top-up reversed`,
    });
  });
}

/**
 * Bring the ledger's usage for (org, period) to `usageMinor` (the period's
 * billed usage at the invoice multiplier, EXCLUDING the buffer line).
 * Inserts one signed delta row per change; negative usage revisions (late
 * Twilio price syncs) produce refund rows. Invariant afterwards:
 * −Σ(usage rows for org+period) = usageMinor.
 */
export async function applyUsageDelta(orgId: string, period: string, usageMinor: number): Promise<void> {
  if (period < TELEPHONY_LEDGER_EPOCH) return;
  await db.transaction(async (tx) => {
    await lockOrg(tx, orgId);
    const [row] = await tx
      .select({ n: sql<number>`COALESCE(SUM(${telephonyCreditTransactions.amountMinor}), 0)::int` })
      .from(telephonyCreditTransactions)
      .where(
        and(
          eq(telephonyCreditTransactions.organizationId, orgId),
          eq(telephonyCreditTransactions.kind, "usage"),
          eq(telephonyCreditTransactions.period, period),
        ),
      );
    const debitedSoFar = -(row?.n ?? 0);
    const delta = usageMinor - debitedSoFar;
    if (delta === 0) return;
    await applyLedgerRow(tx, {
      orgId,
      kind: "usage",
      amountMinor: -delta,
      period,
      description:
        delta > 0
          ? `Telephony usage ${period}`
          : `Telephony usage revision ${period} (late price sync)`,
    });
  });
}

/** Credit one auto top-up charge exactly once, keyed on the PaymentIntent id.
 *  Called both in-process right after a successful off-session charge AND from
 *  the payment_intent.succeeded webhook (backstop if the process died between
 *  charge and credit) — the ledger lookup makes replays no-ops. */
export async function creditAutoTopupOnce(
  orgId: string,
  amountMinor: number,
  paymentIntentId: string,
  currency: string,
  description = "Auto top-up",
): Promise<void> {
  if (amountMinor <= 0) return;
  await db.transaction(async (tx) => {
    await lockOrg(tx, orgId);
    const [dup] = await tx
      .select({ id: telephonyCreditTransactions.id })
      .from(telephonyCreditTransactions)
      .where(eq(telephonyCreditTransactions.stripeSessionId, paymentIntentId))
      .limit(1);
    if (dup) return;
    await applyLedgerRow(tx, {
      orgId,
      kind: "topup",
      amountMinor,
      stripeSessionId: paymentIntentId,
      description,
      metadata: { currency, paymentIntentId, auto: true },
    });
  });
}

const AUTOTOPUP_COOLDOWN_MIN = 20; // one attempt per window across instances
const AUTOTOPUP_MIN_CHARGE_MINOR = 100; // Stripe minimums + sanity
const AUTOTOPUP_MAX_CHARGE_MINOR = 1_000_000; // $10k cap per single charge

/** Find a reusable saved payment method for off-session charges. Order:
 *  customer default → subscription default → any saved card → any saved
 *  Link method (subscription checkouts paid via Stripe Link attach a
 *  "link"-type method, not a card — it charges off-session just fine). */
async function resolveSavedPaymentMethod(
  stripeApi: typeof import("./stripe").stripe,
  customerId: string,
  subscriptionId?: string | null,
): Promise<string | null> {
  const customer = await stripeApi.customers.retrieve(customerId);
  if (!customer.deleted) {
    const def = customer.invoice_settings?.default_payment_method;
    const id = typeof def === "string" ? def : (def?.id ?? null);
    if (id) return id;
  }
  if (subscriptionId) {
    try {
      const sub = await stripeApi.subscriptions.retrieve(subscriptionId);
      const def = sub.default_payment_method;
      const id = typeof def === "string" ? def : (def?.id ?? null);
      if (id) return id;
    } catch {
      /* subscription gone — fall through */
    }
  }
  for (const type of ["card", "link"] as const) {
    const pms = await stripeApi.paymentMethods.list({ customer: customerId, type, limit: 1 });
    if (pms.data[0]?.id) return pms.data[0].id;
  }
  return null;
}

/** Displayable details of the org's saved payment method (for the top-up
 *  confirmation UI). Null when nothing is on file. */
export async function getSavedPaymentMethodDetails(orgId: string): Promise<{
  kind: string;
  brand: string;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
  email: string | null;
} | null> {
  const [org] = await db
    .select({
      stripeCustomerId: organizations.stripeCustomerId,
      stripeSubscriptionId: organizations.stripeSubscriptionId,
    })
    .from(organizations)
    .where(eq(organizations.id, orgId));
  if (!org?.stripeCustomerId) return null;

  try {
    const { stripe } = await import("./stripe");
    const pmId = await resolveSavedPaymentMethod(stripe, org.stripeCustomerId, org.stripeSubscriptionId);
    if (!pmId) return null;
    const pm = await stripe.paymentMethods.retrieve(pmId);
    if (pm.type === "card" && pm.card) {
      return {
        kind: "card",
        brand: pm.card.brand,
        last4: pm.card.last4,
        expMonth: pm.card.exp_month,
        expYear: pm.card.exp_year,
        email: null,
      };
    }
    if (pm.type === "link") {
      return { kind: "link", brand: "link", last4: null, expMonth: null, expYear: null, email: pm.link?.email ?? null };
    }
    return { kind: pm.type, brand: pm.type, last4: null, expMonth: null, expYear: null, email: null };
  } catch {
    return null;
  }
}

/**
 * Charge the org's saved payment method off-session and credit the wallet.
 * Shared by auto top-up and the customer's manual top-up. Idempotent
 * crediting via the PaymentIntent id. Returns the error message on failure.
 */
export async function chargeSavedCardAndCredit(
  orgId: string,
  amountMinor: number,
  description: string,
  metadataType: "telephony_autotopup" | "telephony_topup",
): Promise<{
  charged: boolean;
  error?: string;
  /** "no_payment_method" → the caller can fall back to a Checkout page. */
  reason?: "no_payment_method";
  settledInvoices?: string[];
}> {
  const [org] = await db
    .select({
      name: organizations.name,
      stripeCustomerId: organizations.stripeCustomerId,
      stripeSubscriptionId: organizations.stripeSubscriptionId,
    })
    .from(organizations)
    .where(eq(organizations.id, orgId));
  if (!org?.stripeCustomerId) {
    return {
      charged: false,
      reason: "no_payment_method",
      error: "No billing profile on file — make a one-off top-up to save a card.",
    };
  }

  try {
    const { stripe } = await import("./stripe");
    const paymentMethod = await resolveSavedPaymentMethod(
      stripe,
      org.stripeCustomerId,
      org.stripeSubscriptionId,
    );
    if (!paymentMethod) {
      return {
        charged: false,
        reason: "no_payment_method",
        error: "No saved payment method — make a one-off top-up to save a card.",
      };
    }

    const currency = (await getAccountCurrency()).toLowerCase();
    const pi = await stripe.paymentIntents.create({
      amount: amountMinor,
      currency,
      customer: org.stripeCustomerId,
      payment_method: paymentMethod,
      off_session: true,
      confirm: true,
      description: `${description} — ${org.name}`,
      metadata: { type: metadataType, orgId },
    });
    if (pi.status !== "succeeded") {
      return { charged: false, error: `Card charge did not complete (status: ${pi.status}).` };
    }

    await creditAutoTopupOnce(orgId, amountMinor, pi.id, currency, description);
    const settledInvoices = await settleOpenTelephonyInvoices(orgId);
    return { charged: true, settledInvoices };
  } catch (err: any) {
    return { charged: false, error: err?.message || "Card charge failed." };
  }
}

/**
 * Settle open telephony invoices oldest-first from the wallet. Coverage =
 * how much of the invoiced usage the wallet now funds: sum of the open
 * invoices' usage plus the (possibly negative) balance. Each fully-covered
 * invoice is marked paid ("Settled by balance top-up") WITHOUT crediting the
 * wallet again — the top-up already put the money in. A shortfall leaves the
 * newest invoice(s) open; their remainder is exactly the wallet's remaining
 * negative balance, cleared by the next top-up.
 */
export async function settleOpenTelephonyInvoices(orgId: string): Promise<string[]> {
  const balance = await getTelephonyBalance(orgId);
  const open = await db
    .select()
    .from(invoices)
    .where(
      and(
        eq(invoices.organizationId, orgId),
        eq(invoices.type, "telephony"),
        eq(invoices.status, "open"),
      ),
    )
    .orderBy(invoices.issuedAt);
  if (!open.length) return [];

  const usageOf = (inv: typeof invoices.$inferSelect) =>
    Number((inv.meta as Record<string, unknown>)?.usageMinor ?? inv.totalMinor) || inv.totalMinor;

  let coverage = open.reduce((a, inv) => a + usageOf(inv), 0) + balance;
  const settled: string[] = [];
  for (const inv of open) {
    const usage = usageOf(inv);
    if (coverage < usage) break;
    coverage -= usage;
    await db
      .update(invoices)
      .set({
        status: "paid",
        paidAt: new Date(),
        notes: "Settled by balance top-up.",
      })
      .where(and(eq(invoices.id, inv.id), eq(invoices.status, "open")));
    if (inv.stripePaymentLinkId) {
      try {
        const { stripe } = await import("./stripe");
        await stripe.paymentLinks.update(inv.stripePaymentLinkId, { active: false });
      } catch {
        /* best-effort — a dead link that still gets paid is reconciled by the webhook */
      }
    }
    settled.push(inv.number);
    console.log(`[TelephonyCredits] invoice ${inv.number} settled by top-up (org ${orgId})`);
  }
  return settled;
}

/**
 * Auto top-up: if enabled and the wallet is below the org's threshold, charge
 * the saved card off-session to bring the balance back to the target. Runs
 * from the autogen sweeper (every 6h) and immediately after settings save.
 * A conditional-UPDATE claim on last_at stops overlapping instances from
 * double-charging; `force` (settings save) skips the cooldown but not the
 * threshold check. Failures land in telephony_autotopup_last_error.
 */
export async function maybeAutoTopup(
  orgId: string,
  opts: { force?: boolean } = {},
): Promise<{ charged: boolean; amountMinor?: number; error?: string }> {
  const [org] = await db
    .select({
      enabled: organizations.telephonyAutoTopupEnabled,
      thresholdMinor: organizations.telephonyAutoTopupThresholdMinor,
      targetMinor: organizations.telephonyAutoTopupTargetMinor,
      balance: organizations.telephonyCreditBalanceMinor,
      stripeCustomerId: organizations.stripeCustomerId,
      name: organizations.name,
    })
    .from(organizations)
    .where(eq(organizations.id, orgId));
  if (!org?.enabled || org.targetMinor <= 0) return { charged: false };
  if (org.balance >= org.thresholdMinor) return { charged: false };

  const amountMinor = Math.min(org.targetMinor - org.balance, AUTOTOPUP_MAX_CHARGE_MINOR);
  if (amountMinor < AUTOTOPUP_MIN_CHARGE_MINOR) return { charged: false };

  // Claim the attempt window (concurrency + retry-storm guard).
  const claimWhere = opts.force
    ? eq(organizations.id, orgId)
    : and(
        eq(organizations.id, orgId),
        sql`(${organizations.telephonyAutoTopupLastAt} IS NULL OR ${organizations.telephonyAutoTopupLastAt} < now() - interval '${sql.raw(String(AUTOTOPUP_COOLDOWN_MIN))} minutes')`,
      );
  const claimed = await db
    .update(organizations)
    .set({ telephonyAutoTopupLastAt: new Date() })
    .where(claimWhere)
    .returning({ id: organizations.id });
  if (!claimed.length) return { charged: false };

  const result = await chargeSavedCardAndCredit(
    orgId,
    amountMinor,
    "Leadey telephony auto top-up",
    "telephony_autotopup",
  );
  if (!result.charged) {
    const error = result.error || "Card charge failed.";
    await db
      .update(organizations)
      .set({ telephonyAutoTopupLastError: error, updatedAt: new Date() })
      .where(eq(organizations.id, orgId));
    console.warn(`[TelephonyAutoTopup] org ${orgId}: ${error}`);
    return { charged: false, error };
  }

  await db
    .update(organizations)
    .set({ telephonyAutoTopupLastError: null, updatedAt: new Date() })
    .where(eq(organizations.id, orgId));
  console.log(`[TelephonyAutoTopup] org ${orgId} charged ${amountMinor} minor`);
  return { charged: true, amountMinor };
}

/** Admin add/remove/set. Negative balances allowed — this wallet tracks a
 *  float, it doesn't gate spending. Returns the new balance + applied delta. */
export async function adjustTelephonyBalance(args: {
  orgId: string;
  action: "add" | "remove" | "set";
  amountMinor: number;
  userId?: string | null;
  description?: string;
}): Promise<{ balanceMinor: number; delta: number }> {
  return db.transaction(async (tx) => {
    await lockOrg(tx, args.orgId);
    const [current] = await tx
      .select({ balance: organizations.telephonyCreditBalanceMinor })
      .from(organizations)
      .where(eq(organizations.id, args.orgId));
    if (!current) throw new Error(`Organization ${args.orgId} not found`);

    const delta =
      args.action === "add"
        ? args.amountMinor
        : args.action === "remove"
          ? -args.amountMinor
          : args.amountMinor - current.balance;
    if (delta === 0) return { balanceMinor: current.balance, delta: 0 };

    const balanceMinor = await applyLedgerRow(tx, {
      orgId: args.orgId,
      kind: "adjustment",
      amountMinor: delta,
      userId: args.userId ?? null,
      description: args.description || `Admin ${args.action}`,
    });
    return { balanceMinor, delta };
  });
}
