import { Router, Request, Response, NextFunction } from "express";
import { getAuth } from "@clerk/express";
import { eq, and, desc } from "drizzle-orm";
import { db } from "../db";
import { leads, leadEvents } from "../db/schema/leads";
import { smsMessages } from "../db/schema/sms";
import { funnels } from "../db/schema/funnels";
import { users } from "../db/schema/organizations";
import { whatsappAccounts } from "../db/schema/whatsapp-accounts";
import { getOrgId } from "../lib/auth";
import { ApiError, createId, phoneKey } from "../lib/helpers";
import { requirePerm } from "../lib/permission-service";
import { encryptSecret } from "../lib/crypto";
import { notifyWorkflowEvent, fireTriggerForLead } from "../services/workflow-engine";
import { createNotificationForUsers, recipientsForLine } from "./notifications";
import { sendWhatsapp, getWhatsappAccount } from "../services/whatsapp-sender";
import {
  metaConfigured,
  exchangeCode,
  getPhoneInfo,
  subscribeApp,
  unsubscribeApp,
  registerPhone,
  listTemplates,
  verifyMetaSignature,
} from "../lib/meta-whatsapp";

// WhatsApp runs on the official Meta WhatsApp Cloud API, onboarded per-org via
// Embedded Signup (Tech Provider). Messages reuse the sms_messages table with
// channel="whatsapp" so threads/inbox/reply-triggers are shared with SMS.

const router = Router();

function asyncHandler(handler: (req: Request, res: Response, next: NextFunction) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

// ── GET /api/whatsapp/settings ──────────────────────────────────────
router.get(
  "/whatsapp/settings",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const [row] = await db
      .select()
      .from(whatsappAccounts)
      .where(eq(whatsappAccounts.organizationId, orgId))
      .limit(1);
    res.json({
      data: {
        available: metaConfigured(),
        connected: !!row,
        phone: row?.displayPhone ?? null,
        wabaId: row?.wabaId ?? null,
      },
    });
  }),
);

// ── POST /api/whatsapp/connect — finish Embedded Signup ─────────────
// Body: { code, phoneNumberId, wabaId, businessId } captured client-side from
// the FB.login callback + the WA_EMBEDDED_SIGNUP message event.
router.post(
  "/whatsapp/connect",
  requirePerm("messaging.manageAccounts"),
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    if (!metaConfigured()) throw new ApiError(501, "WhatsApp is not configured on the platform");
    const code = String(req.body?.code || "").trim();
    const phoneNumberId = String(req.body?.phoneNumberId || "").trim();
    const wabaId = String(req.body?.wabaId || "").trim();
    const businessId = req.body?.businessId ? String(req.body.businessId) : null;
    if (!code || !phoneNumberId || !wabaId) {
      throw new ApiError(400, "Missing Embedded Signup details (code, phoneNumberId, wabaId)");
    }

    // Exchange the 30-second code for a long-lived business token.
    const { accessToken, expiresIn } = await exchangeCode(code);
    // Subscribe our app to the WABA so inbound messages reach our webhook.
    await subscribeApp(wabaId, accessToken).catch((err) => {
      console.warn("[whatsapp] subscribeApp failed:", err instanceof Error ? err.message : err);
    });
    // Register the number for Cloud API (best-effort — often already registered).
    const pin = String(Math.floor(100000 + Math.random() * 900000));
    await registerPhone(phoneNumberId, accessToken, pin).catch((err) => {
      console.warn("[whatsapp] registerPhone (non-fatal):", err instanceof Error ? err.message : err);
    });
    // Display number + verified name for the UI.
    const info = await getPhoneInfo(phoneNumberId, accessToken).catch(() => ({ displayPhone: null, verifiedName: null }));

    const now = new Date();
    const tokenExpiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000) : new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);
    const values = {
      organizationId: orgId,
      wabaId,
      phoneNumberId,
      displayPhone: info.displayPhone,
      verifiedName: info.verifiedName,
      businessId,
      encryptedToken: encryptSecret(accessToken),
      tokenExpiresAt,
      status: "connected" as const,
      lastError: null,
      updatedAt: now,
    };
    await db
      .insert(whatsappAccounts)
      .values({ id: createId("wac"), ...values })
      .onConflictDoUpdate({ target: whatsappAccounts.organizationId, set: values });

    res.status(201).json({ data: { connected: true, phone: info.displayPhone, wabaId } });
  }),
);

// ── DELETE /api/whatsapp/account — disconnect ───────────────────────
router.delete(
  "/whatsapp/account",
  requirePerm("messaging.manageAccounts"),
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const account = await getWhatsappAccount(orgId);
    if (account) {
      await unsubscribeApp(account.wabaId, account.token).catch(() => {});
    }
    await db.delete(whatsappAccounts).where(eq(whatsappAccounts.organizationId, orgId));
    res.json({ data: { connected: false } });
  }),
);

