import { Router, Request, Response, NextFunction } from "express";
import { eq, and, count, gte, sql, inArray } from "drizzle-orm";
import { clerkClient } from "@clerk/express";
import { db } from "../db/index";
import { organizations, users } from "../db/schema/organizations";
import { callRecords } from "../db/schema/call-records";
import { opportunities } from "../db/schema/opportunities";
import { getOrgId } from "../lib/auth";
import { ApiError, createId } from "../lib/helpers";
import { getAuth } from "@clerk/express";
import { getPlanConfig } from "../lib/stripe";
import { getSetting, upsertSetting } from "../lib/settings-service";
import { inviteEmailToOrganization, ensureOrgMembershipCap } from "../lib/invitations";
import { syncUserPrimaryOrg, cleanupUserOrgAssignments } from "../lib/org-membership";
import { orgRoles } from "../db/schema/org-roles";
import {
  resolvePermissions,
  requirePerm,
  invalidateUserPermissions,
  invalidateOrgPermissions,
} from "../lib/permission-service";
import {
  ALL_PERM_KEYS,
  isValidPermValue,
  BUILTIN_ROLE_KEYS,
  BUILTIN_ROLE_LABELS,
  BUILTIN_ROLES,
  type PermissionMap,
} from "../lib/permission-catalog";

const KPI_CONFIG_KEY = "team_kpi_config";
const DEPARTMENTS_KEY = "team_departments";

// Seeded for orgs that haven't customised yet — mirrors the legacy "pods" so
// existing member assignments keep resolving.
const DEFAULT_DEPARTMENTS = [
  { name: "Enterprise", color: "#97A4D6" },
  { name: "Mid-Market", color: "#86EFAC" },
  { name: "SMB", color: "#6E7BCB" },
];
const DEPARTMENT_COLORS = [
  "#97A4D6", "#86EFAC", "#6E7BCB", "#E0A878", "#C58FD6", "#5FB6C9", "#E08FA8", "#6FBEA8",
];

interface Department {
  name: string;
  color: string;
}

async function loadDepartments(orgId: string): Promise<Department[]> {
  const raw = await getSetting(orgId, DEPARTMENTS_KEY);
  if (!raw) return DEFAULT_DEPARTMENTS;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_DEPARTMENTS;
    const cleaned = parsed
      .map((d, i) => ({
        name: typeof d?.name === "string" ? d.name.trim() : "",
        color: typeof d?.color === "string" && /^#[0-9a-fA-F]{6}$/.test(d.color)
          ? d.color
          : DEPARTMENT_COLORS[i % DEPARTMENT_COLORS.length],
      }))
      .filter((d) => d.name.length > 0);
    return cleaned;
  } catch {
    return DEFAULT_DEPARTMENTS;
  }
}

async function loadKpiConfig(orgId: string): Promise<Record<string, unknown>> {
  const raw = await getSetting(orgId, KPI_CONFIG_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

const router = Router();

type AsyncHandler<P = Record<string, string>> = (
  req: Request<P>,
  res: Response,
  next: NextFunction,
) => Promise<void>;

function asyncHandler<P = Record<string, string>>(handler: AsyncHandler<P>) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req as Request<P>, res, next)).catch(next);
  };
}

// ─── GET /team/me ───────────────────────────────────────────────────
// Get current user's role
router.get(
  "/team/me",
  asyncHandler(async (req, res) => {
    const auth = getAuth(req);
    if (!auth?.userId) {
      res.json({ data: { role: "rep" } });
      return;
    }

    const user = await db.query.users.findFirst({
      where: eq(users.id, auth.userId),
      columns: { role: true },
    });

    let role = user?.role || "org:member";
    // Normalize (kept for older clients that still read `role`).
    if (role === "org:admin") role = "admin";
    else if (role === "org:member") role = "rep";

    // Resolved granular permissions for the new client. Fail-closed: on error
    // the frontend hook synthesizes a locked-down map, never admin.
    let permissions = null;
    let appRole = "member";
    let isOrgAdmin = false;
    try {
      const orgId = getOrgId(req);
      const resolved = await resolvePermissions(orgId, auth.userId);
      permissions = resolved.permissions;
      appRole = resolved.appRole;
      isOrgAdmin = resolved.isOrgAdmin;
    } catch (err) {
      console.warn("[team/me] permission resolve failed:", err instanceof Error ? err.message : err);
    }

    res.json({ data: { role, appRole, isOrgAdmin, permissions } });
  }),
);

