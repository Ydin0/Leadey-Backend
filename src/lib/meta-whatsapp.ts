import crypto from "crypto";

/**
 * Thin Meta WhatsApp Cloud API (Graph) client for the Embedded Signup /
 * Tech Provider flow. Every send uses the customer's own business token
 * (onboarded via Embedded Signup); app-level values come from env.
 *
 * Env: META_APP_ID, META_APP_SECRET, META_GRAPH_VERSION (default v25.0),
 * META_WEBHOOK_VERIFY_TOKEN.
 */

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v25.0";
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;

export function metaConfigured(): boolean {
  return !!(process.env.META_APP_ID && process.env.META_APP_SECRET);
}

async function graph<T = unknown>(
  path: string,
  opts: { method?: string; token?: string; body?: unknown; query?: Record<string, string> } = {},
): Promise<T> {
  const url = new URL(`${GRAPH}${path}`);
  for (const [k, v] of Object.entries(opts.query || {})) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), {
    method: opts.method || "GET",
    headers: {
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.body ? { "Content-Type": "application/json" } : {}),
    },
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
  });
  const data = (await res.json().catch(() => null)) as T & { error?: { message?: string } };
  if (!res.ok) {
    const msg = (data as { error?: { message?: string } })?.error?.message || `Graph ${res.status}`;
    throw new Error(msg);
  }
  return data as T;
}

/** Exchange the Embedded Signup 30s code for a long-lived business token. */
export async function exchangeCode(code: string): Promise<{ accessToken: string; expiresIn: number | null }> {
  const data = await graph<{ access_token: string; expires_in?: number }>("/oauth/access_token", {
    query: {
      client_id: process.env.META_APP_ID || "",
      client_secret: process.env.META_APP_SECRET || "",
      code,
    },
  });
  return { accessToken: data.access_token, expiresIn: data.expires_in ?? null };
}

/** Display number + verified name for a phone number id. */
export async function getPhoneInfo(
  phoneNumberId: string,
  token: string,
): Promise<{ displayPhone: string | null; verifiedName: string | null }> {
  const data = await graph<{ display_phone_number?: string; verified_name?: string }>(`/${phoneNumberId}`, {
    token,
    query: { fields: "display_phone_number,verified_name" },
  });
  return { displayPhone: data.display_phone_number ?? null, verifiedName: data.verified_name ?? null };
}

/** Subscribe our app to the customer's WABA webhooks (required for inbound). */
export async function subscribeApp(wabaId: string, token: string): Promise<void> {
  await graph(`/${wabaId}/subscribed_apps`, { method: "POST", token });
}

export async function unsubscribeApp(wabaId: string, token: string): Promise<void> {
  await graph(`/${wabaId}/subscribed_apps`, { method: "DELETE", token });
}

/** Register the phone number for Cloud API with a 6-digit PIN. Best-effort —
 *  numbers created fresh in Embedded Signup are often already registered. */
export async function registerPhone(phoneNumberId: string, token: string, pin: string): Promise<void> {
  await graph(`/${phoneNumberId}/register`, {
    method: "POST",
    token,
    body: { messaging_product: "whatsapp", pin },
  });
}

export interface MetaTemplate {
  name: string;
  language: string;
  status: string; // APPROVED | PENDING | REJECTED | …
  category: string;
  /** Number of {{n}} placeholders in the BODY component. */
  bodyVariableCount: number;
  bodyText: string;
}

/** Approved (and pending) message templates on the WABA. */
export async function listTemplates(wabaId: string, token: string): Promise<MetaTemplate[]> {
  const data = await graph<{ data?: RawTemplate[] }>(`/${wabaId}/message_templates`, {
    token,
    query: { limit: "200", fields: "name,language,status,category,components" },
  });
  return (data.data || []).map((t) => {
    const body = (t.components || []).find((c) => c.type === "BODY");
    const text = body?.text || "";
    const count = new Set([...text.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => m[1])).size;
    return {
      name: t.name,
      language: t.language,
      status: t.status,
      category: t.category,
      bodyVariableCount: count,
      bodyText: text,
    };
  });
}

interface RawTemplate {
  name: string;
  language: string;
  status: string;
  category: string;
  components?: { type: string; text?: string }[];
}

/** Send a freeform text message (only valid inside the 24h window). */
export async function sendText(
  phoneNumberId: string,
  token: string,
  toDigits: string,
  body: string,
): Promise<{ messageId: string | null }> {
  const data = await graph<{ messages?: { id: string }[] }>(`/${phoneNumberId}/messages`, {
    method: "POST",
    token,
    body: {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: toDigits,
      type: "text",
      text: { preview_url: true, body },
    },
  });
  return { messageId: data.messages?.[0]?.id ?? null };
}

/** Send an approved template. `variables` fill the BODY {{1}},{{2}},… slots. */
export async function sendTemplate(
  phoneNumberId: string,
  token: string,
  toDigits: string,
  name: string,
  language: string,
  variables: string[],
): Promise<{ messageId: string | null }> {
  const components =
    variables.length > 0
      ? [{ type: "body", parameters: variables.map((v) => ({ type: "text", text: v })) }]
      : [];
  const data = await graph<{ messages?: { id: string }[] }>(`/${phoneNumberId}/messages`, {
    method: "POST",
    token,
    body: {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: toDigits,
      type: "template",
      template: { name, language: { code: language }, ...(components.length ? { components } : {}) },
    },
  });
  return { messageId: data.messages?.[0]?.id ?? null };
}

/** Verify Meta's X-Hub-Signature-256 (sha256=<hmac of raw body with app secret>). */
export function verifyMetaSignature(rawBody: Buffer, header: string | undefined): boolean {
  const secret = process.env.META_APP_SECRET;
  if (!secret) return false;
  const sig = (header || "").replace(/^sha256=/, "");
  if (!sig) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