// ── GET /api/whatsapp/templates — approved templates for the picker ──
router.get(
  "/whatsapp/templates",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const account = await getWhatsappAccount(orgId);
    if (!account) {
      res.json({ data: [] });
      return;
    }
    const templates = await listTemplates(account.wabaId, account.token).catch(() => []);
    res.json({ data: templates });
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
    const templateName = req.body?.templateName ? String(req.body.templateName) : undefined;
    const templateLanguage = req.body?.templateLanguage ? String(req.body.templateLanguage) : undefined;
    const templateVariables = Array.isArray(req.body?.templateVariables)
      ? (req.body.templateVariables as string[]).map(String)
      : undefined;
    const contentBody = req.body?.contentBody ? String(req.body.contentBody) : undefined;
    if (!body && !templateName) throw new ApiError(400, "A message body or template is required");

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
      templateName,
      templateLanguage,
      templateVariables,
      contentBody,
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
      meta: { channel: "whatsapp", direction: "outbound", body: body || templateName, template: templateName || null, userId, userName },
      timestamp: now,
    });

    res.status(201).json({
      data: {
        id: result.messageId,
        direction: "outbound",
        channel: "whatsapp",
        fromNumber: result.fromNumber,
        toNumber: result.toNumber,
        body: body || `[template: ${templateName}]`,
        status: result.status,
        userId,
        userName,
        createdAt: now.toISOString(),
      },
    });
  }),
);

export default router;

// ── PUBLIC: Meta webhook (mounted under /webhooks; raw body for signature) ──
export const whatsappPublicRouter = Router();

/** Webhook verification handshake (Meta App Dashboard → WhatsApp → Config). */
whatsappPublicRouter.get("/meta/whatsapp", (req: Request, res: Response) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === process.env.META_WEBHOOK_VERIFY_TOKEN) {
    res.status(200).send(String(challenge ?? ""));
    return;
  }
  res.sendStatus(403);
});

/** Map a Meta delivery status to our sms_messages.status. */
function mapStatus(s: string): string {
  if (s === "read") return "delivered";
  if (s === "delivered") return "delivered";
  if (s === "sent") return "sent";
  if (s === "failed") return "failed";
  return s;
}

/** Inbound messages + delivery statuses for connected WABAs. Body is RAW
 *  (express.raw registered for /webhooks/meta) so we can verify the signature. */
whatsappPublicRouter.post("/meta/whatsapp", asyncHandler(async (req, res) => {
  try {
    const raw: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}));
    if (!verifyMetaSignature(raw, req.header("x-hub-signature-256"))) {
      // Reject spoofed calls but still 200 so Meta doesn't disable the hook.
      console.warn("[whatsapp] meta webhook signature mismatch");
      res.sendStatus(200);
      return;
    }
    const payload = JSON.parse(raw.toString("utf8")) as MetaWebhook;

    for (const entry of payload.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== "messages") continue;
        const value = change.value || {};
        const phoneNumberId = value.metadata?.phone_number_id;
        if (!phoneNumberId) continue;
        const [account] = await db
          .select({ organizationId: whatsappAccounts.organizationId, displayPhone: whatsappAccounts.displayPhone })
          .from(whatsappAccounts)
          .where(eq(whatsappAccounts.phoneNumberId, phoneNumberId))
          .limit(1);
        if (!account) continue;
        const orgId = account.organizationId;

        // Delivery/read statuses → update the stored outbound row.
        for (const st of value.statuses || []) {
          if (!st.id) continue;
          await db
            .update(smsMessages)
            .set({ status: mapStatus(st.status) })
            .where(and(eq(smsMessages.organizationId, orgId), eq(smsMessages.twilioSid, st.id)));
        }

        // Inbound messages → store, match a lead, fire reply triggers, notify.
        for (const msg of value.messages || []) {
          const fromDigits = (msg.from || "").replace(/\D/g, "");
          const text =
            msg.type === "text"
              ? msg.text?.body || ""
              : msg.button?.text || msg.interactive?.list_reply?.title || msg.interactive?.button_reply?.title || `[${msg.type}]`;
          if (!fromDigits || !text) continue;

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
            toNumber: account.displayPhone || "whatsapp",
            body: text,
            status: "received",
            twilioSid: msg.id ?? null,
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
            {
              // The WhatsApp sender is org-level (no assigned rep), so notify
              // the last texter, else everyone in the org.
              const recipients = await recipientsForLine({ orgId, preferUserId: lastOut?.userId ?? null });
              await createNotificationForUsers(recipients, {
                orgId,
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
    }
  } catch (err) {
    console.error("[whatsapp] meta webhook failed:", err);
  }
  // Always 200 so Meta doesn't disable the webhook on transient errors.
  res.sendStatus(200);
}));

// ── Meta webhook payload shapes (partial) ──
interface MetaWebhook {
  entry?: {
    id?: string;
    changes?: {
      field?: string;
      value?: {
        metadata?: { display_phone_number?: string; phone_number_id?: string };
        messages?: {
          from?: string;
          id?: string;
          type?: string;
          text?: { body?: string };
          button?: { text?: string };
          interactive?: { list_reply?: { title?: string }; button_reply?: { title?: string } };
        }[];
        statuses?: { id?: string; status: string; recipient_id?: string }[];
      };
    }[];
  }[];
}