// ─── GET /team ──────────────────────────────────────────────────────
// List team members + seat usage
router.get(
  "/team",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);

    const [org] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, orgId));
    if (!org) throw new ApiError(404, "Organization not found");

    // Source the roster from CLERK — the source of truth for org membership.
    // Our single-row `users` table only stores one org per user, so a multi-org
    // member would otherwise be missing from every org's list but one. We pull
    // this org's real memberships from Clerk and enrich with locally-stored
    // fields; roles are per-org (from the Clerk membership). DB fallback on a
    // transient Clerk error.
    type Member = {
      id: string; email: string; firstName: string | null; lastName: string | null;
      imageUrl: string | null; role: string; createdAt: string;
      appRole: string; hasOverrides: boolean;
    };
    // The member's effective app-role: org:admin is always "admin"; otherwise
    // the stored app_role (default member).
    const effectiveAppRole = (clerkRole: string, row?: typeof users.$inferSelect) =>
      clerkRole === "org:admin" ? "admin" : row?.appRole || "member";
    const hasOverrides = (row?: typeof users.$inferSelect) =>
      !!row?.permissionOverrides && Object.keys(row.permissionOverrides).length > 0;
    let members: Member[];
    try {
      const list = await clerkClient.organizations.getOrganizationMembershipList({
        organizationId: orgId,
        limit: 100,
      });
      const ids = list.data.map((m) => m.publicUserData?.userId).filter(Boolean) as string[];
      const rows = ids.length ? await db.select().from(users).where(inArray(users.id, ids)) : [];
      const byId = new Map(rows.map((r) => [r.id, r]));
      members = list.data.map((m) => {
        const pud = m.publicUserData;
        const row = pud?.userId ? byId.get(pud.userId) : undefined;
        const clerkRole = m.role || "org:member";
        return {
          id: pud?.userId || m.id,
          email: pud?.identifier || row?.email || "",
          firstName: pud?.firstName ?? row?.firstName ?? null,
          lastName: pud?.lastName ?? row?.lastName ?? null,
          imageUrl: pud?.imageUrl ?? row?.imageUrl ?? null,
          role: clerkRole,
          appRole: effectiveAppRole(clerkRole, row),
          hasOverrides: hasOverrides(row),
          createdAt: new Date(m.createdAt).toISOString(),
        };
      });
    } catch {
      const rows = await db.select().from(users).where(eq(users.organizationId, orgId));
      members = rows.map((m) => ({
        id: m.id,
        email: m.email,
        firstName: m.firstName,
        lastName: m.lastName,
        imageUrl: m.imageUrl,
        role: m.role || "org:member",
        appRole: effectiveAppRole(m.role || "org:member", m),
        hasOverrides: hasOverrides(m),
        createdAt: m.createdAt.toISOString(),
      }));
    }

    const config = getPlanConfig(org.plan);

    res.json({
      data: {
        members,
        seatUsage: {
          used: members.length,
          included: org.seatsIncluded || config.seats,
        },
      },
    });
  }),
);

// ─── GET /team/kpi-config ───────────────────────────────────────────
// Per-member sales role / pod / daily KPI targets, keyed by lowercased email
// so config survives the invite → accept transition. Stored in org settings.
router.get(
  "/team/kpi-config",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    res.json({ data: await loadKpiConfig(orgId) });
  }),
);

