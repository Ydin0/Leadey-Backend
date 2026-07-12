import { pgTable, text, integer, boolean, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

/** A single "HH:MM" 24h time-range within a day. */
export interface TimeRange {
  start: string; // "09:00"
  end: string; // "17:00"
}
/** Weekly availability windows keyed by weekday (empty array = unavailable). */
export interface WeeklyAvailability {
  mon: TimeRange[];
  tue: TimeRange[];
  wed: TimeRange[];
  thu: TimeRange[];
  fri: TimeRange[];
  sat: TimeRange[];
  sun: TimeRange[];
}

export const DEFAULT_AVAILABILITY: WeeklyAvailability = {
  mon: [{ start: "09:00", end: "17:00" }],
  tue: [{ start: "09:00", end: "17:00" }],
  wed: [{ start: "09:00", end: "17:00" }],
  thu: [{ start: "09:00", end: "17:00" }],
  fri: [{ start: "09:00", end: "17:00" }],
  sat: [],
  sun: [],
};

/** A rep's Calendly-style booking page (event type + availability schedule).
 *  Reps can have several; each defines its own hours, timezone, duration, and
 *  whether to subtract their live Google/Outlook calendar busy times. */
export const bookingPages = pgTable(
  "booking_pages",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Owner rep — the host whose mailbox creates the event. */
    userId: text("user_id").notNull(),
    name: text("name").notNull().default("Meeting"),
    durationMin: integer("duration_min").notNull().default(30),
    /** Attach a native video link (Google Meet / Teams) to booked meetings. */
    video: boolean("video").notNull().default(true),
    /** IANA timezone the weekly hours are expressed in. */
    timezone: text("timezone").notNull().default("UTC"),
    availability: jsonb("availability").$type<WeeklyAvailability>().notNull().default(DEFAULT_AVAILABILITY),
    /** When true, subtract the host's live calendar busy times from availability. */
    respectCalendar: boolean("respect_calendar").notNull().default(true),
    bufferBeforeMin: integer("buffer_before_min").notNull().default(0),
    bufferAfterMin: integer("buffer_after_min").notNull().default(0),
    /** Earliest a slot can be booked, minutes from now. */
    minNoticeMin: integer("min_notice_min").notNull().default(240),
    /** How far ahead slots are offered, in days. */
    maxDaysAhead: integer("max_days_ahead").notNull().default(60),
    isActive: boolean("is_active").notNull().default(true),
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("booking_pages_org_user_idx").on(t.organizationId, t.userId),
  ],
);
