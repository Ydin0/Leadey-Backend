import { Router, Request, Response, NextFunction } from "express";
import { getAuth } from "@clerk/express";
import { eq, and, desc } from "drizzle-orm";
import { db } from "../db";
import { leads, leadEvents } from "../db/schema/leads";
import { smsMessages } from "../db/schema/sms";
import { funnels } from "../db/schema/funnels";
import { users } from "../db/schema/organizations";
import { settings } from "../db/schema/settings";
import { getOrgId } from "../lib/auth";
import { ApiError, createId, phoneKey } from "../lib/helpers";
import { requirePerm } from "../lib/permission-service";
import { getSetting, upsertSetting, deleteSetting } from "../lib/settings-service";
import { notifyWorkflowEvent, fireTriggerForLead } from "../services/workflow-engine";
import { createNotification } from "./notifications";
import {
  sendWhatsapp,
  getConnectedUnipileWhatsapp,
  unipilePlatformClient,
  UNIPILE_WA_ACCOUNT_KEY,
  UNIPILE_WA_PHONE_KEY,
} from "../services/whatsapp-sender";

// WhatsApp is QR-linked via Unipile (Close.com-style): the org scans a QR with
// their own phone, and sends go out from that number. No Twilio, no Meta WABA,
// no templates, no 24-hour window. Messages reuse the sms_messages table with
// channel="whatsapp" so threads/inbox/reply-triggers are shared with SMS.

const router = Router();

function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

// ── GET /api/whatsapp/settings ──────────────────────────────────────
router.get(
  "/whatsapp/settings",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const unipile = await getConnectedUnipileWhatsapp(orgId);
    res.json({
      data: {
        /** Whether the platform has Unipile configured at all. */
        available: !!unipilePlatformClient(),
        /** Whether this org has a QR-connected WhatsApp account. */
        connected: !!unipile,
        /** The connected phone number (display only). */
        phone: unipile?.phone ?? null,
      },
    });
  }),
);

// ── POST /api/whatsapp/connect-link — start the QR connect flow ─────
// Returns a Unipile hosted-auth URL: the customer opens it, scans the QR with
// their own WhatsApp, and Unipile calls our notify webhook with the new
// account id.
router.post(
  "/whatsapp/connect-link",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const unipile = unipilePlatformClient();
    if (!unipile) throw new ApiError(501, "WhatsApp connection is not configured on the platform");
    const base = process.env.WEBHOOK_BASE_URL;
    const appBase = process.env.APP_BASE_URL || "http://localhost:3000";

    // Make sure incoming WhatsApp messages reach us (idempotent, best-effort).
    if (base) {
      const messagesUrl = `${base}/webhooks/unipile/messages`;
      try {
        const hooks = await unipile.listWebhooks();
        if (!hooks.some((h) => h.request_url === messagesUrl)) {
          await unipile.createMessagingWebhook(messagesUrl);
        }
      } catch (err) {
        console.warn("[whatsapp] unipile webhook registration failed:", err instanceof Error ? err.message : err);
      }
    }

    const link = await unipile.createHostedAuthLink({
      providers: ["WHATSAPP"],
      name: orgId,
      ...(base ? { notifyUrl: `${base}/webhooks/unipile/hosted-auth` } : {}),
      successRedirectUrl: `${appBase}/dashboard/settings?tab=whatsapp&whatsapp_connected=1`,
      failureRedirectUrl: `${appBase}/dashboard/settings?tab=whatsapp&whatsapp_error=1`,
    });
    res.json({ data: { url: link.url } });
  }),
);

// ── DELETE /api/whatsapp/account — disconnect the QR-linked WhatsApp ──
router.delete(
  "/whatsapp/account",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const connected = await getConnectedUnipileWhatsapp(orgId);
    if (connected) {
      // Remove the Unipile account too (it bills per connected account).
      try {
        await unipilePlatformClient()?.deleteAccount(connected.accountId);
      } catch (err) {
        console.warn("[whatsapp] unipile account delete failed (continuing):", err instanceof Error ? err.message : err);
      }
    }
    await deleteSetting(orgId, UNIPILE_WA_ACCOUNT_KEY);
    await deleteSetting(orgId, UNIPILE_WA_PHONE_KEY);
    res.json({ data: { connected: false } });
  }),
);

// ── POST /api/funnels/:funnelId/leads/:leadId/whatsapp — manual send ──
router.post(
  "/funnels/:funnelId/leads/:leadId/whatsapp",
  requirePerm("messaging.sendWhatsapp"),
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const userId = getAuth(req)?.userId || null;
    const funnelId = String(req.params.funnelId);
    const leadId = String(req.params.leadId);
    const body = String(req.body?.body ?? "").trim();
    if (!body) throw new ApiError(400, "A message body is required");

    const [lead] = await db
      .select({ id: leads.id, phone: leads.phone, currentStep: leads.currentStep, funnelId: leads.funnelId })
      .from(leads)
      .innerJoin(funnels, eq(leads.funnelId, funnels.id))
      .where(and(eq(leads.id, leadId), eq(leads.funnelId, funnelId), eq(funnels.organizationId, orgId)));
    if (!lead) throw new ApiError(404, "Lead not found");

    const result = await sendWhatsapp({
      orgId,
      lead: { id: lead.id, phone: lead.phone, funnelId: lead.funnelId },
      body,
      userId,
    });

    let userName: string | null = null;
    if (userId) {
      const [u] = await db
        .select({ firstName: users.firstName, lastName: users.lastName })
        .from(users)
        .where(eq(users.id, userId));
      userName = [u?.firstName, u?.lastName].filter(Boolean).join(" ") || null;
    }

    const now = new Date();
    await db.insert(leadEvents).values({
      id: createId("event"),
      leadId: lead.id,
      type: "step_outcome",
      outcome: "sent",
      stepIndex: Math.max(0, (lead.currentStep || 1) - 1),
      meta: { channel: "whatsapp", direction: "outbound", body, userId, userName },
      timestamp: now,
    });

    res.status(201).json({
      data: {
        id: result.messageId,
        direction: "outbound",
        channel: "whatsapp",
        fromNumber: result.fromNumber,
        toNumber: result.toNumber,
        body,
        status: result.status,
        userId,
        userName,
        createdAt: now.toISOString(),
      },
    });
  }),
);

