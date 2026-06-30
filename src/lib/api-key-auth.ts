import { Request, Response, NextFunction } from "express";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/index";
import { apiKeys } from "../db/schema/api-keys";
import { ApiError } from "./helpers";
import { API_KEY_PREFIX, hashApiKey } from "./api-keys";

export interface ApiAuth {
  orgId: string;
  keyId: string;
}

// ─── Per-key rate limit (in-memory token bucket) ──────────────────────────────
// Lightweight protection for the public API. Resets every window. Single-process
// only — fine for the current deploy; swap for Redis if the API scales out.
const RATE_LIMIT = 120; // requests per window per key
const WINDOW_MS = 60_000;
const buckets = new Map<string, { count: number; resetAt: number }>();

// `lastUsedAt` is written at most once per key per minute to avoid a write on
// every request.
const LAST_USED_THROTTLE_MS = 60_000;
const lastUsedWrites = new Map<string, number>();

/** Org id for the key that authenticated this request (parallels lib/auth#getOrgId). */
export function getApiOrgId(req: Request): string {
  const auth = (req as unknown as { apiAuth?: ApiAuth }).apiAuth;
  if (!auth?.orgId) throw new ApiError(401, "API key authentication required");
  return auth.orgId;
}

/**
 * Authenticates a public `/v1` request via `Authorization: Bearer <api_key>`.
 * Resolves the key to its organization, enforces a per-key rate limit, and
 * attaches `req.apiAuth = { orgId, keyId }`. Does NOT touch Clerk.
 */
export async function requireApiKeyAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      throw new ApiError(401, "Missing API key. Provide it as 'Authorization: Bearer <key>'.");
    }
    const presented = header.slice(7).trim();
    if (!presented.startsWith(API_KEY_PREFIX)) {
      throw new ApiError(401, "Invalid API key.");
    }

    const keyHash = hashApiKey(presented);
    const [row] = await db
      .select({ id: apiKeys.id, organizationId: apiKeys.organizationId })
      .from(apiKeys)
      .where(and(eq(apiKeys.keyHash, keyHash), isNull(apiKeys.revokedAt)))
      .limit(1);
    if (!row) throw new ApiError(401, "Invalid or revoked API key.");

    // Rate limit.
    const now = Date.now();
    const bucket = buckets.get(row.id);
    if (!bucket || bucket.resetAt <= now) {
      buckets.set(row.id, { count: 1, resetAt: now + WINDOW_MS });
    } else {
      bucket.count += 1;
      if (bucket.count > RATE_LIMIT) {
        const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
        res.setHeader("Retry-After", String(retryAfter));
        throw new ApiError(429, `Rate limit exceeded. Retry in ${retryAfter}s.`);
      }
    }

    (req as unknown as { apiAuth: ApiAuth }).apiAuth = {
      orgId: row.organizationId,
      keyId: row.id,
    };

    // Throttled, fire-and-forget last-used stamp.
    const lastWrite = lastUsedWrites.get(row.id) ?? 0;
    if (now - lastWrite > LAST_USED_THROTTLE_MS) {
      lastUsedWrites.set(row.id, now);
      db.update(apiKeys)
        .set({ lastUsedAt: new Date() })
        .where(eq(apiKeys.id, row.id))
        .catch(() => {
          /* best-effort */
        });
    }

    next();
  } catch (err) {
    next(err);
  }
}
