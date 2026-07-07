import { db } from "../db";
import { smsMessages } from "../db/schema/sms";
import { ApiError, createId } from "../lib/helpers";
import { getSetting } from "../lib/settings-service";
import { UnipileClient } from "../lib/unipile-client";

/** Shared WhatsApp send path — used by the manual send route AND the workflow
 *  engine, so persistence and behaviour are identical everywhere.
 *
 *  WhatsApp is QR-linked via Unipile (Close.com-style): the org scans a QR with
 *  their own WhatsApp, and sends go out from that number. Freeform is always
 *  allowed (it's a normal WhatsApp conversation) — no Meta approval, templates
 *  or 24-hour window. Conversational volumes only (rides WhatsApp Web). */

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
 *  used when a workflow step carries a template-style body (Unipile has no
 *  Content-API concept; the rendered text is sent directly). */
function fillTemplateSlots(body: string, vars: Record<string, string>): string {
  return body.replace(/\{\{\s*(\d+)\s*\}\}/g, (_, slot: string) => vars[slot] ?? "");
}

/** Strict E.164 for WhatsApp addressing. Reuses the same US/UK heuristics as
 *  the SMS country matcher. */
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
  /** Template-style body (with {{n}} slots) for workflow steps; slots filled
   *  from contentVariables and sent as normal freeform text. */
  contentBody?: string;
  contentVariables?: Record<string, string>;
  userId?: string | null;
}): Promise<SendWhatsappResult> {
  const { orgId, lead } = opts;
  if (!lead.phone) throw new ApiError(400, "This lead has no phone number");
  const to = toE164(lead.phone);

  const unipile = await getConnectedUnipileWhatsapp(orgId);
  if (!unipile) {
    throw new ApiError(400, "No WhatsApp account connected — link one in Settings → WhatsApp.");
  }

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
