import { pgTable, text, timestamp, index, unique, jsonb, integer } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

/** A rep's connected calendar (Google Calendar / Outlook via Microsoft Graph),
 *  per-rep OAuth. Reuses the same Google/Microsoft OAuth apps as email accounts
 *  but with read-only calendar scopes. Tokens encrypted at rest (src/lib/crypto.ts). */
export const calendarAccounts = pgTable(
  "calendar_accounts",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    provider: text("provider").notNull(), // "google" | "microsoft"
    email: text("email").notNull().default(""),
    name: text("name").notNull().default(""),
    status: text("status").notNull().default("active"), // active | error | disconnected
    /** Encrypted JSON { access, refresh, expiresAt, scope }. */
    encryptedTokens: text("encrypted_tokens"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    lastError: text("last_error"),
    /** Consecutive TRANSIENT sync failures (5xx / timeout / network). Reset to 0
     *  on any success. Auth failures skip this and disconnect immediately; a run
     *  of transient failures only escalates to "error" once this crosses the
     *  threshold, so a one-off 504 never triggers a reconnect email. */
    syncFailures: integer("sync_failures").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("calendar_accounts_org_user_idx").on(t.organizationId, t.userId),
    unique("calendar_accounts_org_user_provider_uq").on(t.organizationId, t.userId, t.provider),
  ],
);

/** Upcoming events synced from a connected calendar. Matched to leads at query
 *  time by attendee-email overlap, so newly added leads pick up existing events. */
export const calendarEvents = pgTable(
  "calendar_events",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    accountId: text("account_id")
      .notNull()
      .references(() => calendarAccounts.id, { onDelete: "cascade" }),
    providerEventId: text("provider_event_id").notNull(),
    title: text("title").notNull().default(""),
    startTime: timestamp("start_time", { withTimezone: true }),
    endTime: timestamp("end_time", { withTimezone: true }),
    joinUrl: text("join_url"),
    location: text("location"),
    organizerEmail: text("organizer_email"),
    /** Normalized lowercase attendee emails (incl. organizer). */
    attendeeEmails: text("attendee_emails").array().notNull().default([]),
    /** Per-attendee RSVP keyed by normalized email: accepted | declined | tentative | needsAction. */
    attendeeResponses: jsonb("attendee_responses")
      .$type<Record<string, "accepted" | "declined" | "tentative" | "needsAction">>()
      .notNull()
      .default({}),
    status: text("status").notNull().default("confirmed"), // confirmed | cancelled
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("calendar_events_org_start_idx").on(t.organizationId, t.startTime),
    index("calendar_events_account_idx").on(t.accountId),
    unique("calendar_events_account_event_uq").on(t.accountId, t.providerEventId),
  ],
);
