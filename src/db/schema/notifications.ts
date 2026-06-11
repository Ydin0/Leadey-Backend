import { pgTable, text, boolean, timestamp, index } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

/** In-app notification targeted at a single rep (the top-right bell). */
export const notifications = pgTable(
  "notifications",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** The rep this notification is for (Clerk user id). */
    userId: text("user_id").notNull(),
    type: text("type").notNull(), // "sms_reply" | ... (generic for future producers)
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    // Optional deep-link target.
    leadId: text("lead_id"),
    funnelId: text("funnel_id"),
    read: boolean("read").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("notifications_user_read_idx").on(t.userId, t.read)],
);
