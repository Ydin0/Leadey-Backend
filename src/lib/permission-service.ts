/**
 * Permission resolver + enforcement helpers. Resolves a user's effective
 * permissions (role defaults ← custom role ← per-user overrides), with a Clerk
 * org:admin escape hatch that always grants everything. Backs both the
 * requirePerm() middleware (boolean-capability writes) and inline query-
 * predicate injection (visibility scopes) throughout the routes.
 */
import { Request, Response, NextFunction } from "express";
import { eq, and, inArray, type SQL, sql } from "drizzle-orm";
import { getAuth } from "@clerk/express";
import { db } from "../db";
import { users } from "../db/schema/organizations";
import { orgRoles } from "../db/schema/org-roles";
import { funnels, funnelMembers } from "../db/schema/funnels";
import { leads } from "../db/schema/leads";
import { ApiError } from "./helpers";
import { getOrgId } from "./auth";
import { createTtlCache } from "./ttl-cache";
import {
  builtinRoleDefaults,
  mergePermissions,
  hasPerm,
  scopeOf,
  BUILTIN_ROLES,
  type ResolvedPermissions,
} from "./permission-catalog";

export interface ResolvedUser {
  permissions: ResolvedPermissions;
  appRole: string;
  isOrgAdmin: boolean;
}

const TTL_MS = 30_000;
const permCache = createTtlCache<ResolvedUser>(TTL_MS);
const visibleFunnelCache = createTtlCache<{ mode: "all" | "none" | "ids"; ids: string[] }>(TTL_MS);

/** Bumped per-org so a custom-role edit/delete invalidates every assignee in
 *  O(1) (cache keys embed the version). */
const orgVersion = new Map<string, number>();
const verOf = (orgId: string) => orgVersion.get(orgId) ?? 0;

export function invalidateOrgPermissions(orgId: string): void {
  orgVersion.set(orgId, verOf(orgId) + 1);
}
export function invalidateUserPermissions(orgId: string, userId: string): void {
  permCache.delete(`${orgId}:v${verOf(orgId)}:${userId}`);
  visibleFunnelCache.delete(`${orgId}:v${verOf(orgId)}:${userId}`);
}

/** Resolve a user's effective permissions. Fail CLOSED (throws) on DB error —
 *  callers should let it 500 rather than silently granting access. */
export async function resolvePermissions(orgId: string, userId: string): Promise<ResolvedUser> {
  const cacheKey = `${orgId}:v${verOf(orgId)}:${userId}`;
  const cached = permCache.get(cacheKey);
  if (cached) return cached;

  const [u] = await db
    .select({ role: users.role, appRole: users.appRole, overrides: users.permissionOverrides })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  const isOrgAdmin = u?.role === "org:admin" || u?.role === "admin";
  let resolved: ResolvedUser;

  if (isOrgAdmin) {
    // Escape hatch: owners always have everything, regardless of appRole.
    resolved = { permissions: BUILTIN_ROLES.admin, appRole: "admin", isOrgAdmin: true };
  } else {
    const appRole = u?.appRole || "member";
    let base: ResolvedPermissions;
    if (appRole.startsWith("role_")) {
      const [custom] = await db
        .select({ permissions: orgRoles.permissions })
        .from(orgRoles)
        .where(and(eq(orgRoles.id, appRole), eq(orgRoles.organizationId, orgId)))
        .limit(1);
      // Merge the custom map over member defaults so new catalog keys are safe;
      // a missing/foreign role falls back to plain member.
      base = custom ? mergePermissions(BUILTIN_ROLES.member, custom.permissions) : BUILTIN_ROLES.member;
    } else {
      base = builtinRoleDefaults(appRole);
    }
    resolved = {
      permissions: mergePermissions(base, u?.overrides ?? null),
      appRole,
      isOrgAdmin: false,
    };
  }

  permCache.set(cacheKey, resolved);
  return resolved;
}

// ── Per-request memo (handlers doing predicate injection resolve once) ──
const REQ_KEY = Symbol("leadey.perms");
export async function getPerms(req: Request): Promise<ResolvedUser> {
  const cached = (req as unknown as Record<symbol, ResolvedUser>)[REQ_KEY];
  if (cached) return cached;
  const orgId = getOrgId(req);
  const userId = getAuth(req)?.userId;
  if (!userId) throw new ApiError(401, "Not authenticated");
  const resolved = await resolvePermissions(orgId, userId);
  (req as unknown as Record<symbol, ResolvedUser>)[REQ_KEY] = resolved;
  return resolved;
}

/** Middleware: require ALL given boolean-capability permissions. */
export function requirePerm(...keys: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    getPerms(req)
      .then((resolved) => {
        const missing = keys.filter((k) => !hasPerm(resolved.permissions, k));
        if (missing.length > 0) {
          next(new ApiError(403, `Missing permission: ${missing.join(", ")}`));
        } else {
          next();
        }
      })
      .catch(next);
  };
}

// ── Campaign-scoped visibility ──

/** The set of campaigns this user may see, honoring campaigns.access:
 *  "all" → every org funnel; "assigned" → public funnels + ones they're a
 *  member of; "none" → nothing. */
export async function getVisibleFunnelIds(
  orgId: string,
  userId: string,
  perms: ResolvedPermissions,
): Promise<{ mode: "all" | "none" | "ids"; ids: string[] }> {
  const access = scopeOf(perms, "campaigns.access");
  if (access === "all") return { mode: "all", ids: [] };
  if (access === "none") return { mode: "none", ids: [] };

  const cacheKey = `${orgId}:v${verOf(orgId)}:${userId}`;
  const cached = visibleFunnelCache.get(cacheKey);
  if (cached) return cached;

  const [orgFunnels, memberships] = await Promise.all([
    db.select({ id: funnels.id, visibility: funnels.visibility }).from(funnels).where(eq(funnels.organizationId, orgId)),
    db.select({ funnelId: funnelMembers.funnelId }).from(funnelMembers).where(eq(funnelMembers.userId, userId)),
  ]);
  const memberSet = new Set(memberships.map((m) => m.funnelId));
  const ids = orgFunnels.filter((f) => f.visibility === "public" || memberSet.has(f.id)).map((f) => f.id);
  const result = { mode: "ids" as const, ids };
  visibleFunnelCache.set(cacheKey, result);
  return result;
}

export function invalidateVisibleFunnels(orgId: string, userId?: string): void {
  if (userId) visibleFunnelCache.delete(`${orgId}:v${verOf(orgId)}:${userId}`);
  else invalidateOrgPermissions(orgId); // visibility change affects everyone
}

/** A WHERE condition scoping the `leads` table to what the user may view, per
 *  leads.view. Returns null = no extra filter (org predicate suffices),
 *  or a SQL predicate. Callers must have `funnels` joined for the "campaigns"
 *  case (uses leads.funnelId). */
export function leadVisibilityCondition(
  perms: ResolvedPermissions,
  visible: { mode: "all" | "none" | "ids"; ids: string[] },
): SQL | null {
  const view = scopeOf(perms, "leads.view");
  if (view === "all") return null;
  if (view === "none") return sql`false`;
  // "campaigns" → only leads in visible funnels.
  if (visible.mode === "all") return null;
  if (visible.mode === "none" || visible.ids.length === 0) return sql`false`;
  return inArray(leads.funnelId, visible.ids);
}