export default router;

// ── PUBLIC: Unipile webhooks (mounted under /webhooks, no auth) ──────
export const whatsappPublicRouter = Router();

/** Hosted-auth completion: Unipile POSTs { status, account_id, name } where
 *  `name` is the orgId we passed when creating the link. */
whatsappPublicRouter.post(
  "/unipile/hosted-auth",
  asyncHandler(async (req, res) => {
    try {
      const status = String(req.body?.status || "");
      const accountId = String(req.body?.account_id || "");
      const orgId = String(req.body?.name || "");
      if (accountId && orgId && (status === "CREATION_SUCCESS" || status === "RECONNECTED" || !status)) {
        await upsertSetting(orgId, UNIPILE_WA_ACCOUNT_KEY, accountId);
        // The account's display name is the connected phone number.
        try {
          const account = await unipilePlatformClient()?.getAccount(accountId);
          if (account?.name) await upsertSetting(orgId, UNIPILE_WA_PHONE_KEY, account.name);
        } catch {
          // phone label is cosmetic — connection still works without it
        }
        console.log(`[whatsapp] unipile account ${accountId} connected for org ${orgId}`);
      }
    } catch (err) {
      console.error("[whatsapp] hosted-auth notify failed:", err);
    }
    res.json({ ok: true });
  }),
);

/** Incoming WhatsApp messages for QR-connected accounts. Mirrors the Twilio
 *  inbound path: store the message, match the lead by phone, log the timeline
 *  event, fire reply triggers, notify the last rep. */
whatsappPublicRouter.post(
  "/unipile/messages",
  asyncHandler(async (req, res) => {
    try {
      const p = (req.body || {}) as Record<string, unknown>;
      const accountType = String(p.account_type || "");
      const accountId = String(p.account_id || "");
      if (accountId && (!accountType || accountType.toUpperCase() === "WHATSAPP")) {
        // Which org owns this connected account?
        const [row] = await db
          .select({ organizationId: settings.organizationId })
          .from(settings)
          .where(and(eq(settings.key, UNIPILE_WA_ACCOUNT_KEY), eq(settings.value, accountId)));
        const orgId = row?.organizationId;

        const sender = (p.sender || {}) as Record<string, unknown>;
        const senderProviderId = String(sender.attendee_provider_id || "");
        const fromDigits = senderProviderId.replace(/@.*/, "").replace(/\D/g, "");
        const text =
          typeof p.message === "string"
            ? p.message
            : String((p.message as Record<string, unknown> | undefined)?.text || "");
        const ourPhone = orgId ? ((await getSetting(orgId, UNIPILE_WA_PHONE_KEY)) || "") : "";
        const isOwnMessage = !!fromDigits && ourPhone.replace(/\D/g, "").endsWith(fromDigits.slice(-9));

        if (orgId && fromDigits && text && !isOwnMessage) {
          // Match the lead by the sender's number.
          const key = phoneKey(fromDigits);
          let lead: { id: string; funnelId: string; name: string } | null = null;
          if (key) {
            const candidates = await db
              .select({ id: leads.id, funnelId: leads.funnelId, name: leads.name, phone: leads.phone })
              .from(leads)
              .innerJoin(funnels, eq(leads.funnelId, funnels.id))
              .where(eq(funnels.organizationId, orgId));
            lead = candidates.find((c) => phoneKey(c.phone) === key) || null;
          }

          await db.insert(smsMessages).values({
            id: createId("sms"),
            organizationId: orgId,
            leadId: lead?.id ?? null,
            funnelId: lead?.funnelId ?? null,
            lineId: null,
            userId: null,
            direction: "inbound",
            channel: "whatsapp",
            fromNumber: `+${fromDigits}`,
            toNumber: ourPhone || "whatsapp",
            body: text,
            status: "received",
            twilioSid: null,
          });

          if (lead) {
            await db.insert(leadEvents).values({
              id: createId("event"),
              leadId: lead.id,
              type: "step_outcome",
              outcome: "replied",
              stepIndex: 0,
              meta: { channel: "whatsapp", direction: "inbound", body: text },
              timestamp: new Date(),
            });
            void notifyWorkflowEvent(lead.id, "replied");
            void fireTriggerForLead(lead.id, "reply_received");

            const [lastOut] = await db
              .select({ userId: smsMessages.userId })
              .from(smsMessages)
              .where(and(eq(smsMessages.leadId, lead.id), eq(smsMessages.direction, "outbound")))
              .orderBy(desc(smsMessages.createdAt))
              .limit(1);
            if (lastOut?.userId) {
              await createNotification({
                orgId,
                userId: lastOut.userId,
                type: "sms_reply",
                title: `${lead.name} replied on WhatsApp`,
                body: text.slice(0, 140),
                leadId: lead.id,
                funnelId: lead.funnelId,
              });
            }
          }
        }
      }
    } catch (err) {
      console.error("[whatsapp] unipile message webhook failed:", err);
    }
    // Always 200 so Unipile doesn't disable the webhook on transient errors.
    res.json({ ok: true });
  }),
);
