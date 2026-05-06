import { pgTable, text, integer, jsonb, timestamp, unique } from "drizzle-orm/pg-core";

export const funnels = pgTable("funnels", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  status: text("status").notNull().default("draft"),
  sourceTypes: jsonb("source_types").$type<string[]>().notNull().default([]),
  smartleadCampaignId: text("smartlead_campaign_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const funnelSteps = pgTable("funnel_steps", {
  id: text("id").primaryKey(),
  funnelId: text("funnel_id")
    .notNull()
    .references(() => funnels.id, { onDelete: "cascade" }),
  channel: text("channel").notNull(),
  label: text("label").notNull(),
  dayOffset: integer("day_offset").notNull().default(0),
  sortOrder: integer("sort_order").notNull().default(0),
  subject: text("subject"),
  emailBody: text("email_body"),
  action: text("action"),
});

export const funnelMembers = pgTable("funnel_members", {
  id: text("id").primaryKey(),
  funnelId: text("funnel_id")
    .notNull()
    .references(() => funnels.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull(),
  role: text("role").notNull().default("contributor"), // "owner" | "contributor" | "viewer"
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique().on(t.funnelId, t.userId),
]);
