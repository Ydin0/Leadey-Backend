import { pgTable, text, real, boolean, timestamp } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

export const phoneLines = pgTable("phone_lines", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  twilioSid: text("twilio_sid").notNull(),
  number: text("number").notNull(),
  friendlyName: text("friendly_name").notNull(),
  country: text("country").notNull(),
  countryCode: text("country_code").notNull(),
  type: text("type").notNull(), // "local" | "toll-free" | "mobile"
  status: text("status").notNull().default("active"),
  assignedTo: text("assigned_to"),
  assignedToName: text("assigned_to_name"),
  monthlyCost: real("monthly_cost").notNull().default(1.15),
  voicemailGreeting: text("voicemail_greeting").notNull().default(""),
  callForwardingNumber: text("call_forwarding_number").notNull().default(""),
  callRecordingEnabled: boolean("call_recording_enabled").notNull().default(false),
  bundleId: text("bundle_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
