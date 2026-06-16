import { pgTable, text, integer, jsonb, timestamp, index } from "drizzle-orm/pg-core";

// ─── Credit Transactions ────────────────────────────────────────────
// Append-only ledger of every change to an organization's credit wallet
// (organizations.credit_balance). One row per debit (enrichment / scrape),
// top-up (Stripe payment) or grant (plan renewal / signup). Powers the usage
// reports on the Credits settings tab.
export const creditTransactions = pgTable(
  "credit_transactions",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    /** Who triggered it (null for system grants / webhooks). */
    userId: text("user_id"),
    /** debit | topup | grant | refund | adjustment */
    kind: text("kind").notNull(),
    /** phone_enrichment | email_enrichment | job_scraping | topup |
     *  signup_grant | plan_grant | admin_adjustment */
    action: text("action").notNull(),
    /** Signed: negative for debits, positive for credits added. */
    credits: integer("credits").notNull(),
    /** Units billed (e.g. # phones, # emails, # jobs). */
    quantity: integer("quantity").notNull().default(1),
    /** Credits per unit (33 / 3 / 1). */
    unitCredits: integer("unit_credits").notNull().default(1),
    /** Wallet balance immediately after this transaction. */
    balanceAfter: integer("balance_after").notNull(),
    /** For top-ups: the USD amount charged, in cents. */
    amountUsdCents: integer("amount_usd_cents"),
    /** Stripe checkout session / invoice id — also the idempotency key. */
    stripeSessionId: text("stripe_session_id"),
    description: text("description"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("credit_tx_org_created_idx").on(t.organizationId, t.createdAt),
    index("credit_tx_stripe_session_idx").on(t.stripeSessionId),
  ],
);
