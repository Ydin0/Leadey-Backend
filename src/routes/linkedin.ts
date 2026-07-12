import { Router, Request, Response, NextFunction } from "express";
import { eq, and, desc } from "drizzle-orm";
import { getAuth } from "@clerk/express";
import { db } from "../db/index";
import { linkedinAccounts } from "../db/schema/linkedin-accounts";
import { users } from "../db/schema/organizations";
import { leads, leadEvents } from "../db/schema/leads";
import { UnipileClient } from "../lib/unipile-client";
import { getOrgId } from "../lib/auth";
import { ApiError, createId } from "../lib/helpers";
import { requirePerm } from "../lib/permission-service";
import { getUsage } from "../lib/linkedin-rate-limiter";
import { notifyWorkflowEvent, fireTriggerForLead } from "../services/workflow-engine";

const backendBase = () => process.env.WEBHOOK_BASE_URL || "http://localhost:3001";
const APP_URL = process.env.APP_URL || "https://app.leadey.ai";

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<void>;
function asyncHandler(handler: AsyncHandler) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

/** Platform-level Unipile client (workspace DSN + API key from env). Every
 *  rep's LinkedIn action runs through this one workspace; per-account scoping
 *  is done via the account_id passed to each call. */
export function getPlatformClient(): UnipileClient {
  const dsn = process.env.UNIPILE_DSN;
  const apiKey = process.env.UNIPILE_API_KEY;
  if (!dsn || !apiKey) throw new ApiError(500, "Unipile platform credentials not configured");
  return new UnipileClient(dsn, apiKey);
}

/** Best-effort: make sure a workspace-wide messaging webhook points at us so
 *  inbound LinkedIn replies can fire "replied" workflow triggers. Idempotent. */
async function ensureMessagingWebhook(client: UnipileClient): Promise<void> {
  const url = `${backendBase()}/linkedin/messaging-webhook`;
  const existing = await client.listWebhooks().catch(() => []);
  if (existing.some((w) => w.request_url === url && w.source === "messaging")) return;
  await client.createMessagingWebhook(url);
}

const router = Router();

// ─── POST /linkedin/accounts/connect ─────────────────────────────────────
// Returns a Unipile hosted-auth URL. The rep logs in + clears 2FA on Unipile's
// own page; Unipile then POSTs the new account id to /linkedin/notify (which
// carries our "<orgId>:<userId>" correlation token back) and redirects the rep
// to Settings → LinkedIn.
router.post(
  "/linkedin/accounts/connect",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const userId = getAuth(req)?.userId || "";
    if (!userId) throw new ApiError(401, "Not authenticated");

    const client = getPlatformClient();
    void ensureMessagingWebhook(client).catch(() => {});

    const settingsUrl = `${APP_URL}/dashboard/settings?tab=linkedin`;
    const { url } = await client.createHostedAuthLink({
      providers: ["LINKEDIN"],
      name: `${orgId}:${userId}`,
      notifyUrl: `${backendBase()}/linkedin/notify`,
      successRedirectUrl: `${settingsUrl}&connected=1`,
      failureRedirectUrl: `${settingsUrl}&connected=0`,
    });
    res.json({ data: { url } });
  }),
);

// ─── GET /linkedin/accounts ──────────────────────────────────────────────
// Org's connected LinkedIn accounts + owner name + rate-limit usage.
router.get(
  "/linkedin/accounts",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const rows = await db
      .select({
        acc: linkedinAccounts,
        firstName: users.firstName,
        lastName: users.lastName,
        email: users.email,
      })
      .from(linkedinAccounts)
      .leftJoin(users, eq(linkedinAccounts.userId, users.id))
      .where(eq(linkedinAccounts.organizationId, orgId))
      .orderBy(desc(linkedinAccounts.createdAt));

    const data = await Promise.all(
      rows.map(async (r) => ({
        id: r.acc.id,
        userId: r.acc.userId,
        ownerName: [r.firstName, r.lastName].filter(Boolean).join(" ") || r.email || null,
        unipileAccountId: r.acc.unipileAccountId,
        name: r.acc.name,
        publicIdentifier: r.acc.publicIdentifier,
        profileUrl: r.acc.profileUrl,
        status: r.acc.status,
        lastError: r.acc.lastError,
        createdAt: r.acc.createdAt,
        usage: await getUsage(r.acc.unipileAccountId).catch(() => null),
      })),
    );
    res.json({ data });
  }),
);

