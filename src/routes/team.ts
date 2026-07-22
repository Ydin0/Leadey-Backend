import { Router, Request, Response, NextFunction } from "express";
import { eq, and, count, gte, sql, inArray } from "drizzle-orm";
import { clerkClient } from "@clerk/express";
import { db } from "../db/index";
import { organizations, users } from "../db/schema/organizations";
import { callRecords } from "../db/schema/call-records";
import { emailMessages } from "../db/schema/email-accounts";
import { smsMessages } from "../db/schema/sms";
import { opportunities } from "../db/schema/opportunities";
import { scheduledMeetings } from "../db/schema/scheduled-meetings";
import { meetingDispositions } from "../db/schema/meeting-dispositions";
import { getOrgId } from "../lib/auth";
import { ApiError, createId } from "../lib/helpers";
import { getAuth } from "@clerk/express";
import { getPlanConfig } from "../lib/stripe";
import { getSetting, upsertSetting } from "../lib/settings-service";
import { inviteEmailToOrganization, ensureOrgMembershipCap } from "../lib/invitations";
import { syncUserPrimaryOrg, cleanupUserOrgAssignments, isOrgMember, upsertMembership, getUserOrgWorkSummary, reassignUserOrgWork } from "../lib/org-membership";
import { orgRoles } from "../db/schema/org-roles";
import { organizationMemberships } from "../db/schema/organization-memberships";
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
const ANALYTICS_CARDS_KEY = "team_analytics_cards";

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

    // Resolved granular permissions for the new client, keyed to the token's
    // active org (per-org via the membership row). Fail-closed: on error the
    // frontend hook synthesizes a locked-down map, never admin.
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

    // Coarse role kept for older clients that still read `role`.
    const role = isOrgAdmin ? "admin" : "rep";
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
    // Per-org appRole/overrides come from the membership row (source of truth),
    // falling back to the legacy single-org users columns during transition.
    type Mem = { appRole: string | null; permissionOverrides: Record<string, boolean | string> | null };
    const appRoleFor = (clerkRole: string, mem?: Mem, row?: typeof users.$inferSelect) =>
      clerkRole === "org:admin" ? "admin" : mem?.appRole || row?.appRole || "member";
    const overridesFor = (mem?: Mem, row?: typeof users.$inferSelect) => {
      const o = mem?.permissionOverrides ?? row?.permissionOverrides;
      return !!o && Object.keys(o).length > 0;
    };
    const memRows = await db
      .select({ userId: organizationMemberships.userId, appRole: organizationMemberships.appRole, permissionOverrides: organizationMemberships.permissionOverrides })
      .from(organizationMemberships)
      .where(eq(organizationMemberships.organizationId, orgId));
    const memById = new Map<string, Mem>(memRows.map((m) => [m.userId, m]));
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
        const uid = pud?.userId;
        const row = uid ? byId.get(uid) : undefined;
        const mem = uid ? memById.get(uid) : undefined;
        const clerkRole = m.role || "org:member";
        return {
          id: uid || m.id,
          email: pud?.identifier || row?.email || "",
          firstName: pud?.firstName ?? row?.firstName ?? null,
          lastName: pud?.lastName ?? row?.lastName ?? null,
          imageUrl: pud?.imageUrl ?? row?.imageUrl ?? null,
          role: clerkRole,
          appRole: appRoleFor(clerkRole, mem, row),
          hasOverrides: overridesFor(mem, row),
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
        appRole: appRoleFor(m.role || "org:member", memById.get(m.id), m),
        hasOverrides: overridesFor(memById.get(m.id), m),
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
      .from(organizationMemberships)
      .where(eq(organizationMemberships.organizationId, orgId));

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
      const nextAppRole = role === "org:admin" ? "admin" : "member";
      await db
        .update(users)
        .set({ role, appRole: nextAppRole, updatedAt: new Date() })
        .where(eq(users.id, userId));
      // Per-org membership row is the source of truth going forward.
      await upsertMembership(orgId, userId, { role, appRole: nextAppRole });
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

    // Member must belong to this org — Clerk source of truth (multi-org safe).
    if (!(await isOrgMember(userId, orgId))) throw new ApiError(404, "Member not found");
    const targetPerms = await resolvePermissions(orgId, userId);

    // Escalation guard: only an org:admin may touch an org:admin's grant or
    // hand out the "admin" app-role.
    if (targetPerms.isOrgAdmin && !caller.isOrgAdmin) {
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
    // Mirror to the per-org membership row (source of truth going forward).
    const memPatch: Partial<{ appRole: string; permissionOverrides: Record<string, boolean | string> | null }> = {};
    if (appRole !== undefined) memPatch.appRole = appRole;
    if (overrides !== undefined) memPatch.permissionOverrides = (updates.permissionOverrides as Record<string, boolean | string> | null) ?? null;
    if (Object.keys(memPatch).length > 0) await upsertMembership(orgId, userId, memPatch);
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
      .select({ appRole: organizationMemberships.appRole, count: count() })
      .from(organizationMemberships)
      .where(eq(organizationMemberships.organizationId, orgId))
      .groupBy(organizationMemberships.appRole);
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
      // Reassign anyone on this custom role back to member — in the per-org
      // membership rows (source of truth) AND the legacy users column.
      const reassigned = await tx
        .update(organizationMemberships)
        .set({ appRole: "member", updatedAt: new Date() })
        .where(and(eq(organizationMemberships.organizationId, orgId), eq(organizationMemberships.appRole, roleId)))
        .returning({ id: organizationMemberships.userId });
      await tx
        .update(users)
        .set({ appRole: "member", updatedAt: new Date() })
        .where(and(eq(users.organizationId, orgId), eq(users.appRole, roleId)));
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

// ─── GET /team/:userId/removal-summary ──────────────────────────────
// Counts of the member's active work (tasks / opportunities / leads / phone
// numbers) so the Remove-User modal can offer reassignment before removal.
router.get(
  "/team/:userId/removal-summary",
  requirePerm("settings.manageTeam"),
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const summary = await getUserOrgWorkSummary(orgId, req.params.userId);
    res.json({ data: summary });
  }),
);

