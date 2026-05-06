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
  businessName: text("business_name").notNull(),
  businessAddress: text("business_address").notNull().default(""),
  businessRegistrationNumber: text("business_registration_number").notNull().default(""),
  businessType: text("business_type").notNull().default("limited_company"),
  contactEmail: text("contact_email").notNull().default(""),
  contactPhone: text("contact_phone").notNull().default(""),
  identityDocumentName: text("identity_document_name").notNull().default(""),
  twilioBundleSid: text("twilio_bundle_sid"),
  twilioEndUserSid: text("twilio_end_user_sid"),
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
