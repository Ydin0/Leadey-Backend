import { pgTable, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

/** A single LinkedIn message (inbound or outbound) exchanged through a rep's
 *  connected LinkedIn account (Unipile). Powers the LinkedIn Inbox thread view.
 *  Inbound rows come from the messaging webhook + history sync; outbound rows
 *  from workflow/manual/inbox sends. `providerId` is the OTHER party's LinkedIn
 *  provider id — the thread key, matched to `leads.unipileProviderId`. */
export const linkedinMessages = pgTable(
  "linkedin_messages",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** The connected account this conversation belongs to (linkedin_accounts.id). */
    accountId: text("account_id"),
    /** Unipile account id the message was sent/received through. */
    unipileAccountId: text("unipile_account_id"),
    /** Resolved lead this conversation is with (by provider id), when known. */
    leadId: text("lead_id"),
    /** The counterparty's LinkedIn provider id — the thread key. */
    providerId: text("provider_id").notNull(),
    /** Unipile chat id (for sending replies into the same thread). */
    chatId: text("chat_id"),
    /** Unipile message id — dedupes webhook + sync ingestion. */
    unipileMessageId: text("unipile_message_id"),
    direction: text("direction").notNull(), // inbound | outbound
    text: text("text").notNull().default(""),
    senderName: text("sender_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("linkedin_messages_org_lead_idx").on(t.organizationId, t.leadId),
    index("linkedin_messages_org_provider_idx").on(t.organizationId, t.providerId),
    index("linkedin_messages_org_created_idx").on(t.organizationId, t.createdAt),
    uniqueIndex("linkedin_messages_unipile_msg_uq").on(t.unipileMessageId),
  ],
);
