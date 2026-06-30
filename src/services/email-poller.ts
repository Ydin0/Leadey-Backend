import { eq, and, or, inArray, desc } from "drizzle-orm";
import { db } from "../db";
import { emailAccounts, emailMessages } from "../db/schema/email-accounts";
import { leadEvents } from "../db/schema/leads";
import { createId } from "../lib/helpers";
import { fetchNewMessages, type InboundMessage } from "../lib/email-providers";
import { createNotification } from "../routes/notifications";
import { fireTrigger, notifyWorkflowEvent } from "./workflow-engine";

const POLL_INTERVAL_MS = 2 * 60 * 1000;

/** Match an inbound message to one of our tracked outbound emails so we can
 *  attach the reply to the right lead. Prefers thread/in-reply-to/references;
 *  falls back to the recipient address. */
async function matchOutbound(
  orgId: string,
  inbound: InboundMessage,
): Promise<{ leadId: string; funnelId: string | null; userId: string | null } | null> {
  const conds = [];
  if (inbound.providerThreadId) conds.push(eq(emailMessages.providerThreadId, inbound.providerThreadId));
  if (inbound.inReplyTo) conds.push(eq(emailMessages.messageIdHeader, inbound.inReplyTo));
  if (inbound.references.length) conds.push(inArray(emailMessages.messageIdHeader, inbound.references));

  if (conds.length) {
    const [hit] = await db
      .select({ leadId: emailMessages.leadId, funnelId: emailMessages.funnelId, userId: emailMessages.userId })
      .from(emailMessages)
      .where(and(eq(emailMessages.organizationId, orgId), eq(emailMessages.direction, "outbound"), or(...conds)))
      .orderBy(desc(emailMessages.createdAt))
      .limit(1);
    if (hit?.leadId) return { leadId: hit.leadId, funnelId: hit.funnelId, userId: hit.userId };
  }

  // Fallback: most recent outbound to this sender's address.
  if (inbound.fromEmail) {
    const [hit] = await db
      .select({ leadId: emailMessages.leadId, funnelId: emailMessages.funnelId, userId: emailMessages.userId })
      .from(emailMessages)
      .where(and(eq(emailMessages.organizationId, orgId), eq(emailMessages.direction, "outbound"), eq(emailMessages.toEmail, inbound.fromEmail)))
      .orderBy(desc(emailMessages.createdAt))
      .limit(1);
    if (hit?.leadId) return { leadId: hit.leadId, funnelId: hit.funnelId, userId: hit.userId };
  }
  return null;
}

async function pollAccount(account: typeof emailAccounts.$inferSelect): Promise<void> {
  const { messages, cursor } = await fetchNewMessages(account);

  for (const inbound of messages) {
    // Skip our own sent copies and dedup by provider message id.
    if (inbound.fromEmail && inbound.fromEmail === account.email.toLowerCase()) continue;
    if (inbound.providerMessageId) {
      const [dup] = await db
        .select({ id: emailMessages.id })
        .from(emailMessages)
        .where(and(eq(emailMessages.accountId, account.id), eq(emailMessages.providerMessageId, inbound.providerMessageId)))
        .limit(1);
      if (dup) continue;
    }

    const match = await matchOutbound(account.organizationId, inbound);
    if (!match) continue; // not a reply to anything we sent — ignore

    const now = inbound.date || new Date();
    await db.insert(emailMessages).values({
      id: createId("emsg"),
      organizationId: account.organizationId,
      accountId: account.id,
      leadId: match.leadId,
      funnelId: match.funnelId,
      userId: null,
      direction: "inbound",
      fromEmail: inbound.fromEmail,
      fromName: inbound.fromName,
      toEmail: inbound.toEmail || account.email,
      subject: inbound.subject,
      bodyHtml: inbound.html,
      bodyText: inbound.text,
      providerMessageId: inbound.providerMessageId,
      providerThreadId: inbound.providerThreadId,
      messageIdHeader: inbound.messageIdHeader,
      inReplyTo: inbound.inReplyTo,
      status: "received",
      createdAt: now,
    });
    await db.insert(leadEvents).values({
      id: createId("event"),
      leadId: match.leadId,
      type: "step_outcome",
      outcome: "replied",
      stepIndex: 0,
      meta: { channel: "email", direction: "inbound", subject: inbound.subject, body: inbound.text || inbound.html },
      timestamp: now,
    });
    // Workflow reactions: wake wait-for-reply steps + apply exit-on-reply, and
    // enroll into any "reply received" workflows.
    void notifyWorkflowEvent(match.leadId, "replied");
    if (match.funnelId) void fireTrigger(account.organizationId, match.funnelId, match.leadId, "reply_received");
    if (match.userId) {
      await createNotification({
        orgId: account.organizationId,
        userId: match.userId,
        type: "email_reply",
        title: `${inbound.fromName || inbound.fromEmail} replied`,
        body: inbound.subject || (inbound.text || "").slice(0, 140),
        leadId: match.leadId,
        funnelId: match.funnelId,
      });
    }
  }

  // Advance the per-account sync cursor + clear any prior error.
  await db
    .update(emailAccounts)
    .set({ ...cursor, lastSyncedAt: new Date(), status: "active", lastError: null, updatedAt: new Date() })
    .where(eq(emailAccounts.id, account.id));
}

async function pollAll(): Promise<void> {
  let accounts: (typeof emailAccounts.$inferSelect)[] = [];
  try {
    accounts = await db.select().from(emailAccounts).where(eq(emailAccounts.status, "active"));
  } catch (err) {
    console.error("[email-poller] could not load accounts:", err);
    return;
  }
  for (const account of accounts) {
    try {
      await pollAccount(account);
    } catch (err: any) {
      console.error(`[email-poller] account ${account.email} failed:`, err?.message || err);
      await db
        .update(emailAccounts)
        .set({ lastError: String(err?.message || err), updatedAt: new Date() })
        .where(eq(emailAccounts.id, account.id))
        .catch(() => {});
    }
  }
}

/** Start the background reply poller. Safe no-op until accounts exist. */
export function startEmailPoller(): void {
  setInterval(() => {
    void pollAll();
  }, POLL_INTERVAL_MS);
  console.log("[email-poller] started (every 2m)");
}