// ─── DELETE /linkedin/accounts/:id ───────────────────────────────────────
router.delete(
  "/linkedin/accounts/:id",
  requirePerm("settings.manageIntegrations"),
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const [row] = await db
      .select()
      .from(linkedinAccounts)
      .where(and(eq(linkedinAccounts.id, String(req.params.id)), eq(linkedinAccounts.organizationId, orgId)));
    if (!row) throw new ApiError(404, "LinkedIn account not found");
    try {
      await getPlatformClient().deleteAccount(row.unipileAccountId);
    } catch {
      // Unipile may already have dropped it — remove our row regardless.
    }
    await db.delete(linkedinAccounts).where(eq(linkedinAccounts.id, row.id));
    res.json({ data: { deleted: true } });
  }),
);

export default router;

// ─── PUBLIC (unauthed) — Unipile hosted-auth notify + messaging webhook ──
export const linkedinPublicRouter = Router();

// Unipile POSTs here after a successful hosted-auth connection. Payload carries
// the new account_id and echoes back the `name` we passed ("<orgId>:<userId>").
linkedinPublicRouter.post(
  "/linkedin/notify",
  asyncHandler(async (req, res) => {
    const accountId = String(req.body?.account_id || "").trim();
    const name = String(req.body?.name || "").trim();
    // account_id is only present on a successful creation/reconnection.
    if (!accountId || !name.includes(":")) {
      res.json({ ok: true });
      return;
    }
    const [orgId, userId] = name.split(":");
    if (!orgId || !userId) {
      res.json({ ok: true });
      return;
    }

    let accountName: string | null = null;
    try {
      const acc = await getPlatformClient().getAccount(accountId);
      accountName = acc?.name || null;
    } catch {
      // Non-fatal — persist what we have.
    }

    // One LinkedIn per rep: drop any prior account rows for this user, then
    // upsert the new one (unique on unipileAccountId guards reconnects).
    await db
      .delete(linkedinAccounts)
      .where(and(eq(linkedinAccounts.organizationId, orgId), eq(linkedinAccounts.userId, userId)));
    await db
      .insert(linkedinAccounts)
      .values({
        id: createId("liacc"),
        organizationId: orgId,
        userId,
        unipileAccountId: accountId,
        name: accountName,
        status: "connected",
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: linkedinAccounts.unipileAccountId,
        set: { organizationId: orgId, userId, name: accountName, status: "connected", lastError: null, updatedAt: new Date() },
      });

    res.json({ ok: true });
  }),
);

// Inbound LinkedIn messages → fire the "replied" workflow signal so conditional
// follow-ups (wait → branch if not replied → message) behave correctly.
linkedinPublicRouter.post(
  "/linkedin/messaging-webhook",
  asyncHandler(async (req, res) => {
    // Acknowledge fast; Unipile retries on non-2xx.
    res.json({ ok: true });
    try {
      const b = req.body || {};
      // Only inbound (someone else's) messages matter. Unipile marks own sends.
      if (b.is_sender === true || b.event === "message_sent") return;
      const senderProviderId = String(
        b?.sender?.attendee_provider_id || b?.from?.attendee_provider_id || b?.attendee_provider_id || "",
      ).trim();
      if (!senderProviderId) return;

      const [lead] = await db
        .select({ id: leads.id })
        .from(leads)
        .where(eq(leads.unipileProviderId, senderProviderId))
        .limit(1);
      if (!lead) return;

      await db.insert(leadEvents).values({
        id: createId("event"),
        leadId: lead.id,
        type: "linkedin_reply",
        outcome: "replied",
        stepIndex: 0,
        meta: { text: String(b?.message?.text || b?.text || "").slice(0, 2000) },
        timestamp: new Date(),
      });
      void notifyWorkflowEvent(lead.id, "replied");
      void fireTriggerForLead(lead.id, "reply_received");
    } catch (err) {
      console.error("[linkedin messaging-webhook] handler error:", err);
    }
  }),
);
