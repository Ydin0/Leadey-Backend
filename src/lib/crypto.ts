import crypto from "crypto";

/**
 * Symmetric encryption for email-account secrets (OAuth refresh tokens, SMTP
 * passwords) stored at rest. AES-256-GCM with a key derived from
 * EMAIL_ENCRYPTION_KEY. The env value can be any string — we SHA-256 it to a
 * 32-byte key — but in production set a long random secret.
 */
const KEY = crypto
  .createHash("sha256")
  .update(process.env.EMAIL_ENCRYPTION_KEY || "leadey-dev-insecure-key-change-me")
  .digest();

export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // [iv(12) | tag(16) | ciphertext] base64
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

export function decryptSecret(payload: string): string {
  const buf = Buffer.from(payload, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

const STATE_SECRET =
  process.env.EMAIL_OAUTH_STATE_SECRET ||
  process.env.CLERK_SECRET_KEY ||
  "leadey-oauth-state-secret";

/** HMAC-signed, expiring `state` for OAuth round-trips (CSRF protection). */
export function signState(obj: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(obj)).toString("base64url");
  const sig = crypto.createHmac("sha256", STATE_SECRET).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifyState<T = Record<string, unknown>>(state: string): T | null {
  const [payload, sig] = (state || "").split(".");
  if (!payload || !sig) return null;
  const expected = crypto.createHmac("sha256", STATE_SECRET).update(payload).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const obj = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: number };
    if (obj.exp && Date.now() > obj.exp) return null;
    return obj as T;
  } catch {
    return null;
  }
}
