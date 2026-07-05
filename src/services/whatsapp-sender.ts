import { eq, and, gte } from "drizzle-orm";
import twilioSdk from "twilio";
import { db } from "../db";
import { smsMessages } from "../db/schema/sms";
import { whatsappSenders } from "../db/schema/whatsapp";
import { ApiError, createId } from "../lib/helpers";
import { getSetting } from "../lib/settings-service";
import { UnipileClient } from "../lib/unipile-client";

/** Shared WhatsApp send path — used by the manual send route AND the workflow
 *  engine, so the 24h-session rule, sender resolution and message persistence
 *  behave identically everywhere.
 *
 *  Meta's core constraint: a business may only send FREEFORM text inside the
 *  24-hour customer-service window opened by the lead's last inbound message.
 *  Outside it, only pre-approved Content templates (contentSid) are allowed —
 *  freeform fails with Twilio error 63016. We enforce this locally with a
 *  clear error instead of letting sends silently die. */

const client = twilioSdk(
  process.env.TWILIO_ACCOUNT_SID!,
  process.env.TWILIO_AUTH_TOKEN!,
);

/** The shared Twilio WhatsApp sandbox number, for dev — when set, sends skip
 *  sender registration entirely (recipients must have joined the sandbox). */
export function sandboxNumber(): string | null {
  return process.env.TWILIO_WHATSAPP_SANDBOX_NUMBER?.trim() || null;
}

// ── Unipile-connected WhatsApp (the customer's own number, QR-linked) ──
// This is the primary customer path (Close.com-style): the org scans a QR
// with their own WhatsApp, and sends go out from that number via Unipile.
// No Meta approval, no template/24h rules — but conversational volumes only.

export const UNIPILE_WA_ACCOUNT_KEY = "whatsapp_unipile_account_id";
export const UNIPILE_WA_PHONE_KEY = "whatsapp_unipile_phone";

export function unipilePlatformClient(): UnipileClient | null {
  const dsn = process.env.UNIPILE_DSN;
  const apiKey = process.env.UNIPILE_API_KEY;
  if (!dsn || !apiKey) return null;
  return new UnipileClient(dsn, apiKey);
}

export async function getConnectedUnipileWhatsapp(
  orgId: string,
): Promise<{ accountId: string; phone: string | null } | null> {
  if (!unipilePlatformClient()) return null;
  const accountId = (await getSetting(orgId, UNIPILE_WA_ACCOUNT_KEY))?.trim();
  if (!accountId) return null;
  const phone = (await getSetting(orgId, UNIPILE_WA_PHONE_KEY))?.trim() || null;
  return { accountId, phone };
}

/** Fill {{1}}-style slots of a template body with their configured values —
 *  used when a template-mode workflow step sends through Unipile (which has
 *  no Content-API concept; the rendered text is sent directly). */
function fillTemplateSlots(body: string, vars: Record<string, string>): string {
  return body.replace(/\{\{\s*(\d+)\s*\}\}/g, (_, slot: string) => vars[slot] ?? "");
}

export interface ResolvedSender {
  fromNumber: string;
  lineId: string | null;
  sandbox: boolean;
}

/** Pick the WhatsApp from-number: sandbox when configured, else the org's
 *  first ONLINE registered sender (honoring a preferred line). */
export async function resolveWhatsappSender(
  orgId: string,
  preferredLineId?: string | null,
): Promise<ResolvedSender> {
  const sandbox = sandboxNumber();
  if (sandbox) return { fromNumber: sandbox, lineId: null, sandbox: true };

  const senders = await db
    .select()
    .from(whatsappSenders)
    .where(and(eq(whatsappSenders.organizationId, orgId), eq(whatsappSenders.status, "online")));
  const sender =
    (preferredLineId && senders.find((s) => s.lineId === preferredLineId)) ||
    senders[0] ||
    null;
  if (!sender) {
    throw new ApiError(
      400,
      "No WhatsApp sender is online for this organization. Register one in Settings → WhatsApp.",
    );
  }
  return { fromNumber: sender.number, lineId: sender.lineId, sandbox: false };
}

/** Whether the lead has messaged us on WhatsApp within the last 24 hours —
 *  Meta's customer-service window for freeform (non-template) replies. */
export async function hasOpenSession(orgId: string, leadId: string): Promise<boolean> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [row] = await db
    .select({ id: smsMessages.id })
    .from(smsMessages)
    .where(and(
      eq(smsMessages.organizationId, orgId),
      eq(smsMessages.leadId, leadId),
      eq(smsMessages.channel, "whatsapp"),
      eq(smsMessages.direction, "inbound"),
      gte(smsMessages.createdAt, cutoff),
    ))
    .limit(1);
  return !!row;
}

