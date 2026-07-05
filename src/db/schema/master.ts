import { pgTable, text, integer, bigint, timestamp, unique, boolean, index, uniqueIndex, jsonb } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
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
  // Name-based company resolution (write paths + profile name-fallback).
  index("master_companies_org_name_lower_idx").on(t.organizationId, sql`lower(${t.name})`),
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
  /** Additional labeled emails/phones (mirrors leads.extra_emails/extra_phones
   *  so they follow the person across campaigns). Identity keys stay derived
   *  from the primary email/phone only. */
  extraEmails: jsonb("extra_emails").$type<{ label: string; value: string }[]>().notNull().default([]),
  extraPhones: jsonb("extra_phones").$type<{ label: string; value: string }[]>().notNull().default([]),
  enrichmentStatus: text("enrichment_status").notNull().default("none"),

  /** Normalised identity keys — how a PERSON is recognised across campaigns
   *  (see lib/person-resolve.ts). email_key is lower(email) but NULL for
   *  role inboxes (info@, sales@, …); phone_key is the last 9 digits;
   *  linkedin_key is the protocol/www/slash/case-insensitive profile path.
   *  Uniqueness (partial, per-org, email+linkedin only) arrives with the
   *  cutover migration AFTER the backfill dedupes historical rows. */
  emailKey: text("email_key"),
  phoneKey: text("phone_key"),
  linkedinKey: text("linkedin_key"),

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
  index("master_contacts_org_phone_key").on(t.organizationId, t.phoneKey),
  // One person per identity key. Partial + added AFTER the identity backfill
  // deduped historical rows. Phone is deliberately NOT unique — switchboards
  // are legitimately shared by different people.
  uniqueIndex("master_contacts_org_email_key_unique")
    .on(t.organizationId, t.emailKey)
    .where(sql`email_key IS NOT NULL`),
  uniqueIndex("master_contacts_org_linkedin_key_unique")
    .on(t.organizationId, t.linkedinKey)
    .where(sql`linkedin_key IS NOT NULL`),
]);
