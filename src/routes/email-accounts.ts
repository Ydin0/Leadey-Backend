import { Router, Request, Response, NextFunction } from "express";
import { getAuth } from "@clerk/express";
import { eq, and, asc, inArray } from "drizzle-orm";
import { db } from "../db";
import { emailAccounts, emailMessages, type EmailAttachmentRef } from "../db/schema/email-accounts";
import { emailSignatures } from "../db/schema/email-signatures";
import { calendarEvents } from "../db/schema/calendar";
import { leads, leadEvents } from "../db/schema/leads";
import { funnels } from "../db/schema/funnels";
import { users, organizations } from "../db/schema/organizations";
import { templateAttachments } from "../db/schema/template-attachments";
import { getOrgId } from "../lib/auth";
import { getPerms } from "../lib/permission-service";
import { hasPerm } from "../lib/permission-catalog";
import { ApiError, createId } from "../lib/helpers";
import { signState, verifyState, encryptSecret } from "../lib/crypto";
import { isEmailSuppressed, suppressEmail } from "../lib/suppression";
import { sendEmailVia, verifySmtp, packTokens, accountCanSchedule, type EmailAttachment } from "../lib/email-providers";
import { readAttachmentFile } from "../lib/template-attachment-storage";

const MAX_TOTAL_ATTACHMENT_BYTES = 20 * 1024 * 1024; // providers cap ~25MB total incl. encoding

/** Resolve org-scoped attachment ids into loadable email attachments AND a
 *  metadata snapshot to persist on the message. Unknown ids are skipped
 *  (attachment deleted); an unreadable file is an error — the sender picked
 *  it, so dropping it silently would send a broken email. */
async function loadAttachments(
  orgId: string,
  ids: unknown,
): Promise<{ files: EmailAttachment[]; refs: EmailAttachmentRef[] }> {
  if (!Array.isArray(ids) || ids.length === 0) return { files: [], refs: [] };
  const rows = await db
    .select()
    .from(templateAttachments)
    .where(and(eq(templateAttachments.organizationId, orgId), inArray(templateAttachments.id, ids.map(String))));
  const files: EmailAttachment[] = [];
  const refs: EmailAttachmentRef[] = [];
  let total = 0;
  for (const r of rows) {
    const content = await readAttachmentFile(r.storedName);
    if (!content) {
      console.error(`[email send] attachment file unreadable: ${r.id} (${r.fileName})`);
      throw new ApiError(400, `Attachment "${r.fileName}" could not be read — remove it and upload the file again.`);
    }
    total += content.length;
    if (total > MAX_TOTAL_ATTACHMENT_BYTES) {
      throw new ApiError(400, "Attachments exceed the 20MB total limit.");
    }
    files.push({ filename: r.fileName, content, contentType: r.mimeType || "application/octet-stream" });
    refs.push({ id: r.id, fileName: r.fileName, mimeType: r.mimeType || "application/octet-stream", size: r.size });
  }
  return { files, refs };
}

const router = Router(); // authed, mounted at /api
const publicRouter = Router(); // unauthenticated (OAuth callback + tracking pixel)

function asyncHandler(handler: (req: Request, res: Response, next: NextFunction) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

const backendBase = () => process.env.WEBHOOK_BASE_URL || "http://localhost:3001";
const appBase = () => process.env.APP_BASE_URL || "http://localhost:3000";

async function resolveUserName(userId: string | null): Promise<string | null> {
  if (!userId) return null;
  const [u] = await db.select({ firstName: users.firstName, lastName: users.lastName }).from(users).where(eq(users.id, userId));
  return [u?.firstName, u?.lastName].filter(Boolean).join(" ") || null;
}

async function resolveUserEmail(userId: string | null): Promise<string | null> {
  if (!userId) return null;
  const [u] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId));
  return u?.email ?? null;
}

function serializeAccount(a: typeof emailAccounts.$inferSelect) {
  return {
    id: a.id,
    provider: a.provider,
    email: a.email,
    fromName: a.fromName,
    signature: a.signature ?? null,
    signatureId: a.signatureId ?? null,
    status: a.status,
    isDefault: a.isDefault,
    /** True when this account's token can create calendar events (host a
     *  meeting). Older send-only connections are false until reconnected. */
    canSchedule: accountCanSchedule(a),
    createdAt: a.createdAt.toISOString(),
  };
}

