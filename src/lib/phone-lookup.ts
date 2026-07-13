import twilioSdk from "twilio";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { phoneLookups } from "../db/schema/phone-lookups";
import { getSetting } from "./settings-service";

const STALE_MS = 90 * 24 * 60 * 60 * 1000; // re-verify a number at most every 90 days
const twilio = () => twilioSdk(process.env.TWILIO_ACCOUNT_SID!, process.env.TWILIO_AUTH_TOKEN!);

export interface SmsCapability {
  /** Can this number receive SMS? Fail-open: only a DEFINITIVE landline is false. */
  smsCapable: boolean;
  /** Twilio line type (mobile | landline | voip | ...) or null when unknown. */
  lineType: string | null;
}

/** Normalise to E.164, but ONLY when the input is unambiguously E.164 already
 *  (leads in this system store phones with a leading +). If it isn't, we return
 *  null and the caller allows the send — we never guess a country and never
 *  block a number we can't classify. */
export function toE164(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const t = phone.trim();
  if (!t.startsWith("+")) return null;
  const digits = t.replace(/[^\d]/g, "");
  if (digits.length < 8 || digits.length > 15) return null;
  return `+${digits}`;
}

/** Whether an org blocks SMS to landlines. Default ON — only an explicit
 *  "false" setting disables it. */
export async function landlineBlockEnabled(orgId: string): Promise<boolean> {
  const v = await getSetting(orgId, "sms_block_landline");
  return v !== "false";
}

/** Resolve a number's SMS capability via the local cache, falling back to a
 *  Twilio Lookup v2 line-type call (cached for reuse across leads/orgs). Never
 *  throws — any uncertainty (non-E.164 input, unknown line type, lookup error,
 *  add-on not enabled) resolves to `smsCapable: true` so we only ever refuse a
 *  number Twilio positively identifies as a landline. */
export async function checkSmsCapability(phone: string | null | undefined): Promise<SmsCapability> {
  const e164 = toE164(phone);
  if (!e164) return { smsCapable: true, lineType: null };

  const cached = await db.query.phoneLookups.findFirst({ where: eq(phoneLookups.phoneE164, e164) });
  if (cached && Date.now() - cached.checkedAt.getTime() < STALE_MS) {
    return { smsCapable: cached.smsCapable, lineType: cached.lineType };
  }

  let lineType: string | null = null;
  let carrier: string | null = null;
  try {
    const res = await twilio().lookups.v2.phoneNumbers(e164).fetch({ fields: "line_type_intelligence" });
    const lti = (res.lineTypeIntelligence || {}) as Record<string, unknown>;
    lineType = typeof lti.type === "string" ? lti.type : null;
    carrier = typeof lti.carrier_name === "string" ? lti.carrier_name : null;
  } catch (err) {
    // Lookup unavailable / transient error → allow the send, don't cache.
    console.warn("[phone-lookup] lookup failed, allowing send:", err instanceof Error ? err.message : err);
    return { smsCapable: true, lineType: null };
  }

  const smsCapable = lineType !== "landline"; // only a positive landline is blocked
  const now = new Date();
  await db
    .insert(phoneLookups)
    .values({ phoneE164: e164, lineType, carrier, smsCapable, checkedAt: now })
    .onConflictDoUpdate({ target: phoneLookups.phoneE164, set: { lineType, carrier, smsCapable, checkedAt: now } });

  return { smsCapable, lineType };
}