// ─── PUT /team/kpi-config ───────────────────────────────────────────
// Upsert one member's KPI config entry.
router.put(
  "/team/kpi-config",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const { key, role, pod, targets } = req.body || {};
    if (!key || typeof key !== "string") throw new ApiError(400, "key is required");

    const config = await loadKpiConfig(orgId);
    const k = key.toLowerCase();
    const prev = (config[k] as Record<string, unknown>) || {};
    config[k] = {
      ...prev,
      ...(role !== undefined ? { role } : {}),
      ...(pod !== undefined ? { pod } : {}),
      ...(targets !== undefined ? { targets } : {}),
    };
    await upsertSetting(orgId, KPI_CONFIG_KEY, JSON.stringify(config));
    res.json({ data: config });
  }),
);

// ─── GET /team/departments ──────────────────────────────────────────
// The org's departments (formerly "pods"). Seeded with defaults if unset.
router.get(
  "/team/departments",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    res.json({ data: await loadDepartments(orgId) });
  }),
);

// ─── PUT /team/departments ──────────────────────────────────────────
// Replace the org's department list. Body: { departments: [{name,color}] }.
// Renaming a department here does NOT rewrite member assignments — callers
// should update affected members' department too if they rename one.
router.put(
  "/team/departments",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const input = Array.isArray(req.body?.departments) ? req.body.departments : [];
    const seen = new Set<string>();
    const cleaned: Department[] = [];
    for (let i = 0; i < input.length; i++) {
      const d = input[i];
      const name = typeof d?.name === "string" ? d.name.trim() : "";
      if (!name) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue; // no duplicate names
      seen.add(key);
      cleaned.push({
        name,
        color: typeof d?.color === "string" && /^#[0-9a-fA-F]{6}$/.test(d.color)
          ? d.color
          : DEPARTMENT_COLORS[i % DEPARTMENT_COLORS.length],
      });
    }
    await upsertSetting(orgId, DEPARTMENTS_KEY, JSON.stringify(cleaned));
    res.json({ data: cleaned });
  }),
);

// ─── POST /team/invite ──────────────────────────────────────────────
// Invite a new member via Clerk
router.post(
  "/team/invite",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const { email, role, firstName, lastName } = req.body;

    if (!email) throw new ApiError(400, "email is required");
    const inviteRole = role === "org:admin" ? "org:admin" : "org:member";

    // Check seat limit
    const [org] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, orgId));
    if (!org) throw new ApiError(404, "Organization not found");

    const [{ memberCount }] = await db
      .select({ memberCount: count() })
      .from(users)
      .where(eq(users.organizationId, orgId));

    const config = getPlanConfig(org.plan);
    const seatLimit = org.seatsIncluded || config.seats;

    if (Number(memberCount) >= seatLimit) {
      throw new ApiError(403, `Seat limit reached (${seatLimit}). Upgrade your plan to add more team members.`);
    }

    // Look up the inviter's display name (for the email).
    const auth = getAuth(req);
    let invitedBy: string | undefined;
    if (auth?.userId) {
      const [inviter] = await db
        .select({ firstName: users.firstName, lastName: users.lastName, email: users.email })
        .from(users)
        .where(eq(users.id, auth.userId));
      if (inviter) {
        invitedBy =
          [inviter.firstName, inviter.lastName].filter(Boolean).join(" ").trim() ||
          inviter.email ||
          undefined;
      }
    }

    // Keep Clerk's org membership cap in sync with our seat allowance before
    // adding the membership. Clerk enforces its own `max_allowed_memberships`
    // (low default) and rejects invites with "organization membership quota
    // exceeded" even when we have seats free. ensureOrgMembershipCap raises it
    // via the REST API and logs on failure (rather than silently swallowing).
    await ensureOrgMembershipCap(orgId, seatLimit);

    try {
      // Create the Clerk user (with name) + org membership directly, then email
      // a magic-link sign-in. This reliably attaches them to the org (no
      // accept-flow race) and lets us pre-fill their name.
      const result = await inviteEmailToOrganization({
        email: String(email).trim(),
        firstName: firstName ? String(firstName).trim() : undefined,
        lastName: lastName ? String(lastName).trim() : undefined,
        organizationId: orgId,
        organizationName: org.name,
        role: inviteRole,
        invitedBy,
        template: "member",
      });

      res.status(201).json({
        data: {
          id: result.userId,
          emailAddress: String(email).trim(),
          role: inviteRole,
          status: "active",
          createdAt: new Date().toISOString(),
        },
      });
    } catch (err: any) {
      if (err instanceof ApiError) throw err;
      if (err?.errors?.[0]?.message) {
        throw new ApiError(400, err.errors[0].message);
      }
      throw new ApiError(500, "Failed to send invitation");
    }
  }),
);

