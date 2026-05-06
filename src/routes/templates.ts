import { Router, Request, Response, NextFunction } from "express";
import { eq, and, desc } from "drizzle-orm";
import { db } from "../db/index";
import { templates } from "../db/schema/templates";
import { getOrgId } from "../lib/auth";
import { ApiError, createId } from "../lib/helpers";
import { getAuth } from "@clerk/express";

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

// ─── GET /templates ─────────────────────────────────────────────────
router.get(
  "/templates",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const channel = req.query.channel as string | undefined;

    const conditions = [eq(templates.organizationId, orgId)];
    if (channel) conditions.push(eq(templates.channel, channel));

    const rows = await db
      .select()
      .from(templates)
      .where(and(...conditions))
      .orderBy(desc(templates.updatedAt));

    res.json({
      data: rows.map((r) => ({
        id: r.id,
        name: r.name,
        channel: r.channel,
        category: r.category,
        subject: r.subject,
        body: r.body,
        tags: r.tags,
        createdBy: r.createdBy,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      })),
    });
  }),
);

// ─── GET /templates/:id ─────────────────────────────────────────────
router.get(
  "/templates/:id",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const id = req.params.id as string;

    const [row] = await db
      .select()
      .from(templates)
      .where(and(eq(templates.id, id), eq(templates.organizationId, orgId)));

    if (!row) throw new ApiError(404, "Template not found");

    res.json({
      data: {
        id: row.id,
        name: row.name,
        channel: row.channel,
        category: row.category,
        subject: row.subject,
        body: row.body,
        tags: row.tags,
        createdBy: row.createdBy,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      },
    });
  }),
);

// ─── POST /templates ────────────────────────────────────────────────
router.post(
  "/templates",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const auth = getAuth(req);
    const { name, channel, category, subject, body, tags } = req.body;

    if (!name) throw new ApiError(400, "name is required");
    if (!channel) throw new ApiError(400, "channel is required");
    if (!body) throw new ApiError(400, "body is required");

    const id = createId("tmpl");
    const [row] = await db
      .insert(templates)
      .values({
        id,
        organizationId: orgId,
        name,
        channel,
        category: category || null,
        subject: subject || null,
        body,
        tags: tags || [],
        createdBy: auth?.userId || null,
      })
      .returning();

    res.status(201).json({
      data: {
        id: row.id,
        name: row.name,
        channel: row.channel,
        category: row.category,
        subject: row.subject,
        body: row.body,
        tags: row.tags,
        createdBy: row.createdBy,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      },
    });
  }),
);

// ─── PATCH /templates/:id ───────────────────────────────────────────
router.patch(
  "/templates/:id",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const id = req.params.id as string;

    const existing = await db.query.templates.findFirst({
      where: and(eq(templates.id, id), eq(templates.organizationId, orgId)),
    });
    if (!existing) throw new ApiError(404, "Template not found");

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (req.body.name !== undefined) updates.name = req.body.name;
    if (req.body.channel !== undefined) updates.channel = req.body.channel;
    if (req.body.category !== undefined) updates.category = req.body.category || null;
    if (req.body.subject !== undefined) updates.subject = req.body.subject || null;
    if (req.body.body !== undefined) updates.body = req.body.body;
    if (req.body.tags !== undefined) updates.tags = req.body.tags;

    const [row] = await db
      .update(templates)
      .set(updates)
      .where(eq(templates.id, id))
      .returning();

    res.json({
      data: {
        id: row.id,
        name: row.name,
        channel: row.channel,
        category: row.category,
        subject: row.subject,
        body: row.body,
        tags: row.tags,
        createdBy: row.createdBy,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      },
    });
  }),
);

// ─── DELETE /templates/:id ──────────────────────────────────────────
router.delete(
  "/templates/:id",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const id = req.params.id as string;

    const existing = await db.query.templates.findFirst({
      where: and(eq(templates.id, id), eq(templates.organizationId, orgId)),
    });
    if (!existing) throw new ApiError(404, "Template not found");

    await db.delete(templates).where(eq(templates.id, id));

    res.json({ data: { id, deleted: true } });
  }),
);

export default router;
