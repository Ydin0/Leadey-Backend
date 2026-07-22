import { pgTable, text, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

export interface MeetingAttendeeRef {
  email: string;
  name?: string | null;
}

/** A meeting booked from inside Leadey (the "Book meeting" action) — a real
 *  Google Meet / Teams calendar event created on the host's mailbox and sent to
 *  the lead's contact + guests. Stores leadId directly so it shows on the lead
 *  profile instantly (before the 5-min calendar sync pulls the same event). */
export const scheduledMeetings = pgTable(
  "scheduled_meetings",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    leadId: text("lead_id"),
    funnelId: text("funnel_id"),
    /** The rep whose mailbox hosts the event + the account it was created on. */
    hostUserId: text("host_user_id"),
    hostAccountId: text("host_account_id"),
    hostEmail: text("host_email"),
    /** The rep CREDITED with booking this meeting — drives per-rep booking
     *  leaderboards + sit rate. In-app "Book meeting" ⇒ the rep who clicked it;
     *  public self-booking ⇒ the assigned host (with createdBy null ⇒ inbound). */
    bookedByUserId: text("booked_by_user_id"),
    provider: text("provider").notNull(), // google | microsoft
    /** External calendar event id — dedupes against the calendar-sync feed. */
    providerEventId: text("provider_event_id").notNull(),
    title: text("title").notNull().default(""),
    description: text("description"),
    startTime: timestamp("start_time", { withTimezone: true }),
    endTime: timestamp("end_time", { withTimezone: true }),
    joinUrl: text("join_url"),
    location: text("location"),
    attendees: jsonb("attendees").$type<MeetingAttendeeRef[]>().notNull().default([]),
    status: text("status").notNull().default("confirmed"), // confirmed | cancelled
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("scheduled_meetings_org_lead_idx").on(t.organizationId, t.leadId),
    index("scheduled_meetings_org_start_idx").on(t.organizationId, t.startTime),
    index("scheduled_meetings_org_booked_idx").on(t.organizationId, t.bookedByUserId),
    uniqueIndex("scheduled_meetings_event_uq").on(t.providerEventId),
  ],
);