/** Append the account's signature to an outgoing HTML body. Plain-text
 *  signatures (no tags) get their newlines converted; HTML passes through. */
export function withSignature(bodyHtml: string, signature: string | null | undefined): string {
  const sig = (signature || "").trim();
  if (!sig) return bodyHtml;
  const sigHtml = /<[a-z][\s\S]*>/i.test(sig) ? sig : sig.replace(/\n/g, "<br>");
  return `${bodyHtml}<br><br>${sigHtml}`;
}

// ── OAuth provider config ───────────────────────────────────────────
const OAUTH = {
  google: {
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    scope: "https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile",
    clientId: () => process.env.GOOGLE_CLIENT_ID || "",
    clientSecret: () => process.env.GOOGLE_CLIENT_SECRET || "",
    extraAuth: { access_type: "offline", prompt: "consent" } as Record<string, string>,
    providerKey: "gmail" as const,
  },
  microsoft: {
    authorize: `https://login.microsoftonline.com/${process.env.MICROSOFT_TENANT || "common"}/oauth2/v2.0/authorize`,
    token: `https://login.microsoftonline.com/${process.env.MICROSOFT_TENANT || "common"}/oauth2/v2.0/token`,
    scope: "offline_access Mail.Send Mail.Read Calendars.ReadWrite User.Read",
    clientId: () => process.env.MICROSOFT_CLIENT_ID || "",
    clientSecret: () => process.env.MICROSOFT_CLIENT_SECRET || "",
    extraAuth: { response_mode: "query" } as Record<string, string>,
    providerKey: "outlook" as const,
  },
};
type OAuthName = keyof typeof OAUTH;
const redirectUri = (provider: OAuthName) => `${backendBase()}/api/email/oauth/${provider}/callback`;

// ── GET /api/email/accounts — the caller's connected inboxes ─────────
// ?scope=org (settings.manageIntegrations only): EVERY org mailbox with its
// owner, so admins can audit what's connected and by whom.
router.get(
  "/email/accounts",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const userId = getAuth(req)?.userId || "";

    if (req.query.scope === "org") {
      const perms = await getPerms(req);
      if (!hasPerm(perms.permissions, "settings.manageIntegrations")) {
        throw new ApiError(403, "You don't have permission to view all email accounts");
      }
      const rows = await db
        .select({ account: emailAccounts, firstName: users.firstName, lastName: users.lastName })
        .from(emailAccounts)
        .leftJoin(users, eq(emailAccounts.userId, users.id))
        .where(eq(emailAccounts.organizationId, orgId))
        .orderBy(asc(emailAccounts.userId), asc(emailAccounts.createdAt));
      res.json({
        data: rows.map((r) => ({
          ...serializeAccount(r.account),
          userId: r.account.userId,
          ownerName: [r.firstName, r.lastName].filter(Boolean).join(" ") || null,
        })),
      });
      return;
    }

    const rows = await db
      .select()
      .from(emailAccounts)
      .where(and(eq(emailAccounts.organizationId, orgId), eq(emailAccounts.userId, userId)))
      .orderBy(asc(emailAccounts.createdAt));
    res.json({ data: rows.map(serializeAccount) });
  }),
);

// ── PATCH /api/email/accounts/:id — from-name + signature ────────────
router.patch(
  "/email/accounts/:id",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const userId = getAuth(req)?.userId || "";
    const body = req.body as { fromName?: string; signature?: string | null; signatureId?: string | null };

    const patch: Partial<{ fromName: string; signature: string | null; signatureId: string | null; updatedAt: Date }> = { updatedAt: new Date() };
    if (body.fromName !== undefined) patch.fromName = String(body.fromName).slice(0, 120);
    // A shared signature and a raw custom one are mutually exclusive — setting
    // one clears the other.
    if (body.signatureId !== undefined) {
      patch.signatureId = body.signatureId || null;
      if (patch.signatureId) patch.signature = null;
    }
    if (body.signature !== undefined) {
      const sig = body.signature == null ? null : String(body.signature);
      if (sig && sig.length > 20_000) throw new ApiError(400, "Signature is too long (max 20,000 characters)");
      patch.signature = sig && sig.trim() ? sig : null;
      if (patch.signature) patch.signatureId = null;
    }

    const [updated] = await db
      .update(emailAccounts)
      .set(patch)
      .where(and(eq(emailAccounts.id, String(req.params.id)), eq(emailAccounts.organizationId, orgId), eq(emailAccounts.userId, userId)))
      .returning();
    if (!updated) throw new ApiError(404, "Email account not found");
    res.json({ data: serializeAccount(updated) });
  }),
);