// ─── DELETE /team/:userId ───────────────────────────────────────────
// Remove a member from the organization. Accepts an optional body
// { reassign: { tasks?, opportunities?, leads?, phoneNumbers? } } of target
// userIds to hand each category of active work to before the member is detached.
router.delete(
  "/team/:userId",
  requirePerm("settings.manageTeam"),
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const auth = getAuth(req);
    const userId = req.params.userId;

    if (userId === auth?.userId) {
      throw new ApiError(400, "You cannot remove yourself from the organization");
    }

    // Hand the leaving member's active work to teammates BEFORE detaching them,
    // so the categories the admin chose to reassign aren't nulled by cleanup.
    const reassign = req.body && typeof req.body.reassign === "object" && req.body.reassign ? req.body.reassign : null;
    if (reassign) await reassignUserOrgWork(orgId, userId, reassign);

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

// ─── GET /team/analytics-cards ──────────────────────────────────────
// Ordered list of stat-card ids shown on the Team analytics page. Org-wide
// (one layout for the whole team), stored in org settings. Empty/absent → the
// client falls back to its DEFAULT_CARD_IDS.
router.get(
  "/team/analytics-cards",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const raw = await getSetting(orgId, ANALYTICS_CARDS_KEY);
    let cards: string[] = [];
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) cards = parsed.filter((x): x is string => typeof x === "string");
      } catch { /* ignore malformed */ }
    }
    res.json({ data: { cards } });
  }),
);

