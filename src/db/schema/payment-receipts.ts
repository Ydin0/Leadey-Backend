import { pgTable, text, integer, timestamp } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

/** One row per payment we've emailed a receipt for. The Stripe reference
 *  (PaymentIntent id or Invoice id) is the primary key, so a re-delivered
 *  webhook claims-then-skips instead of sending a duplicate "thank you" email. */
export const paymentReceipts = pgTable("payment_receipts", {
  reference: text("reference").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  amountMinor: integer("amount_minor").notNull().default(0),
  currency: text("currency").notNull().default("usd"),
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
});
