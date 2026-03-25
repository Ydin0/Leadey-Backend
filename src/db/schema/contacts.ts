import { pgTable, text, integer, real, jsonb, timestamp } from "drizzle-orm/pg-core";
import { scraperAssignments } from "./scrapers";

// ─── Discovery Runs ─────────────────────────────────────────────────
// Each Apify actor invocation for finding contacts at companies
export const discoveryRuns = pgTable("discovery_runs", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  assignmentId: text("assignment_id")
    .notNull()
    .references(() => scraperAssignments.id, { onDelete: "cascade" }),
  apifyRunId: text("apify_run_id"),
  apifyDatasetId: text("apify_dataset_id"),
  targetRoles: jsonb("target_roles").$type<string[]>().notNull().default([]),
  seniorityLevels: jsonb("seniority_levels").$type<string[]>().notNull().default([]),
  maxPerCompany: integer("max_per_company").notNull().default(5),
  maxTotal: integer("max_total").notNull().default(100),
  companyLinkedinUrls: jsonb("company_linkedin_urls").$type<string[]>().notNull().default([]),
  status: text("status").notNull().default("pending"),
  error: text("error"),
  companiesQueried: integer("companies_queried").notNull().default(0),
  contactsFound: integer("contacts_found").notNull().default(0),
  estimatedCost: real("estimated_cost").notNull().default(0),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── Scraper Contacts ───────────────────────────────────────────────
// Individual discovered people from Apify LinkedIn scraper
export const scraperContacts = pgTable("scraper_contacts", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  assignmentId: text("assignment_id")
    .notNull()
    .references(() => scraperAssignments.id, { onDelete: "cascade" }),
  discoveryRunId: text("discovery_run_id")
    .notNull()
    .references(() => discoveryRuns.id, { onDelete: "cascade" }),

  // Person data (from Apify)
  firstName: text("first_name"),
  lastName: text("last_name"),
  fullName: text("full_name"),
  headline: text("headline"),
  linkedinUrl: text("linkedin_url"),
  location: text("location"),
  profileImageUrl: text("profile_image_url"),
  currentTitle: text("current_title"),
  currentCompany: text("current_company"),
  currentCompanyLinkedinUrl: text("current_company_linkedin_url"),

  // The company we searched for (from scraperSignals)
  companyName: text("company_name"),
  companyDomain: text("company_domain"),
  companyLinkedinUrl: text("company_linkedin_url"),

  // Enrichment (from BetterContact)
  email: text("email"),
  emailStatus: text("email_status"),
  phone: text("phone"),
  phoneStatus: text("phone_status"),
  enrichmentStatus: text("enrichment_status").notNull().default("none"),
  bettercontactRequestId: text("bettercontact_request_id"),
  enrichedAt: timestamp("enriched_at", { withTimezone: true }),

  // Status management
  status: text("status").notNull().default("discovered"),
  rawData: jsonb("raw_data").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
