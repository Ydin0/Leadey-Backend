import { Request, Response, NextFunction } from "express";
import { getAuth, clerkClient } from "@clerk/express";
import { eq, and, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../db";
import { users } from "../db/schema/organizations";
import { funnels, funnelMembers } from "../db/schema/funnels";
import { organizationMemberships } from "../db/schema/organization-memberships";
import { leads } from "../db/schema/leads";
import { leadTasks } from "../db/schema/lead-tasks";
import { opportunities } from "../db/schema/opportunities";
import { phoneLines } from "../db/schema/phone-lines";
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
    // Opportunities they owned become unassigned (never leave a ghost owner).
    await db.update(opportunities).set({ ownerId: null, updatedAt: new Date() }).where(and(eq(opportunities.organizationId, orgId), eq(opportunities.ownerId, userId)));
  } catch (e) {
    console.error("[cleanupUserOrgAssignments] failed:", e instanceof Error ? e.message : e);
  }
}

/** Categories of a leaving member's active work that can be reassigned. */
export interface ReassignTargets {
  tasks?: string | null;
  opportunities?: string | null;
  leads?: string | null;
  phoneNumbers?: string | null;
}

const N = sql<number>`count(*)::int`;

/** Counts of a member's *active* work in one org — powers the Remove-User
 *  modal so an admin can see what needs reassigning before removing them. */
export async function getUserOrgWorkSummary(orgId: string, userId: string): Promise<{ tasks: number; opportunities: number; leads: number; phoneNumbers: number }> {
  const orgFunnels = await db.select({ id: funnels.id }).from(funnels).where(eq(funnels.organizationId, orgId));
  const fids = orgFunnels.map((f) => f.id);
  const [[tasks], [opps], [phones]] = await Promise.all([
    db.select({ n: N }).from(leadTasks).where(and(eq(leadTasks.organizationId, orgId), eq(leadTasks.assigneeId, userId), eq(leadTasks.done, false))),
    db.select({ n: N }).from(opportunities).where(and(eq(opportunities.organizationId, orgId), eq(opportunities.ownerId, userId), isNull(opportunities.closedAt))),
    db.select({ n: N }).from(phoneLines).where(and(eq(phoneLines.organizationId, orgId), eq(phoneLines.assignedTo, userId))),
  ]);
  let leadCount = 0;
  if (fids.length) {
    const [l] = await db.select({ n: N }).from(leads).where(and(eq(leads.ownerId, userId), inArray(leads.funnelId, fids)));
    leadCount = l?.n ?? 0;
  }
  return { tasks: tasks?.n ?? 0, opportunities: opps?.n ?? 0, leads: leadCount, phoneNumbers: phones?.n ?? 0 };
}

/** Move a leaving member's active work to teammates BEFORE removal. Only the
 *  categories given a (non-empty, non-self) target are moved; the rest are left
 *  for cleanupUserOrgAssignments to detach. Best-effort — never throws. */
export async function reassignUserOrgWork(orgId: string, fromUserId: string, targets: ReassignTargets): Promise<void> {
  try {
    const now = new Date();
    const valid = (t?: string | null): t is string => !!t && t !== fromUserId;
    if (valid(targets.tasks)) {
      await db.update(leadTasks).set({ assigneeId: targets.tasks, updatedAt: now })
        .where(and(eq(leadTasks.organizationId, orgId), eq(leadTasks.assigneeId, fromUserId), eq(leadTasks.done, false)));
    }
    if (valid(targets.opportunities)) {
      await db.update(opportunities).set({ ownerId: targets.opportunities, updatedAt: now })
        .where(and(eq(opportunities.organizationId, orgId), eq(opportunities.ownerId, fromUserId), isNull(opportunities.closedAt)));
    }
    if (valid(targets.leads)) {
      const orgFunnels = await db.select({ id: funnels.id }).from(funnels).where(eq(funnels.organizationId, orgId));
      const fids = orgFunnels.map((f) => f.id);
      if (fids.length) {
        await db.update(leads).set({ ownerId: targets.leads, updatedAt: now })
          .where(and(eq(leads.ownerId, fromUserId), inArray(leads.funnelId, fids)));
      }
    }
    if (valid(targets.phoneNumbers)) {
      const [t] = await db.select({ firstName: users.firstName, lastName: users.lastName, email: users.email }).from(users).where(eq(users.id, targets.phoneNumbers));
      const name = t ? ([t.firstName, t.lastName].filter(Boolean).join(" ") || t.email || null) : null;
      await db.update(phoneLines).set({ assignedTo: targets.phoneNumbers, assignedToName: name, updatedAt: now })
        .where(and(eq(phoneLines.organizationId, orgId), eq(phoneLines.assignedTo, fromUserId)));
    }
  } catch (e) {
    console.error("[reassignUserOrgWork] failed:", e instanceof Error ? e.message : e);
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

/** Whether a user already belongs to ANY organization other than `excludeOrgId`,
 *  per Clerk (the source of truth). Used at org-creation time to decide if the
 *  creator is an existing member (→ must pay, no free trial) vs a first-time
 *  signup. Fetches fresh (not the TTL cache) so the decision is authoritative;
 *  callers should treat a thrown error as "allow trial" (fail-open). */
export async function userBelongsToAnyOtherOrg(userId: string, excludeOrgId: string): Promise<boolean> {
  if (!userId) return false;
  const list = await clerkClient.users.getOrganizationMembershipList({ userId, limit: 100 });
  return list.data.some((m) => m.organization.id !== excludeOrgId);
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
