import { pgTable, text, integer, boolean, timestamp, index } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

/** A rep's connected personal inbox (Gmail/Outlook OAuth or generic SMTP/IMAP)
 *  used to send 1:1 emails from the lead profile and capture replies. Secrets
 *  (OAuth tokens, SMTP password) are encrypted at rest via src/lib/crypto.ts. */
export const emailAccounts = pgTable(
  "email_accounts",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    provider: text("provider").notNull(), // "gmail" | "outlook" | "smtp"
    email: text("email").notNull(),
    fromName: text("from_name").notNull().default(""),
  /** Per-account signature appended to one-off + workflow emails (HTML, or
   *  plain text converted to <br> at send time). Sequences (Smartlead) are
   *  unaffected. */
  signature: text("signature"),
    status: text("status").notNull().default("active"), // active | error | disconnected
    isDefault: boolean("is_default").notNull().default(false),
    // OAuth (gmail/outlook): encrypted JSON { access, refresh, expiresAt, scope }
    encryptedTokens: text("encrypted_tokens"),
    // SMTP/IMAP
    smtpHost: text("smtp_host"),
    smtpPort: integer("smtp_port"),
    smtpSecure: boolean("smtp_secure").notNull().default(true),
    username: text("username"),
    encryptedPassword: text("encrypted_password"),
    imapHost: text("imap_host"),
    imapPort: integer("imap_port"),
    imapSecure: boolean("imap_secure").notNull().default(true),
    // Per-provider sync cursors for reply capture.
    gmailHistoryId: text("gmail_history_id"),
    graphDeltaLink: text("graph_delta_link"),
    imapUid: integer("imap_uid"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("email_accounts_org_user_idx").on(t.organizationId, t.userId),
  ],
);

/** One row per 1:1 email sent or received — the lead conversation thread plus
 *  open-tracking state. Mirrors the sms_messages model. */
export const emailMessages = pgTable(
  "email_messages",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    accountId: text("account_id"),
    leadId: text("lead_id"),
    funnelId: text("funnel_id"),
    userId: text("user_id"),
    direction: text("direction").notNull(), // "outbound" | "inbound"
    fromEmail: text("from_email").notNull(),
    fromName: text("from_name").notNull().default(""),
    toEmail: text("to_email").notNull().default(""),
    subject: text("subject").notNull().default(""),
    bodyHtml: text("body_html").notNull().default(""),
    bodyText: text("body_text").notNull().default(""),
    providerMessageId: text("provider_message_id"),
    providerThreadId: text("provider_thread_id"),
    messageIdHeader: text("message_id_header"),
    inReplyTo: text("in_reply_to"),
    status: text("status").notNull().default("sent"), // sent | bounced | received | failed
    openedAt: timestamp("opened_at", { withTimezone: true }),
    openCount: integer("open_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("email_messages_lead_idx").on(t.leadId),
    index("email_messages_thread_idx").on(t.providerThreadId),
    index("email_messages_org_idx").on(t.organizationId),
    // Keyset-paginated timeline reads: (lead_id, created_at DESC).
    index("email_messages_lead_created_idx").on(t.leadId, t.createdAt),
  ],
);
