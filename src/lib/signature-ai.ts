import OpenAI from "openai";

const MODEL = "gpt-4o-mini";

/** The Leadey sender tokens the AI is allowed to insert. Custom link fields use
 *  the {{sender_<key>}} convention. */
const SYSTEM = `You are a tool that tokenizes an email signature so ONE template can serve a whole team: each rep's own details fill in at send time.

You are given the raw HTML (or plain text) of an email signature that currently contains ONE person's hardcoded details. Replace the hardcoded PERSONAL details with Leadey merge tokens, and return the signature otherwise byte-for-byte identical.

Tokens to use (only where the corresponding detail actually appears):
- {{sender_full_name}}  → the person's full name
- {{sender_title}}      → their job title / role
- {{sender_company}}    → the company name (NOT inside the logo image or a brand wordmark — only where it's the person's employer text)
- {{sender_email}}      → their email address (also inside a mailto: href → mailto:{{sender_email}})
- {{sender_phone}}      → their phone/mobile number (also inside a tel: href → tel:{{sender_phone}})
- For a PERSONAL link that clearly varies per rep (e.g. a personal booking/calendar link, a personal LinkedIn profile URL), use a custom token: a booking/scheduling link → {{sender_booking_link}}; a LinkedIn profile → {{sender_linkedin}}. Only do this when the URL is clearly individual, not a shared company page.

STRICT RULES:
- Preserve ALL html tags, attributes, inline styles, classes, table structure, whitespace and URLs EXACTLY. Do not reformat, minify, re-indent, or "improve" anything.
- Do NOT touch the company logo image URL/src, brand imagery, social icon images, or shared company website/social URLs — leave them exactly as-is.
- Only replace the literal personal text/hrefs listed above. If a detail does not appear, do not invent a token for it.
- If a name appears split across first/last in separate elements, you may use {{sender_first_name}} and {{sender_last_name}} for those specific spots.
- Return ONLY the resulting signature markup. No explanation, no code fences, no commentary.`;

/** Analyze a pasted signature and return it with Leadey {{sender_*}} tokens
 *  inserted in place of the hardcoded personal details. Returns null when the
 *  LLM is unavailable so the caller can surface a clear error. */
export async function tokenizeSignature(html: string): Promise<string | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const input = (html || "").trim();
  if (!input) return "";

  const client = new OpenAI({ apiKey });
  const completion = await client.chat.completions.create({
    model: MODEL,
    temperature: 0,
    max_tokens: 4000,
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: input },
    ],
  });
  let out = completion.choices[0]?.message?.content ?? "";
  // Strip an accidental ```html … ``` fence if the model added one.
  out = out.trim().replace(/^```[a-zA-Z]*\n?/, "").replace(/\n?```$/, "").trim();
  return out || input;
}
