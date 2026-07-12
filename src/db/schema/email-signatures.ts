import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

/** Org-shared email signature templates. `contentHtml` is HTML (simple text or
 *  a full corporate signature with logo/table) containing {{sender_*}} tokens
 *  that are resolved to each sending rep's own details at send time — so one
 *  signature serves the whole team. Assigned to a mailbox via
 *  email_accounts.signatureId. */
export const emailSignatures = pgTable("email_signatures", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  contentHtml: text("content_html").notNull().default(""),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
