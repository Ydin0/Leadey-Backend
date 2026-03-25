import { pgTable, text, integer, bigint, boolean, jsonb, timestamp, real } from "drizzle-orm/pg-core";

// ─── Scraper Assignments ─────────────────────────────────────────────
// User-configured scraper instance, org-scoped
export const scraperAssignments = pgTable("scraper_assignments", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  scraperId: text("scraper_id").notNull(),
  scraperName: text("scraper_name").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  frequency: text("frequency").notNull().default("daily"),
  status: text("status").notNull().default("idle"),

  // Config
  keywords: jsonb("keywords").$type<string[]>().notNull().default([]),
  excludedKeywords: jsonb("excluded_keywords").$type<string[]>().notNull().default([]),
  keywordMatchMode: text("keyword_match_mode").notNull().default("any"),
  countries: jsonb("countries").$type<string[]>().notNull().default([]),
  languages: jsonb("languages").$type<string[]>().notNull().default(["English"]),
  sourceIds: jsonb("source_ids").$type<string[]>().notNull().default([]),
  sourceSignalLimits: jsonb("source_signal_limits").$type<Record<string, number>>().notNull().default({}),
  lookbackDays: integer("lookback_days").notNull().default(7),
  maxSignalsPerRun: integer("max_signals_per_run").notNull().default(100),
  minSignalScore: integer("min_signal_score").notNull().default(50),

  // TheirStack-specific filters
  jobSeniority: jsonb("job_seniority").$type<string[]>().notNull().default([]),
  remoteFilter: text("remote_filter").notNull().default("include"),

  // Saved Search fields
  filters: jsonb("filters").$type<Record<string, unknown>>().notNull().default({}),
  searchName: text("search_name").notNull().default("Untitled Search"),
  totalResults: integer("total_results").notNull().default(0),
  lastRunResultCount: integer("last_run_result_count").notNull().default(0),

  // Guardrails
  onlyDecisionMakers: boolean("only_decision_makers").notNull().default(false),
  dedupeCompanies: boolean("dedupe_companies").notNull().default(true),
  includeRemoteRoles: boolean("include_remote_roles").notNull().default(true),
  notifyOnHighIntent: boolean("notify_on_high_intent").notNull().default(false),

  // Stats
  signalsFound: integer("signals_found").notNull().default(0),
  companiesFound: integer("companies_found").notNull().default(0),
  creditsPerRun: real("credits_per_run").notNull().default(0),

  // Timestamps
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── Scraper Runs ────────────────────────────────────────────────────
// Individual execution record
export const scraperRuns = pgTable("scraper_runs", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  assignmentId: text("assignment_id")
    .notNull()
    .references(() => scraperAssignments.id, { onDelete: "cascade" }),
  sourceId: text("source_id").notNull().default("theirstack"),
  // Legacy Apify fields (nullable, no longer populated)
  apifyActorId: text("apify_actor_id"),
  apifyRunId: text("apify_run_id"),
  apifyDatasetId: text("apify_dataset_id"),
  status: text("status").notNull().default("pending"),
  error: text("error"),
  inputPayload: jsonb("input_payload").$type<Record<string, unknown>>(),
  itemsScraped: integer("items_scraped").notNull().default(0),
  signalsCreated: integer("signals_created").notNull().default(0),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

// ─── Scraper Signals ─────────────────────────────────────────────────
// Normalized job listing results
export const scraperSignals = pgTable("scraper_signals", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  assignmentId: text("assignment_id")
    .notNull()
    .references(() => scraperAssignments.id, { onDelete: "cascade" }),
  runId: text("run_id")
    .notNull()
    .references(() => scraperRuns.id, { onDelete: "cascade" }),
  sourceId: text("source_id").notNull(),

  // Job data
  jobTitle: text("job_title").notNull(),
  company: text("company").notNull(),
  companyDomain: text("company_domain"),
  location: text("location"),
  jobUrl: text("job_url"),
  description: text("description"),
  salary: text("salary"),
  postedAt: timestamp("posted_at", { withTimezone: true }),
  jobType: text("job_type"),
  isRemote: boolean("is_remote").notNull().default(false),

  // Company enrichment data
  companyLogo: text("company_logo"),
  companyIndustry: text("company_industry"),
  companyEmployeeCount: integer("company_employee_count"),
  companyRevenue: bigint("company_revenue", { mode: "number" }),
  companyFunding: bigint("company_funding", { mode: "number" }),
  companyFundingStage: text("company_funding_stage"),
  companyCountry: text("company_country"),
  companyCity: text("company_city"),
  companyLinkedinUrl: text("company_linkedin_url"),
  hiringTeam: jsonb("hiring_team").$type<Array<{ name: string; role: string; linkedinUrl: string; imageUrl: string }>>().notNull().default([]),
  seniority: text("seniority"),
  technologySlugs: jsonb("technology_slugs").$type<string[]>().notNull().default([]),
  minSalaryUsd: integer("min_salary_usd"),
  maxSalaryUsd: integer("max_salary_usd"),
  employmentStatus: text("employment_status"),
  discoveredAt: timestamp("discovered_at", { withTimezone: true }),
  enrichmentStatus: text("enrichment_status").notNull().default("none"),

  // Signal
  score: integer("score").notNull().default(50),
  signalType: text("signal_type").notNull().default("hiring"),
  status: text("status").notNull().default("new"),
  rawData: jsonb("raw_data").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
