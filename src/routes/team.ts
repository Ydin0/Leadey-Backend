import { Router, Request, Response, NextFunction } from "express";
import { eq, and, count, gte, sql } from "drizzle-orm";
import { clerkClient } from "@clerk/express";
import { db } from "../db/index";
import { organizations, users } from "../db/schema/organizations";
import { callRecords } from "../db/schema/call-records";
import { opportunities } from "../db/schema/opportunities";
import { getOrgId } from "../lib/auth";
import { ApiError } from "../lib/helpers";
import { getAuth } from "@clerk/express";
import { getPlanConfig } from "../lib/stripe";
import { getSetting, upsertSetting } from "../lib/settings-service";
import { inviteEmailToOrganization } from "../lib/invitations";

const KPI_CONFIG_KEY = "team_kpi_config";

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
    // Normalize
    if (role === "org:admin") role = "admin";
    else if (role === "org:member") role = "rep";

    res.json({ data: { role } });
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

    const members = await db
      .select()
      .from(users)
      .where(eq(users.organizationId, orgId));

    const config = getPlanConfig(org.plan);

    res.json({
      data: {
        members: members.map((m) => ({
          id: m.id,
          email: m.email,
          firstName: m.firstName,
          lastName: m.lastName,
          imageUrl: m.imageUrl,
          role: m.role || "org:member",
          createdAt: m.createdAt.toISOString(),
        })),
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

    // Keep Clerk's org membership cap in sync with our seat allowance.
    // Clerk enforces its own `max_allowed_memberships` (default 5) and will
    // reject invites with "organization membership quota exceeded" even when
    // we have seats free, so raise it to at least our seat limit first.
    try {
      await clerkClient.organizations.updateOrganization(orgId, {
        maxAllowedMemberships: seatLimit,
      });
    } catch {
      // Non-fatal — if this fails, the invite below surfaces the real error.
    }

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
// Update a member's role
router.patch(
  "/team/:userId/role",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const userId = req.params.userId;
    const { role } = req.body;

    if (!role) throw new ApiError(400, "role is required");

    try {
      // Find the membership
      const memberships = await clerkClient.organizations.getOrganizationMembershipList({
        organizationId: orgId,
      });

      const membership = (memberships.data || []).find(
        (m: any) => m.publicUserData?.userId === userId
      );

      if (!membership) throw new ApiError(404, "Member not found");

      await clerkClient.organizations.updateOrganizationMembership({
        organizationId: orgId,
        userId,
        role,
      });

      // Update local DB
      await db
        .update(users)
        .set({ role, updatedAt: new Date() })
        .where(eq(users.id, userId));

      res.json({ data: { id: userId, role } });
    } catch (err: any) {
      if (err instanceof ApiError) throw err;
      throw new ApiError(400, err?.errors?.[0]?.message || "Failed to update role");
    }
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

    // Detach in our DB — GET /team reads from the users table, so this is what
    // actually removes them from the list (idempotent regardless of Clerk).
    await db
      .update(users)
      .set({ organizationId: null, updatedAt: new Date() })
      .where(and(eq(users.id, userId), eq(users.organizationId, orgId)));

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
    const talkMap = new Map<string, Map<string, number>>();
    for (const r of callRows) {
      if (!r.userId) continue;
      if (!callMap.has(r.userId)) callMap.set(r.userId, new Map());
      callMap.get(r.userId)!.set(r.day, Number(r.c));
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
      const talk = talkMap.get(m.id);
      const meets = meetMap.get(m.id);
      return {
        id: m.id,
        series: days.map((day) => ({
          date: `${day}T00:00:00.000Z`,
          calls: calls?.get(day) ?? 0,
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
