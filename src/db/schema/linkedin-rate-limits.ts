import { pgTable, text, integer, timestamp } from "drizzle-orm/pg-core";

export const linkedinRateLimits = pgTable("linkedin_rate_limits", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  date: text("date").notNull(),
  invitationsSent: integer("invitations_sent").notNull().default(0),
  messagesSent: integer("messages_sent").notNull().default(0),
  profilesViewed: integer("profiles_viewed").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
