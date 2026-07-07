import { Request, Response, NextFunction } from "express";
import { getAuth, clerkClient } from "@clerk/express";
import { eq, and, inArray } from "drizzle-orm";
import { db } from "../db";
import { users } from "../db/schema/organizations";
import { funnels, funnelMembers } from "../db/schema/funnels";
import { organizationMemberships } from "../db/schema/organization-memberships";
import { leads } from "../db/schema/leads";
import { leadTasks } from "../db/schema/lead-tasks";
import { ApiError, createId } from "./helpers";

/**
 * Detach a removed member from everything they were assigned to WITHIN one org,
 * so they stop appearing (as "Unknown") on campaigns, leads and tasks. Scoped
 * to the org's funnels, so a user who is still a member of OTHER orgs keeps
 * their assignments there. Best-effort — never throws to the caller.
 */
export async function cleanupUserOrgAssignments(orgId: string, userId: string): Promise<void> {
  try {
    const orgFunnels = await db.select({ id: funnels.id }).from(funnels).where(eq(funnels.organizationId, orgId));
    const fids = orgFunnels.map((f) => f.id);
    if (fids.length) {
      // Campaign assignment (the "Assigned reps" avatars + filter).
      await db.delete(funnelMembers).where(and(eq(funnelMembers.userId, userId), inArray(funnelMembers.funnelId, fids)));
      // Lead ownership.
      await db.update(leads).set({ ownerId: null, updatedAt: new Date() }).where(and(eq(leads.ownerId, userId), inArray(leads.funnelId, fids)));
    }
    // Open tasks assigned to them become unassigned.
    await db.update(leadTasks).set({ assigneeId: null, updatedAt: new Date() }).where(and(eq(leadTasks.assigneeId, userId), eq(leadTasks.organizationId, orgId)));
  } catch (e) {
    console.error("[cleanupUserOrgAssignments] failed:", e instanceof Error ? e.message : e);
  }
}

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

/**
 * Re-point a user's (single-row) `users` record to an org they STILL belong to
 * in Clerk after a membership change. CRITICAL safety: removing a user from one
 * org must never blank their record while they remain in OTHER orgs — doing so
 * made them vanish platform-wide (off every team list, role-less). We keep the
 * row pointing at a still-valid org (preferring the one it already references),
 * and only clear it when the user has no memberships left. Clerk is the source
 * of truth; this just keeps our cache coherent. Best-effort — never throws.
 */
export async function syncUserPrimaryOrg(userId: string): Promise<void> {
  invalidateOrgMembership(userId);
  let memberships: { organization: { id: string }; role: string }[];
  try {
    const res = await clerkClient.users.getOrganizationMembershipList({ userId, limit: 100 });
    memberships = res.data.map((m) => ({ organization: { id: m.organization.id }, role: m.role }));
  } catch {
    return; // don't risk clobbering the record on a transient Clerk error
  }
  try {
    if (memberships.length === 0) {
      await db
        .update(users)
        .set({ organizationId: null, role: null, updatedAt: new Date() })
        .where(eq(users.id, userId));
      return;
    }
    const current = await db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { organizationId: true },
    });
    const keep =
      memberships.find((m) => m.organization.id === current?.organizationId) ?? memberships[0];
    await db
      .update(users)
      .set({ organizationId: keep.organization.id, role: keep.role, updatedAt: new Date() })
      .where(eq(users.id, userId));
  } catch (err) {
    console.error("[syncUserPrimaryOrg] failed:", err instanceof Error ? err.message : err);
  }
}

/** Drop a user's cached membership set so a change takes effect immediately
 *  (called when we add/remove a member, or on a Clerk membership webhook). */
export function invalidateOrgMembership(userId: string): void {
  cache.delete(userId);
}

// ── organization_memberships (per-org role/appRole/overrides) ──────────────
// The join table that replaces the single-org users.role/appRole/overrides.
// Clerk is still the source of truth for WHICH orgs a user is in (isOrgMember /
// requireOrgMembership above); these rows hold the per-org RBAC data.

export interface OrgMembership {
  role: string;
  appRole: string | null;
  permissionOverrides: Record<string, boolean | string> | null;
}

/** The user's role data for one org, or null if no membership row yet. */
export async function getMembership(userId: string, orgId: string): Promise<OrgMembership | null> {
  const [m] = await db
    .select({
      role: organizationMemberships.role,
      appRole: organizationMemberships.appRole,
      permissionOverrides: organizationMemberships.permissionOverrides,
    })
    .from(organizationMemberships)
    .where(and(eq(organizationMemberships.userId, userId), eq(organizationMemberships.organizationId, orgId)))
    .limit(1);
  return m ?? null;
}

/** Upsert a user's membership row for an org (dual-write from webhooks / team /
 *  admin). Only the provided fields are updated on conflict. */
export async function upsertMembership(
  orgId: string,
  userId: string,
  data: Partial<OrgMembership>,
): Promise<void> {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (data.role !== undefined) set.role = data.role;
  if (data.appRole !== undefined) set.appRole = data.appRole;
  if (data.permissionOverrides !== undefined) set.permissionOverrides = data.permissionOverrides;
  await db
    .insert(organizationMemberships)
    .values({
      id: createId("mem"),
      organizationId: orgId,
      userId,
      role: data.role ?? "org:member",
      appRole: data.appRole ?? "member",
      permissionOverrides: data.permissionOverrides ?? null,
    })
    .onConflictDoUpdate({
      target: [organizationMemberships.organizationId, organizationMemberships.userId],
      set,
    });
}

export async function deleteMembership(orgId: string, userId: string): Promise<void> {
  await db
    .delete(organizationMemberships)
    .where(and(eq(organizationMemberships.organizationId, orgId), eq(organizationMemberships.userId, userId)));
}

/** Remove all of a user's memberships (on user.deleted — no userId FK cascades). */
export async function deleteAllMembershipsForUser(userId: string): Promise<void> {
  await db.delete(organizationMemberships).where(eq(organizationMemberships.userId, userId));
}

async function fetchMemberOrgIds(userId: string): Promise<Set<string>> {
  const list = await clerkClient.users.getOrganizationMembershipList({ userId, limit: 100 });
  const orgs = new Set(list.data.map((m) => m.organization.id));
  cache.set(userId, { orgs, exp: Date.now() + TTL_MS });
  return orgs;
}

/** Whether a user is a member of an org per Clerk (the source of truth),
 *  cached. Use this instead of the local `users.organizationId` column when
 *  checking membership: that column is single-org, so a user who belongs to
 *  several Clerk orgs (or whose row hasn't synced) can falsely look like a
 *  non-member of an org they're genuinely in. Fails closed on a hard error. */
export async function isOrgMember(userId: string, orgId: string): Promise<boolean> {
  if (!userId || !orgId) return false;
  const hit = cache.get(userId);
  if (hit && hit.exp > Date.now()) return hit.orgs.has(orgId);
  try {
    return (await fetchMemberOrgIds(userId)).has(orgId);
  } catch {
    return false;
  }
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
