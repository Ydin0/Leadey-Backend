import { Router, Request, Response, NextFunction } from "express";
import { getAuth } from "@clerk/express";
import { eq, and, asc } from "drizzle-orm";
import { db } from "../db";
import { emailAccounts, emailMessages } from "../db/schema/email-accounts";
import { leads, leadEvents } from "../db/schema/leads";
import { funnels } from "../db/schema/funnels";
import { users } from "../db/schema/organizations";
import { getOrgId } from "../lib/auth";
import { ApiError, createId } from "../lib/helpers";
import { signState, verifyState, encryptSecret } from "../lib/crypto";
import { sendEmailVia, verifySmtp, packTokens } from "../lib/email-providers";

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

function serializeAccount(a: typeof emailAccounts.$inferSelect) {
  return {
    id: a.id,
    provider: a.provider,
    email: a.email,
    fromName: a.fromName,
    status: a.status,
    isDefault: a.isDefault,
    createdAt: a.createdAt.toISOString(),
  };
}

// ── OAuth provider config ───────────────────────────────────────────
const OAUTH = {
  google: {
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    scope: "https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/userinfo.email",
    clientId: () => process.env.GOOGLE_CLIENT_ID || "",
    clientSecret: () => process.env.GOOGLE_CLIENT_SECRET || "",
    extraAuth: { access_type: "offline", prompt: "consent" } as Record<string, string>,
    providerKey: "gmail" as const,
  },
  microsoft: {
    authorize: `https://login.microsoftonline.com/${process.env.MICROSOFT_TENANT || "common"}/oauth2/v2.0/authorize`,
    token: `https://login.microsoftonline.com/${process.env.MICROSOFT_TENANT || "common"}/oauth2/v2.0/token`,
    scope: "offline_access Mail.Send Mail.Read User.Read",
    clientId: () => process.env.MICROSOFT_CLIENT_ID || "",
    clientSecret: () => process.env.MICROSOFT_CLIENT_SECRET || "",
    extraAuth: { response_mode: "query" } as Record<string, string>,
    providerKey: "outlook" as const,
  },
};
type OAuthName = keyof typeof OAUTH;
const redirectUri = (provider: OAuthName) => `${backendBase()}/api/email/oauth/${provider}/callback`;

// ── GET /api/email/accounts — the caller's connected inboxes ─────────
router.get(
  "/email/accounts",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const userId = getAuth(req)?.userId || "";
    const rows = await db
      .select()
      .from(emailAccounts)
      .where(and(eq(emailAccounts.organizationId, orgId), eq(emailAccounts.userId, userId)))
      .orderBy(asc(emailAccounts.createdAt));
    res.json({ data: rows.map(serializeAccount) });
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
    if (!subject && !bodyHtml) throw new ApiError(400, "Subject or body is required");

    const [lead] = await db
      .select({ id: leads.id, name: leads.name, email: leads.email, currentStep: leads.currentStep, funnelId: leads.funnelId })
      .from(leads)
      .innerJoin(funnels, eq(leads.funnelId, funnels.id))
      .where(and(eq(leads.id, leadId), eq(leads.funnelId, funnelId), eq(funnels.organizationId, orgId)));
    if (!lead) throw new ApiError(404, "Lead not found");
    if (!lead.email) throw new ApiError(400, "This lead has no email address");

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
    // Open-tracking pixel (best-effort; blocked images simply won't register).
    const pixel = `<img src="${backendBase()}/track/email/${messageId}/open.gif" width="1" height="1" alt="" style="display:none" />`;
    const html = `${bodyHtml}${pixel}`;

    let result;
    try {
      result = await sendEmailVia(account, { to: lead.email, toName: lead.name, subject, html });
    } catch (err: any) {
      console.error(`[email send] ${account.provider} ${account.email} failed:`, err?.message || err);
      await db.update(emailAccounts).set({ status: "error", lastError: String(err?.message || err) }).where(eq(emailAccounts.id, account.id));
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
      toEmail: lead.email,
      subject,
      bodyHtml,
      providerMessageId: result.providerMessageId,
      providerThreadId: result.providerThreadId,
      messageIdHeader: result.messageIdHeader,
      status: "sent",
      createdAt: now,
    });
    await db.insert(leadEvents).values({
      id: createId("event"),
      leadId: lead.id,
      type: "step_outcome",
      outcome: "sent",
      stepIndex: Math.max(0, (lead.currentStep || 1) - 1),
      meta: { channel: "email", direction: "outbound", subject, body: bodyHtml, fromEmail: account.email, userId, userName },
      timestamp: now,
    });

    res.status(201).json({
      data: {
        id: messageId,
        direction: "outbound",
        fromEmail: account.email,
        fromName: account.fromName,
        toEmail: lead.email,
        subject,
        bodyHtml,
        status: "sent",
        openedAt: null,
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
        status: emailMessages.status,
        openedAt: emailMessages.openedAt,
        userId: emailMessages.userId,
        createdAt: emailMessages.createdAt,
      })
      .from(emailMessages)
      .where(and(eq(emailMessages.organizationId, orgId), eq(emailMessages.leadId, leadId)))
      .orderBy(asc(emailMessages.createdAt));
    res.json({ data: rows });
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

export default router;
export { publicRouter as emailPublicRouter };
