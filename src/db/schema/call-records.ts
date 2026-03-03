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
  duration: integer("duration").notNull().default(0),
  disposition: text("disposition").notNull().default("completed"),
  calledAt: timestamp("called_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
