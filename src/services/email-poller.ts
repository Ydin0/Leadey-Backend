import { eq, and, or, inArray, desc, sql } from "drizzle-orm";
import { db } from "../db";
import { emailAccounts, emailMessages } from "../db/schema/email-accounts";
import { leadEvents, leads } from "../db/schema/leads";
import { users } from "../db/schema/organizations";
import { createId } from "../lib/helpers";
import { fetchNewMessages, type InboundMessage } from "../lib/email-providers";
import { suppressEmail } from "../lib/suppression";
import { createNotification } from "../routes/notifications";
import { fireTrigger, notifyWorkflowEvent } from "./workflow-engine";

const POLL_INTERVAL_MS = 2 * 60 * 1000;

// Auth failures that will never fix themselves without the user reconnecting
// (revoked/deleted/expired OAuth token, bad credentials). Retrying these every
// cycle just spams the logs and wastes work.
const AUTH_ERROR_RE =
  /invalid[_ ]?grant|unauthor|token|expired|revoked|deleted|reconnect|\b401\b|invalid credentials|permission|refresh failed/i;
// Disconnect after this many consecutive AUTH failures (≈ this × 2min to react
// to a genuinely dead mailbox, while surviving a transient blip or two).
const AUTH_FAIL_LIMIT = 3;
// Safety cap: disconnect after this many consecutive failures of ANY kind, so a
// persistently-broken account can't retry forever.
const MAX_FAIL_LIMIT = 12;

// A reply asking to stop receiving mail — honored as an unsubscribe.
const STOP_RE = /\bunsubscribe\b|\bopt[\s.-]?out\b|remove me|(^|\n)\s*stop\b/i;

// A bounce / non-delivery report (NDR) from a receiving mail server.
const BOUNCE_FROM_RE = /mailer-daemon@|postmaster@/i;
const BOUNCE_SUBJECT_RE =
  /undelivered|delivery status notification|delivery (has )?failed|failure notice|returned mail|mail delivery (failed|subsystem)|could ?n[o']?t be delivered/i;
const isBounce = (m: InboundMessage) =>
  BOUNCE_FROM_RE.test(m.fromEmail || "") || BOUNCE_SUBJECT_RE.test(m.subject || "");
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

/** Handle a bounce/NDR: find the original recipient we sent to, mark the
 *  message + lead bounced, and auto-suppress so we stop emailing them. */
async function handleBounce(account: typeof emailAccounts.$inferSelect, inbound: InboundMessage): Promise<void> {
  const orgId = account.organizationId;
  const sel = {
    id: emailMessages.id, leadId: emailMessages.leadId,
    funnelId: emailMessages.funnelId, toEmail: emailMessages.toEmail,
  };

  // Primary: match the failed message via References/In-Reply-To headers.
  const refs = [...inbound.references];
  if (inbound.inReplyTo) refs.push(inbound.inReplyTo);
  let orig: { id: string; leadId: string | null; funnelId: string | null; toEmail: string } | undefined;
  if (refs.length) {
    [orig] = await db
      .select(sel).from(emailMessages)
      .where(and(eq(emailMessages.organizationId, orgId), eq(emailMessages.direction, "outbound"), inArray(emailMessages.messageIdHeader, refs)))
      .orderBy(desc(emailMessages.createdAt)).limit(1);
  }

  // Fallback: the failed recipient's address appears in the NDR body — match it
  // against a recent outbound recipient of ours.
  if (!orig) {
    const body = `${inbound.text || ""} ${inbound.html || ""}`;
    const found = [...new Set((body.match(EMAIL_RE) || []).map((e) => e.toLowerCase()))]
      .filter((e) => e !== account.email.toLowerCase() && !BOUNCE_FROM_RE.test(e));
    if (found.length) {
      [orig] = await db
        .select(sel).from(emailMessages)
        .where(and(
          eq(emailMessages.organizationId, orgId), eq(emailMessages.direction, "outbound"),
          inArray(sql`lower(${emailMessages.toEmail})`, found),
        ))
        .orderBy(desc(emailMessages.createdAt)).limit(1);
    }
  }

  if (!orig?.toEmail) return; // couldn't attribute the bounce — drop it
  await db.update(emailMessages).set({ status: "bounced" }).where(eq(emailMessages.id, orig.id));
  if (orig.leadId) {
    await db.update(leads).set({ status: "bounced" }).where(eq(leads.id, orig.leadId));
  }
  // suppressEmail records the bounce lead-event + exits active enrollments.
  await suppressEmail(orgId, orig.toEmail, "bounce", orig.leadId);
}

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

    // Bounce / non-delivery report → mark bounced + auto-suppress.
    if (isBounce(inbound)) {
      try { await handleBounce(account, inbound); } catch (err) { console.error("[email-poller] bounce handling failed:", err); }
      continue;
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
    // A "stop"/"unsubscribe" reply is honored as an opt-out (in addition to
    // being recorded as a normal reply above).
    if (STOP_RE.test(`${inbound.subject || ""}\n${inbound.text || inbound.html || ""}`) && inbound.fromEmail) {
      void suppressEmail(account.organizationId, inbound.fromEmail, "unsubscribe", match.leadId);
    }
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

  // Advance the per-account sync cursor + clear any prior error/failure streak.
  await db
    .update(emailAccounts)
    .set({ ...cursor, lastSyncedAt: new Date(), status: "active", lastError: null, consecutiveFailures: 0, updatedAt: new Date() })
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
      const msg = String(err?.message || err);
      const fails = (account.consecutiveFailures ?? 0) + 1;
      const isAuth = AUTH_ERROR_RE.test(msg);
      // Disconnect a dead mailbox: repeated auth failures (token revoked/
      // deleted/expired), or too many failures of any kind. This drops it from
      // the active poll set so we stop retrying + spamming logs every cycle.
      const shouldDisconnect = (isAuth && fails >= AUTH_FAIL_LIMIT) || fails >= MAX_FAIL_LIMIT;

      await db
        .update(emailAccounts)
        .set({
          lastError: msg,
          consecutiveFailures: fails,
          status: shouldDisconnect ? "disconnected" : account.status,
          updatedAt: new Date(),
        })
        .where(eq(emailAccounts.id, account.id))
        .catch(() => {});

      if (shouldDisconnect) {
        console.warn(`[email-poller] disconnected ${account.email} after ${fails} failures: ${msg}`);
        // Email the mailbox owner a "reconnect" prompt. Idempotent per account
        // via claimOnce in system-emails; re-armed when they reconnect (OAuth
        // callback clears the claim), so a future disconnect alerts again.
        try {
          const [owner] = await db
            .select({ email: users.email })
            .from(users)
            .where(eq(users.id, account.userId));
          const { notifyMailboxDisconnected } = await import("../lib/system-emails");
          await notifyMailboxDisconnected({
            accountId: account.id,
            userEmail: owner?.email ?? null,
            mailbox: account.email,
            provider: account.provider,
            lastError: msg,
          });
        } catch (notifyErr) {
          console.error("[email-poller] disconnect notify failed:", notifyErr);
        }
      } else {
        console.error(`[email-poller] account ${account.email} failed (${fails}/${isAuth ? AUTH_FAIL_LIMIT : MAX_FAIL_LIMIT}):`, msg);
      }
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
