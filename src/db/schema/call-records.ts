import { pgTable, text, integer, timestamp, jsonb, real } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { phoneLines } from "./phone-lines";

/** One diarized line of the transcript. `speaker` is a stable id ("A"/"B"); the
 *  display name + colour are resolved from `speakers`. */
export interface TranscriptSegment {
  speaker: string;
  start: number; // seconds
  end: number;
  text: string;
}
export interface TranscriptSpeaker {
  id: string;
  name: string;
  role: "rep" | "prospect" | "other";
  talkPct: number; // 0-100
}
export interface CallSummaryStructured {
  tldr: string[];
  sections: { title: string; points: string[] }[];
  nextSteps?: string[];
}

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
  /** Diarized, timestamped transcript lines (interactive transcript UI). */
  transcriptSegments: jsonb("transcript_segments").$type<TranscriptSegment[]>(),
  /** Resolved speakers with display name, role and talk-time %. */
  speakers: jsonb("speakers").$type<TranscriptSpeaker[]>(),
  /** Sectioned AI summary (TL;DR + breakdown + next steps). */
  summaryStructured: jsonb("summary_structured").$type<CallSummaryStructured>(),
  // Rep who made/received the call
  userId: text("user_id"),
  userName: text("user_name"),
  // Exact Twilio cost — the billed `price` on the Twilio Call resource, synced
  // from the Twilio API (positive amount). Null until synced; `priceUnit` is the
  // account billing currency (e.g. "USD"). Used for per-org cost reporting.
  twilioPrice: real("twilio_price"),
  twilioPriceUnit: text("twilio_price_unit"),
  twilioPriceSyncedAt: timestamp("twilio_price_synced_at", { withTimezone: true }),
  calledAt: timestamp("called_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
