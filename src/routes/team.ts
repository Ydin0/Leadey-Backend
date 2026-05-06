import { Router, Request, Response, NextFunction } from "express";
import { eq, and, count } from "drizzle-orm";
import { clerkClient } from "@clerk/express";
import { db } from "../db/index";
import { organizations, users } from "../db/schema/organizations";
import { getOrgId } from "../lib/auth";
import { ApiError } from "../lib/helpers";
import { getAuth } from "@clerk/express";
import { getPlanConfig } from "../lib/stripe";

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

// ─── POST /team/invite ──────────────────────────────────────────────
// Invite a new member via Clerk
router.post(
  "/team/invite",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const { email, role } = req.body;

    if (!email) throw new ApiError(400, "email is required");

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

    try {
      const invitation = await clerkClient.organizations.createOrganizationInvitation({
        organizationId: orgId,
        emailAddress: email,
        role: role || "org:member",
      });

      res.status(201).json({
        data: {
          id: invitation.id,
          emailAddress: invitation.emailAddress,
          role: invitation.role,
          status: invitation.status,
          createdAt: invitation.createdAt ? new Date(invitation.createdAt).toISOString() : new Date().toISOString(),
        },
      });
    } catch (err: any) {
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

    try {
      await clerkClient.organizations.deleteOrganizationMembership({
        organizationId: orgId,
        userId,
      });

      res.json({ data: { id: userId, removed: true } });
    } catch (err: any) {
      throw new ApiError(400, err?.errors?.[0]?.message || "Failed to remove member");
    }
  }),
);

export default router;
