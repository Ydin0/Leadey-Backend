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
  // Rich HTML body for email templates (links, formatting). `body` keeps a
  // plain-text extraction for previews / non-HTML channels; null on legacy
  // rows and on linkedin/sms templates.
  bodyHtml: text("body_html"),
  tags: jsonb("tags").$type<string[]>().notNull().default([]),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
