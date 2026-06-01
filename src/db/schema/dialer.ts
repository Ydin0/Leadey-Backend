import {
  pgTable,
  text,
  integer,
  boolean,
  jsonb,
  timestamp,
  unique,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations } from "./organizations";
import { funnelSteps } from "./funnels";
import { leads } from "./leads";
import { callRecords } from "./call-records";
import { masterContacts } from "./master";

/** Per-org configurable disposition outcomes (e.g. "connected", "voicemail",
 *  "no-answer"). System rows are seeded on org create — additional rows can
 *  be added/edited by users from settings. */
export const callDispositions = pgTable(
  "call_dispositions",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    label: text("label").notNull(),
    /** contacted | not_contacted | negative — drives high-level reporting */
    outcomeBucket: text("outcome_bucket").notNull(),
    /** Default funnel action when this disposition is chosen. Step-specific
     *  overrides live in `funnel_disposition_rules`. */
    funnelAction: text("funnel_action").notNull().default("none"), // advance|retry|drop|none
    retryAfterDays: integer("retry_after_days"),
    sortOrder: integer("sort_order").notNull().default(0),
    /** "1".."9" — keyboard shortcut in the dialer UI */
    hotkey: text("hotkey"),
    color: text("color"),
    isSystem: boolean("is_system").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.organizationId, t.slug)],
);

/** Pre-recorded voicemail drops. recordingUrl must be publicly fetchable by
 *  Twilio's <Play> verb — we host these on Twilio Assets. */
export const voicemailDrops = pgTable("voicemail_drops", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  /** null = org-wide; otherwise this rep's personal VM */
  userId: text("user_id"),
  name: text("name").notNull(),
  recordingUrl: text("recording_url").notNull(),
  /** Twilio Asset SID — kept so we can delete from Twilio when row is dropped */
  twilioAssetSid: text("twilio_asset_sid"),
  durationSeconds: integer("duration_seconds").notNull().default(0),
  isDefault: boolean("is_default").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Per-funnel-step disposition rule overrides. Falls back to
 *  call_dispositions.funnelAction when no row exists. */
export const funnelDispositionRules = pgTable(
  "funnel_disposition_rules",
  {
    id: text("id").primaryKey(),
    funnelStepId: text("funnel_step_id")
      .notNull()
      .references(() => funnelSteps.id, { onDelete: "cascade" }),
    dispositionId: text("disposition_id")
      .notNull()
      .references(() => callDispositions.id, { onDelete: "cascade" }),
    funnelAction: text("funnel_action").notNull(), // advance|retry|drop|none
    retryAfterDays: integer("retry_after_days"),
  },
  (t) => [unique().on(t.funnelStepId, t.dispositionId)],
);

/** One dialing session = one rep working through one funnel step's queue. */
export const dialerSessions = pgTable(
  "dialer_sessions",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    funnelStepId: text("funnel_step_id")
      .notNull()
      .references(() => funnelSteps.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("active"), // active|paused|completed|abandoned
    totalLeads: integer("total_leads").notNull().default(0),
    completedLeads: integer("completed_leads").notNull().default(0),
    currentLeadIndex: integer("current_lead_index").notNull().default(0),
    /** counts by disposition slug — { connected: 4, voicemail: 12, ... } */
    dispositionsJson: jsonb("dispositions_json")
      .$type<Record<string, number>>()
      .notNull()
      .default({}),
    /** snapshotted filters used at session creation */
    filtersJson: jsonb("filters_json")
      .$type<{
        excludeDoNotCall: boolean;
        excludeRecentlyCalled: boolean;
        respectTimezone: boolean;
        maxAttempts: number | null;
      }>()
      .notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [
    // Partial unique index: only one active session per user globally.
    uniqueIndex("dialer_sessions_one_active_per_user")
      .on(t.userId)
      .where(sql`status = 'active'`),
  ],
);

/** Snapshotted queue items. Funnel mutations mid-session do NOT reshuffle
 *  the rep's queue — order/membership are fixed at session creation. */
export const dialerQueueItems = pgTable(
  "dialer_queue_items",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => dialerSessions.id, { onDelete: "cascade" }),
    leadId: text("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    /** master_contacts linkage (resolved via linkedinUrl/email at queue time)
     *  for cross-funnel DNC + call-history. nullable for CSV leads without a
     *  master_contact peer. */
    masterContactId: text("master_contact_id").references(() => masterContacts.id, {
      onDelete: "set null",
    }),
    /** Phone snapshotted so funnel/lead edits mid-session don't change what
     *  we dial. */
    leadPhone: text("lead_phone").notNull(),
    position: integer("position").notNull(),
    status: text("status").notNull().default("pending"),
    // pending | in_progress | awaiting_disposition | completed | skipped | failed
    dispositionId: text("disposition_id").references(() => callDispositions.id, {
      onDelete: "set null",
    }),
    callRecordId: text("call_record_id").references(() => callRecords.id, {
      onDelete: "set null",
    }),
    notes: text("notes"),
    calledAt: timestamp("called_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("dialer_queue_items_session_position").on(t.sessionId, t.position),
    index("dialer_queue_items_session_status").on(t.sessionId, t.status),
  ],
);
