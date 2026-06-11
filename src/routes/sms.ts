import { Router, Request, Response, NextFunction } from "express";
import { getAuth } from "@clerk/express";
import { eq, and, asc } from "drizzle-orm";
import twilioSdk from "twilio";
import { db } from "../db";
import { leads, leadEvents } from "../db/schema/leads";
import { funnels } from "../db/schema/funnels";
import { phoneLines } from "../db/schema/phone-lines";
import { smsMessages } from "../db/schema/sms";
import { users } from "../db/schema/organizations";
import { getOrgId } from "../lib/auth";
import { ApiError, createId } from "../lib/helpers";

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

/** Make sure the line's Twilio number routes inbound SMS to our webhook. Looks
 *  the number up by E.164 and sets smsUrl if missing/stale. Best-effort. */
async function ensureSmsConfigured(number: string): Promise<void> {
  const base = process.env.WEBHOOK_BASE_URL;
  if (!base) return;
  const smsUrl = `${base}/webhooks/twilio/sms`;
  try {
    const matches = await client.incomingPhoneNumbers.list({ phoneNumber: number, limit: 1 });
    const n = matches[0];
    if (n && n.smsUrl !== smsUrl) {
      await client.incomingPhoneNumbers(n.sid).update({ smsUrl, smsMethod: "POST" });
    }
  } catch (err) {
    console.warn("[SMS] ensureSmsConfigured failed (sending anyway):", err);
  }
}

// POST /api/funnels/:funnelId/leads/:leadId/sms — send a text to a lead.
router.post(
  "/funnels/:funnelId/leads/:leadId/sms",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const userId = getAuth(req)?.userId || null;
    const funnelId = String(req.params.funnelId);
    const leadId = String(req.params.leadId);
    const body = String((req.body?.body ?? "")).trim();
    const requestedLineId = req.body?.lineId ? String(req.body.lineId) : null;
    if (!body) throw new ApiError(400, "Message body is required");

    // Lead must belong to the caller's org (via its funnel).
    const [lead] = await db
      .select({ id: leads.id, phone: leads.phone, currentStep: leads.currentStep, funnelId: leads.funnelId })
      .from(leads)
      .innerJoin(funnels, eq(leads.funnelId, funnels.id))
      .where(and(eq(leads.id, leadId), eq(leads.funnelId, funnelId), eq(funnels.organizationId, orgId)));
    if (!lead) throw new ApiError(404, "Lead not found");
    if (!lead.phone) throw new ApiError(400, "This lead has no phone number");

    // Pick the sender line: the rep's assigned active line, else the org's
    // first active line.
    const orgLines = await db
      .select({ id: phoneLines.id, number: phoneLines.number, assignedTo: phoneLines.assignedTo, status: phoneLines.status })
      .from(phoneLines)
      .where(eq(phoneLines.organizationId, orgId));
    const activeLines = orgLines.filter((l) => l.status === "active");
    // If the sender explicitly chose a line, honour it (any active org line);
    // otherwise default to their assigned line, then the first active line.
    const line =
      (requestedLineId && activeLines.find((l) => l.id === requestedLineId)) ||
      (userId && activeLines.find((l) => l.assignedTo === userId)) ||
      activeLines[0] ||
      null;
    if (!line) throw new ApiError(400, "No active phone line available to send from");

    await ensureSmsConfigured(line.number);

    const base = process.env.WEBHOOK_BASE_URL;
    let twilioSid: string | null = null;
    let status = "queued";
    try {
      const msg = await client.messages.create({
        to: lead.phone,
        from: line.number,
        body,
        ...(base ? { statusCallback: `${base}/webhooks/twilio/sms-status` } : {}),
      });
      twilioSid = msg.sid;
      status = msg.status || "queued";
    } catch (err: any) {
      throw new ApiError(502, `Twilio rejected the message: ${err?.message || "send failed"}`);
    }

    // Resolve the rep's display name for the timeline.
    let userName: string | null = null;
    if (userId) {
      const [u] = await db
        .select({ firstName: users.firstName, lastName: users.lastName })
        .from(users)
        .where(eq(users.id, userId));
      userName = [u?.firstName, u?.lastName].filter(Boolean).join(" ") || null;
    }

    const now = new Date();
    const messageId = createId("sms");
    await db.insert(smsMessages).values({
      id: messageId,
      organizationId: orgId,
      leadId: lead.id,
      funnelId: lead.funnelId,
      lineId: line.id,
      userId,
      direction: "outbound",
      fromNumber: line.number,
      toNumber: lead.phone,
      body,
      status,
      twilioSid,
      createdAt: now,
    });

    // Mirror onto the lead's activity timeline.
    await db.insert(leadEvents).values({
      id: createId("event"),
      leadId: lead.id,
      type: "step_outcome",
      outcome: "sent",
      stepIndex: Math.max(0, (lead.currentStep || 1) - 1),
      meta: { channel: "sms", direction: "outbound", body, userId, userName },
      timestamp: now,
    });

    res.status(201).json({
      data: {
        id: messageId,
        direction: "outbound",
        fromNumber: line.number,
        toNumber: lead.phone,
        body,
        status,
        userId,
        userName,
        createdAt: now.toISOString(),
      },
    });
  }),
);

// GET /api/funnels/:funnelId/leads/:leadId/sms — the full thread.
router.get(
  "/funnels/:funnelId/leads/:leadId/sms",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const leadId = String(req.params.leadId);

    // Confirm the lead is in the caller's org before exposing its thread.
    const [lead] = await db
      .select({ id: leads.id })
      .from(leads)
      .innerJoin(funnels, eq(leads.funnelId, funnels.id))
      .where(and(eq(leads.id, leadId), eq(funnels.organizationId, orgId)));
    if (!lead) throw new ApiError(404, "Lead not found");

    const rows = await db
      .select({
        id: smsMessages.id,
        direction: smsMessages.direction,
        fromNumber: smsMessages.fromNumber,
        toNumber: smsMessages.toNumber,
        body: smsMessages.body,
        status: smsMessages.status,
        userId: smsMessages.userId,
        createdAt: smsMessages.createdAt,
      })
      .from(smsMessages)
      .where(and(eq(smsMessages.organizationId, orgId), eq(smsMessages.leadId, leadId)))
      .orderBy(asc(smsMessages.createdAt));

    res.json({ data: rows });
  }),
);

export default router;
