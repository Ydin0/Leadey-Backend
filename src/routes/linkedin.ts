import { Router, Request, Response, NextFunction } from "express";
import { eq, and, desc } from "drizzle-orm";
import { getAuth } from "@clerk/express";
import { db } from "../db/index";
import { linkedinAccounts } from "../db/schema/linkedin-accounts";
import { linkedinMessages } from "../db/schema/linkedin-messages";
import { linkedinInvitations } from "../db/schema/linkedin-invitations";
import { users } from "../db/schema/organizations";
import { leads, leadEvents } from "../db/schema/leads";
import { funnels } from "../db/schema/funnels";
import { UnipileClient } from "../lib/unipile-client";
import { getOrgId } from "../lib/auth";
import { ApiError, createId } from "../lib/helpers";
import { requirePerm } from "../lib/permission-service";
import { getUsage, canExecute, recordExecution } from "../lib/linkedin-rate-limiter";
import { recordLinkedinMessage } from "../lib/linkedin-store";
import { syncLinkedinOrg } from "../services/linkedin-sync";
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

// ─── GET /linkedin/threads — conversation list for the Inbox ─────────────
router.get(
  "/linkedin/threads",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const rows = await db
      .select({ m: linkedinMessages, leadName: leads.name, company: leads.company, funnelId: leads.funnelId })
      .from(linkedinMessages)
      .leftJoin(leads, eq(linkedinMessages.leadId, leads.id))
      .where(eq(linkedinMessages.organizationId, orgId))
      .orderBy(desc(linkedinMessages.createdAt))
      .limit(4000);

    type Thread = {
      key: string; providerId: string; leadId: string | null; funnelId: string | null;
      contactName: string; company: string | null; lastBody: string; lastDirection: string;
      lastAt: string; total: number; needsReply: boolean;
    };
    const byProvider = new Map<string, Thread>();
    // rows are newest-first, so the first time we see a provider is its latest msg.
    for (const r of rows) {
      const pid = r.m.providerId;
      if (!byProvider.has(pid)) {
        byProvider.set(pid, {
          key: pid, providerId: pid, leadId: r.m.leadId, funnelId: r.funnelId ?? null,
          contactName: r.leadName || r.m.senderName || "LinkedIn member",
          company: r.company ?? null, lastBody: r.m.text, lastDirection: r.m.direction,
          lastAt: r.m.createdAt.toISOString(), total: 0, needsReply: r.m.direction === "inbound",
        });
      }
      const t = byProvider.get(pid)!;
      t.total++;
      if (!t.leadId && r.m.leadId) { t.leadId = r.m.leadId; t.funnelId = r.funnelId ?? t.funnelId; }
      if (!r.leadName && r.m.senderName && t.contactName === "LinkedIn member") t.contactName = r.m.senderName;
    }
    res.json({ data: [...byProvider.values()] });
  }),
);

// ─── GET /linkedin/thread?providerId= — one conversation's messages ──────
router.get(
  "/linkedin/thread",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const providerId = String(req.query.providerId || "").trim();
    if (!providerId) throw new ApiError(400, "providerId is required");
    const rows = await db
      .select()
      .from(linkedinMessages)
      .where(and(eq(linkedinMessages.organizationId, orgId), eq(linkedinMessages.providerId, providerId)))
      .orderBy(linkedinMessages.createdAt);
    res.json({
      data: rows.map((m) => ({
        id: m.id, direction: m.direction, text: m.text, senderName: m.senderName,
        leadId: m.leadId, createdAt: m.createdAt.toISOString(),
      })),
    });
  }),
);

// ─── GET /linkedin/invitations — sent connection requests + status ───────
router.get(
  "/linkedin/invitations",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const rows = await db
      .select({ inv: linkedinInvitations, leadName: leads.name, company: leads.company, funnelId: leads.funnelId })
      .from(linkedinInvitations)
      .leftJoin(leads, eq(linkedinInvitations.leadId, leads.id))
      .where(eq(linkedinInvitations.organizationId, orgId))
      .orderBy(desc(linkedinInvitations.sentAt))
      .limit(1000);
    res.json({
      data: rows.map((r) => ({
        id: r.inv.id, providerId: r.inv.providerId, leadId: r.inv.leadId, funnelId: r.funnelId ?? null,
        name: r.leadName || r.inv.name || "LinkedIn member", company: r.company ?? null,
        status: r.inv.status, sentAt: r.inv.sentAt.toISOString(),
        acceptedAt: r.inv.acceptedAt ? r.inv.acceptedAt.toISOString() : null,
      })),
    });
  }),
);

// ─── POST /linkedin/sync — pull recent conversations from Unipile ────────
router.post(
  "/linkedin/sync",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    await syncLinkedinOrg(orgId).catch((e) => console.error("[linkedin/sync] failed:", e));
    res.json({ data: { ok: true } });
  }),
);

