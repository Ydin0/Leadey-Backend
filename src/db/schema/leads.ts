import { pgTable, text, integer, jsonb, timestamp, boolean, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { funnels } from "./funnels";
import { masterCompanies, masterContacts } from "./master";

export const leads = pgTable("leads", {
  id: text("id").primaryKey(),
  funnelId: text("funnel_id")
    .notNull()
    .references(() => funnels.id, { onDelete: "cascade" }),
  /** The canonical PERSON this enrollment belongs to (master_contacts).
   *  A lead row is one person's enrollment in one campaign; identity —
   *  who they are across campaigns, DNC, timezone — lives on the master.
   *  Nullable: legacy rows are linked by the person-identity backfill, and
   *  a row with no email/phone/linkedin may be unresolvable. */
  masterContactId: text("master_contact_id").references(() => masterContacts.id, { onDelete: "set null" }),
  /** The canonical COMPANY this enrollment belongs to (master_companies).
   *  Set on every lead write path and backfilled (domain → normalized name);
   *  the universal company profile aggregates by this id, with a
   *  normalized-name fallback for rows that predate the link. Nullable:
   *  a lead with an empty company name is unresolvable. */
  masterCompanyId: text("master_company_id").references(() => masterCompanies.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  /** Explicit first/last name when the source provided them separately (CSV
   *  import, scraper). Lets email templates field-map {{first_name}} /
   *  {{last_name}} reliably instead of splitting the full name. */
  firstName: text("first_name"),
  lastName: text("last_name"),
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
  companyDomain: text("company_domain"),
  companyIndustry: text("company_industry"),
  companyEmployeeCount: integer("company_employee_count"),
  companyLocation: text("company_location"),
  companyDescription: text("company_description"),
  companyLinkedin: text("company_linkedin"),
  companyAnnualRevenue: text("company_annual_revenue"),
  /** Roles the company is actively hiring for (job-scraper signal). */
  companyHiringRoles: jsonb("company_hiring_roles").$type<string[]>(),
  /** Per-PERSON Do-Not-Contact flag (compliance). Non-destructive: the lead
   *  stays in the campaign but is shown in red and calls are confirmed first.
   *  Mirrored onto master_contacts.doNotCall so it follows the person. */
  doNotCall: boolean("do_not_call").notNull().default(false),
  /** Free-form tags (used by workflow Tag steps + filtering). */
  tags: jsonb("tags").$type<string[]>().notNull().default([]),
  /** Assigned owner (Clerk user id) — set by workflow Assign steps. */
  ownerId: text("owner_id"),
  smartleadLeadId: text("smartlead_lead_id"),
  unipileProviderId: text("unipile_provider_id"),
  /** The CSV import that created this lead, if any. Lets the Imports page
   *  list and roll back a bad import. FK to imports.id ON DELETE SET NULL
   *  (added in migration) so deleting an import record never kills leads. */
  importId: text("import_id"),
  /** Set once the lead is converted to an Opportunity. The lead stays
   *  active in the campaign — this is just a link. ON DELETE SET NULL
   *  so removing an opp doesn't cascade-kill the lead history. */
  opportunityId: text("opportunity_id"),
  notes: jsonb("notes").$type<Record<string, string>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // Person-identity lookups: memberships, DNC fan-out, sibling sync.
  index("leads_master_contact_id_idx").on(t.masterContactId),
  index("leads_funnel_id_idx").on(t.funnelId),
  // Company-identity lookups: universal company profile aggregation.
  index("leads_master_company_id_idx").on(t.masterCompanyId),
  // Cross-campaign sibling matching by identity keys (activity counts,
  // memberships fallback) — probe org leads by normalized email/phone
  // instead of scanning org-wide event/call tables.
  index("leads_email_lower_idx").on(sql`lower(${t.email})`),
  index("leads_phone_digits_idx").on(sql`regexp_replace(${t.phone}, '[^0-9]', '', 'g')`),
  // The org leads list orders by lower(company).
  index("leads_company_lower_idx").on(sql`lower(${t.company})`),
]);

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
}, (t) => [
  // Per-lead timeline reads (lead profile + universal company profile) are
  // keyset-paginated by (lead_id, timestamp DESC).
  index("lead_events_lead_id_ts_idx").on(t.leadId, t.timestamp),
  // Time-sliced org activity (e.g. the rep dashboard's "today" aggregates)
  // starts from the small recent slice instead of per-lead probes.
  index("lead_events_timestamp_idx").on(t.timestamp),
]);