// ─── GET /team/invitations ──────────────────────────────────────────
// List pending invitations
router.get(
  "/team/invitations",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);

    try {
      const invitations = await clerkClient.organizations.getOrganizationInvitationList({
        organizationId: orgId,
      });

      const pending = (invitations.data || [])
        .filter((inv: any) => inv.status === "pending")
        .map((inv: any) => ({
          id: inv.id,
          emailAddress: inv.emailAddress,
          role: inv.role,
          status: inv.status,
          createdAt: inv.createdAt ? new Date(inv.createdAt).toISOString() : new Date().toISOString(),
        }));

      res.json({ data: pending });
    } catch {
      res.json({ data: [] });
    }
  }),
);

// ─── DELETE /team/invitations/:invitationId ─────────────────────────
// Revoke a pending invitation
router.delete(
  "/team/invitations/:invitationId",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const invitationId = req.params.invitationId;

    try {
      await clerkClient.organizations.revokeOrganizationInvitation({
        organizationId: orgId,
        invitationId,
        requestingUserId: getAuth(req)?.userId || "",
      });
      res.json({ data: { id: invitationId, revoked: true } });
    } catch (err: any) {
      throw new ApiError(400, err?.errors?.[0]?.message || "Failed to revoke invitation");
    }
  }),
);

// ─── PATCH /team/:userId/role ───────────────────────────────────────
// Change a member's Clerk org role (admin vs member). Gated on manageTeam;
// validates the role value; refuses to demote the last org:admin; only an
// org:admin may change another org:admin. Keeps app_role in sync.
router.patch(
  "/team/:userId/role",
  requirePerm("settings.manageTeam"),
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const userId = req.params.userId;
    const { role } = req.body;

    if (role !== "org:admin" && role !== "org:member") {
      throw new ApiError(400, "role must be 'org:admin' or 'org:member'");
    }

    try {
      const memberships = await clerkClient.organizations.getOrganizationMembershipList({
        organizationId: orgId,
      });
      const membership = (memberships.data || []).find(
        (m: any) => m.publicUserData?.userId === userId,
      );
      if (!membership) throw new ApiError(404, "Member not found");

      const targetIsAdmin = membership.role === "org:admin";
      const admins = (memberships.data || []).filter((m: any) => m.role === "org:admin");

      // Only an org:admin may change another org:admin's role.
      const caller = await resolvePermissions(orgId, getAuth(req)?.userId || "");
      if (targetIsAdmin && !caller.isOrgAdmin) {
        throw new ApiError(403, "Only an admin can change another admin's role");
      }
      // Never demote the last admin.
      if (targetIsAdmin && role === "org:member" && admins.length <= 1) {
        throw new ApiError(400, "Can't remove the last admin — promote someone else first");
      }

      await clerkClient.organizations.updateOrganizationMembership({
        organizationId: orgId,
        userId,
        role,
      });

      // Mirror to DB. Promoting to admin sets app_role "admin"; demoting resets
      // to "member" so the granular role actually applies from now on.
      await db
        .update(users)
        .set({ role, appRole: role === "org:admin" ? "admin" : "member", updatedAt: new Date() })
        .where(eq(users.id, userId));
      invalidateUserPermissions(orgId, userId);

      res.json({ data: { id: userId, role } });
    } catch (err: any) {
      if (err instanceof ApiError) throw err;
      throw new ApiError(400, err?.errors?.[0]?.message || "Failed to update role");
    }
  }),
);