// ── GET /api/email/accounts/oauth/:provider/start ───────────────────
router.get(
  "/email/accounts/oauth/:provider/start",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const userId = getAuth(req)?.userId || "";
    const provider = String(req.params.provider) as OAuthName;
    const cfg = OAUTH[provider];
    if (!cfg) throw new ApiError(400, "Unknown provider");
    if (!cfg.clientId()) throw new ApiError(501, `${provider} OAuth is not configured on the server`);

    const state = signState({ orgId, userId, provider, exp: Date.now() + 10 * 60 * 1000 });
    const params = new URLSearchParams({
      client_id: cfg.clientId(),
      redirect_uri: redirectUri(provider),
      response_type: "code",
      scope: cfg.scope,
      state,
      ...cfg.extraAuth,
    });
    res.json({ data: { url: `${cfg.authorize}?${params.toString()}` } });
  }),
);

// ── POST /api/email/accounts/smtp — connect via SMTP/IMAP ───────────
router.post(
  "/email/accounts/smtp",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const userId = getAuth(req)?.userId || "";
    const b = req.body || {};
    const email = String(b.email || "").trim();
    const password = String(b.password || "");
    const smtpHost = String(b.smtpHost || "").trim();
    const smtpPort = Number(b.smtpPort) || 587;
    if (!email || !password || !smtpHost) throw new ApiError(400, "email, password and smtpHost are required");

    const smtpSecure = b.smtpSecure !== undefined ? !!b.smtpSecure : smtpPort === 465;
    const username = String(b.username || email).trim();
    const imapHost = b.imapHost ? String(b.imapHost).trim() : undefined;
    const imapPort = b.imapPort ? Number(b.imapPort) : 993;
    const imapSecure = b.imapSecure !== undefined ? !!b.imapSecure : true;

    try {
      await verifySmtp({ smtpHost, smtpPort, smtpSecure, username, password, imapHost, imapPort, imapSecure });
    } catch (err: any) {
      throw new ApiError(400, `Could not connect: ${err?.message || "invalid credentials"}`);
    }

    const existing = await db
      .select({ id: emailAccounts.id })
      .from(emailAccounts)
      .where(and(eq(emailAccounts.organizationId, orgId), eq(emailAccounts.userId, userId)));
    const [account] = await db
      .insert(emailAccounts)
      .values({
        id: createId("eml"),
        organizationId: orgId,
        userId,
        provider: "smtp",
        email,
        fromName: String(b.fromName || "").trim(),
        status: "active",
        isDefault: existing.length === 0,
        smtpHost,
        smtpPort,
        smtpSecure,
        username,
        encryptedPassword: encryptSecret(password),
        imapHost: imapHost || null,
        imapPort: imapHost ? imapPort : null,
        imapSecure,
      })
      .returning();
    res.status(201).json({ data: serializeAccount(account) });
  }),
);

// ── POST /api/email/accounts/:id/default ────────────────────────────
router.post(
  "/email/accounts/:id/default",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const userId = getAuth(req)?.userId || "";
    const id = String(req.params.id);
    await db
      .update(emailAccounts)
      .set({ isDefault: false })
      .where(and(eq(emailAccounts.organizationId, orgId), eq(emailAccounts.userId, userId)));
    await db
      .update(emailAccounts)
      .set({ isDefault: true })
      .where(and(eq(emailAccounts.id, id), eq(emailAccounts.userId, userId)));
    res.json({ data: { ok: true } });
  }),
);

// ── DELETE /api/email/accounts/:id ──────────────────────────────────
router.delete(
  "/email/accounts/:id",
  asyncHandler(async (req, res) => {
    const userId = getAuth(req)?.userId || "";
    const id = String(req.params.id);
    await db.delete(emailAccounts).where(and(eq(emailAccounts.id, id), eq(emailAccounts.userId, userId)));
    // This mailbox's calendar may have been synced into the calendar view — clean up.
    await db.delete(calendarEvents).where(eq(calendarEvents.accountId, id));
    res.json({ data: { ok: true } });
  }),
);

