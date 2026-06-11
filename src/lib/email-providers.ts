import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { emailAccounts } from "../db/schema/email-accounts";
import { encryptSecret, decryptSecret } from "./crypto";
import { createId } from "./helpers";

type Account = typeof emailAccounts.$inferSelect;

export interface SendInput {
  to: string;
  toName?: string | null;
  /** Optional comma-separated Cc recipients. */
  cc?: string;
  subject: string;
  html: string;
}
export interface SendResult {
  providerMessageId: string | null;
  providerThreadId: string | null;
  messageIdHeader: string | null;
}
export interface InboundMessage {
  fromEmail: string;
  fromName: string;
  toEmail: string;
  subject: string;
  html: string;
  text: string;
  providerMessageId: string | null;
  providerThreadId: string | null;
  messageIdHeader: string | null;
  inReplyTo: string | null;
  references: string[];
  date: Date;
}
export interface FetchResult {
  messages: InboundMessage[];
  cursor: Partial<Pick<Account, "gmailHistoryId" | "graphDeltaLink" | "imapUid">>;
}

interface OAuthTokens {
  access: string;
  refresh: string;
  expiresAt: number;
  scope?: string;
}

// ── OAuth token helpers ─────────────────────────────────────────────

export function packTokens(t: OAuthTokens): string {
  return encryptSecret(JSON.stringify(t));
}
function readTokens(account: Account): OAuthTokens {
  return JSON.parse(decryptSecret(account.encryptedTokens || "")) as OAuthTokens;
}

async function refreshGoogle(refresh: string): Promise<{ access_token: string; expires_in: number; refresh_token?: string }> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID || "",
      client_secret: process.env.GOOGLE_CLIENT_SECRET || "",
      refresh_token: refresh,
      grant_type: "refresh_token",
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Google token refresh failed: ${data?.error_description || data?.error || res.status}`);
  return data;
}

async function refreshMicrosoft(refresh: string): Promise<{ access_token: string; expires_in: number; refresh_token?: string }> {
  const res = await fetch(`https://login.microsoftonline.com/${process.env.MICROSOFT_TENANT || "common"}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.MICROSOFT_CLIENT_ID || "",
      client_secret: process.env.MICROSOFT_CLIENT_SECRET || "",
      refresh_token: refresh,
      grant_type: "refresh_token",
      scope: "offline_access Mail.Send Mail.Read User.Read",
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Microsoft token refresh failed: ${data?.error_description || data?.error || res.status}`);
  return data;
}

/** Return a valid access token, refreshing + persisting rotated tokens. */
async function getAccessToken(account: Account): Promise<string> {
  const t = readTokens(account);
  if (t.access && t.expiresAt > Date.now() + 60_000) return t.access;
  const refreshed = account.provider === "gmail" ? await refreshGoogle(t.refresh) : await refreshMicrosoft(t.refresh);
  const next: OAuthTokens = {
    access: refreshed.access_token,
    refresh: refreshed.refresh_token || t.refresh,
    expiresAt: Date.now() + refreshed.expires_in * 1000,
    scope: t.scope,
  };
  await db
    .update(emailAccounts)
    .set({ encryptedTokens: packTokens(next), updatedAt: new Date() })
    .where(eq(emailAccounts.id, account.id));
  return next.access;
}

// ── MIME builder (for raw Gmail send) ───────────────────────────────

async function buildMime(account: Account, input: SendInput): Promise<{ raw: Buffer; messageId: string }> {
  const domain = account.email.split("@")[1] || "leadey.ai";
  const messageId = `<${createId("emsg")}@${domain}>`;
  const composer = new MailComposer({
    from: { name: account.fromName || account.email, address: account.email },
    to: input.toName ? { name: input.toName, address: input.to } : input.to,
    ...(input.cc ? { cc: input.cc } : {}),
    subject: input.subject,
    html: input.html,
    messageId,
  });
  const raw = await new Promise<Buffer>((resolve, reject) => {
    composer.compile().build((err, msg) => (err ? reject(err) : resolve(msg)));
  });
  return { raw, messageId };
}

// ── Send ────────────────────────────────────────────────────────────

async function sendSmtp(account: Account, input: SendInput): Promise<SendResult> {
  const transport = nodemailer.createTransport({
    host: account.smtpHost || "",
    port: account.smtpPort || 587,
    secure: !!account.smtpSecure,
    auth: { user: account.username || account.email, pass: decryptSecret(account.encryptedPassword || "") },
  });
  const info = await transport.sendMail({
    from: { name: account.fromName || account.email, address: account.email },
    to: input.toName ? `"${input.toName}" <${input.to}>` : input.to,
    ...(input.cc ? { cc: input.cc } : {}),
    subject: input.subject,
    html: input.html,
  });
  return { providerMessageId: info.messageId || null, providerThreadId: null, messageIdHeader: info.messageId || null };
}

async function sendGmail(account: Account, input: SendInput): Promise<SendResult> {
  const token = await getAccessToken(account);
  const { raw, messageId } = await buildMime(account, input);
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw: raw.toString("base64url") }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Gmail send failed: ${data?.error?.message || res.status}`);
  return { providerMessageId: data.id, providerThreadId: data.threadId, messageIdHeader: messageId };
}

