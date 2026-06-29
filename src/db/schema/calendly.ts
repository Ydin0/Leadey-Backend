import { pgTable, text, timestamp, index, unique } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

/** A rep's connected Calendly account (per-rep OAuth). Tokens are encrypted at
 *  rest via src/lib/crypto.ts. We also store the per-account webhook
 *  subscription + its signing key so we can verify inbound events. */
export const calendlyAccounts = pgTable(
  "calendly_accounts",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    email: text("email").notNull().default(""),
    schedulingUrl: text("scheduling_url"),
    calendlyUserUri: text("calendly_user_uri"),
    calendlyOrgUri: text("calendly_org_uri"),
    /** Encrypted JSON { access, refresh, expiresAt }. */
    encryptedTokens: text("encrypted_tokens"),
    webhookSubscriptionUri: text("webhook_subscription_uri"),
    webhookSigningKey: text("webhook_signing_key"),
    status: text("status").notNull().default("active"), // active | error | disconnected
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("calendly_accounts_org_user_idx").on(t.organizationId, t.userId),
    unique("calendly_accounts_org_user_uq").on(t.organizationId, t.userId),
  ],
);

/** Every Calendly meeting we hear about (matched to a lead or not). Source of
 *  truth for the lead timeline event + Potential Contacts de-dupe. */
export const calendlyMeetings = pgTable(
  "calendly_meetings",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id"),
    calendlyEventUri: text("calendly_event_uri").notNull(),
    inviteeEmail: text("invitee_email").notNull().default(""),
    inviteeName: text("invitee_name").notNull().default(""),
    title: text("title").notNull().default(""),
    startTime: timestamp("start_time", { withTimezone: true }),
    endTime: timestamp("end_time", { withTimezone: true }),
    joinUrl: text("join_url"),
    status: text("status").notNull().default("scheduled"), // scheduled | canceled
    /** Matched lead, if the invitee email is on a lead. */
    leadId: text("lead_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("calendly_meetings_org_idx").on(t.organizationId),
    index("calendly_meetings_lead_idx").on(t.leadId),
    index("calendly_meetings_email_idx").on(t.inviteeEmail),
    unique("calendly_meetings_event_uq").on(t.calendlyEventUri),
  ],
);