// ── 1:1 email send + thread ─────────────────────────────────────────
router.post(
  "/funnels/:funnelId/leads/:leadId/email",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const userId = getAuth(req)?.userId || null;
    const funnelId = String(req.params.funnelId);
    const leadId = String(req.params.leadId);
    const subject = String(req.body?.subject || "").trim();
    const bodyHtml = String(req.body?.bodyHtml || "");
    const fromAccountId = req.body?.fromAccountId ? String(req.body.fromAccountId) : null;
    const cc = String(req.body?.cc || "").trim();
    const bcc = String(req.body?.bcc || "").trim();
    if (!subject && !bodyHtml) throw new ApiError(400, "Subject or body is required");

    const [lead] = await db
      .select({ id: leads.id, name: leads.name, email: leads.email, currentStep: leads.currentStep, funnelId: leads.funnelId })
      .from(leads)
      .innerJoin(funnels, eq(leads.funnelId, funnels.id))
      .where(and(eq(leads.id, leadId), eq(leads.funnelId, funnelId), eq(funnels.organizationId, orgId)));
    if (!lead) throw new ApiError(404, "Lead not found");

    // Recipient: an explicit override (reply to a different sender, or forward to
    // a new address) wins; otherwise default to the lead's own email.
    const toEmail = String(req.body?.toEmail || "").trim() || lead.email;
    if (!toEmail) throw new ApiError(400, "A recipient email address is required");
    if (await isEmailSuppressed(orgId, toEmail)) {
      throw new ApiError(409, "This address has unsubscribed or hard-bounced and is on your suppression list. Remove it there to email again.");
    }
    const toName = toEmail === lead.email ? lead.name : null;

    // Pick the sender account: explicit choice → the rep's default → first.
    const accounts = await db
      .select()
      .from(emailAccounts)
      .where(and(eq(emailAccounts.organizationId, orgId), eq(emailAccounts.userId, userId || "")));
    const account =
      (fromAccountId && accounts.find((a) => a.id === fromAccountId)) ||
      accounts.find((a) => a.isDefault) ||
      accounts[0];
    if (!account) throw new ApiError(400, "No connected email account. Connect one in Settings → Email Accounts.");

    const messageId = createId("emsg");
    // Signature first, then the open-tracking pixel (best-effort). A shared
    // signature is resolved with this rep's {{sender_*}} details.
    const { resolveSignatureChoice } = await import("../lib/signature");
    const sigChoice = req.body?.signatureId != null ? String(req.body.signatureId) : undefined;
    const resolvedSig = await resolveSignatureChoice(account, sigChoice);
    const htmlWithSig = withSignature(bodyHtml, resolvedSig);
    const pixel = `<img src="${backendBase()}/track/email/${messageId}/open.gif" width="1" height="1" alt="" style="display:none" />`;
    const html = `${htmlWithSig}${pixel}`;
    const { files: attachments, refs: attachmentRefs } = await loadAttachments(orgId, req.body?.attachmentIds);

    let result;
    try {
      result = await sendEmailVia(account, { to: toEmail, toName, cc: cc || undefined, bcc: bcc || undefined, subject, html, attachments });
    } catch (err: any) {
      const msg = String(err?.message || err);
      console.error(`[email send] ${account.provider} ${account.email} failed:`, msg);
      await db.update(emailAccounts).set({ status: "error", lastError: msg }).where(eq(emailAccounts.id, account.id));
      // Only alert "reconnect your mailbox" on an AUTH failure — a one-off send
      // error (bad recipient, rate limit) shouldn't cry disconnect.
      if (/invalid_grant|unauthor|token|expired|reconnect|401|invalid credentials|permission/i.test(msg)) {
        const { notifyMailboxDisconnected } = await import("../lib/system-emails");
        void notifyMailboxDisconnected({
          accountId: account.id,
          userEmail: await resolveUserEmail(account.userId),
          mailbox: account.email,
          provider: account.provider,
          lastError: msg,
        });
      }
      throw new ApiError(502, `Email send failed: ${err?.message || "provider error"}`);
    }

    const userName = await resolveUserName(userId);
    const now = new Date();
    await db.insert(emailMessages).values({
      id: messageId,
      organizationId: orgId,
      accountId: account.id,
      leadId: lead.id,
      funnelId: lead.funnelId,
      userId,
      direction: "outbound",
      fromEmail: account.email,
      fromName: account.fromName || "",
      toEmail,
      subject,
      bodyHtml: htmlWithSig,
      providerMessageId: result.providerMessageId,
      providerThreadId: result.providerThreadId,
      messageIdHeader: result.messageIdHeader,
      status: "sent",
      attachments: attachmentRefs,
      createdAt: now,
    });
    await db.insert(leadEvents).values({
      id: createId("event"),
      leadId: lead.id,
      type: "step_outcome",
      outcome: "sent",
      stepIndex: Math.max(0, (lead.currentStep || 1) - 1),
      meta: { channel: "email", direction: "outbound", subject, body: htmlWithSig, fromEmail: account.email, fromName: account.fromName, toEmail, cc: cc || undefined, bcc: bcc || undefined, userId, userName },
      timestamp: now,
    });

    res.status(201).json({
      data: {
        id: messageId,
        direction: "outbound",
        fromEmail: account.email,
        fromName: account.fromName,
        toEmail,
        subject,
        bodyHtml: htmlWithSig,
        status: "sent",
        openedAt: null,
        attachments: attachmentRefs,
        createdAt: now.toISOString(),
      },
    });
  }),
);

