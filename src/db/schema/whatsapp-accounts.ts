import { pgTable, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

/** An org's WhatsApp Cloud API account, onboarded via Meta Embedded Signup.
 *  One per org for now. The access token is a long-lived (≈60-day) business
 *  token, stored encrypted (crypto.encryptSecret). Inbound webhooks are routed
 *  to the org by `phoneNumberId` (unique). */
export const whatsappAccounts = pgTable(
  "whatsapp_accounts",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Meta WhatsApp Business Account id. */
    wabaId: text("waba_id").notNull(),
    /** Meta phone number id — the Cloud API send target + webhook routing key. */
    phoneNumberId: text("phone_number_id").notNull(),
    /** Human-readable connected number (e.g. +44 7…) and its verified name. */
    displayPhone: text("display_phone"),
    verifiedName: text("verified_name"),
    /** Meta business portfolio id (from Embedded Signup). */
    businessId: text("business_id"),
    /** AES-256-GCM encrypted business access token. */
    encryptedToken: text("encrypted_token").notNull(),
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
    status: text("status").notNull().default("connected"), // connected | error
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgUq: uniqueIndex("whatsapp_accounts_org_uq").on(t.organizationId),
    phoneNumberUq: uniqueIndex("whatsapp_accounts_phone_number_uq").on(t.phoneNumberId),
    wabaIdx: index("whatsapp_accounts_waba_idx").on(t.wabaId),
  }),
);
