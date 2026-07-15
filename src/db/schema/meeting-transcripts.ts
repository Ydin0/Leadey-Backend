import { pgTable, text, timestamp, integer, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

export interface TranscriptSentence {
  speaker: string | null;
  text: string;
  /** Seconds from the start of the recording. */
  start: number | null;
}

export interface TranscriptSummary {
  /** One-paragraph overview / gist. */
  overview: string | null;
  /** Bulleted action items. */
  actionItems: string[];
  /** Optional key topics / keywords. */
  keywords: string[];
}

/** One scored dimension of a call (0..max). */
export interface CallScoreMetric {
  key: string;
  label: string;
  score: number;
  max: number;
  note: string | null;
}

/** AI scoring of a call against a closing framework. Generated on demand from
 *  the transcript and cached on the row; re-scoreable. */
export interface CallScore {
  /** 0..100 overall. */
  overall: number;
  /** Short verdict word, e.g. "Strong" / "Solid" / "Needs work". */
  verdict: string;
  metrics: CallScoreMetric[];
  strengths: string[];
  improvements: string[];
  /** Rep-vs-prospect talk share (percent), when derivable from speakers. */
  talkRatio: { rep: number; prospect: number } | null;
  model: string;
  generatedAt: string;
}

/**
 * A meeting transcript pulled from Fathom or Fireflies and linked to a lead.
 * Keyed by (org, provider, externalId) so re-pulling upserts rather than
 * duplicating. Holds the AI summary, speaker-tagged transcript and a recording
 * URL for embedding on the lead's meeting-detail view.
 */
export const meetingTranscripts = pgTable(
  "meeting_transcripts",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(), // "fathom" | "fireflies"
    /** The provider's own id for the recording/transcript. */
    externalId: text("external_id").notNull(),
    /** Lead this transcript was matched/attached to. */
    leadId: text("lead_id"),
    /** The scheduled_meetings / calendar_events id it matched, when known. */
    meetingId: text("meeting_id"),
    /** Rep whose connected account fetched it. */
    fetchedByUserId: text("fetched_by_user_id"),
    title: text("title").notNull().default(""),
    heldAt: timestamp("held_at", { withTimezone: true }),
    durationSec: integer("duration_sec"),
    summary: jsonb("summary").$type<TranscriptSummary | null>(),
    /** Cached AI call scoring (generated on demand from the transcript). */
    score: jsonb("score").$type<CallScore | null>(),
    transcript: jsonb("transcript").$type<TranscriptSentence[]>().notNull().default([]),
    /** Direct video/audio URL (Fireflies) — may be embeddable. */
    recordingUrl: text("recording_url"),
    /** Shareable/embeddable page (Fathom share_url). */
    embedUrl: text("embed_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("meeting_transcripts_provider_ext_uq").on(t.organizationId, t.provider, t.externalId),
    index("meeting_transcripts_lead_idx").on(t.leadId),
  ],
);
