import { pgTable, text, integer, jsonb, timestamp } from "drizzle-orm/pg-core";
import { funnels } from "./funnels";

export const leads = pgTable("leads", {
  id: text("id").primaryKey(),
  funnelId: text("funnel_id")
    .notNull()
    .references(() => funnels.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  title: text("title").notNull().default(""),
  company: text("company").notNull(),
  email: text("email").notNull().default(""),
  phone: text("phone").notNull().default(""),
  linkedinUrl: text("linkedin_url").notNull().default(""),
  currentStep: integer("current_step").notNull().default(1),
  totalSteps: integer("total_steps").notNull().default(1),
  status: text("status").notNull().default("pending"),
  nextAction: text("next_action").notNull().default(""),
  nextDate: timestamp("next_date", { withTimezone: true }),
  source: text("source").notNull().default(""),
  sourceType: text("source_type").notNull().default("csv"),
  score: integer("score").notNull().default(50),
  smartleadLeadId: text("smartlead_lead_id"),
  unipileProviderId: text("unipile_provider_id"),
  notes: jsonb("notes").$type<Record<string, string>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const leadEvents = pgTable("lead_events", {
  id: text("id").primaryKey(),
  leadId: text("lead_id")
    .notNull()
    .references(() => leads.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  outcome: text("outcome"),
  stepIndex: integer("step_index").notNull().default(0),
  meta: jsonb("meta").$type<Record<string, unknown>>(),
  timestamp: timestamp("timestamp", { withTimezone: true }).notNull().defaultNow(),
});
