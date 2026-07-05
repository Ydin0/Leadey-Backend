import { Router, Request, Response, NextFunction } from "express";
import { getAuth } from "@clerk/express";
import { eq, and, desc } from "drizzle-orm";
import twilioSdk from "twilio";
import { db } from "../db";
import { leads, leadEvents } from "../db/schema/leads";
import { smsMessages } from "../db/schema/sms";
import { funnels } from "../db/schema/funnels";
import { phoneLines } from "../db/schema/phone-lines";
import { whatsappSenders } from "../db/schema/whatsapp";
import { users, organizations } from "../db/schema/organizations";
import { settings } from "../db/schema/settings";
import { getOrgId } from "../lib/auth";
import { ApiError, createId, phoneKey } from "../lib/helpers";
import { getSetting, upsertSetting, deleteSetting } from "../lib/settings-service";
import { notifyWorkflowEvent, fireTriggerForLead } from "../services/workflow-engine";
import { createNotification } from "./notifications";
import {
  sendWhatsapp,
  sandboxNumber,
  listContentTemplates,
  createTextTemplate,
  getConnectedUnipileWhatsapp,
  unipilePlatformClient,
  UNIPILE_WA_ACCOUNT_KEY,
  UNIPILE_WA_PHONE_KEY,
} from "../services/whatsapp-sender";

const WABA_SETTING_KEY = "whatsapp_waba_id";

/** The WhatsApp Business Account senders are registered under. We run a
 *  white-label platform WABA (env TWILIO_WHATSAPP_WABA_ID — one-time Meta
 *  Embedded Signup done by US in the Twilio Console), so customers never
 *  touch Twilio/Meta. A per-org setting can override it for orgs that bring
 *  their own WABA. */
async function resolveWabaId(orgId: string): Promise<string> {
  const orgWaba = (await getSetting(orgId, WABA_SETTING_KEY))?.trim();
  return orgWaba || process.env.TWILIO_WHATSAPP_WABA_ID?.trim() || "";
}

const router = Router();
const client = twilioSdk(
  process.env.TWILIO_ACCOUNT_SID!,
  process.env.TWILIO_AUTH_TOKEN!,
);

function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

type SenderRow = typeof whatsappSenders.$inferSelect;

function serializeSender(s: SenderRow, lineName?: string | null) {
  return {
    id: s.id,
    lineId: s.lineId,
    lineName: lineName ?? null,
    lineReleased: s.lineId === null,
    number: s.number,
    status: s.status,
    lastError: s.lastError,
    createdAt: s.createdAt.toISOString(),
  };
}

/** Twilio sender statuses arrive uppercase (ONLINE, PENDING_VERIFICATION,
 *  ONLINE:UPDATING …) — store a stable lowercase form. */
function normalizeSenderStatus(status: string | null | undefined): string {
  const s = (status || "creating").toLowerCase();
  return s === "online:updating" ? "online" : s;
}

// ── GET /api/whatsapp/settings ──────────────────────────────────────
router.get(
  "/whatsapp/settings",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const orgWaba = (await getSetting(orgId, WABA_SETTING_KEY)) || "";
    const platformWabaConfigured = !!process.env.TWILIO_WHATSAPP_WABA_ID?.trim();
    const unipile = await getConnectedUnipileWhatsapp(orgId);
    res.json({
      data: {
        /** Primary path: the org's own QR-connected WhatsApp (Unipile). */
        unipile: {
          available: !!unipilePlatformClient(),
          connected: !!unipile,
          phone: unipile?.phone ?? null,
        },
        wabaId: orgWaba,
        /** Registration is possible (org override or the platform WABA). */
        wabaConfigured: !!orgWaba.trim() || platformWabaConfigured,
        /** Platform-managed — the UI hides the WABA card entirely. */
        platformWabaConfigured,
        sandbox: !!sandboxNumber(),
        sandboxNumber: sandboxNumber(),
      },
    });
  }),
);

// ── POST /api/whatsapp/connect-link — start the QR connect flow ─────
// Returns a Unipile hosted-auth URL: the customer opens it, scans the QR with
// their own WhatsApp, and Unipile calls our notify webhook with the new
// account id. No Twilio, no Meta, no WABA involved.
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

