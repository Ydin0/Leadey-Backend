import { pgTable, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

/** A rep's own LinkedIn account, connected through Unipile's hosted-auth flow
 *  (login + 2FA happen on Unipile's page, never in-app). One row per connected
 *  account; a rep may connect one. `unipileAccountId` is the id every Unipile
 *  action (invite/message/profile) is executed against, and the key the
 *  linkedin_rate_limits table counts under. Used by workflow LinkedIn steps —
 *  the step either sends as the rep who triggered the workflow (their own row)
 *  or a fixed account chosen on the node. */
export const linkedinAccounts = pgTable(
  "linkedin_accounts",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Owner — the rep whose LinkedIn this is (users.id). */
    userId: text("user_id").notNull(),
    /** Unipile account id — the target of every send + the rate-limit key. */
    unipileAccountId: text("unipile_account_id").notNull(),
    /** Display name / headline reported by Unipile at connect time. */
    name: text("name"),
    /** LinkedIn public identifier (e.g. "jane-smith-123") + full profile URL. */
    publicIdentifier: text("public_identifier"),
    profileUrl: text("profile_url"),
    status: text("status").notNull().default("connected"), // connected | error
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("linkedin_accounts_org_idx").on(t.organizationId),
    index("linkedin_accounts_org_user_idx").on(t.organizationId, t.userId),
    uniqueIndex("linkedin_accounts_unipile_uq").on(t.unipileAccountId),
  ],
);