async function sendOutlook(account: Account, input: SendInput): Promise<SendResult> {
  const token = await getAccessToken(account);
  // Use /me/sendMail — it only needs the Mail.Send permission (which we have).
  // (Creating a draft to capture the thread id would require Mail.ReadWrite;
  // reply threading instead falls back to matching the recipient address.)
  const res = await fetch("https://graph.microsoft.com/v1.0/me/sendMail", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: {
        subject: input.subject,
        body: { contentType: "HTML", content: input.html },
        toRecipients: [{ emailAddress: { address: input.to, name: input.toName || undefined } }],
        ccRecipients: (input.cc || "")
          .split(",")
          .map((a) => a.trim())
          .filter(Boolean)
          .map((address) => ({ emailAddress: { address } })),
      },
      saveToSentItems: true,
    }),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => null);
    throw new Error(`Outlook send failed: ${e?.error?.message || res.status}`);
  }
  return { providerMessageId: null, providerThreadId: null, messageIdHeader: null };
}

export async function sendEmailVia(account: Account, input: SendInput): Promise<SendResult> {
  if (account.provider === "smtp") return sendSmtp(account, input);
  if (account.provider === "gmail") return sendGmail(account, input);
  if (account.provider === "outlook") return sendOutlook(account, input);
  throw new Error(`Unsupported provider: ${account.provider}`);
}

// ── Reply capture ───────────────────────────────────────────────────

function nameFromHeader(addr: { name?: string; address?: string } | undefined): { name: string; email: string } {
  return { name: addr?.name || "", email: (addr?.address || "").toLowerCase() };
}

async function fetchImap(account: Account): Promise<FetchResult> {
  const messages: InboundMessage[] = [];
  let maxUid = account.imapUid || 0;
  const imap = new ImapFlow({
    host: account.imapHost || account.smtpHost || "",
    port: account.imapPort || 993,
    secure: account.imapSecure ?? true,
    auth: { user: account.username || account.email, pass: decryptSecret(account.encryptedPassword || "") },
    logger: false,
  });
  await imap.connect();
  try {
    const lock = await imap.getMailboxLock("INBOX");
    try {
      const sinceUid = (account.imapUid || 0) + 1;
      // First run: just record the latest UID so we only track future replies.
      if (!account.imapUid) {
        const status = await imap.status("INBOX", { uidNext: true });
        return { messages: [], cursor: { imapUid: (status.uidNext || 1) - 1 } };
      }
      for await (const msg of imap.fetch(`${sinceUid}:*`, { uid: true, source: true }, { uid: true })) {
        if (!msg.source) continue;
        const parsed = await simpleParser(msg.source);
        const from = nameFromHeader(parsed.from?.value?.[0]);
        messages.push({
          fromEmail: from.email,
          fromName: from.name,
          toEmail: (parsed.to && "value" in parsed.to ? parsed.to.value?.[0]?.address : "") || account.email,
          subject: parsed.subject || "",
          html: typeof parsed.html === "string" ? parsed.html : "",
          text: parsed.text || "",
          providerMessageId: String(msg.uid),
          providerThreadId: null,
          messageIdHeader: parsed.messageId || null,
          inReplyTo: parsed.inReplyTo || null,
          references: Array.isArray(parsed.references) ? parsed.references : parsed.references ? [parsed.references] : [],
          date: parsed.date || new Date(),
        });
        if (msg.uid > maxUid) maxUid = msg.uid;
      }
    } finally {
      lock.release();
    }
  } finally {
    await imap.logout().catch(() => {});
  }
  return { messages, cursor: { imapUid: maxUid } };
}