// ── PUT /api/whatsapp/settings ──────────────────────────────────────
router.put(
  "/whatsapp/settings",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const wabaId = String(req.body?.wabaId ?? "").trim();
    await upsertSetting(orgId, WABA_SETTING_KEY, wabaId);
    res.json({ data: { wabaId } });
  }),
);

// ── GET /api/whatsapp/senders ───────────────────────────────────────
router.get(
  "/whatsapp/senders",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const rows = await db
      .select({ sender: whatsappSenders, lineName: phoneLines.friendlyName })
      .from(whatsappSenders)
      .leftJoin(phoneLines, eq(whatsappSenders.lineId, phoneLines.id))
      .where(eq(whatsappSenders.organizationId, orgId));
    res.json({ data: { senders: rows.map((r) => serializeSender(r.sender, r.lineName)) } });
  }),
);

// ── POST /api/whatsapp/senders — register a line as a WhatsApp sender ──
// Creates the sender with Meta via the Twilio Senders API. The number then
// goes through OTP verification (POST …/verify) before it comes ONLINE.
router.post(
  "/whatsapp/senders",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const lineId = String(req.body?.lineId || "");
    const displayName = String(req.body?.displayName || "").trim();
    if (!lineId) throw new ApiError(400, "lineId is required");

    const wabaId = await resolveWabaId(orgId);
    if (!wabaId) {
      throw new ApiError(400, "WhatsApp isn't configured on this platform yet — please contact support");
    }

    const [line] = await db
      .select()
      .from(phoneLines)
      .where(and(eq(phoneLines.id, lineId), eq(phoneLines.organizationId, orgId)));
    if (!line) throw new ApiError(404, "Phone line not found");
    if (line.status !== "active") throw new ApiError(400, "This phone line is not active");

    const [existing] = await db
      .select({ id: whatsappSenders.id })
      .from(whatsappSenders)
      .where(eq(whatsappSenders.number, line.number));
    if (existing) throw new ApiError(409, "This number is already registered as a WhatsApp sender");

    // Meta shows the profile name on WhatsApp and reviews it — the org's real
    // business name is the sensible default, not the line's internal label.
    const [org] = await db
      .select({ name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, orgId));

    const base = process.env.WEBHOOK_BASE_URL;
    let created;
    try {
      created = await client.messaging.v2.channelsSenders.create({
        senderId: `whatsapp:${line.number}`,
        // OTP via SMS: the code lands on our own inbound webhook (it's a
        // Twilio number), where it's captured and submitted automatically.
        configuration: { wabaId, verificationMethod: "sms" },
        profile: { name: displayName || org?.name || line.friendlyName || line.number },
        ...(base
          ? { webhook: { callbackUrl: `${base}/webhooks/twilio/sms`, callbackMethod: "POST" } }
          : {}),
      });
    } catch (err) {
      const e = err as { message?: string };
      throw new ApiError(502, `Twilio rejected the sender registration: ${e?.message || "unknown error"}`);
    }

    const row: typeof whatsappSenders.$inferInsert = {
      id: createId("was"),
      organizationId: orgId,
      lineId: line.id,
      number: line.number,
      senderSid: created.sid,
      wabaId,
      status: normalizeSenderStatus(created.status),
    };
    await db.insert(whatsappSenders).values(row);
    res.status(201).json({ data: { sender: serializeSender({ ...row, lastError: null, createdAt: new Date(), updatedAt: new Date() } as SenderRow, line.friendlyName) } });
  }),
);

// ── POST /api/whatsapp/senders/:id/verify — submit the OTP code ────
router.post(
  "/whatsapp/senders/:id/verify",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const code = String(req.body?.code || "").trim();
    if (!code) throw new ApiError(400, "Verification code is required");

    const [sender] = await db
      .select()
      .from(whatsappSenders)
      .where(and(eq(whatsappSenders.id, String(req.params.id)), eq(whatsappSenders.organizationId, orgId)));
    if (!sender) throw new ApiError(404, "WhatsApp sender not found");

    try {
      await client.messaging.v2.channelsSenders(sender.senderSid).update({
        configuration: { verificationCode: code },
      });
    } catch (err) {
      const e = err as { message?: string };
      throw new ApiError(400, `Verification failed: ${e?.message || "invalid code"}`);
    }

    const fresh = await client.messaging.v2.channelsSenders(sender.senderSid).fetch();
    const status = normalizeSenderStatus(fresh.status);
    await db
      .update(whatsappSenders)
      .set({ status, lastError: null, updatedAt: new Date() })
      .where(eq(whatsappSenders.id, sender.id));
    res.json({ data: { id: sender.id, status } });
  }),
);

