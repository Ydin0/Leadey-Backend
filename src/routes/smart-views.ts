import { Router, Request, Response, NextFunction } from "express";
import { and, eq, asc } from "drizzle-orm";
import { db } from "../db/index";
import { smartViews } from "../db/schema/smart-views";
import { getOrgId } from "../lib/auth";
import { ApiError, createId, normalizeString } from "../lib/helpers";
import { getAuth } from "@clerk/express";

const router = Router();

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<void>;
function asyncHandler(handler: AsyncHandler) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function serialize(v: typeof smartViews.$inferSelect) {
  return {
    id: v.id,
    scope: v.scope,
    funnelId: v.funnelId,
    name: v.name,
    definition: v.definition,
    createdBy: v.createdBy,
    createdAt: v.createdAt.toISOString(),
    updatedAt: v.updatedAt.toISOString(),
  };
}

// ─── GET /smart-views?scope=&funnelId= ───────────────────────────────
// Team-shared saved filters for a scope (campaign views are funnel-scoped).
router.get(
  "/smart-views",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const scope = (req.query.scope as string) === "org" ? "org" : "campaign";
    const funnelId = normalizeString(req.query.funnelId as string | undefined);

    const conds = [eq(smartViews.organizationId, orgId), eq(smartViews.scope, scope)];
    if (scope === "campaign") {
      if (!funnelId) throw new ApiError(400, "funnelId is required for campaign views");
      conds.push(eq(smartViews.funnelId, funnelId));
    }

    const rows = await db
      .select()
      .from(smartViews)
      .where(and(...conds))
      .orderBy(asc(smartViews.name));

    res.json({ data: rows.map(serialize) });
  }),
);

// ─── POST /smart-views ───────────────────────────────────────────────
router.post(
  "/smart-views",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const body = req.body as { scope?: string; funnelId?: string; name?: string; definition?: Record<string, unknown> };
    const scope = body.scope === "org" ? "org" : "campaign";
    const name = normalizeString(body.name);
    if (!name) throw new ApiError(400, "Name is required");
    if (scope === "campaign" && !normalizeString(body.funnelId)) {
      throw new ApiError(400, "funnelId is required for campaign views");
    }

    const id = createId("sv");
    await db.insert(smartViews).values({
      id,
      organizationId: orgId,
      scope,
      funnelId: scope === "campaign" ? normalizeString(body.funnelId) : null,
      name,
      definition: body.definition ?? {},
      createdBy: getAuth(req)?.userId ?? null,
    });
    const [row] = await db.select().from(smartViews).where(eq(smartViews.id, id));
    res.status(201).json({ data: serialize(row) });
  }),
);

// ─── PATCH /smart-views/:id ──────────────────────────────────────────
router.patch(
  "/smart-views/:id",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const id = String(req.params.id);
    const body = req.body as { name?: string; definition?: Record<string, unknown> };

    const [existing] = await db
      .select()
      .from(smartViews)
      .where(and(eq(smartViews.id, id), eq(smartViews.organizationId, orgId)));
    if (!existing) throw new ApiError(404, "Smart view not found");

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (body.name !== undefined) {
      const name = normalizeString(body.name);
      if (!name) throw new ApiError(400, "Name cannot be empty");
      updates.name = name;
    }
    if (body.definition !== undefined) updates.definition = body.definition;

    await db.update(smartViews).set(updates).where(eq(smartViews.id, id));
    const [row] = await db.select().from(smartViews).where(eq(smartViews.id, id));
    res.json({ data: serialize(row) });
  }),
);

// ─── DELETE /smart-views/:id ─────────────────────────────────────────
router.delete(
  "/smart-views/:id",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const id = String(req.params.id);
    await db
      .delete(smartViews)
      .where(and(eq(smartViews.id, id), eq(smartViews.organizationId, orgId)));
    res.json({ data: { id, deleted: true } });
  }),
);

export default router;