// ─── POST /funnels/:funnelId/leads/:leadId/linkedin/message — reply ──────
router.post(
  "/funnels/:funnelId/leads/:leadId/linkedin/message",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const userId = getAuth(req)?.userId || "";
    const text = String(req.body?.text || "").trim();
    if (!text) throw new ApiError(400, "Message text is required");

    const [lead] = await db
      .select({ id: leads.id, name: leads.name, funnelId: leads.funnelId, linkedinUrl: leads.linkedinUrl, providerId: leads.unipileProviderId })
      .from(leads)
      .innerJoin(funnels, eq(leads.funnelId, funnels.id))
      .where(and(eq(leads.id, String(req.params.leadId)), eq(funnels.organizationId, orgId)));
    if (!lead) throw new ApiError(404, "Lead not found");
    if (!lead.linkedinUrl && !lead.providerId) throw new ApiError(400, "This lead has no LinkedIn profile.");

    // Sender = the acting rep's connected account, else the org's first connected.
    const accts = await db.select().from(linkedinAccounts).where(and(eq(linkedinAccounts.organizationId, orgId), eq(linkedinAccounts.status, "connected")));
    const account = accts.find((a) => a.userId === userId) || accts[0];
    if (!account) throw new ApiError(400, "No connected LinkedIn account.");

    const check = await canExecute(account.unipileAccountId, "message");
    if (!check.allowed) throw new ApiError(429, check.reason || "LinkedIn message limit reached");

    const client = getPlatformClient();
    let providerId = lead.providerId || null;
    if (!providerId && lead.linkedinUrl) {
      const profile = await client.resolveProfile(account.unipileAccountId, lead.linkedinUrl);
      providerId = profile.provider_id;
      if (providerId) await db.update(leads).set({ unipileProviderId: providerId, updatedAt: new Date() }).where(eq(leads.id, lead.id));
    }
    if (!providerId) throw new ApiError(400, "Could not resolve the LinkedIn profile.");

    const chat = await client.sendMessage(account.unipileAccountId, providerId, text);
    await recordExecution(account.unipileAccountId, "message");
    await recordLinkedinMessage({
      organizationId: orgId, accountId: account.id, unipileAccountId: account.unipileAccountId,
      leadId: lead.id, providerId, chatId: chat?.chat_id ?? null, direction: "outbound", text,
    });
    await db.insert(leadEvents).values({
      id: createId("event"), leadId: lead.id, type: "linkedin_action", outcome: "sent",
      stepIndex: 0, meta: { channel: "linkedin", action: "message", direction: "outbound", body: text, source: "inbox" }, timestamp: new Date(),
    });
    res.status(201).json({ data: { ok: true, providerId } });
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

      const accountId = String(b?.account_id || "").trim();
      const text = String(b?.message?.text || b?.text || "").slice(0, 8000);
      const chatId = String(b?.chat_id || b?.message?.chat_id || "") || null;
      const unipileMessageId = String(b?.message?.id || b?.message_id || b?.id || "") || null;
      const senderName = String(b?.sender?.attendee_name || b?.sender?.name || "") || null;

      // Resolve the receiving connected account → org + owner rep (for scoping +
      // the notification). Falls back to a global lead match when unknown.
      const [acct] = accountId
        ? await db.select().from(linkedinAccounts).where(eq(linkedinAccounts.unipileAccountId, accountId)).limit(1)
        : [];

      const [lead] = await db
        .select({ id: leads.id, name: leads.name, funnelId: leads.funnelId })
        .from(leads)
        .where(eq(leads.unipileProviderId, senderProviderId))
        .limit(1);

      // Persist the inbound message so it appears in the LinkedIn Inbox thread —
      // even lead-less, so the conversation still shows.
      if (acct) {
        const { recordLinkedinMessage } = await import("../lib/linkedin-store");
        await recordLinkedinMessage({
          organizationId: acct.organizationId, accountId: acct.id, unipileAccountId: accountId,
          leadId: lead?.id ?? null, providerId: senderProviderId, chatId, unipileMessageId,
          direction: "inbound", text, senderName,
        });
      }

      if (!lead) return;

      await db.insert(leadEvents).values({
        id: createId("event"),
        leadId: lead.id,
        type: "linkedin_reply",
        outcome: "replied",
        stepIndex: 0,
        meta: { text: text.slice(0, 2000) },
        timestamp: new Date(),
      });
      void notifyWorkflowEvent(lead.id, "replied"); // exits sequences (exitOnReply)
      void fireTriggerForLead(lead.id, "reply_received");

      // Notify the rep whose LinkedIn received the reply (top-right bell).
      if (acct) {
        const { createNotificationForUsers } = await import("./notifications");
        await createNotificationForUsers([acct.userId], {
          orgId: acct.organizationId,
          type: "linkedin_reply",
          title: `${lead.name} replied on LinkedIn`,
          body: text.slice(0, 140),
          leadId: lead.id,
          funnelId: lead.funnelId,
        });
      }
    } catch (err) {
      console.error("[linkedin messaging-webhook] handler error:", err);
    }
  }),
);
