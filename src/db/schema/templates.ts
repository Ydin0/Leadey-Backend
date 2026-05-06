import { pgTable, text, jsonb, timestamp } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

export const templates = pgTable("templates", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  channel: text("channel").notNull(), // "email" | "linkedin"
  category: text("category"), // "outreach" | "follow_up" | "breakup" | "referral" | "custom"
  subject: text("subject"), // email only
  body: text("body").notNull(),
  tags: jsonb("tags").$type<string[]>().notNull().default([]),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