/** Strict E.164 for WhatsApp addressing (stricter than SMS — Twilio tolerates
 *  loose formats for SMS but whatsapp:<to> must be +<digits>). Reuses the
 *  same US/UK heuristics as the SMS country matcher. */
export function toE164(phone: string): string {
  const raw = (phone || "").trim();
  if (/^\+\d{7,15}$/.test(raw.replace(/[\s()-]/g, ""))) return raw.replace(/[\s()-]/g, "");
  const d = raw.replace(/\D/g, "");
  if (/^07\d{9}$/.test(d)) return `+44${d.slice(1)}`; // UK local mobile
  if (d.length === 10) return `+1${d}`; // US 10-digit
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  if (d.length === 11 && d.startsWith("44")) return `+${d}`;
  if (d.length >= 11 && d.length <= 15) return `+${d}`; // already has a country code
  throw new ApiError(400, `Cannot resolve "${phone}" to an international (E.164) number for WhatsApp`);
}

export interface SendWhatsappResult {
  messageId: string;
  twilioSid: string | null;
  status: string;
  fromNumber: string;
  toNumber: string;
}

export async function sendWhatsapp(opts: {
  orgId: string;
  lead: { id: string; phone: string; funnelId: string };
  body: string;
  contentSid?: string;
  /** The template's text body — used verbatim (slots filled) on the Unipile
   *  path, where Twilio Content templates don't exist. */
  contentBody?: string;
  contentVariables?: Record<string, string>;
  preferredLineId?: string | null;
  userId?: string | null;
}): Promise<SendWhatsappResult> {
  const { orgId, lead } = opts;
  if (!lead.phone) throw new ApiError(400, "This lead has no phone number");
  const to = toE164(lead.phone);

  // Preferred path: the org's own QR-connected WhatsApp via Unipile —
  // freeform is always allowed there (it's a normal WhatsApp conversation).
  const unipile = await getConnectedUnipileWhatsapp(orgId);
  if (unipile) {
    const text =
      (opts.body || "").trim() ||
      fillTemplateSlots((opts.contentBody || "").trim(), opts.contentVariables || {});
    if (!text) throw new ApiError(400, "Message body is required");
    const client = unipilePlatformClient()!;
    try {
      await client.sendMessage(unipile.accountId, `${to.replace(/\D/g, "")}@s.whatsapp.net`, text);
    } catch (err) {
      throw new ApiError(502, `WhatsApp send failed: ${err instanceof Error ? err.message : "unknown error"}`);
    }
    const messageId = createId("sms");
    const fromNumber = unipile.phone || "whatsapp";
    await db.insert(smsMessages).values({
      id: messageId,
      organizationId: orgId,
      leadId: lead.id,
      funnelId: lead.funnelId,
      lineId: null,
      userId: opts.userId ?? null,
      direction: "outbound",
      channel: "whatsapp",
      fromNumber,
      toNumber: to,
      body: text,
      status: "sent",
      twilioSid: null,
      createdAt: new Date(),
    });
    return { messageId, twilioSid: null, status: "sent", fromNumber, toNumber: to };
  }

  const sender = await resolveWhatsappSender(orgId, opts.preferredLineId);

  // Template sends are always allowed; freeform only inside the 24h window
  // (sandbox skips the local check — Twilio enforces its own session there).
  let payload: { contentSid: string; contentVariables?: string } | { body: string };
  if (opts.contentSid) {
    payload = {
      contentSid: opts.contentSid,
      ...(opts.contentVariables && Object.keys(opts.contentVariables).length > 0
        ? { contentVariables: JSON.stringify(opts.contentVariables) }
        : {}),
    };
  } else {
    const body = (opts.body || "").trim();
    if (!body) throw new ApiError(400, "Message body is required");
    if (!sender.sandbox && !(await hasOpenSession(orgId, lead.id))) {
      throw new ApiError(
        400,
        "Outside the 24-hour WhatsApp session window — this lead hasn't messaged you on WhatsApp in the last 24 hours. Use an approved template message instead.",
      );
    }
    payload = { body };
  }

  const base = process.env.WEBHOOK_BASE_URL;
  let twilioSid: string | null = null;
  let status = "queued";
  try {
    const msg = await client.messages.create({
      to: `whatsapp:${to}`,
      from: `whatsapp:${sender.fromNumber}`,
      ...payload,
      ...(base ? { statusCallback: `${base}/webhooks/twilio/sms-status` } : {}),
    });
    twilioSid = msg.sid;
    status = msg.status || "queued";
  } catch (err) {
    const e = err as { code?: number; message?: string };
    if (e?.code === 63016) {
      throw new ApiError(
        400,
        "WhatsApp rejected the freeform message — the 24-hour session window is closed. Use an approved template.",
      );
    }
    throw new ApiError(502, `Twilio rejected the WhatsApp message: ${e?.message || "send failed"}`);
  }

  const messageId = createId("sms");
  await db.insert(smsMessages).values({
    id: messageId,
    organizationId: orgId,
    leadId: lead.id,
    funnelId: lead.funnelId,
    lineId: sender.lineId,
    userId: opts.userId ?? null,
    direction: "outbound",
    channel: "whatsapp",
    fromNumber: sender.fromNumber, // bare E.164 — prefix never stored
    toNumber: to,
    body: opts.contentSid ? opts.body || "" : (payload as { body: string }).body,
    status,
    twilioSid,
    createdAt: new Date(),
  });

  return { messageId, twilioSid, status, fromNumber: sender.fromNumber, toNumber: to };
}

