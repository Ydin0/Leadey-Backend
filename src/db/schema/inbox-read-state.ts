import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

/** Per-rep "seen" watermarks for the notification-style inbox tabs. A tab's
 *  badge counts only items newer than the rep's watermark for that tab, so
 *  opening the tab acknowledges the current items and clears the badge (new
 *  activity afterwards re-increments it). */
export const inboxReadState = pgTable("inbox_read_state", {
  /** Clerk user id — one row per rep. */
  userId: text("user_id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  /** Missed-call activity at/before this instant is considered seen. */
  callsSeenAt: timestamp("calls_seen_at", { withTimezone: true }),
  /** Message activity at/before this instant is considered seen. */
  messagesSeenAt: timestamp("messages_seen_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
