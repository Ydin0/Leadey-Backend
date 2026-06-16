import { Request, Response, NextFunction } from "express";
import { eq, and } from "drizzle-orm";
import { getAuth } from "@clerk/express";
import { db } from "../db/index";
import { users } from "../db/schema/organizations";
import { funnelMembers } from "../db/schema/funnels";

// Role hierarchy: admin > manager > rep > viewer
const ROLE_HIERARCHY: Record<string, number> = {
  admin: 40,
  "org:admin": 40,
  manager: 30,
  rep: 20,
  "org:member": 20,
  viewer: 10,
};

function roleLevel(role: string): number {
  return ROLE_HIERARCHY[role] || 10;
}

/**
 * Get the user's platform role from the DB.
 * Falls back to "rep" if no role is set.
 */
export async function getUserRole(userId: string): Promise<string> {
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { role: true },
  });
  const role = user?.role || "org:member";
  // Normalize Clerk roles to platform roles
  if (role === "org:admin") return "admin";
  if (role === "org:member") return "rep";
  return role;
}

/**
 * Whether a user can see a campaign given its visibility.
 *
 * - Admins & managers see every campaign in the org.
 * - Otherwise (reps/viewers): a PUBLIC campaign is visible to everyone on the
 *   team; a PRIVATE campaign is visible only to its assigned members.
 *
 * This is what makes the create-campaign Private/Public selector actually do
 * something — private campaigns are hidden from non-members.
 */
export function canViewFunnel(
  role: string,
  visibility: string | null | undefined,
  isMember: boolean,
): boolean {
  if (role === "admin" || role === "manager") return true;
  if ((visibility ?? "private") === "public") return true;
  return isMember;
}

/**
 * Middleware: require the user to have one of the specified platform roles.
 * Usage: requireRole("admin", "manager")
 */
export function requireRole(...allowedRoles: string[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const auth = getAuth(req);
    if (!auth?.userId) {
      res.status(401).json({ error: { message: "Unauthorized", code: "UNAUTHORIZED" } });
      return;
    }

    const role = await getUserRole(auth.userId);
    if (allowedRoles.includes(role)) {
      (req as any)._userRole = role;
      return next();
    }

    res.status(403).json({
      error: { message: "You do not have permission to perform this action", code: "FORBIDDEN" },
    });
  };
}

/**
 * Middleware: check if user has access to a specific funnel.
 * Admin/Manager always have access. Rep/Viewer only if they're a funnel member.
 * Optionally specify required funnel roles (e.g., "owner" for member management).
 */
export function requireFunnelAccess(...requiredFunnelRoles: string[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const auth = getAuth(req);
    if (!auth?.userId) {
      res.status(401).json({ error: { message: "Unauthorized", code: "UNAUTHORIZED" } });
      return;
    }

    const platformRole = await getUserRole(auth.userId);
    (req as any)._userRole = platformRole;

    // Admin always has full access
    if (platformRole === "admin") {
      (req as any)._funnelRole = "owner";
      return next();
    }

    // Manager has access to all funnels but with funnel-level role check
    const funnelId = String(req.params.funnelId || req.params.id || "");
    if (!funnelId) return next();

    const membership = await db.query.funnelMembers.findFirst({
      where: and(
        eq(funnelMembers.funnelId, funnelId),
        eq(funnelMembers.userId, auth.userId),
      ),
    });

    // Manager without explicit membership still gets contributor access
    if (platformRole === "manager" && !membership) {
      (req as any)._funnelRole = "contributor";
      if (requiredFunnelRoles.length === 0 || requiredFunnelRoles.includes("contributor")) {
        return next();
      }
    }

    if (!membership && platformRole !== "manager") {
      res.status(403).json({
        error: { message: "You do not have access to this funnel", code: "FUNNEL_ACCESS_DENIED" },
      });
      return;
    }

    const funnelRole = membership?.role || "viewer";
    (req as any)._funnelRole = funnelRole;

    if (requiredFunnelRoles.length > 0 && !requiredFunnelRoles.includes(funnelRole) && platformRole !== "admin") {
      res.status(403).json({
        error: { message: "You do not have the required role for this action", code: "INSUFFICIENT_FUNNEL_ROLE" },
      });
      return;
    }

    next();
  };
}
