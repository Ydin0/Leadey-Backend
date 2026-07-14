import { pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

/**
 * Org-wide email suppression list — the source of truth for "never email this
 * address again." A recipient is suppressed by unsubscribe (link or "stop"
 * reply), a hard bounce, a spam complaint, or a manual add. Every outbound
 * marketing email (workflow + manual composer) checks this by the normalized
 * lower(email) key before sending, so a suppressed address is skipped even for
 * leads imported later with the same email.
 */
export const emailSuppressions = pgTable(
  "email_suppressions",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** lower(trim(email)) — the normalized suppression key. */
    emailKey: text("email_key").notNull(),
    reason: text("reason").notNull(), // unsubscribe | bounce | complaint | manual
    /** The lead that triggered the suppression, when known (best-effort). */
    leadId: text("lead_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("email_suppressions_org_email_uq").on(t.organizationId, t.emailKey)],
);
