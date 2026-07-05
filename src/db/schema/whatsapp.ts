import { pgTable, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { phoneLines } from "./phone-lines";

/** A phone number registered as a WhatsApp sender with Meta via the Twilio
 *  Senders API (v2). Lifecycle: creating → pending_verification/verifying
 *  (OTP) → online. Kept separate from phone_lines because the sender has its
 *  own state machine (senderSid, WABA, verification, offline reasons) and a
 *  released line must not silently orphan a live Meta registration — hence
 *  the nullable lineId (set null) plus the denormalized `number`. */
export const whatsappSenders = pgTable(
  "whatsapp_senders",
  {
    id: text("id").primaryKey(), // createId("was")
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    lineId: text("line_id").references(() => phoneLines.id, { onDelete: "set null" }),
    /** Bare E.164 (no whatsapp: prefix). */
    number: text("number").notNull(),
    /** Twilio Senders API sid (XE…). */
    senderSid: text("sender_sid").notNull(),
    /** The org's WhatsApp Business Account id the sender is registered under. */
    wabaId: text("waba_id").notNull(),
    /** Lowercased Twilio sender status: creating | pending_verification |
     *  verifying | online | offline | twilio_review | draft | stubbed. */
    status: text("status").notNull().default("creating"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("whatsapp_senders_org_idx").on(t.organizationId),
    // One WhatsApp registration per number platform-wide (single master
    // Twilio account — Meta rejects duplicate registrations anyway).
    uniqueIndex("whatsapp_senders_number_uq").on(t.number),
  ],
);