// ── Content templates (Meta-approved message templates via Twilio Content API) ──
// The Content API is account-wide on our single master Twilio account, so
// templates are namespaced per org by prefixing the friendlyName with
// "<orgId>__" and filtering lists on that prefix.

export interface WhatsappContentTemplate {
  sid: string;
  name: string;
  language: string;
  body: string;
  variables: Record<string, string>;
  approvalStatus: string; // approved | pending | rejected | received | unsubmitted | …
  rejectionReason: string | null;
}

const orgPrefix = (orgId: string) => `${orgId}__`;

/** Approval info lives under approvalRequests as a loosely-typed record. */
function readApproval(raw: Record<string, unknown> | null | undefined): { status: string; reason: string | null } {
  if (!raw || typeof raw !== "object") return { status: "unsubmitted", reason: null };
  const status = typeof raw.status === "string" && raw.status ? raw.status : "unsubmitted";
  const reason = typeof raw.rejection_reason === "string" && raw.rejection_reason ? raw.rejection_reason : null;
  return { status, reason };
}

export async function listContentTemplates(orgId: string): Promise<WhatsappContentTemplate[]> {
  const rows = await client.content.v1.contentAndApprovals.list({ limit: 200 });
  return rows
    .filter((c) => (c.friendlyName || "").startsWith(orgPrefix(orgId)))
    .map((c) => {
      const text = (c.types as Record<string, { body?: string } | undefined>)["twilio/text"];
      const approval = readApproval(c.approvalRequests as Record<string, unknown>);
      const variables: Record<string, string> = {};
      for (const [k, v] of Object.entries(c.variables || {})) variables[k] = String(v);
      return {
        sid: c.sid,
        name: (c.friendlyName || "").slice(orgPrefix(orgId).length),
        language: c.language,
        body: text?.body || "",
        variables,
        approvalStatus: approval.status,
        rejectionReason: approval.reason,
      };
    });
}

export async function createTextTemplate(
  orgId: string,
  opts: { name: string; body: string; language?: string; category?: string },
): Promise<{ sid: string; approvalStatus: string }> {
  const name = opts.name.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  if (!name) throw new ApiError(400, "Template name is required (letters, numbers, underscores)");
  const body = opts.body.trim();
  if (!body) throw new ApiError(400, "Template body is required");

  // Default sample values for {{1}}-style placeholders (Meta requires samples).
  const variables: Record<string, string> = {};
  for (const m of body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)) variables[m[1]] = `sample_${m[1]}`;

  const content = await client.content.v1.contents.create({
    friendlyName: `${orgPrefix(orgId)}${name}`,
    language: opts.language || "en",
    ...(Object.keys(variables).length > 0 ? { variables } : {}),
    // SDK request types use camelCase keys; serialized as "twilio/text".
    types: { twilioText: { body } },
  });

  let approvalStatus = "unsubmitted";
  try {
    await client.content.v1.contents(content.sid).approvalCreate.create({
      name,
      category: (opts.category || "UTILITY").toUpperCase(),
    });
    approvalStatus = "pending";
  } catch (err) {
    console.warn("[whatsapp] template approval submission failed:", err instanceof Error ? err.message : err);
  }
  return { sid: content.sid, approvalStatus };
}
