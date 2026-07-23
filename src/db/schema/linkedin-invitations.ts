import { pgTable, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

/** A LinkedIn connection request sent through a rep's connected account. Drives
 *  the Inbox "Sent connection requests" list AND the acceptance sweeper: while
 *  `status = 'pending'` a sweeper polls Unipile for whether the recipient is now
 *  a 1st-degree connection, flipping to `accepted` and firing the
 *  `connection_accepted` workflow event. */
export const linkedinInvitations = pgTable(
  "linkedin_invitations",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    accountId: text("account_id"),
    unipileAccountId: text("unipile_account_id").notNull(),
    /** Owner rep (linkedin_accounts.userId) — who the request was sent from. */
    userId: text("user_id"),
    leadId: text("lead_id"),
    /** Recipient's LinkedIn provider id. */
    providerId: text("provider_id").notNull(),
    publicIdentifier: text("public_identifier"),
    name: text("name"),
    message: text("message"),
    status: text("status").notNull().default("pending"), // pending | accepted | withdrawn | failed
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    /** Last time the sweeper polled this invite's acceptance status. */
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
  },
  (t) => [
    index("linkedin_invitations_org_status_idx").on(t.organizationId, t.status),
    index("linkedin_invitations_org_lead_idx").on(t.organizationId, t.leadId),
    uniqueIndex("linkedin_invitations_acct_provider_uq").on(t.unipileAccountId, t.providerId),
  ],
);
