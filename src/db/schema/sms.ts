import { pgTable, text, timestamp, index, real } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

/** One row per SMS sent to or received from a lead — the conversation thread
 *  and the system of record for delivery status + "who texted last". */
export const smsMessages = pgTable(
  "sms_messages",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    // Lead/funnel are nullable: an inbound text may not match a known lead.
    leadId: text("lead_id"),
    funnelId: text("funnel_id"),
    lineId: text("line_id"),
    // The rep who sent it (null for inbound).
    userId: text("user_id"),
    direction: text("direction").notNull(), // "outbound" | "inbound"
    /** Which messaging channel carried this message. WhatsApp messages share
     *  this table so status callbacks, cost sync, threads and reply triggers
     *  all work channel-agnostically. */
    channel: text("channel").notNull().default("sms"), // "sms" | "whatsapp"
    fromNumber: text("from_number").notNull(),
    toNumber: text("to_number").notNull(),
    body: text("body").notNull().default(""),
    status: text("status").notNull().default("queued"), // queued|sent|delivered|failed|received
    twilioSid: text("twilio_sid"),
    // Exact Twilio cost — the billed `price` on the Twilio Message resource,
    // synced from the API (positive amount). `priceUnit` is the account currency.
    twilioPrice: real("twilio_price"),
    twilioPriceUnit: text("twilio_price_unit"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("sms_messages_lead_idx").on(t.leadId),
    index("sms_messages_org_idx").on(t.organizationId),
    // Twilio cost sync updates prices by twilio_sid — index it so those writes
    // don't full-scan (same fix as call_records.twilio_call_sid).
    index("sms_messages_twilio_sid_idx").on(t.twilioSid),
    // Keyset-paginated timeline reads: (lead_id, created_at DESC).
    index("sms_messages_lead_created_idx").on(t.leadId, t.createdAt),
    // Cost reporting: org-scoped period scans (daily buckets, monthly
    // aggregates, paginated raw usage logs ordered by created_at DESC).
    index("sms_messages_org_created_idx").on(t.organizationId, t.createdAt),
    // Inbox: threads/counts scoped to the org line(s) they're on.
    index("sms_messages_line_created_idx").on(t.lineId, t.createdAt),
  ],
);
