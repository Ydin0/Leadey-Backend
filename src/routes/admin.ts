import { Router, Request, Response, NextFunction } from "express";
import { eq, sql, like, or, and, gte } from "drizzle-orm";
import { db } from "../db/index";
import { organizations, users } from "../db/schema/organizations";
import { ApiError } from "../lib/helpers";

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

// ─── GET /stats ───────────────────────────────────────────────────────────

router.get(
  "/stats",
  asyncHandler(async (_req, res) => {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const [orgCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(organizations);

    const [userCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(users);

    const [newOrgsThisMonth] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(organizations)
      .where(gte(organizations.createdAt, startOfMonth));

    const [newUsersThisMonth] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(users)
      .where(gte(users.createdAt, startOfMonth));

    res.json({
      data: {
        totalOrganizations: orgCount.count,
        totalUsers: userCount.count,
        newOrganizationsThisMonth: newOrgsThisMonth.count,
        newUsersThisMonth: newUsersThisMonth.count,
      },
    });
  }),
);

// ─── GET /organizations ───────────────────────────────────────────────────

router.get(
  "/organizations",
  asyncHandler(async (req, res) => {
    const search = (req.query.search as string) || "";
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const offset = Number(req.query.offset) || 0;

    const conditions = search
      ? or(
          like(organizations.name, `%${search}%`),
          like(organizations.slug, `%${search}%`),
        )
      : undefined;

    const rows = await db
      .select({
        id: organizations.id,
        name: organizations.name,
        slug: organizations.slug,
        imageUrl: organizations.imageUrl,
        createdAt: organizations.createdAt,
        updatedAt: organizations.updatedAt,
        userCount: sql<number>`(
          SELECT count(*)::int FROM users WHERE users.organization_id = ${organizations.id}
        )`,
      })
      .from(organizations)
      .where(conditions)
      .orderBy(organizations.createdAt)
      .limit(limit)
      .offset(offset);

    const [{ count: total }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(organizations)
      .where(conditions);

    res.json({ data: { items: rows, total, limit, offset } });
  }),
);

// ─── GET /organizations/:id ──────────────────────────────────────────────

interface OrgParams {
  id: string;
}

router.get(
  "/organizations/:id",
  asyncHandler<OrgParams>(async (req, res) => {
    const org = await db.query.organizations.findFirst({
      where: eq(organizations.id, req.params.id),
      with: { users: true },
    });

    if (!org) throw new ApiError(404, "Organization not found");

    res.json({ data: org });
  }),
);

// ─── POST /organizations ─────────────────────────────────────────────────

router.post(
  "/organizations",
  asyncHandler(async (req, res) => {
    const { name, adminEmail } = req.body || {};

    if (!name?.trim()) {
      throw new ApiError(400, "Organization name is required");
    }

    // Create org via Clerk Backend API
    const clerkSecretKey = process.env.CLERK_SECRET_KEY;
    if (!clerkSecretKey) throw new ApiError(500, "Clerk secret key not configured");

    const createRes = await fetch("https://api.clerk.com/v1/organizations", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${clerkSecretKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: name.trim() }),
    });

    if (!createRes.ok) {
      const err = await createRes.json().catch(() => null);
      throw new ApiError(createRes.status, err?.errors?.[0]?.message || "Failed to create organization");
    }

    const orgData = await createRes.json();

    // If adminEmail provided, invite them
    if (adminEmail?.trim()) {
      await fetch(
        `https://api.clerk.com/v1/organizations/${orgData.id}/invitations`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${clerkSecretKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            email_address: adminEmail.trim(),
            role: "org:admin",
          }),
        },
      );
    }

    res.status(201).json({ data: orgData });
  }),
);

// ─── PATCH /organizations/:id ────────────────────────────────────────────

router.patch(
  "/organizations/:id",
  asyncHandler<OrgParams>(async (req, res) => {
    const { name } = req.body || {};

    if (!name?.trim()) {
      throw new ApiError(400, "Organization name is required");
    }

    const clerkSecretKey = process.env.CLERK_SECRET_KEY;
    if (!clerkSecretKey) throw new ApiError(500, "Clerk secret key not configured");

    const updateRes = await fetch(
      `https://api.clerk.com/v1/organizations/${req.params.id}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${clerkSecretKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: name.trim() }),
      },
    );

    if (!updateRes.ok) {
      const err = await updateRes.json().catch(() => null);
      throw new ApiError(updateRes.status, err?.errors?.[0]?.message || "Failed to update organization");
    }

    const orgData = await updateRes.json();
    res.json({ data: orgData });
  }),
);

// ─── DELETE /organizations/:id ───────────────────────────────────────────

router.delete(
  "/organizations/:id",
  asyncHandler<OrgParams>(async (req, res) => {
    const clerkSecretKey = process.env.CLERK_SECRET_KEY;
    if (!clerkSecretKey) throw new ApiError(500, "Clerk secret key not configured");

    const deleteRes = await fetch(
      `https://api.clerk.com/v1/organizations/${req.params.id}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${clerkSecretKey}`,
        },
      },
    );

    if (!deleteRes.ok) {
      const err = await deleteRes.json().catch(() => null);
      throw new ApiError(deleteRes.status, err?.errors?.[0]?.message || "Failed to delete organization");
    }

    res.json({ data: { id: req.params.id, deleted: true } });
  }),
);