// ─── PATCH /team/:userId/permissions ────────────────────────────────
// Set a member's granular app-role and/or sparse permission overrides.
// Body: { appRole?: string, overrides?: Record<string, boolean|string>|null }.
router.patch(
  "/team/:userId/permissions",
  requirePerm("settings.manageTeam"),
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const userId = req.params.userId;
    const { appRole, overrides } = req.body || {};
    const caller = await resolvePermissions(orgId, getAuth(req)?.userId || "");

    // Member must belong to this org.
    const [target] = await db
      .select({ id: users.id, role: users.role })
      .from(users)
      .where(and(eq(users.id, userId), eq(users.organizationId, orgId)));
    if (!target) throw new ApiError(404, "Member not found");

    // Escalation guard: only an org:admin may touch an org:admin's grant or
    // hand out the "admin" app-role.
    if (target.role === "org:admin" && !caller.isOrgAdmin) {
      throw new ApiError(403, "Only an admin can edit another admin's permissions");
    }

    const updates: Record<string, unknown> = { updatedAt: new Date() };

    if (appRole !== undefined) {
      const validBuiltin = (BUILTIN_ROLE_KEYS as string[]).includes(appRole);
      let validCustom = false;
      if (typeof appRole === "string" && appRole.startsWith("role_")) {
        const [role] = await db
          .select({ id: orgRoles.id })
          .from(orgRoles)
          .where(and(eq(orgRoles.id, appRole), eq(orgRoles.organizationId, orgId)));
        validCustom = !!role;
      }
      if (!validBuiltin && !validCustom) throw new ApiError(400, "Unknown role");
      if (appRole === "admin" && !caller.isOrgAdmin) {
        throw new ApiError(403, "Only an admin can grant the Admin role");
      }
      updates.appRole = appRole;
    }

    if (overrides !== undefined) {
      if (overrides === null) {
        updates.permissionOverrides = null;
      } else if (typeof overrides === "object") {
        const clean: PermissionMap = {};
        for (const [key, value] of Object.entries(overrides)) {
          if (!isValidPermValue(key, value)) throw new ApiError(400, `Invalid permission: ${key}`);
          clean[key] = value as boolean | string;
        }
        updates.permissionOverrides = Object.keys(clean).length > 0 ? clean : null;
      } else {
        throw new ApiError(400, "overrides must be an object or null");
      }
    }

    await db.update(users).set(updates).where(eq(users.id, userId));
    invalidateUserPermissions(orgId, userId);
    res.json({ data: { id: userId, ok: true } });
  }),
);

// ─── Roles (built-in presets + custom org roles) ────────────────────
router.get(
  "/team/roles",
  requirePerm("settings.manageTeam"),
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const custom = await db.select().from(orgRoles).where(eq(orgRoles.organizationId, orgId));
    // Member count per role (org:admin members always resolve to admin).
    const rows = await db
      .select({ appRole: users.appRole, count: count() })
      .from(users)
      .where(eq(users.organizationId, orgId))
      .groupBy(users.appRole);
    const counts = new Map(rows.map((r) => [r.appRole || "member", Number(r.count)]));
    res.json({
      data: {
        builtins: BUILTIN_ROLE_KEYS.map((key) => ({
          key,
          name: BUILTIN_ROLE_LABELS[key],
          permissions: BUILTIN_ROLES[key],
          memberCount: counts.get(key) ?? 0,
        })),
        custom: custom.map((r) => ({
          id: r.id,
          name: r.name,
          description: r.description,
          permissions: r.permissions,
          memberCount: counts.get(r.id) ?? 0,
        })),
      },
    });
  }),
);

