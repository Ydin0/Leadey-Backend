import { pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

/**
 * A rep's manual attendance disposition on a past meeting — "attended" (green)
 * or "no_show" (red). Meetings are merged at query time from several sources
 * (scheduled_meetings, calendar_events, calendly_meetings), so the disposition
 * is keyed by a stable `${source}:${sourceId}` string rather than a FK — that
 * key is identical across the lead-profile feed and the calendar/Cockpit feed,
 * so a meeting marked in one place shows the same label everywhere.
 */
export const meetingDispositions = pgTable(
  "meeting_dispositions",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** `${source}:${sourceId}` — e.g. "leadey:sm_123", "google:ce_456". */
    meetingKey: text("meeting_key").notNull(),
    disposition: text("disposition").notNull(), // attended | no_show
    /** The rep who set it (best-effort). */
    markedBy: text("marked_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("meeting_dispositions_org_key_uq").on(t.organizationId, t.meetingKey)],
);
