import { and, eq, gte, isNull, sql } from "drizzle-orm";
import { db } from "../db/index";
import { organizations } from "../db/schema/organizations";
import { creditTransactions } from "../db/schema/credits";
import { scraperContacts } from "../db/schema/contacts";
import { ApiError, createId } from "./helpers";

// ─── Pricing ────────────────────────────────────────────────────────
// Fixed credit costs per billable action. 1 credit = $0.01 (1 US cent).
export const CREDIT_COSTS = {
  phone_enrichment: 33,
  email_enrichment: 3,
  job_scraping: 1,
} as const;

/** Cents charged per credit on a top-up (strict 1:1, no bonus). */
export const CREDIT_CENTS_PER = 1;

export type DebitAction = keyof typeof CREDIT_COSTS;
export type CreditKind = "debit" | "topup" | "grant" | "refund" | "adjustment";

/** Thrown when a debit would take the wallet below zero. Maps to HTTP 402 via
 *  the global error handler so the client can prompt a top-up. */
export class InsufficientCreditsError extends ApiError {
  constructor(required: number, balance: number) {
    super(
      402,
      `Insufficient credits — this action needs ${required} credits but your balance is ${balance}. Please top up.`,
      { code: "INSUFFICIENT_CREDITS", required, balance },
    );
  }
}

/** Current wallet balance for an org (0 if the org is missing). */
export async function getBalance(orgId: string): Promise<number> {
  const [org] = await db
    .select({ balance: organizations.creditBalance })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  return org?.balance ?? 0;
}

/** Whether the org can afford `n` credits right now. */
export async function hasCredits(orgId: string, n: number): Promise<boolean> {
  if (n <= 0) return true;
  return (await getBalance(orgId)) >= n;
}

interface DeductArgs {
  orgId: string;
  action: DebitAction;
  /** Units billed (e.g. # phones, # emails, # jobs). */
  quantity: number;
  /** Override the per-unit cost (defaults to CREDIT_COSTS[action]). */
  unitCredits?: number;
  userId?: string | null;
  description?: string;
  metadata?: Record<string, unknown>;
  /** When true, charge even if it takes the balance negative — for costs
   *  already incurred (e.g. enrichment results already paid to BetterContact).
   *  The hard block is enforced by the pre-flight check, not here. */
  allowNegative?: boolean;
}

/**
 * Atomically debit the wallet and write a ledger row. By default the
 * conditional UPDATE (`credit_balance >= amount`) guarantees we never go
 * negative even under concurrent debits, throwing InsufficientCreditsError when
 * too low. With `allowNegative`, the debit always applies (for already-incurred
 * costs). A non-positive amount (e.g. 0 jobs created) is a no-op.
 */
export async function deductCredits(args: DeductArgs): Promise<number> {
  const unit = args.unitCredits ?? CREDIT_COSTS[args.action];
  const amount = Math.max(0, Math.round(unit * args.quantity));
  if (amount === 0) return getBalance(args.orgId);

  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(organizations)
      .set({ creditBalance: sql`${organizations.creditBalance} - ${amount}`, updatedAt: new Date() })
      .where(
        args.allowNegative
          ? eq(organizations.id, args.orgId)
          : and(eq(organizations.id, args.orgId), gte(organizations.creditBalance, amount)),
      )
      .returning({ balance: organizations.creditBalance });

    if (!updated) {
      const balance = await getBalance(args.orgId);
      throw new InsufficientCreditsError(amount, balance);
    }

    await tx.insert(creditTransactions).values({
      id: createId("ctx"),
      organizationId: args.orgId,
      userId: args.userId ?? null,
      kind: "debit",
      action: args.action,
      credits: -amount,
      quantity: args.quantity,
      unitCredits: unit,
      balanceAfter: updated.balance,
      description: args.description,
      metadata: args.metadata,
    });

    return updated.balance;
  });
}

interface AddArgs {
  orgId: string;
  kind: Exclude<CreditKind, "debit">;
  action: string;
  credits: number;
  amountUsdCents?: number | null;
  stripeSessionId?: string | null;
  userId?: string | null;
  description?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Atomically add credits (top-up / grant / refund) and write a ledger row.
 * Idempotent on `stripeSessionId` — replaying a Stripe webhook never
 * double-credits the wallet. Returns the new balance.
 */
export async function addCredits(args: AddArgs): Promise<number> {
  const amount = Math.max(0, Math.round(args.credits));
  if (amount === 0) return getBalance(args.orgId);

  return db.transaction(async (tx) => {
    if (args.stripeSessionId) {
      const [existing] = await tx
        .select({ id: creditTransactions.id })
        .from(creditTransactions)
        .where(eq(creditTransactions.stripeSessionId, args.stripeSessionId))
        .limit(1);
      if (existing) {
        return getBalance(args.orgId); // already processed
      }
    }

    const [updated] = await tx
      .update(organizations)
      .set({ creditBalance: sql`${organizations.creditBalance} + ${amount}`, updatedAt: new Date() })
      .where(eq(organizations.id, args.orgId))
      .returning({ balance: organizations.creditBalance });

    if (!updated) throw new ApiError(404, "Organization not found");

    await tx.insert(creditTransactions).values({
      id: createId("ctx"),
      organizationId: args.orgId,
      userId: args.userId ?? null,
      kind: args.kind,
      action: args.action,
      credits: amount,
      quantity: 1,
      unitCredits: amount,
      balanceAfter: updated.balance,
      amountUsdCents: args.amountUsdCents ?? null,
      stripeSessionId: args.stripeSessionId ?? null,
      description: args.description,
      metadata: args.metadata,
    });

    return updated.balance;
  });
}

/**
 * Bill the credit cost of completed BetterContact enrichment results. Charges
 * 33 credits per phone found and 3 per email found. Idempotent and race-safe:
 * it claims each contact by atomically stamping `credits_billed_at` (only when
 * still null), so the poll route and the webhook never double-charge. Charges
 * with `allowNegative` because the cost is already incurred — the hard block
 * lives in the `/contacts/enrich` pre-flight.
 */
export async function billEnrichmentResults(
  orgId: string,
  contactIds: string[],
  userId?: string | null,
): Promise<void> {
  for (const contactId of contactIds) {
    // Atomically claim this contact's billing (idempotency guard).
    const [claimed] = await db
      .update(scraperContacts)
      .set({ creditsBilledAt: new Date() })
      .where(
        and(
          eq(scraperContacts.id, contactId),
          eq(scraperContacts.organizationId, orgId),
          isNull(scraperContacts.creditsBilledAt),
        ),
      )
      .returning({ email: scraperContacts.email, phone: scraperContacts.phone });
    if (!claimed) continue; // already billed by the other code path

    try {
      if (claimed.phone) {
        await deductCredits({
          orgId,
          action: "phone_enrichment",
          quantity: 1,
          userId,
          description: "Phone number enrichment",
          metadata: { contactId },
          allowNegative: true,
        });
      }
      if (claimed.email) {
        await deductCredits({
          orgId,
          action: "email_enrichment",
          quantity: 1,
          userId,
          description: "Email enrichment",
          metadata: { contactId },
          allowNegative: true,
        });
      }
    } catch (err) {
      console.error(`[credits] Failed to bill enrichment for ${contactId}:`, err);
    }
  }
}