function sanitizePermMap(raw: unknown): PermissionMap {
  const clean: PermissionMap = {};
  if (raw && typeof raw === "object") {
    for (const [key, value] of Object.entries(raw)) {
      if (isValidPermValue(key, value)) clean[key] = value as boolean | string;
    }
  }
  return clean;
}

router.post(
  "/team/roles",
  requirePerm("settings.manageTeam"),
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const name = String(req.body?.name || "").trim();
    if (!name) throw new ApiError(400, "name is required");
    const [dupe] = await db
      .select({ id: orgRoles.id })
      .from(orgRoles)
      .where(and(eq(orgRoles.organizationId, orgId), sql`lower(${orgRoles.name}) = ${name.toLowerCase()}`));
    if (dupe) throw new ApiError(409, "A role with that name already exists");

    const id = createId("role");
    await db.insert(orgRoles).values({
      id,
      organizationId: orgId,
      name,
      description: req.body?.description ? String(req.body.description) : null,
      permissions: sanitizePermMap(req.body?.permissions),
    });
    res.status(201).json({ data: { id, name } });
  }),
);

router.patch(
  "/team/roles/:roleId",
  requirePerm("settings.manageTeam"),
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const roleId = req.params.roleId;
    const [existing] = await db
      .select({ id: orgRoles.id })
      .from(orgRoles)
      .where(and(eq(orgRoles.id, roleId), eq(orgRoles.organizationId, orgId)));
    if (!existing) throw new ApiError(404, "Role not found");

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (req.body?.name !== undefined) {
      const name = String(req.body.name).trim();
      if (!name) throw new ApiError(400, "name cannot be empty");
      updates.name = name;
    }
    if (req.body?.description !== undefined) updates.description = req.body.description ? String(req.body.description) : null;
    if (req.body?.permissions !== undefined) updates.permissions = sanitizePermMap(req.body.permissions);

    await db.update(orgRoles).set(updates).where(eq(orgRoles.id, roleId));
    invalidateOrgPermissions(orgId); // affects every assignee
    res.json({ data: { id: roleId, ok: true } });
  }),
);

router.delete(
  "/team/roles/:roleId",
  requirePerm("settings.manageTeam"),
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const roleId = req.params.roleId;
    const result = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ id: orgRoles.id })
        .from(orgRoles)
        .where(and(eq(orgRoles.id, roleId), eq(orgRoles.organizationId, orgId)));
      if (!existing) throw new ApiError(404, "Role not found");
      const reassigned = await tx
        .update(users)
        .set({ appRole: "member", updatedAt: new Date() })
        .where(and(eq(users.organizationId, orgId), eq(users.appRole, roleId)))
        .returning({ id: users.id });
      await tx.delete(orgRoles).where(eq(orgRoles.id, roleId));
      return reassigned.length;
    });
    invalidateOrgPermissions(orgId);
    res.json({ data: { id: roleId, deleted: true, reassignedCount: result } });
  }),
);

