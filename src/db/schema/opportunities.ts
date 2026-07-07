import {
  pgTable,
  text,
  integer,
  boolean,
  jsonb,
  numeric,
  timestamp,
  date,
  primaryKey,
  unique,
  index,
} from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { masterCompanies, masterContacts } from "./master";
import { leads } from "./leads";

/** A pipeline groups stages for one motion (e.g. "Sales", "Renewals",
 *  "Partner"). Each org gets a default "Sales" pipeline seeded on
 *  organization.created. */
export const pipelines = pgTable(
  "pipelines",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    isDefault: boolean("is_default").notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.organizationId, t.name)],
);

/** Who can work a pipeline. Mirrors funnel_members: admins/managers see all
 *  pipelines; a member scoped to "assigned" opportunities sees pipelines they
 *  belong to (plus opps they own). */
export const pipelineMembers = pgTable(
  "pipeline_members",
  {
    id: text("id").primaryKey(),
    pipelineId: text("pipeline_id")
      .notNull()
      .references(() => pipelines.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    role: text("role").notNull().default("contributor"), // "owner" | "contributor" | "viewer"
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.pipelineId, t.userId), index("pipeline_members_user_idx").on(t.userId)],
);

/** Stages within a pipeline. `type` drives terminal semantics — `won`
 *  and `lost` stages set `opportunities.closedAt` on transition.
 *  `defaultProbability` is 0-100; an opportunity may override per-row.
 *  `slug` is stable across renames so we can reference "won"/"lost"
 *  conceptually even if the label changes. */
export const pipelineStages = pgTable(
  "pipeline_stages",
  {
    id: text("id").primaryKey(),
    pipelineId: text("pipeline_id")
      .notNull()
      .references(() => pipelines.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    label: text("label").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    type: text("type").notNull().default("open"), // "open" | "won" | "lost"
    defaultProbability: integer("default_probability").notNull().default(50),
    color: text("color"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.pipelineId, t.slug)],
);

/** Opportunities — deals tracked through a pipeline. */
export const opportunities = pgTable(
  "opportunities",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    pipelineId: text("pipeline_id")
      .notNull()
      .references(() => pipelines.id, { onDelete: "restrict" }),
    stageId: text("stage_id")
      .notNull()
      .references(() => pipelineStages.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    masterCompanyId: text("master_company_id").references(
      () => masterCompanies.id,
      { onDelete: "set null" },
    ),
    /** Primary contact. Additional contacts live in opportunity_contacts. */
    masterContactId: text("master_contact_id").references(
      () => masterContacts.id,
      { onDelete: "set null" },
    ),
    /** Opportunity owner (users.id). Plain text — users table FK is added
     *  in a later migration, so we don't constrain to keep the schema
     *  forward-compatible with that change. */
    ownerId: text("owner_id"),
    /** The campaign lead this opp was converted from, if any. */
    sourceLeadId: text("source_lead_id").references(() => leads.id, {
      onDelete: "set null",
    }),
    /** Manual position within a stage column on the kanban board (0 = top). */
    sortOrder: integer("sort_order").notNull().default(0),
    value: numeric("value", { precision: 14, scale: 2 }).notNull().default("0"),
    currency: text("currency").notNull().default("USD"),
    /** When set, overrides the stage's defaultProbability for this opp. */
    probabilityOverride: integer("probability_override"),
    expectedCloseDate: date("expected_close_date"),
    /** Set when stage transitions into a `won`/`lost` stage; cleared on
     *  reopen. */
    closedAt: timestamp("closed_at", { withTimezone: true }),
    lostReason: text("lost_reason"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("opportunities_org_pipeline_stage_idx").on(
      t.organizationId,
      t.pipelineId,
      t.stageId,
    ),
    index("opportunities_org_owner_idx").on(t.organizationId, t.ownerId),
  ],
);

/** Additional contacts on an opportunity (beyond the primary). */
export const opportunityContacts = pgTable(
  "opportunity_contacts",
  {
    opportunityId: text("opportunity_id")
      .notNull()
      .references(() => opportunities.id, { onDelete: "cascade" }),
    masterContactId: text("master_contact_id")
      .notNull()
      .references(() => masterContacts.id, { onDelete: "cascade" }),
    role: text("role"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.opportunityId, t.masterContactId] })],
);

/** Activity timeline. Every meaningful change emits a row here so the
 *  detail page can render a complete history. */
export const opportunityEvents = pgTable(
  "opportunity_events",
  {
    id: text("id").primaryKey(),
    opportunityId: text("opportunity_id")
      .notNull()
      .references(() => opportunities.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** "created" | "stage_changed" | "owner_changed" | "value_changed"
     *  | "close_date_changed" | "note_added" | "won" | "lost"
     *  | "reopened" | "contact_added" | "contact_removed" */
    type: text("type").notNull(),
    meta: jsonb("meta").$type<Record<string, unknown>>(),
    userId: text("user_id"),
    userName: text("user_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("opportunity_events_opp_created_idx").on(t.opportunityId, t.createdAt),
  ],
);
