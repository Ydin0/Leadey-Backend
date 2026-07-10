import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/** Idempotency ledger for system/transactional emails that must send at most
 *  once per milestone (trial reminders, low-balance/blocked warnings, account
 *  disconnects, subscription lifecycle). The `key` encodes the event +
 *  scope + milestone, e.g. "trial_ending:org_123:3" or "mailbox_disconnected:
 *  eml_123". A row's presence means "already sent" — so webhook redelivery or
 *  a cron re-run claims-then-skips. (Payment receipts use payment_receipts.) */
export const emailSends = pgTable("email_sends", {
  key: text("key").primaryKey(),
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
});
