import { pgTable, text, integer, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

/**
 * Telephony credit ledger — SEPARATE from the generic action-credit wallet
 * (organizations.creditBalance). This wallet is MONEY in the Twilio account
 * currency's minor units (USD cents): paid telephony invoices (usage at 2×
 * + buffer %) top it up, and billed usage draws it down as it accrues.
 * `organizations.telephonyCreditBalanceMinor` is the denormalized live
 * balance, mutated in the same transaction as every ledger insert.
 *
 * Kinds:
 *  - topup:      invoice payment (invoiceId + optional stripeSessionId set)
 *  - usage:      signed usage delta for a period (period set; negative rows
 *                are draw-downs, positive rows are late-sync refunds)
 *  - adjustment: admin add/remove/set, and invoice un-pay reversals
 */
export const telephonyCreditTransactions = pgTable(
  "telephony_credit_transactions",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Admin actor for adjustments. */
    userId: text("user_id"),
    kind: text("kind").notNull(), // topup | usage | adjustment
    /** Signed, account-currency minor units. */
    amountMinor: integer("amount_minor").notNull(),
    balanceAfterMinor: integer("balance_after_minor").notNull(),
    invoiceId: text("invoice_id"),
    stripeSessionId: text("stripe_session_id"),
    /** YYYY-MM for usage rows. */
    period: text("period"),
    description: text("description"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("tel_credit_tx_org_created_idx").on(t.organizationId, t.createdAt),
    // Powers the per-period usage SUM in applyUsageDelta.
    index("tel_credit_tx_org_period_idx").on(t.organizationId, t.period, t.kind),
    // Powers the net-credited SUM in creditInvoicePayment / reverseInvoiceCredit.
    index("tel_credit_tx_invoice_idx").on(t.invoiceId),
  ],
);
