import { eq, and, gte } from "drizzle-orm";
import { db } from "../db";
import { smsMessages } from "../db/schema/sms";
import { whatsappAccounts } from "../db/schema/whatsapp-accounts";
import { ApiError, createId } from "../lib/helpers";
import { decryptSecret } from "../lib/crypto";
import { sendText, sendTemplate, metaConfigured } from "../lib/meta-whatsapp";

/** Shared WhatsApp send path — used by the manual send route AND the workflow
 *  engine, so persistence and behaviour are identical everywhere.
 *
 *  WhatsApp runs on the official Meta Cloud API (Embedded Signup / Tech
 *  Provider). Meta's rule: FREEFORM text is only allowed inside the 24-hour
 *  customer-service window opened by the lead's last inbound message; outside
 *  it (cold/first-touch outreach) an approved TEMPLATE is required. */

export function metaWhatsappConfigured(): boolean {
  return metaConfigured();
}

/** The org's connected WhatsApp account (one per org), with a decrypted token. */
export async function getWhatsappAccount(
  orgId: string,
): Promise<{ phoneNumberId: string; wabaId: string; displayPhone: string | null; token: string } | null> {
  const [row] = await db
    .select()
    .from(whatsappAccounts)
    .where(eq(whatsappAccounts.organizationId, orgId))
    .limit(1);
  if (!row) return null;
  let token = "";
  try {
    token = decryptSecret(row.encryptedToken);
  } catch {
    return null;
  }
  return { phoneNumberId: row.phoneNumberId, wabaId: row.wabaId, displayPhone: row.displayPhone, token };
}

/** Fill {{1}}-style slots of a template body with their configured values. */
export function fillTemplateSlots(body: string, vars: Record<string, string>): string {
  return body.replace(/\{\{\s*(\d+)\s*\}\}/g, (_, slot: string) => vars[slot] ?? "");
}

/** Whether the lead messaged us on WhatsApp within the last 24 hours — Meta's
 *  customer-service window for freeform (non-template) replies. */
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

/** Strict E.164 for WhatsApp addressing. Reuses US/UK heuristics. Meta wants
 *  digits only (no leading +). */
export function toE164(phone: string): string {
  const raw = (phone || "").trim();
  if (/^\+\d{7,15}$/.test(raw.replace(/[\s()-]/g, ""))) return raw.replace(/[\s()-]/g, "");
  const d = raw.replace(/\D/g, "");
  if (/^07\d{9}$/.test(d)) return `+44${d.slice(1)}`; // UK local mobile
  if (d.length === 10) return `+1${d}`; // US 10-digit
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  if (d.length === 11 && d.startsWith("44")) return `+${d}`;
  if (d.length >= 11 && d.length <= 15) return `+${d}`;
  throw new ApiError(400, `Cannot resolve "${phone}" to an international (E.164) number for WhatsApp`);
}

export interface SendWhatsappResult {
  messageId: string;
  /** Meta message id (wamid) — reuses the sms_messages.twilioSid column. */
  twilioSid: string | null;
  status: string;
  fromNumber: string;
  toNumber: string;
}

export async function sendWhatsapp(opts: {
  orgId: string;
  lead: { id: string; phone: string; funnelId: string };
  body: string;
  /** When set, sends the approved Meta template instead of freeform text. */
  templateName?: string;
  templateLanguage?: string;
  /** Ordered BODY variable values ({{1}},{{2}},…). Legacy {n} maps also work. */
  templateVariables?: string[] | Record<string, string>;
  /** Template body text — used to store a readable message on the timeline. */
  contentBody?: string;
  contentVariables?: Record<string, string>;
  userId?: string | null;
}): Promise<SendWhatsappResult> {
  const { orgId, lead } = opts;
  if (!lead.phone) throw new ApiError(400, "This lead has no phone number");
  const to = toE164(lead.phone);
  const toDigits = to.replace(/\D/g, "");

  const account = await getWhatsappAccount(orgId);
  if (!account) {
    throw new ApiError(400, "No WhatsApp account connected — connect one in Settings → WhatsApp.");
  }

  const fromNumber = account.displayPhone || "whatsapp";
  const isTemplate = !!opts.templateName;

  // Resolve the message body stored on the timeline + the outbound transport.
  let storedBody: string;
  let wamid: string | null = null;
  try {
    if (isTemplate) {
      const language = opts.templateLanguage || "en_US";
      const vars = Array.isArray(opts.templateVariables)
        ? opts.templateVariables
        : Object.entries(opts.templateVariables || {})
            .sort((a, b) => Number(a[0]) - Number(b[0]))
            .map(([, v]) => v);
      const res = await sendTemplate(account.phoneNumberId, account.token, toDigits, opts.templateName!, language, vars);
      wamid = res.messageId;
      // Store a readable rendering: fill the template body with the vars.
      const varMap: Record<string, string> = {};
      vars.forEach((v, i) => (varMap[String(i + 1)] = v));
      storedBody = opts.contentBody ? fillTemplateSlots(opts.contentBody, varMap) : `[template: ${opts.templateName}]`;
    } else {
      const text =
        (opts.body || "").trim() ||
        fillTemplateSlots((opts.contentBody || "").trim(), opts.contentVariables || {});
      if (!text) throw new ApiError(400, "Message body is required");
      if (!(await hasOpenSession(orgId, lead.id))) {
        throw new ApiError(
          400,
          "Outside the 24-hour WhatsApp window — this lead hasn't messaged you on WhatsApp in the last 24 hours. Send an approved template instead.",
        );
      }
      const res = await sendText(account.phoneNumberId, account.token, toDigits, text);
      wamid = res.messageId;
      storedBody = text;
    }
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(502, `WhatsApp send failed: ${err instanceof Error ? err.message : "unknown error"}`);
  }

  const messageId = createId("sms");
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
    body: storedBody,
    status: "sent",
    twilioSid: wamid,
    createdAt: new Date(),
  });
  return { messageId, twilioSid: wamid, status: "sent", fromNumber, toNumber: to };
}