// ─── PUT /team/analytics-cards ──────────────────────────────────────
// Replace the org-wide card layout (managers/admins only).
router.put(
  "/team/analytics-cards",
  requirePerm("settings.manageTeam"),
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const body = req.body || {};
    if (!Array.isArray(body.cards)) throw new ApiError(400, "cards must be an array");
    const cards = (body.cards as unknown[]).filter((x): x is string => typeof x === "string").slice(0, 40);
    await upsertSetting(orgId, ANALYTICS_CARDS_KEY, JSON.stringify(cards));
    res.json({ data: { cards } });
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

    // Resolve which stored outcome KEYS mean "voicemail" for this org. A call's
    // outcome column holds the outcome KEY, and a renamed outcome keeps its
    // original key — so an outcome relabelled "Voicemail" may have a key like
    // "no_answer" that never contains the substring "voicemail". Match against
    // the org's actual catalog (by key OR label) instead of a fragile substring.
    const { getCallOutcomes } = await import("../lib/call-outcomes");
    const orgOutcomes = await getCallOutcomes(orgId);
    const vmKeys = orgOutcomes
      .filter((o) => o.key.toLowerCase().includes("voicemail") || o.label.toLowerCase().includes("voicemail"))
      .map((o) => o.key.toLowerCase());
    const vmKeyMatch = vmKeys.length
      ? sql`lower(${callRecords.outcome}) in (${sql.join(vmKeys.map((k) => sql`${k}`), sql`, `)})`
      : sql`false`;
    // A call reached voicemail when the telephony disposition says so, or its
    // outcome resolves to a "voicemail" outcome, or the raw value mentions it.
    // coalesce → a proper boolean even when outcome/disposition is NULL, so the
    // `not vmCond` used by the connect-rate filter never goes NULL.
    const vmCond = sql`coalesce(${callRecords.disposition} = 'voicemail' or ${vmKeyMatch} or ${callRecords.outcome} ilike '%voicemail%', false)`;

    // Per-rep calls + talk time (sum of call duration, seconds) by UTC day.
    const callRows = await db
      .select({
        userId: callRecords.userId,
        day: sql<string>`to_char(date_trunc('day', ${callRecords.calledAt} AT TIME ZONE 'UTC'), 'YYYY-MM-DD')`,
        c: count(),
        // Connected = a PERSON picked up: talk time > 0 (ringing excluded) and
        // not a voicemail/machine. Drives the connect-rate stat.
        connected: sql<number>`coalesce(count(*) filter (where ${callRecords.duration} > 0 and not ${vmCond}), 0)`,
        // Calls that reached voicemail (disposition or a voicemail outcome).
        voicemail: sql<number>`coalesce(count(*) filter (where ${vmCond}), 0)`,
        talk: sql<number>`coalesce(sum(${callRecords.duration}), 0)`,
        // Direction splits — outbound vs inbound calls + talk time.
        outC: sql<number>`coalesce(count(*) filter (where ${callRecords.direction} = 'outbound'), 0)`,
        inC: sql<number>`coalesce(count(*) filter (where ${callRecords.direction} = 'inbound'), 0)`,
        talkOut: sql<number>`coalesce(sum(${callRecords.duration}) filter (where ${callRecords.direction} = 'outbound'), 0)`,
        talkIn: sql<number>`coalesce(sum(${callRecords.duration}) filter (where ${callRecords.direction} = 'inbound'), 0)`,
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

    // Per-rep MEETINGS BOOKED through the Leadey booking flow, credited to the
    // booker (COALESCE(created_by, host_user_id)), bucketed by the day it was
    // booked. Only confirmed bookings count.
    const booker = sql<string>`coalesce(${scheduledMeetings.createdBy}, ${scheduledMeetings.hostUserId})`;
    const bookedRows = await db
      .select({
        userId: booker,
        day: sql<string>`to_char(date_trunc('day', ${scheduledMeetings.createdAt} AT TIME ZONE 'UTC'), 'YYYY-MM-DD')`,
        c: count(),
      })
      .from(scheduledMeetings)
      .where(and(
        eq(scheduledMeetings.organizationId, orgId),
        eq(scheduledMeetings.status, "confirmed"),
        gte(scheduledMeetings.createdAt, startUtc),
      ))
      .groupBy(booker, sql`date_trunc('day', ${scheduledMeetings.createdAt} AT TIME ZONE 'UTC')`);

    // Per-rep SIT OUTCOMES on the meetings they booked — attended vs no-show
    // from meeting_dispositions (key `leadey:<meetingId>`), bucketed by the day
    // the meeting occurred. Only dispositioned meetings contribute to sit rate.
    const sitRows = await db
      .select({
        userId: booker,
        day: sql<string>`to_char(date_trunc('day', ${scheduledMeetings.startTime} AT TIME ZONE 'UTC'), 'YYYY-MM-DD')`,
        attended: sql<number>`coalesce(count(*) filter (where ${meetingDispositions.disposition} = 'attended'), 0)`,
        noShow: sql<number>`coalesce(count(*) filter (where ${meetingDispositions.disposition} = 'no_show'), 0)`,
      })
      .from(scheduledMeetings)
      .innerJoin(
        meetingDispositions,
        and(
          eq(meetingDispositions.organizationId, scheduledMeetings.organizationId),
          eq(meetingDispositions.meetingKey, sql`'leadey:' || ${scheduledMeetings.id}`),
        ),
      )
      .where(and(
        eq(scheduledMeetings.organizationId, orgId),
        gte(scheduledMeetings.startTime, startUtc),
      ))
      .groupBy(booker, sql`date_trunc('day', ${scheduledMeetings.startTime} AT TIME ZONE 'UTC')`);

    // Per-rep emails (sent + received) by UTC day, split by direction.
    const emailRows = await db
      .select({
        userId: emailMessages.userId,
        day: sql<string>`to_char(date_trunc('day', ${emailMessages.createdAt} AT TIME ZONE 'UTC'), 'YYYY-MM-DD')`,
        c: count(),
        outC: sql<number>`coalesce(count(*) filter (where ${emailMessages.direction} = 'outbound'), 0)`,
        inC: sql<number>`coalesce(count(*) filter (where ${emailMessages.direction} = 'inbound'), 0)`,
      })
      .from(emailMessages)
      .where(and(eq(emailMessages.organizationId, orgId), gte(emailMessages.createdAt, startUtc)))
      .groupBy(emailMessages.userId, sql`date_trunc('day', ${emailMessages.createdAt} AT TIME ZONE 'UTC')`);

    // Per-rep SMS (sent + received) by UTC day, split by direction. WhatsApp
    // shares this table (channel='whatsapp') but is excluded from the SMS card.
    const smsRows = await db
      .select({
        userId: smsMessages.userId,
        day: sql<string>`to_char(date_trunc('day', ${smsMessages.createdAt} AT TIME ZONE 'UTC'), 'YYYY-MM-DD')`,
        c: count(),
        outC: sql<number>`coalesce(count(*) filter (where ${smsMessages.direction} = 'outbound'), 0)`,
        inC: sql<number>`coalesce(count(*) filter (where ${smsMessages.direction} = 'inbound'), 0)`,
      })
      .from(smsMessages)
      .where(and(eq(smsMessages.organizationId, orgId), eq(smsMessages.channel, "sms"), gte(smsMessages.createdAt, startUtc)))
      .groupBy(smsMessages.userId, sql`date_trunc('day', ${smsMessages.createdAt} AT TIME ZONE 'UTC')`);

    // Consolidate every source into one userId → day → metrics bucket.
    type DayAgg = {
      calls: number; callsInbound: number; callsOutbound: number;
      connectedCalls: number; voicemailCalls: number;
      talkTime: number; talkTimeInbound: number; talkTimeOutbound: number;
      emails: number; emailsInbound: number; emailsOutbound: number;
      sms: number; smsInbound: number; smsOutbound: number;
      meetings: number;
      meetingsBooked: number; meetingsAttended: number; meetingsNoShow: number;
    };
    const zero = (): DayAgg => ({
      calls: 0, callsInbound: 0, callsOutbound: 0, connectedCalls: 0, voicemailCalls: 0,
      talkTime: 0, talkTimeInbound: 0, talkTimeOutbound: 0,
      emails: 0, emailsInbound: 0, emailsOutbound: 0, sms: 0, smsInbound: 0, smsOutbound: 0, meetings: 0,
      meetingsBooked: 0, meetingsAttended: 0, meetingsNoShow: 0,
    });
    const agg = new Map<string, Map<string, DayAgg>>();
    const bucket = (userId: string, day: string): DayAgg => {
      let u = agg.get(userId);
      if (!u) { u = new Map(); agg.set(userId, u); }
      let d = u.get(day);
      if (!d) { d = zero(); u.set(day, d); }
      return d;
    };
    for (const r of callRows) {
      if (!r.userId) continue;
      const d = bucket(r.userId, r.day);
      d.calls = Number(r.c); d.callsInbound = Number(r.inC); d.callsOutbound = Number(r.outC);
      d.connectedCalls = Number(r.connected); d.voicemailCalls = Number(r.voicemail);
      d.talkTime = Number(r.talk); d.talkTimeInbound = Number(r.talkIn); d.talkTimeOutbound = Number(r.talkOut);
    }
    for (const r of emailRows) {
      if (!r.userId) continue;
      const d = bucket(r.userId, r.day);
      d.emails = Number(r.c); d.emailsInbound = Number(r.inC); d.emailsOutbound = Number(r.outC);
    }
    for (const r of smsRows) {
      if (!r.userId) continue;
      const d = bucket(r.userId, r.day);
      d.sms = Number(r.c); d.smsInbound = Number(r.inC); d.smsOutbound = Number(r.outC);
    }
    for (const r of meetingRows) {
      if (!r.ownerId) continue;
      bucket(r.ownerId, r.day).meetings = Number(r.c);
    }
    for (const r of bookedRows) {
      if (!r.userId) continue;
      bucket(r.userId, r.day).meetingsBooked = Number(r.c);
    }
    for (const r of sitRows) {
      if (!r.userId) continue;
      const d = bucket(r.userId, r.day);
      d.meetingsAttended = Number(r.attended);
      d.meetingsNoShow = Number(r.noShow);
    }

    // Dense list of UTC day strings for the window.
    const days: string[] = [];
    for (let i = 0; i < ANALYTICS_DAYS; i++) {
      const d = new Date(startUtc);
      d.setUTCDate(d.getUTCDate() + i);
      days.push(d.toISOString().slice(0, 10));
    }

    const members = memberRows.map((m) => {
      const u = agg.get(m.id);
      return {
        id: m.id,
        series: days.map((day) => {
          const d = u?.get(day);
          return {
            date: `${day}T00:00:00.000Z`,
            calls: d?.calls ?? 0,
            callsInbound: d?.callsInbound ?? 0,
            callsOutbound: d?.callsOutbound ?? 0,
            connectedCalls: d?.connectedCalls ?? 0,
            voicemailCalls: d?.voicemailCalls ?? 0,
            talkTime: d?.talkTime ?? 0,
            talkTimeInbound: d?.talkTimeInbound ?? 0,
            talkTimeOutbound: d?.talkTimeOutbound ?? 0,
            emails: d?.emails ?? 0,
            emailsInbound: d?.emailsInbound ?? 0,
            emailsOutbound: d?.emailsOutbound ?? 0,
            sms: d?.sms ?? 0,
            smsInbound: d?.smsInbound ?? 0,
            smsOutbound: d?.smsOutbound ?? 0,
            linkedin: 0,
            meetings: d?.meetings ?? 0,
            meetingsBooked: d?.meetingsBooked ?? 0,
            meetingsAttended: d?.meetingsAttended ?? 0,
            meetingsNoShow: d?.meetingsNoShow ?? 0,
            replies: (d?.emailsInbound ?? 0) + (d?.smsInbound ?? 0),
          };
        }),
      };
    });

    res.json({ data: { members } });
  }),
);

export default router;
