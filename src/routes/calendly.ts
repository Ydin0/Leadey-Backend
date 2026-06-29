import { Router, Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { eq, and } from "drizzle-orm";
import { getAuth } from "@clerk/express";
import { db } from "../db";
import { calendlyAccounts } from "../db/schema/calendly";
import { getOrgId } from "../lib/auth";
import { ApiError, createId } from "../lib/helpers";
import { encryptSecret, decryptSecret, signState, verifyState } from "../lib/crypto";

const AUTHORIZE = "https://auth.calendly.com/oauth/authorize";
const TOKEN = "https://auth.calendly.com/oauth/token";
const API = "https://api.calendly.com";

const clientId = () => process.env.CALENDLY_CLIENT_ID || "";
const clientSecret = () => process.env.CALENDLY_CLIENT_SECRET || "";
const backendBase = () => process.env.WEBHOOK_BASE_URL || "http://localhost:3001";
const appBase = () => process.env.APP_BASE_URL || "http://localhost:3000";
const redirectUri = () => `${backendBase()}/api/calendly/oauth/callback`;

function asyncHandler(handler: (req: Request, res: Response, next: NextFunction) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

interface CalTokens { access: string; refresh: string; expiresAt: number }
function packTokens(t: CalTokens): string { return encryptSecret(JSON.stringify(t)); }
function readTokens(enc: string | null): CalTokens | null {
  if (!enc) return null;
  try { return JSON.parse(decryptSecret(enc)) as CalTokens; } catch { return null; }
}

async function calendlyFetch(url: string, token: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers as Record<string, string> | undefined) },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, body?.message || body?.title || "Calendly API request failed", body);
  return body;
}

/** Exchange/refresh helper — returns a valid access token, refreshing if expired. */
export async function validCalendlyToken(account: typeof calendlyAccounts.$inferSelect): Promise<string | null> {
  const t = readTokens(account.encryptedTokens);
  if (!t) return null;
  if (Date.now() < t.expiresAt - 60_000) return t.access;
  // Refresh.
  const res = await fetch(TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId(),
      client_secret: clientSecret(),
      refresh_token: t.refresh,
    }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.access_token) {
    await db.update(calendlyAccounts).set({ status: "error", lastError: "Token refresh failed", updatedAt: new Date() }).where(eq(calendlyAccounts.id, account.id));
    return null;
  }
  const next: CalTokens = {
    access: body.access_token,
    refresh: body.refresh_token || t.refresh,
    expiresAt: Date.now() + (Number(body.expires_in) || 3600) * 1000,
  };
  await db.update(calendlyAccounts).set({ encryptedTokens: packTokens(next), status: "active", lastError: null, updatedAt: new Date() }).where(eq(calendlyAccounts.id, account.id));
  return next.access;
}

const router = Router();

// ── GET /api/calendly/status ────────────────────────────────────────
router.get(
  "/calendly/status",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const userId = getAuth(req)?.userId || "";
    const [acct] = await db
      .select()
      .from(calendlyAccounts)
      .where(and(eq(calendlyAccounts.organizationId, orgId), eq(calendlyAccounts.userId, userId)));
    res.json({
      data: {
        platformConfigured: !!clientId() && !!clientSecret(),
        connected: !!acct && acct.status !== "disconnected",
        email: acct?.email || null,
        schedulingUrl: acct?.schedulingUrl || null,
        status: acct?.status || null,
      },
    });
  }),
);

// ── GET /api/calendly/oauth/start ───────────────────────────────────
router.get(
  "/calendly/oauth/start",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const userId = getAuth(req)?.userId || "";
    if (!clientId() || !clientSecret()) throw new ApiError(501, "Calendly is not configured on the server");
    const state = signState({ orgId, userId, exp: Date.now() + 10 * 60 * 1000 });
    const params = new URLSearchParams({
      client_id: clientId(),
      response_type: "code",
      redirect_uri: redirectUri(),
      state,
    });
    res.json({ data: { url: `${AUTHORIZE}?${params.toString()}` } });
  }),
);

