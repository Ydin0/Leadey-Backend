import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

export const regulatoryBundles = pgTable("regulatory_bundles", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  country: text("country").notNull(),
  countryCode: text("country_code").notNull(),
  status: text("status").notNull().default("draft"),

  /** Twilio number type the bundle applies to: local | mobile | national | toll-free. */
  numberType: text("number_type").notNull().default("local"),
  /** Twilio end-user type: business | individual. UI only exposes "business" for now. */
  endUserType: text("end_user_type").notNull().default("business"),

  // ─── Business information ───────────────────────────────────────────
  businessName: text("business_name").notNull(),
  businessType: text("business_type").notNull().default("limited_company"),
  /** e.g. "UK:CRN", "US:EIN", "AU:ABN" */
  businessRegistrationAuthority: text("business_registration_authority").notNull().default(""),
  businessRegistrationNumber: text("business_registration_number").notNull().default(""),
  businessWebsite: text("business_website").notNull().default(""),
  /** Twilio enum: INDEPENDENT_SOFTWARE_VENDOR | RESELLER | ENTERPRISE | etc. */
  businessClassification: text("business_classification").notNull().default("INDEPENDENT_SOFTWARE_VENDOR"),

  // ─── Business address (structured, per Twilio's Address API) ────────
  addressStreet1: text("address_street1").notNull().default(""),
  addressStreet2: text("address_street2").notNull().default(""),
  addressCity: text("address_city").notNull().default(""),
  /** State / province / region */
  addressSubdivision: text("address_subdivision").notNull().default(""),
  addressPostalCode: text("address_postal_code").notNull().default(""),

  // ─── Authorized Representative (Twilio individual end-user) ─────────
  representativeFirstName: text("representative_first_name").notNull().default(""),
  representativeLastName: text("representative_last_name").notNull().default(""),
  representativeEmail: text("representative_email").notNull().default(""),
  representativePhone: text("representative_phone").notNull().default(""),

  // ─── Legacy fields kept for backwards compatibility ─────────────────
  /** Free-form address (superseded by structured address fields above) */
  businessAddress: text("business_address").notNull().default(""),
  /** @deprecated use representativeEmail */
  contactEmail: text("contact_email").notNull().default(""),
  /** @deprecated use representativePhone */
  contactPhone: text("contact_phone").notNull().default(""),
  identityDocumentName: text("identity_document_name").notNull().default(""),

  // ─── Twilio SIDs ────────────────────────────────────────────────────
  twilioBundleSid: text("twilio_bundle_sid"),
  twilioEndUserSid: text("twilio_end_user_sid"),
  /** Twilio Address SID (created via Address API and attached to bundle) */
  twilioAddressSid: text("twilio_address_sid"),
  /** Individual end-user SID for the authorized representative */
  twilioIndividualEndUserSid: text("twilio_individual_end_user_sid"),
  twilioDocumentSid: text("twilio_document_sid"),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const bundleDocuments = pgTable("bundle_documents", {
  id: text("id").primaryKey(),
  bundleId: text("bundle_id")
    .notNull()
    .references(() => regulatoryBundles.id, { onDelete: "cascade" }),
  twilioDocumentSid: text("twilio_document_sid"),
  documentType: text("document_type").notNull(), // "business_registration" | "government_id" | "utility_bill" | "passport"
  fileName: text("file_name").notNull(),
  status: text("status").notNull().default("uploaded"), // "uploaded" | "approved" | "rejected"
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
