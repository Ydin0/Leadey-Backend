import { Router, Request, Response, NextFunction } from "express";
import { getAuth } from "@clerk/express";
import { eq, and, asc, desc, gte, sql, inArray } from "drizzle-orm";
import twilioSdk from "twilio";
import { db } from "../db";
import { leads, leadEvents } from "../db/schema/leads";
import { funnels } from "../db/schema/funnels";
import { phoneLines } from "../db/schema/phone-lines";
import { smsMessages } from "../db/schema/sms";
import { users } from "../db/schema/organizations";
import { masterContacts } from "../db/schema/master";
import { getOrgId } from "../lib/auth";
import { ApiError, createId } from "../lib/helpers";
import { requirePerm } from "../lib/permission-service";

/** Rough dial-country of a number, so we text a UK lead from a UK number and a
 *  US lead from a US number (Twilio rejects mismatched From/To combinations). */
function phoneCountry(num: string | null | undefined): "us" | "uk" | "other" {
  const raw = (num || "").replace(/[^\d+]/g, "");
  const d = raw.replace(/\D/g, "");
  if (raw.startsWith("+44") || d.startsWith("44") || /^07\d{9}$/.test(d)) return "uk";
  if (raw.startsWith("+1") || (d.length === 11 && d.startsWith("1")) || (!raw.startsWith("+") && d.length === 10)) return "us";
  return "other";
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
  requirePerm("messaging.sendSms"),
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
    // Twilio rejects mismatched From/To combinations (e.g. a US number texting a
    // UK lead). Prefer a sender line whose country matches the recipient.
    const destCountry = phoneCountry(lead.phone);
    const sameCountry = (l: { number: string }) => destCountry === "other" || phoneCountry(l.number) === destCountry;
    // If the sender explicitly chose a line, honour it; otherwise prefer a
    // country-matched line (their own first), then any country-matched line,
    // then the rep's assigned line, then the first active line.
    const line =
      (requestedLineId && activeLines.find((l) => l.id === requestedLineId)) ||
      (userId && activeLines.find((l) => l.assignedTo === userId && sameCountry(l))) ||
      activeLines.find((l) => sameCountry(l)) ||
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
        channel: smsMessages.channel,
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

// GET /api/sms/threads — org-wide SMS conversations grouped by counterparty
// number, latest message first. Includes unmatched inbound texts (leadId null).
router.get(
  "/sms/threads",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const rows = await db
      .select({
        msg: smsMessages,
        leadName: leads.name,
        leadCompany: leads.company,
      })
      .from(smsMessages)
      .leftJoin(leads, eq(leads.id, smsMessages.leadId))
      .where(and(eq(smsMessages.organizationId, orgId), gte(smsMessages.createdAt, since)))
      .orderBy(desc(smsMessages.createdAt))
      .limit(1000);

    const norm = (p: string) => (p || "").replace(/[^\d]/g, "").slice(-10);
    type Thread = {
      key: string; phone: string; leadId: string | null; funnelId: string | null;
      contactName: string | null; company: string | null;
      companyDomain: string | null; masterCompanyId: string | null;
      lastBody: string; lastDirection: string; lastAt: string;
      inboundCount: number; total: number; needsReply: boolean;
    };
    const threads = new Map<string, Thread>();
    for (const r of rows) {
      const m = r.msg;
      const counterparty = m.direction === "outbound" ? m.toNumber : m.fromNumber;
      const key = norm(counterparty) || counterparty;
      let t = threads.get(key);
      if (!t) {
        // rows are latest-first → the first one we see for a key is the latest.
        t = {
          key, phone: counterparty, leadId: m.leadId, funnelId: m.funnelId,
          contactName: r.leadName ?? null, company: r.leadCompany ?? null,
          companyDomain: null, masterCompanyId: null,
          lastBody: m.body, lastDirection: m.direction, lastAt: m.createdAt.toISOString(),
          inboundCount: 0, total: 0, needsReply: m.direction === "inbound",
        };
        threads.set(key, t);
      }
      t.total++;
      if (m.direction === "inbound") t.inboundCount++;
      if (!t.leadId && m.leadId) { t.leadId = m.leadId; t.funnelId = m.funnelId; }
      if (!t.contactName && r.leadName) { t.contactName = r.leadName; t.company = r.leadCompany ?? null; }
    }
    const list = [...threads.values()];

    // Enrich rows for the inbox: full contact name (master contact beats a
    // partial lead name), company + domain + canonical company id, and match
    // threads whose messages were never stamped with a leadId against the
    // org's leads by phone (inbound texts from known contacts).
    const leadFields = {
      id: leads.id,
      funnelId: leads.funnelId,
      name: leads.name,
      company: leads.company,
      companyDomain: leads.companyDomain,
      masterCompanyId: leads.masterCompanyId,
      masterContactId: leads.masterContactId,
    };
    type LeadRow = { id: string; funnelId: string; name: string; company: string; companyDomain: string | null; masterCompanyId: string | null; masterContactId: string | null };

    const stampedIds = [...new Set(list.map((t) => t.leadId).filter(Boolean) as string[])];
    const unmatchedKeys = [...new Set(list.filter((t) => !t.leadId && /^\d{7,}$/.test(t.key)).map((t) => t.key))];

    const [stampedRows, phoneRows] = await Promise.all([
      stampedIds.length
        ? db.select(leadFields).from(leads).where(inArray(leads.id, stampedIds))
        : Promise.resolve([] as LeadRow[]),
      unmatchedKeys.length
        ? db
            .select({ ...leadFields, phoneKey: sql<string>`right(regexp_replace(${leads.phone}, '[^0-9]', '', 'g'), 10)` })
            .from(leads)
            .innerJoin(funnels, eq(leads.funnelId, funnels.id))
            .where(and(
              eq(funnels.organizationId, orgId),
              inArray(sql`right(regexp_replace(${leads.phone}, '[^0-9]', '', 'g'), 10)`, unmatchedKeys),
            ))
            .orderBy(asc(leads.createdAt))
        : Promise.resolve([] as (LeadRow & { phoneKey: string })[]),
    ]);

    const byLeadId = new Map(stampedRows.map((l) => [l.id, l]));
    const byPhoneKey = new Map<string, LeadRow & { phoneKey: string }>();
    for (const l of phoneRows) if (!byPhoneKey.has(l.phoneKey)) byPhoneKey.set(l.phoneKey, l);

    const masterIds = [
      ...new Set([...stampedRows, ...phoneRows].map((l) => l.masterContactId).filter(Boolean) as string[]),
    ];
    const masters = masterIds.length
      ? await db
          .select({ id: masterContacts.id, fullName: masterContacts.fullName })
          .from(masterContacts)
          .where(inArray(masterContacts.id, masterIds))
      : [];
    const masterName = new Map(masters.map((m) => [m.id, m.fullName]));

    for (const t of list) {
      const lead = (t.leadId ? byLeadId.get(t.leadId) : undefined) ?? byPhoneKey.get(t.key);
      if (!lead) continue;
      if (!t.leadId) { t.leadId = lead.id; t.funnelId = lead.funnelId; }
      // Prefer the canonical person's full name over a partial lead name
      // (an SMS-created lead is often just a first name).
      const full = lead.masterContactId ? masterName.get(lead.masterContactId) : null;
      t.contactName = full || t.contactName || lead.name || null;
      t.company = t.company || lead.company || null;
      t.companyDomain = lead.companyDomain ?? null;
      t.masterCompanyId = lead.masterCompanyId ?? null;
    }

    res.json({ data: list });
  }),
);

// GET /api/sms/thread-by-phone?phone=... — the full conversation with one
// counterparty number (matched on the last 10 digits), oldest first. Powers
// the inbox chat panel for numbers that aren't linked to a lead.
router.get(
  "/sms/thread-by-phone",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const last10 = String(req.query.phone || "").replace(/[^\d]/g, "").slice(-10);
    if (!last10) throw new ApiError(400, "phone required");
    const rows = await db
      .select()
      .from(smsMessages)
      .where(
        and(
          eq(smsMessages.organizationId, orgId),
          sql`(right(regexp_replace(${smsMessages.fromNumber}, '[^0-9]', '', 'g'), 10) = ${last10}
               OR right(regexp_replace(${smsMessages.toNumber}, '[^0-9]', '', 'g'), 10) = ${last10})`,
        ),
      )
      .orderBy(smsMessages.createdAt)
      .limit(500);
    res.json({
      data: rows.map((m) => ({
        id: m.id, direction: m.direction, channel: m.channel, fromNumber: m.fromNumber, toNumber: m.toNumber,
        body: m.body, status: m.status, userId: m.userId, createdAt: m.createdAt.toISOString(),
      })),
    });
  }),
);

export default router;
