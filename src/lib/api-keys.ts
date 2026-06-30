import crypto from "crypto";

/** Static prefix on every live key. The secret body follows it. */
export const API_KEY_PREFIX = "leadey_sk_live_";

export interface GeneratedApiKey {
  /** The full plaintext key — shown to the user exactly once, never stored. */
  fullKey: string;
  /** SHA-256 hex of the full key — the only representation stored at rest. */
  keyHash: string;
  /** Static prefix, persisted for the masked display label. */
  keyPrefix: string;
  /** Last 4 chars of the full key, persisted for the masked display label. */
  last4: string;
}

/** Mint a new, cryptographically-random API key.
 *  Uses crypto.randomBytes (NOT createId, which is Math.random-based). */
export function generateApiKey(): GeneratedApiKey {
  const body = crypto.randomBytes(32).toString("base64url"); // ~43 url-safe chars
  const fullKey = `${API_KEY_PREFIX}${body}`;
  return {
    fullKey,
    keyHash: hashApiKey(fullKey),
    keyPrefix: API_KEY_PREFIX,
    last4: fullKey.slice(-4),
  };
}

/** SHA-256 hex of a full key. API keys are high-entropy random tokens, so a
 *  fast hash (not bcrypt) is the correct, standard choice and keeps verification
 *  a single indexed lookup. */
export function hashApiKey(fullKey: string): string {
  return crypto.createHash("sha256").update(fullKey).digest("hex");
}

/** Masked label for the dashboard list, e.g. `leadey_sk_live_••••a1b2`. */
export function maskKey(keyPrefix: string, last4: string): string {
  return `${keyPrefix}••••${last4}`;
}
