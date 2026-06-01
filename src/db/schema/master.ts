import { pgTable, text, integer, bigint, timestamp, unique, boolean } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

export const masterCompanies = pgTable("master_companies", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  domain: text("domain"),
  linkedinUrl: text("linkedin_url"),
  industry: text("industry"),
  employeeCount: integer("employee_count"),
  revenue: bigint("revenue", { mode: "number" }),
  funding: bigint("funding", { mode: "number" }),
  fundingStage: text("funding_stage"),
  country: text("country"),
  city: text("city"),
  logo: text("logo"),
  description: text("description"),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique().on(t.organizationId, t.domain),
]);

export const masterContacts = pgTable("master_contacts", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  linkedinUrl: text("linkedin_url"),
  firstName: text("first_name"),
  lastName: text("last_name"),
  fullName: text("full_name"),
  headline: text("headline"),
  profileImageUrl: text("profile_image_url"),
  currentTitle: text("current_title"),
  currentCompany: text("current_company"),
  masterCompanyId: text("master_company_id").references(() => masterCompanies.id, { onDelete: "set null" }),
  location: text("location"),
  email: text("email"),
  emailStatus: text("email_status"),
  phone: text("phone"),
  phoneStatus: text("phone_status"),
  enrichmentStatus: text("enrichment_status").notNull().default("none"),

  /** Dialer / compliance fields. Stored at the master-contact level (not
   *  per-funnel-lead) so flipping DNC once propagates everywhere the same
   *  person appears. */
  doNotCall: boolean("do_not_call").notNull().default(false),
  /** IANA tz string e.g. "America/Chicago". Used to gate calls to
   *  business hours when the dialer's respectTimezone filter is on. */
  timezone: text("timezone"),
  lastCalledAt: timestamp("last_called_at", { withTimezone: true }),
  callAttempts: integer("call_attempts").notNull().default(0),
  bestTimeStart: text("best_time_start"),
  bestTimeEnd: text("best_time_end"),

  lastDiscoveredAt: timestamp("last_discovered_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique().on(t.organizationId, t.linkedinUrl),
]);