// ─── PATCH /team/:userId ────────────────────────────────────────────
// Edit a member's profile (first/last name). Updates Clerk + our DB so the
// corrected name shows everywhere. Email is the login identity and isn't
// editable here — fixing it means re-inviting the correct address.
router.patch(
  "/team/:userId",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const userId = req.params.userId;
    const { firstName, lastName } = req.body || {};

    if (firstName === undefined && lastName === undefined) {
      throw new ApiError(400, "Nothing to update");
    }

    // Member must belong to this org.
    const [existing] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, userId), eq(users.organizationId, orgId)));
    if (!existing) throw new ApiError(404, "Member not found");

    const first = firstName === undefined ? undefined : String(firstName).trim();
    const last = lastName === undefined ? undefined : String(lastName).trim();

    // Update Clerk (best-effort — DB is the source of truth for the team list).
    try {
      await clerkClient.users.updateUser(userId, {
        ...(first !== undefined ? { firstName: first } : {}),
        ...(last !== undefined ? { lastName: last } : {}),
      });
    } catch (err: any) {
      console.error("[team.patch] Clerk updateUser failed:", err?.errors?.[0]?.message || err?.message);
    }

    const [updated] = await db
      .update(users)
      .set({
        ...(first !== undefined ? { firstName: first || null } : {}),
        ...(last !== undefined ? { lastName: last || null } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(users.id, userId), eq(users.organizationId, orgId)))
      .returning();

    res.json({
      data: {
        id: userId,
        firstName: updated?.firstName ?? null,
        lastName: updated?.lastName ?? null,
      },
    });
  }),
);

// ─── DELETE /team/:userId ───────────────────────────────────────────
// Remove a member from the organization
router.delete(
  "/team/:userId",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const auth = getAuth(req);
    const userId = req.params.userId;

    if (userId === auth?.userId) {
      throw new ApiError(400, "You cannot remove yourself from the organization");
    }

    // Remove the Clerk org membership. Treat "not found" as success — the
    // member may already be gone in Clerk (or was never a live membership),
    // but we still need to detach them in our DB so they leave the team list.
    try {
      await clerkClient.organizations.deleteOrganizationMembership({
        organizationId: orgId,
        userId,
      });
    } catch (err: any) {
      const status = err?.status ?? err?.statusCode;
      const msg = (err?.errors?.[0]?.message || err?.message || "").toLowerCase();
      const alreadyGone = status === 404 || msg.includes("not found");
      if (!alreadyGone) {
        throw new ApiError(400, err?.errors?.[0]?.message || "Failed to remove member");
      }
    }

    // Re-point our single-row users record to an org they STILL belong to (or
    // clear it only if none remain). NEVER blanket-null it — that wiped the
    // user platform-wide even though they were members of other orgs. Also
    // invalidates the membership cache so the guard denies the removed org
    // immediately.
    await syncUserPrimaryOrg(userId);
    // Detach them from this org's campaigns / leads / tasks so they don't
    // linger as "Unknown" assignees.
    await cleanupUserOrgAssignments(orgId, userId);

    res.json({ data: { id: userId, removed: true } });
  }),
);

// ─── GET /team/analytics ────────────────────────────────────────────
// Real 90-day daily activity series per org member. Calls come from
// call_records (per rep), meetings from opportunities created (per owner).
// Email/SMS/LinkedIn/replies are 0 until those integrations land — the shape
// is kept stable so the UI's 4-channel layout works unchanged.
// A full rolling year so the Team page's calendar can select any single date
// or custom range within the last 12 months without a refetch.
const ANALYTICS_DAYS = 365;

