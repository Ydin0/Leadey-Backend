import { Request, Response, NextFunction } from "express";
import { getAuth, clerkClient } from "@clerk/express";
import { ApiError } from "./helpers";

/**
 * Authoritative per-request check that the caller is STILL a member of the org
 * named in their verified token. The backend otherwise scopes purely off the
 * token's `org_id` claim — but a token (or the client's cached session) can
 * outlive a revoked membership, so an admin removing someone wouldn't take
 * effect until the token expired. Clerk is the source of truth for multi-org
 * membership (our `users` table only stores a single org per user), so we check
 * against Clerk and cache the result briefly to avoid an API call per request.
 */

const TTL_MS = 30_000;
const cache = new Map<string, { orgs: Set<string>; exp: number }>();

/** Drop a user's cached membership set so a change takes effect immediately
 *  (called when we add/remove a member, or on a Clerk membership webhook). */
export function invalidateOrgMembership(userId: string): void {
  cache.delete(userId);
}

async function fetchMemberOrgIds(userId: string): Promise<Set<string>> {
  const list = await clerkClient.users.getOrganizationMembershipList({ userId, limit: 100 });
  const orgs = new Set(list.data.map((m) => m.organization.id));
  cache.set(userId, { orgs, exp: Date.now() + TTL_MS });
  return orgs;
}

export async function requireOrgMembership(req: Request, _res: Response, next: NextFunction) {
  const auth = getAuth(req);
  const userId = auth?.userId;
  const orgId = auth?.orgId;
  // No active org in the token — org-scoped routes will reject via getOrgId();
  // routes that don't need an org (e.g. /team/me) stay reachable.
  if (!userId || !orgId) return next();
  try {
    const now = Date.now();
    const hit = cache.get(userId);
    // Fast path: a fresh cache that already lists this org → member, allow.
    if (hit && hit.exp > now && hit.orgs.has(orgId)) return next();
    // Otherwise confirm against Clerk directly (covers a removed member AND a
    // just-created/joined org the cache predates) before deciding.
    const orgs = await fetchMemberOrgIds(userId);
    if (!orgs.has(orgId)) {
      return next(new ApiError(403, "You are no longer a member of this organization"));
    }
    return next();
  } catch {
    // Fail OPEN on a transient Clerk error so an outage can't lock everyone out
    // (no worse than the previous token-only behaviour); the cache keeps calls low.
    return next();
  }
}