// ─── POST /organizations/:id/invite ──────────────────────────────────────

router.post(
  "/organizations/:id/invite",
  asyncHandler<OrgParams>(async (req, res) => {
    const { email, role } = req.body || {};

    if (!email?.trim()) {
      throw new ApiError(400, "Email is required");
    }

    const clerkSecretKey = process.env.CLERK_SECRET_KEY;
    if (!clerkSecretKey) throw new ApiError(500, "Clerk secret key not configured");

    const inviteRes = await fetch(
      `https://api.clerk.com/v1/organizations/${req.params.id}/invitations`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${clerkSecretKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email_address: email.trim(),
          role: role || "org:member",
        }),
      },
    );

    if (!inviteRes.ok) {
      const err = await inviteRes.json().catch(() => null);
      throw new ApiError(inviteRes.status, err?.errors?.[0]?.message || "Failed to invite user");
    }

    const inviteData = await inviteRes.json();
    res.status(201).json({ data: inviteData });
  }),
);

// ─── GET /users ──────────────────────────────────────────────────────────

router.get(
  "/users",
  asyncHandler(async (req, res) => {
    const search = (req.query.search as string) || "";
    const organizationId = (req.query.organizationId as string) || "";
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const offset = Number(req.query.offset) || 0;

    const conditions = [];
    if (search) {
      conditions.push(
        or(
          like(users.email, `%${search}%`),
          like(users.firstName, `%${search}%`),
          like(users.lastName, `%${search}%`),
        ),
      );
    }
    if (organizationId) {
      conditions.push(eq(users.organizationId, organizationId));
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const rows = await db
      .select({
        id: users.id,
        email: users.email,
        firstName: users.firstName,
        lastName: users.lastName,
        imageUrl: users.imageUrl,
        organizationId: users.organizationId,
        role: users.role,
        createdAt: users.createdAt,
        updatedAt: users.updatedAt,
      })
      .from(users)
      .where(where)
      .orderBy(users.createdAt)
      .limit(limit)
      .offset(offset);

    // Attach org names
    const orgIds = [...new Set(rows.map((r) => r.organizationId).filter(Boolean))] as string[];
    const orgs =
      orgIds.length > 0
        ? await db
            .select({ id: organizations.id, name: organizations.name })
            .from(organizations)
            .where(
              sql`${organizations.id} IN ${orgIds}`,
            )
        : [];

    const orgMap = Object.fromEntries(orgs.map((o) => [o.id, o.name]));

    const items = rows.map((r) => ({
      ...r,
      organizationName: r.organizationId ? orgMap[r.organizationId] || null : null,
    }));

    const [{ count: total }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(users)
      .where(where);

    res.json({ data: { items, total, limit, offset } });
  }),
);

// ─── GET /users/:id ─────────────────────────────────────────────────────

interface UserParams {
  id: string;
}

router.get(
  "/users/:id",
  asyncHandler<UserParams>(async (req, res) => {
    const user = await db.query.users.findFirst({
      where: eq(users.id, req.params.id),
      with: { organization: true },
    });

    if (!user) throw new ApiError(404, "User not found");

    res.json({ data: user });
  }),
);

// ─── PATCH /users/:id ───────────────────────────────────────────────────

router.patch(
  "/users/:id",
  asyncHandler<UserParams>(async (req, res) => {
    const { firstName, lastName } = req.body || {};

    const clerkSecretKey = process.env.CLERK_SECRET_KEY;
    if (!clerkSecretKey) throw new ApiError(500, "Clerk secret key not configured");

    const updateRes = await fetch(
      `https://api.clerk.com/v1/users/${req.params.id}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${clerkSecretKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          first_name: firstName,
          last_name: lastName,
        }),
      },
    );

    if (!updateRes.ok) {
      const err = await updateRes.json().catch(() => null);
      throw new ApiError(updateRes.status, err?.errors?.[0]?.message || "Failed to update user");
    }

    const userData = await updateRes.json();
    res.json({ data: userData });
  }),
);

// ─── DELETE /users/:id ──────────────────────────────────────────────────

router.delete(
  "/users/:id",
  asyncHandler<UserParams>(async (req, res) => {
    const clerkSecretKey = process.env.CLERK_SECRET_KEY;
    if (!clerkSecretKey) throw new ApiError(500, "Clerk secret key not configured");

    const deleteRes = await fetch(
      `https://api.clerk.com/v1/users/${req.params.id}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${clerkSecretKey}`,
        },
      },
    );

    if (!deleteRes.ok) {
      const err = await deleteRes.json().catch(() => null);
      throw new ApiError(deleteRes.status, err?.errors?.[0]?.message || "Failed to delete user");
    }

    res.json({ data: { id: req.params.id, deleted: true } });
  }),
);

export default router;
