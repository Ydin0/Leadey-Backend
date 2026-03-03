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
  identityDocumentName: text("identity_document_name").notNull().default(""),
  twilioBundleSid: text("twilio_bundle_sid"),
  twilioEndUserSid: text("twilio_end_user_sid"),
  twilioDocumentSid: text("twilio_document_sid"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