// ── DELETE /api/calendly/disconnect ─────────────────────────────────
router.delete(
  "/calendly/disconnect",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const userId = getAuth(req)?.userId || "";
    const [acct] = await db
      .select()
      .from(calendlyAccounts)
      .where(and(eq(calendlyAccounts.organizationId, orgId), eq(calendlyAccounts.userId, userId)));
    if (acct) {
      // Best-effort: remove the Calendly webhook subscription.
      if (acct.webhookSubscriptionUri) {
        try {
          const token = await validCalendlyToken(acct);
          if (token) await calendlyFetch(acct.webhookSubscriptionUri, token, { method: "DELETE" });
        } catch { /* ignore */ }
      }
      await db.delete(calendlyAccounts).where(eq(calendlyAccounts.id, acct.id));
    }
    res.json({ data: { ok: true } });
  }),
);

export default router;

// ── PUBLIC: OAuth callback (Calendly redirects here, no Clerk session) ──
export const calendlyPublicRouter = Router();

calendlyPublicRouter.get(
  "/api/calendly/oauth/callback",
  asyncHandler(async (req, res) => {
    const settingsUrl = `${appBase()}/dashboard/settings?tab=integrations`;
    const fail = (msg: string) => res.redirect(`${settingsUrl}&calendly_error=${encodeURIComponent(msg)}`);
    const code = String(req.query.code || "");
    const parsed = verifyState<{ orgId: string; userId: string }>(String(req.query.state || ""));
    if (!code || !parsed?.orgId || !parsed?.userId) return fail("Invalid OAuth response");

    try {
      // 1. Exchange the code for tokens.
      const tokRes = await fetch(TOKEN, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: clientId(),
          client_secret: clientSecret(),
          redirect_uri: redirectUri(),
          code,
        }),
      });
      const tok = await tokRes.json().catch(() => null);
      if (!tokRes.ok || !tok?.access_token) return fail("Could not connect Calendly");
      const access = tok.access_token as string;
      const tokens: CalTokens = {
        access,
        refresh: tok.refresh_token || "",
        expiresAt: Date.now() + (Number(tok.expires_in) || 3600) * 1000,
      };

      // 2. Who is this?
      const me = await calendlyFetch(`${API}/users/me`, access);
      const userUri: string = me?.resource?.uri;
      const orgUri: string = me?.resource?.current_organization;
      const email: string = me?.resource?.email || "";
      const schedulingUrl: string = me?.resource?.scheduling_url || "";

      // Stable account id up front so the webhook URL can be account-scoped
      // (lets the webhook handler find the right signing key to verify with).
      const [existing] = await db
        .select({ id: calendlyAccounts.id })
        .from(calendlyAccounts)
        .where(and(eq(calendlyAccounts.organizationId, parsed.orgId), eq(calendlyAccounts.userId, parsed.userId)));
      const accountId = existing?.id || createId("cal");

      // 3. Create a webhook subscription scoped to this user.
      const signingKey = crypto.randomBytes(24).toString("hex");
      let subscriptionUri: string | null = null;
      try {
        const sub = await calendlyFetch(`${API}/webhook_subscriptions`, access, {
          method: "POST",
          body: JSON.stringify({
            url: `${backendBase()}/webhooks/calendly/${accountId}`,
            events: ["invitee.created", "invitee.canceled"],
            organization: orgUri,
            user: userUri,
            scope: "user",
            signing_key: signingKey,
          }),
        });
        subscriptionUri = sub?.resource?.uri || null;
      } catch (e) {
        console.error("[Calendly] webhook subscription create failed:", e);
        // Continue — the account still connects; meetings just won't sync until fixed.
      }

      // 4. Upsert the account row (one per org+user).
      const values = {
        organizationId: parsed.orgId,
        userId: parsed.userId,
        email,
        schedulingUrl,
        calendlyUserUri: userUri,
        calendlyOrgUri: orgUri,
        encryptedTokens: packTokens(tokens),
        webhookSubscriptionUri: subscriptionUri,
        webhookSigningKey: signingKey,
        status: "active",
        lastError: null,
        updatedAt: new Date(),
      };
      if (existing) {
        await db.update(calendlyAccounts).set(values).where(eq(calendlyAccounts.id, accountId));
      } else {
        await db.insert(calendlyAccounts).values({ id: accountId, ...values });
      }

      res.redirect(`${settingsUrl}&calendly=connected`);
    } catch (err) {
      console.error("[Calendly] OAuth callback error:", err);
      fail("Could not connect Calendly");
    }
  }),
);
