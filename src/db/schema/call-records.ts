import { pgTable, text, integer, timestamp, jsonb, real, boolean, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
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
  // Sales OUTCOME of the call (distinct from the telephony disposition) — e.g.
  // "booked_meeting", "qualified", "disqualified". AI-classified on transcription,
  // overridable by the rep. Stores the outcome key; org defines the label set.
  outcome: text("outcome"),
  /** True once a human has set the outcome — AI won't overwrite a manual choice. */
  outcomeManual: boolean("outcome_manual").notNull().default(false),
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
  /** Failed transcription attempts — the backfill sweeper retries a recording
   *  until this hits its cap, so a transient OpenAI outage (quota, rate limit,
   *  downtime) doesn't permanently strand calls without transcripts. */
  transcriptionAttempts: integer("transcription_attempts").notNull().default(0),
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
}, (t) => [
  // Dialer recency scans filter by org over a recent time window.
  index("call_records_org_called_at").on(t.organizationId, t.calledAt),
  // Per-lead recency lookups.
  index("call_records_lead_id").on(t.leadId),
  // Inbox: missed calls filtered by the org line(s) they came in on.
  index("call_records_line_called_at").on(t.lineId, t.calledAt),
  // Phone-number matching (lead activity counts, universal company timeline):
  // calls are matched to people by normalized counterparty digits, so index
  // the digit expressions on both directions.
  index("call_records_org_to_digits_idx").on(
    t.organizationId,
    sql`regexp_replace(${t.toNumber}, '[^0-9]', '', 'g')`,
  ),
  index("call_records_org_from_digits_idx").on(
    t.organizationId,
    sql`regexp_replace(${t.fromNumber}, '[^0-9]', '', 'g')`,
  ),
  // Last-10-digit matching (lead-profile call list, inbound-call → lead
  // resolution, dialer recency): queries wrap the digits in right(…,10), which
  // the plain-digits indexes above DON'T match — so index that exact shape too,
  // otherwise every such lookup full-scans call_records.
  index("call_records_org_to_last10_idx").on(
    t.organizationId,
    sql`right(regexp_replace(${t.toNumber}, '[^0-9]', '', 'g'), 10)`,
  ),
  index("call_records_org_from_last10_idx").on(
    t.organizationId,
    sql`right(regexp_replace(${t.fromNumber}, '[^0-9]', '', 'g'), 10)`,
  ),
]);