router.get(
  "/team/analytics",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);

    // Members (same roster as /team).
    const memberRows = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.organizationId, orgId));

    // Window start = midnight UTC, (DAYS-1) days ago.
    const now = new Date();
    const startUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    startUtc.setUTCDate(startUtc.getUTCDate() - (ANALYTICS_DAYS - 1));

    // Per-rep calls + talk time (sum of call duration, seconds) by UTC day.
    const callRows = await db
      .select({
        userId: callRecords.userId,
        day: sql<string>`to_char(date_trunc('day', ${callRecords.calledAt} AT TIME ZONE 'UTC'), 'YYYY-MM-DD')`,
        c: count(),
        // Connected = a PERSON picked up: talk time > 0 (ringing excluded) and
        // not a voicemail/machine. Drives the connect-rate stat.
        connected: sql<number>`coalesce(count(*) filter (where ${callRecords.duration} > 0 and ${callRecords.disposition} <> 'voicemail' and coalesce(${callRecords.outcome}, '') not ilike '%voicemail%'), 0)`,
        // Calls that reached voicemail: the telephony disposition (VM drop /
        // dialer voicemail disposition) OR a voicemail sales outcome
        // (AI-classified or set by the rep on the call card).
        voicemail: sql<number>`coalesce(count(*) filter (where ${callRecords.disposition} = 'voicemail' or ${callRecords.outcome} ilike '%voicemail%'), 0)`,
        talk: sql<number>`coalesce(sum(${callRecords.duration}), 0)`,
      })
      .from(callRecords)
      .where(and(eq(callRecords.organizationId, orgId), gte(callRecords.calledAt, startUtc)))
      .groupBy(callRecords.userId, sql`date_trunc('day', ${callRecords.calledAt} AT TIME ZONE 'UTC')`);

    // Per-rep meetings (opportunities created) by UTC day.
    const meetingRows = await db
      .select({
        ownerId: opportunities.ownerId,
        day: sql<string>`to_char(date_trunc('day', ${opportunities.createdAt} AT TIME ZONE 'UTC'), 'YYYY-MM-DD')`,
        c: count(),
      })
      .from(opportunities)
      .where(and(eq(opportunities.organizationId, orgId), gte(opportunities.createdAt, startUtc)))
      .groupBy(opportunities.ownerId, sql`date_trunc('day', ${opportunities.createdAt} AT TIME ZONE 'UTC')`);

    const callMap = new Map<string, Map<string, number>>();
    const connectedMap = new Map<string, Map<string, number>>();
    const voicemailMap = new Map<string, Map<string, number>>();
    const talkMap = new Map<string, Map<string, number>>();
    for (const r of callRows) {
      if (!r.userId) continue;
      if (!callMap.has(r.userId)) callMap.set(r.userId, new Map());
      callMap.get(r.userId)!.set(r.day, Number(r.c));
      if (!connectedMap.has(r.userId)) connectedMap.set(r.userId, new Map());
      connectedMap.get(r.userId)!.set(r.day, Number(r.connected));
      if (!voicemailMap.has(r.userId)) voicemailMap.set(r.userId, new Map());
      voicemailMap.get(r.userId)!.set(r.day, Number(r.voicemail));
      if (!talkMap.has(r.userId)) talkMap.set(r.userId, new Map());
      talkMap.get(r.userId)!.set(r.day, Number(r.talk));
    }
    const meetMap = new Map<string, Map<string, number>>();
    for (const r of meetingRows) {
      if (!r.ownerId) continue;
      if (!meetMap.has(r.ownerId)) meetMap.set(r.ownerId, new Map());
      meetMap.get(r.ownerId)!.set(r.day, Number(r.c));
    }

    // Dense list of UTC day strings for the window.
    const days: string[] = [];
    for (let i = 0; i < ANALYTICS_DAYS; i++) {
      const d = new Date(startUtc);
      d.setUTCDate(d.getUTCDate() + i);
      days.push(d.toISOString().slice(0, 10));
    }

    const members = memberRows.map((m) => {
      const calls = callMap.get(m.id);
      const connected = connectedMap.get(m.id);
      const voicemail = voicemailMap.get(m.id);
      const talk = talkMap.get(m.id);
      const meets = meetMap.get(m.id);
      return {
        id: m.id,
        series: days.map((day) => ({
          date: `${day}T00:00:00.000Z`,
          calls: calls?.get(day) ?? 0,
          connectedCalls: connected?.get(day) ?? 0,
          voicemailCalls: voicemail?.get(day) ?? 0,
          talkTime: talk?.get(day) ?? 0,
          emails: 0,
          sms: 0,
          linkedin: 0,
          meetings: meets?.get(day) ?? 0,
          replies: 0,
        })),
      };
    });

    res.json({ data: { members } });
  }),
);

export default router;
