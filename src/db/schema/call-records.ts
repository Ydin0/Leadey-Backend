import { pgTable, text, integer, timestamp } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { phoneLines } from "./phone-lines";

export const callRecords = pgTable("call_records", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  lineId: text("line_id").references(() => phoneLines.id, { onDelete: "set null" }),
  twilioCallSid: text("twilio_call_sid"),
  direction: text("direction").notNull(), // "inbound" | "outbound" | "missed"
  fromNumber: text("from_number").notNull(),
  toNumber: text("to_number").notNull(),
  contactName: text("contact_name"),
  companyName: text("company_name"),
  /** Campaign lead this call was placed against (when dialed from a lead/
   *  campaign context). Nullable + no FK so a record is never lost if the lead
   *  is later removed; the lead view also falls back to phone-number matching
   *  for calls that predate this column. */
  leadId: text("lead_id"),
  funnelId: text("funnel_id"),
  duration: integer("duration").notNull().default(0),
  disposition: text("disposition").notNull().default("completed"),
  // Recording
  recordingUrl: text("recording_url"),
  recordingSid: text("recording_sid"),
  recordingDuration: integer("recording_duration"),
  // Transcription + AI
  transcript: text("transcript"),
  summary: text("summary"),
  // Rep who made/received the call
  userId: text("user_id"),
  userName: text("user_name"),
  calledAt: timestamp("called_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