router.get(
  "/funnels/:funnelId/leads/:leadId/email",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const leadId = String(req.params.leadId);
    const [lead] = await db
      .select({ id: leads.id })
      .from(leads)
      .innerJoin(funnels, eq(leads.funnelId, funnels.id))
      .where(and(eq(leads.id, leadId), eq(funnels.organizationId, orgId)));
    if (!lead) throw new ApiError(404, "Lead not found");

    const rows = await db
      .select({
        id: emailMessages.id,
        direction: emailMessages.direction,
        fromEmail: emailMessages.fromEmail,
        fromName: emailMessages.fromName,
        toEmail: emailMessages.toEmail,
        subject: emailMessages.subject,
        bodyHtml: emailMessages.bodyHtml,
        bodyText: emailMessages.bodyText,
        status: emailMessages.status,
        openedAt: emailMessages.openedAt,
        openCount: emailMessages.openCount,
        userId: emailMessages.userId,
        attachments: emailMessages.attachments,
        createdAt: emailMessages.createdAt,
      })
      .from(emailMessages)
      .where(and(eq(emailMessages.organizationId, orgId), eq(emailMessages.leadId, leadId)))
      .orderBy(asc(emailMessages.createdAt));
    res.json({ data: rows });
  }),
);

// ── GET /email/attachments/:id/download — stream a sent attachment ──
// Org-scoped download of an email attachment (same file store as templates).
router.get(
  "/email/attachments/:id/download",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const [att] = await db
      .select()
      .from(templateAttachments)
      .where(and(eq(templateAttachments.id, String(req.params.id)), eq(templateAttachments.organizationId, orgId)))
      .limit(1);
    if (!att) throw new ApiError(404, "Attachment not found");

    const buffer = await readAttachmentFile(att.storedName);
    if (!buffer) throw new ApiError(404, "Attachment file is no longer available");

    res.setHeader("Content-Type", att.mimeType || "application/octet-stream");
    const asciiName = att.fileName.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "'");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(att.fileName)}`,
    );
    res.setHeader("Content-Length", String(buffer.length));
    res.end(buffer);
  }),
);

// ── Shared email signatures (org-wide, variable-driven) ─────────────

function serializeSignature(s: typeof emailSignatures.$inferSelect) {
  return {
    id: s.id,
    name: s.name,
    contentHtml: s.contentHtml,
    createdBy: s.createdBy,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

// GET /api/email/signatures — the org's shared signatures.
router.get(
  "/email/signatures",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const rows = await db
      .select()
      .from(emailSignatures)
      .where(eq(emailSignatures.organizationId, orgId))
      .orderBy(asc(emailSignatures.name));
    res.json({ data: rows.map(serializeSignature) });
  }),
);

// POST /api/email/signatures — create a shared signature (any member).
router.post(
  "/email/signatures",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const userId = getAuth(req)?.userId || null;
    const name = String(req.body?.name || "").trim();
    const contentHtml = String(req.body?.contentHtml || "");
    if (!name) throw new ApiError(400, "A name is required");
    if (contentHtml.length > 50_000) throw new ApiError(400, "Signature is too long (max 50,000 characters)");
    const [row] = await db
      .insert(emailSignatures)
      .values({ id: createId("esig"), organizationId: orgId, name: name.slice(0, 120), contentHtml, createdBy: userId })
      .returning();
    res.status(201).json({ data: serializeSignature(row) });
  }),
);

// PATCH /api/email/signatures/:id
router.patch(
  "/email/signatures/:id",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const patch: Partial<{ name: string; contentHtml: string; updatedAt: Date }> = { updatedAt: new Date() };
    if (req.body?.name !== undefined) {
      const name = String(req.body.name).trim();
      if (!name) throw new ApiError(400, "A name is required");
      patch.name = name.slice(0, 120);
    }
    if (req.body?.contentHtml !== undefined) {
      const html = String(req.body.contentHtml);
      if (html.length > 50_000) throw new ApiError(400, "Signature is too long (max 50,000 characters)");
      patch.contentHtml = html;
    }
    const [row] = await db
      .update(emailSignatures)
      .set(patch)
      .where(and(eq(emailSignatures.id, String(req.params.id)), eq(emailSignatures.organizationId, orgId)))
      .returning();
    if (!row) throw new ApiError(404, "Signature not found");
    res.json({ data: serializeSignature(row) });
  }),
);

// DELETE /api/email/signatures/:id — also unlinks it from any mailbox using it.
router.delete(
  "/email/signatures/:id",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const id = String(req.params.id);
    await db.update(emailAccounts).set({ signatureId: null, updatedAt: new Date() })
      .where(and(eq(emailAccounts.organizationId, orgId), eq(emailAccounts.signatureId, id)));
    await db.delete(emailSignatures).where(and(eq(emailSignatures.id, id), eq(emailSignatures.organizationId, orgId)));
    res.json({ data: { ok: true } });
  }),
);

// ── Sender signature details (job title + custom fields) ────────────
// GET /api/me/signature-details
router.get(
  "/me/signature-details",
  asyncHandler(async (req, res) => {
    const userId = getAuth(req)?.userId || "";
    const orgId = getOrgId(req);
    const [u] = await db
      .select({
        firstName: users.firstName, lastName: users.lastName, email: users.email, phone: users.phone, title: users.title,
        signatureName: users.signatureName, signatureEmail: users.signatureEmail, signaturePhone: users.signaturePhone, signatureCompany: users.signatureCompany,
        signatureFields: users.signatureFields, defaultSignatureId: users.defaultSignatureId,
      })
      .from(users)
      .where(eq(users.id, userId));
    const [org] = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, orgId));
    res.json({
      data: {
        // Profile/org defaults — shown as placeholders when no override is set.
        firstName: u?.firstName ?? "", lastName: u?.lastName ?? "", email: u?.email ?? "",
        phone: u?.phone ?? "", companyName: org?.name ?? "",
        title: u?.title ?? "",
        // Signature-display overrides (null ⇒ use the default above).
        signatureName: u?.signatureName ?? null, signatureEmail: u?.signatureEmail ?? null,
        signaturePhone: u?.signaturePhone ?? null, signatureCompany: u?.signatureCompany ?? null,
        signatureFields: u?.signatureFields ?? {},
        defaultSignatureId: u?.defaultSignatureId ?? null,
      },
    });
  }),
);

// PATCH /api/me/signature-details — { title?, signatureFields? }
router.patch(
  "/me/signature-details",
  asyncHandler(async (req, res) => {
    const userId = getAuth(req)?.userId || "";
    if (!userId) throw new ApiError(401, "Not authenticated");
    const patch: Partial<{
      title: string | null; signatureName: string | null; signatureEmail: string | null;
      signaturePhone: string | null; signatureCompany: string | null;
      signatureFields: Record<string, string>; defaultSignatureId: string | null; updatedAt: Date;
    }> = { updatedAt: new Date() };
    if (req.body?.title !== undefined) patch.title = String(req.body.title || "").slice(0, 160) || null;
    // Signature-display overrides — a blank string clears the override (⇒ fall
    // back to the profile/org default). Never touches the login identity email.
    const trimOverride = (v: unknown, max: number) => { const s = String(v ?? "").trim().slice(0, max); return s || null; };
    if (req.body?.signatureName !== undefined) patch.signatureName = trimOverride(req.body.signatureName, 160);
    if (req.body?.signatureEmail !== undefined) patch.signatureEmail = trimOverride(req.body.signatureEmail, 200);
    if (req.body?.signaturePhone !== undefined) patch.signaturePhone = trimOverride(req.body.signaturePhone, 60);
    if (req.body?.signatureCompany !== undefined) patch.signatureCompany = trimOverride(req.body.signatureCompany, 160);
    if (req.body?.defaultSignatureId !== undefined) {
      const orgId = getOrgId(req);
      const id = req.body.defaultSignatureId ? String(req.body.defaultSignatureId) : null;
      if (id) {
        // Only allow marking a signature that actually exists in this org.
        const [sig] = await db.select({ id: emailSignatures.id }).from(emailSignatures)
          .where(and(eq(emailSignatures.id, id), eq(emailSignatures.organizationId, orgId)));
        if (!sig) throw new ApiError(404, "Signature not found");
      }
      patch.defaultSignatureId = id;
    }
    if (req.body?.signatureFields !== undefined && req.body.signatureFields && typeof req.body.signatureFields === "object") {
      const clean: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.body.signatureFields as Record<string, unknown>)) {
        const key = k.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase().slice(0, 40);
        if (key) clean[key] = String(v ?? "").slice(0, 500);
      }
      patch.signatureFields = clean;
    }
    await db.update(users).set(patch).where(eq(users.id, userId));
    res.json({ data: { ok: true } });
  }),
);

// ── PUBLIC: OAuth callback (Google/Microsoft redirect here) ─────────
publicRouter.get(
  "/api/email/oauth/:provider/callback",
  asyncHandler(async (req, res) => {
    const provider = String(req.params.provider) as OAuthName;
    const cfg = OAUTH[provider];
    const code = String(req.query.code || "");
    const state = String(req.query.state || "");
    const settingsUrl = `${appBase()}/dashboard/settings?tab=email-accounts`;
    const fail = (msg: string) => res.redirect(`${settingsUrl}&error=${encodeURIComponent(msg)}`);

    if (!cfg || !code) return fail("Missing code");
    const claims = verifyState<{ orgId: string; userId: string; provider: string }>(state);
    if (!claims || claims.provider !== provider) return fail("Invalid state");

    try {
      // Exchange code → tokens.
      const tokenRes = await fetch(cfg.token, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: cfg.clientId(),
          client_secret: cfg.clientSecret(),
          code,
          grant_type: "authorization_code",
          redirect_uri: redirectUri(provider),
          ...(provider === "microsoft" ? { scope: cfg.scope } : {}),
        }),
      });
      const tok = await tokenRes.json();
      if (!tokenRes.ok || !tok.access_token) return fail(tok?.error_description || "Token exchange failed");

      // Identify the connected mailbox.
      let email = "";
      let name = "";
      if (provider === "google") {
        const info = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
          headers: { Authorization: `Bearer ${tok.access_token}` },
        }).then((r) => r.json());
        email = info.email || "";
        name = info.name || "";
      } else {
        const me = await fetch("https://graph.microsoft.com/v1.0/me", {
          headers: { Authorization: `Bearer ${tok.access_token}` },
        }).then((r) => r.json());
        email = me.mail || me.userPrincipalName || "";
        name = me.displayName || "";
      }
      if (!email) return fail("Could not read mailbox address");

      // Fallback so the sender NAME is never left empty (otherwise the provider
      // sends with the email address AS the display name). Prefer the OAuth
      // profile name; else the Leadey user's own name.
      if (!name.trim()) {
        name = (await resolveUserName(claims.userId)) || "";
      }

      const tokens = packTokens({
        access: tok.access_token,
        refresh: tok.refresh_token || "",
        expiresAt: Date.now() + (tok.expires_in || 3600) * 1000,
        scope: cfg.scope,
      });

      // Upsert by (org, user, email).
      const existing = await db
        .select()
        .from(emailAccounts)
        .where(and(eq(emailAccounts.organizationId, claims.orgId), eq(emailAccounts.userId, claims.userId), eq(emailAccounts.email, email)));
      if (existing[0]) {
        await db
          .update(emailAccounts)
          .set({ provider: cfg.providerKey, fromName: name || existing[0].fromName, status: "active", encryptedTokens: tokens, lastError: null, updatedAt: new Date() })
          .where(eq(emailAccounts.id, existing[0].id));
        // Re-arm the disconnect alert for a future auth failure.
        const { clearEmailClaim } = await import("../lib/system-emails");
        void clearEmailClaim(`mailbox_disconnected:${existing[0].id}`);
      } else {
        const anyForUser = await db
          .select({ id: emailAccounts.id })
          .from(emailAccounts)
          .where(and(eq(emailAccounts.organizationId, claims.orgId), eq(emailAccounts.userId, claims.userId)));
        await db.insert(emailAccounts).values({
          id: createId("eml"),
          organizationId: claims.orgId,
          userId: claims.userId,
          provider: cfg.providerKey,
          email,
          fromName: name,
          status: "active",
          isDefault: anyForUser.length === 0,
          encryptedTokens: tokens,
        });
      }
      res.redirect(`${settingsUrl}&connected=1`);
    } catch (err: any) {
      console.error("[email oauth] callback failed:", err);
      fail(err?.message || "Connection failed");
    }
  }),
);

// ── PUBLIC: open-tracking pixel ─────────────────────────────────────
const PIXEL = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
publicRouter.get(
  "/track/email/:messageId/open.gif",
  asyncHandler(async (req, res) => {
    const messageId = String(req.params.messageId);
    try {
      const { sql } = await import("drizzle-orm");
      const [msg] = await db.select().from(emailMessages).where(eq(emailMessages.id, messageId));
      if (msg && msg.direction === "outbound") {
        const firstOpen = !msg.openedAt;
        await db
          .update(emailMessages)
          .set({ openedAt: msg.openedAt || new Date(), openCount: sql`${emailMessages.openCount} + 1` })
          .where(eq(emailMessages.id, messageId));
        if (firstOpen && msg.leadId) {
          await db.insert(leadEvents).values({
            id: createId("event"),
            leadId: msg.leadId,
            type: "step_outcome",
            outcome: "opened",
            stepIndex: 0,
            meta: { channel: "email", direction: "outbound", subject: msg.subject, userId: msg.userId },
            timestamp: new Date(),
          });
          if (msg.userId) {
            const { createNotification } = await import("./notifications");
            await createNotification({
              orgId: msg.organizationId,
              userId: msg.userId,
              type: "email_opened",
              title: `Email opened`,
              body: msg.subject || "",
              leadId: msg.leadId,
              funnelId: msg.funnelId,
            });
          }
        }
      }
    } catch (err) {
      console.error("[email track] failed:", err);
    }
    res.set("Content-Type", "image/gif");
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.set("Pragma", "no-cache");
    res.end(PIXEL);
  }),
);

// ── PUBLIC: one-click unsubscribe ───────────────────────────────────
const unsubPage = (title: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<title>${title}</title></head>` +
  `<body style="margin:0;font-family:Arial,Helvetica,sans-serif;background:#0A0E1F;color:#e5e7eb">` +
  `<div style="max-width:460px;margin:14vh auto 0;padding:32px 28px;background:#151a2e;border:1px solid #262b45;border-radius:14px;text-align:center">` +
  `<h1 style="font-size:18px;margin:0 0 10px;color:#fff">${title}</h1>` +
  `<p style="font-size:14px;line-height:1.6;margin:0;color:#9ca3af">${body}</p>` +
  `</div></body></html>`;

publicRouter.get(
  "/unsubscribe/:token",
  asyncHandler(async (req, res) => {
    res.set("Content-Type", "text/html; charset=utf-8");
    const token = String(req.params.token || "");
    const state = verifyState<{ orgId?: string; emailKey?: string; leadId?: string | null; exp?: number }>(token);
    if (!state?.orgId || !state.emailKey) {
      res.status(400).send(unsubPage("Invalid link", "This unsubscribe link is invalid or has expired."));
      return;
    }
    try {
      await suppressEmail(state.orgId, state.emailKey, "unsubscribe", state.leadId ?? null);
    } catch (err) {
      console.error("[unsubscribe] failed:", err);
    }
    res.status(200).send(
      unsubPage("You've been unsubscribed", `We won't send any more emails to <strong style="color:#e5e7eb">${state.emailKey}</strong>.`),
    );
  }),
);

export default router;
export { publicRouter as emailPublicRouter };