async function fetchGmail(account: Account): Promise<FetchResult> {
  const token = await getAccessToken(account);
  const auth = { Authorization: `Bearer ${token}` };
  // First run: record current historyId, start tracking from now.
  if (!account.gmailHistoryId) {
    const prof = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", { headers: auth }).then((r) => r.json());
    return { messages: [], cursor: { gmailHistoryId: prof.historyId ? String(prof.historyId) : undefined } };
  }
  const histRes = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/history?startHistoryId=${account.gmailHistoryId}&historyTypes=messageAdded&labelId=INBOX`,
    { headers: auth },
  ).then((r) => r.json());
  const messages: InboundMessage[] = [];
  const ids = new Set<string>();
  for (const h of histRes.history || []) {
    for (const m of h.messagesAdded || []) {
      if (m.message?.id) ids.add(m.message.id);
    }
  }
  for (const id of ids) {
    const raw = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=raw`, { headers: auth }).then((r) => r.json());
    if (!raw.raw) continue;
    const parsed = await simpleParser(Buffer.from(raw.raw, "base64url"));
    const from = nameFromHeader(parsed.from?.value?.[0]);
    messages.push({
      fromEmail: from.email,
      fromName: from.name,
      toEmail: (parsed.to && "value" in parsed.to ? parsed.to.value?.[0]?.address : "") || account.email,
      subject: parsed.subject || "",
      html: typeof parsed.html === "string" ? parsed.html : "",
      text: parsed.text || "",
      providerMessageId: raw.id,
      providerThreadId: raw.threadId || null,
      messageIdHeader: parsed.messageId || null,
      inReplyTo: parsed.inReplyTo || null,
      references: Array.isArray(parsed.references) ? parsed.references : parsed.references ? [parsed.references] : [],
      date: parsed.date || new Date(),
    });
  }
  return { messages, cursor: { gmailHistoryId: histRes.historyId ? String(histRes.historyId) : account.gmailHistoryId } };
}

async function fetchOutlook(account: Account): Promise<FetchResult> {
  const token = await getAccessToken(account);
  const auth = { Authorization: `Bearer ${token}` };
  const url =
    account.graphDeltaLink ||
    "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$select=from,toRecipients,subject,body,conversationId,internetMessageId,internetMessageHeaders,receivedDateTime";
  const messages: InboundMessage[] = [];
  let next = url;
  let deltaLink: string | undefined;
  // Walk pages until we hit the deltaLink (bounded to avoid runaways).
  for (let i = 0; i < 10 && next; i++) {
    const page = await fetch(next, { headers: auth }).then((r) => r.json());
    // First run with no stored delta: skip existing items, just keep the deltaLink.
    if (!account.graphDeltaLink) {
      if (page["@odata.deltaLink"]) { deltaLink = page["@odata.deltaLink"]; break; }
      next = page["@odata.nextLink"];
      continue;
    }
    for (const m of page.value || []) {
      if (!m.from) continue;
      const headers: Array<{ name: string; value: string }> = m.internetMessageHeaders || [];
      const inReplyTo = headers.find((h) => h.name.toLowerCase() === "in-reply-to")?.value || null;
      const references = (headers.find((h) => h.name.toLowerCase() === "references")?.value || "").split(/\s+/).filter(Boolean);
      messages.push({
        fromEmail: (m.from.emailAddress?.address || "").toLowerCase(),
        fromName: m.from.emailAddress?.name || "",
        toEmail: m.toRecipients?.[0]?.emailAddress?.address || account.email,
        subject: m.subject || "",
        html: m.body?.contentType === "html" ? m.body?.content || "" : "",
        text: m.body?.contentType === "text" ? m.body?.content || "" : "",
        providerMessageId: m.id,
        providerThreadId: m.conversationId || null,
        messageIdHeader: m.internetMessageId || null,
        inReplyTo,
        references,
        date: m.receivedDateTime ? new Date(m.receivedDateTime) : new Date(),
      });
    }
    if (page["@odata.deltaLink"]) { deltaLink = page["@odata.deltaLink"]; break; }
    next = page["@odata.nextLink"];
  }
  return { messages, cursor: { graphDeltaLink: deltaLink || account.graphDeltaLink || undefined } };
}

export async function fetchNewMessages(account: Account): Promise<FetchResult> {
  if (account.provider === "smtp") return fetchImap(account);
  if (account.provider === "gmail") return fetchGmail(account);
  if (account.provider === "outlook") return fetchOutlook(account);
  return { messages: [], cursor: {} };
}

/** Verify SMTP (and optional IMAP) credentials before saving an account. */
export async function verifySmtp(opts: {
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  username: string;
  password: string;
  imapHost?: string;
  imapPort?: number;
  imapSecure?: boolean;
}): Promise<void> {
  const transport = nodemailer.createTransport({
    host: opts.smtpHost,
    port: opts.smtpPort,
    secure: opts.smtpSecure,
    auth: { user: opts.username, pass: opts.password },
  });
  await transport.verify();
  if (opts.imapHost) {
    const imap = new ImapFlow({
      host: opts.imapHost,
      port: opts.imapPort || 993,
      secure: opts.imapSecure ?? true,
      auth: { user: opts.username, pass: opts.password },
      logger: false,
    });
    await imap.connect();
    await imap.logout();
  }
}
