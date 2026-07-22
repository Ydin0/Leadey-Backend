import { pgTable, text, jsonb, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

/** A rep's signature settings — SCOPED PER ORGANIZATION. The same login can be
 *  in several orgs and needs different signature details in each (name, work
 *  email, phone, title, company, custom link fields, default signature), so
 *  these live keyed by (organizationId, userId) rather than on the single-org
 *  users row. Identity fallbacks (real name/email/phone) still come from users. */
export const memberSignatureDetails = pgTable(
  "member_signature_details",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    /** Job title → {{sender_title}}. */
    title: text("title"),
    /** Overrides for the built-in {{sender_*}} variables (null ⇒ fall back to
     *  the profile/org default). */
    signatureName: text("signature_name"),
    signatureEmail: text("signature_email"),
    signaturePhone: text("signature_phone"),
    signatureCompany: text("signature_company"),
    /** Free-form extra fields → {{sender_<key>}}. */
    signatureFields: jsonb("signature_fields").$type<Record<string, string>>(),
    /** This rep's personal default signature in THIS org (emailSignatures.id). */
    defaultSignatureId: text("default_signature_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("member_signature_details_org_user_uq").on(t.organizationId, t.userId)],
);