// ── POST /api/whatsapp/senders/:id/refresh — re-pull status from Twilio ──
router.post(
  "/whatsapp/senders/:id/refresh",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const [sender] = await db
      .select()
      .from(whatsappSenders)
      .where(and(eq(whatsappSenders.id, String(req.params.id)), eq(whatsappSenders.organizationId, orgId)));
    if (!sender) throw new ApiError(404, "WhatsApp sender not found");

    let status = sender.status;
    let lastError: string | null = sender.lastError;
    try {
      const fresh = await client.messaging.v2.channelsSenders(sender.senderSid).fetch();
      status = normalizeSenderStatus(fresh.status);
      const reasons = (fresh.offlineReasons || []) as { message?: string | null }[];
      lastError = reasons[0]?.message || null;
    } catch (err) {
      const e = err as { message?: string };
      lastError = e?.message || "Could not fetch sender status from Twilio";
    }
    await db
      .update(whatsappSenders)
      .set({ status, lastError, updatedAt: new Date() })
      .where(eq(whatsappSenders.id, sender.id));
    res.json({ data: { id: sender.id, status, lastError } });
  }),
);

// ── DELETE /api/whatsapp/senders/:id — deregister ───────────────────
router.delete(
  "/whatsapp/senders/:id",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const [sender] = await db
      .select()
      .from(whatsappSenders)
      .where(and(eq(whatsappSenders.id, String(req.params.id)), eq(whatsappSenders.organizationId, orgId)));
    if (!sender) throw new ApiError(404, "WhatsApp sender not found");

    try {
      await client.messaging.v2.channelsSenders(sender.senderSid).remove();
    } catch (err) {
      // Already gone on Twilio's side is fine — we still drop our row.
      console.warn("[whatsapp] sender remove failed (continuing):", err instanceof Error ? err.message : err);
    }
    await db.delete(whatsappSenders).where(eq(whatsappSenders.id, sender.id));
    res.json({ data: { ok: true } });
  }),
);

// ── GET /api/whatsapp/content-templates ─────────────────────────────
router.get(
  "/whatsapp/content-templates",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const templates = await listContentTemplates(orgId);
    res.json({ data: { templates } });
  }),
);

// ── POST /api/whatsapp/content-templates ────────────────────────────
router.post(
  "/whatsapp/content-templates",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const { sid, approvalStatus } = await createTextTemplate(orgId, {
      name: String(req.body?.name || ""),
      body: String(req.body?.body || ""),
      language: req.body?.language ? String(req.body.language) : undefined,
      category: req.body?.category ? String(req.body.category) : undefined,
    });
    res.status(201).json({ data: { sid, approvalStatus } });
  }),
);

// ── POST /api/funnels/:funnelId/leads/:leadId/whatsapp — manual send ──
router.post(
  "/funnels/:funnelId/leads/:leadId/whatsapp",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const userId = getAuth(req)?.userId || null;
    const funnelId = String(req.params.funnelId);
    const leadId = String(req.params.leadId);
    const body = String(req.body?.body ?? "").trim();
    const contentSid = req.body?.contentSid ? String(req.body.contentSid) : undefined;
    const contentVariables =
      req.body?.contentVariables && typeof req.body.contentVariables === "object"
        ? (req.body.contentVariables as Record<string, string>)
        : undefined;
    const preferredLineId = req.body?.lineId ? String(req.body.lineId) : null;
    if (!body && !contentSid) throw new ApiError(400, "Provide a message body or a template (contentSid)");

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
      contentSid,
      contentVariables,
      preferredLineId,
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
      meta: { channel: "whatsapp", direction: "outbound", body, contentSid: contentSid || null, userId, userName },
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
