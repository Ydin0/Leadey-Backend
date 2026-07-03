import { Router, Request, Response, NextFunction } from "express";
import { and, eq, asc, inArray, sql } from "drizzle-orm";
import { db } from "../db/index";
import { funnelTags, funnelTagAssignments } from "../db/schema/funnel-tags";
import { funnels } from "../db/schema/funnels";
import { getOrgId } from "../lib/auth";
import { ApiError, createId, normalizeString } from "../lib/helpers";

const router = Router();

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<void>;
function asyncHandler(handler: AsyncHandler) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

/** Named palette keys the client renders theme-aware. */
const TAG_COLORS = new Set([
  "blue",
  "green",
  "red",
  "slate",
  "amber",
  "violet",
  "pink",
  "cyan",
]);
const MAX_TAG_NAME = 40;

function serialize(t: typeof funnelTags.$inferSelect, campaignCount = 0) {
  return {
    id: t.id,
    name: t.name,
    color: t.color,
    sortOrder: t.sortOrder,
    campaignCount,
    createdAt: t.createdAt.toISOString(),
  };
}

function validColor(color: unknown): string {
  const c = normalizeString(color as string | undefined);
  if (!c) return "blue";
  if (!TAG_COLORS.has(c)) throw new ApiError(400, `Unknown tag color "${c}"`);
  return c;
}

// ─── GET /funnel-tags ────────────────────────────────────────────────
// All of the org's campaign tags, with how many campaigns carry each.
router.get(
  "/funnel-tags",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const rows = await db
      .select()
      .from(funnelTags)
      .where(eq(funnelTags.organizationId, orgId))
      .orderBy(asc(funnelTags.sortOrder), asc(funnelTags.name));

    const counts = new Map<string, number>();
    if (rows.length) {
      const countRows = await db
        .select({ tagId: funnelTagAssignments.tagId, n: sql<number>`count(*)::int` })
        .from(funnelTagAssignments)
        .where(inArray(funnelTagAssignments.tagId, rows.map((r) => r.id)))
        .groupBy(funnelTagAssignments.tagId);
      for (const r of countRows) counts.set(r.tagId, r.n);
    }

    res.json({ data: rows.map((r) => serialize(r, counts.get(r.id) ?? 0)) });
  }),
);

// ─── POST /funnel-tags ───────────────────────────────────────────────
router.post(
  "/funnel-tags",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const body = req.body as { name?: string; color?: string };
    const name = normalizeString(body.name);
    if (!name) throw new ApiError(400, "Tag name is required");
    if (name.length > MAX_TAG_NAME) throw new ApiError(400, `Tag name must be ${MAX_TAG_NAME} characters or fewer`);
    const color = validColor(body.color);

    const [dupe] = await db
      .select({ id: funnelTags.id })
      .from(funnelTags)
      .where(and(eq(funnelTags.organizationId, orgId), sql`lower(${funnelTags.name}) = lower(${name})`));
    if (dupe) throw new ApiError(409, `A tag named "${name}" already exists`);

    // Append to the end of the ordered list.
    const [{ max }] = await db
      .select({ max: sql<number>`coalesce(max(${funnelTags.sortOrder}), 0)::int` })
      .from(funnelTags)
      .where(eq(funnelTags.organizationId, orgId));

    const id = createId("ftag");
    await db.insert(funnelTags).values({ id, organizationId: orgId, name, color, sortOrder: max + 1 });
    const [row] = await db.select().from(funnelTags).where(eq(funnelTags.id, id));
    res.status(201).json({ data: serialize(row) });
  }),
);

// ─── PATCH /funnel-tags/:id ──────────────────────────────────────────
router.patch(
  "/funnel-tags/:id",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const id = String(req.params.id);
    const body = req.body as { name?: string; color?: string; sortOrder?: number };

    const [existing] = await db
      .select()
      .from(funnelTags)
      .where(and(eq(funnelTags.id, id), eq(funnelTags.organizationId, orgId)));
    if (!existing) throw new ApiError(404, "Tag not found");

    const updates: Record<string, unknown> = {};
    if (body.name !== undefined) {
      const name = normalizeString(body.name);
      if (!name) throw new ApiError(400, "Tag name cannot be empty");
      if (name.length > MAX_TAG_NAME) throw new ApiError(400, `Tag name must be ${MAX_TAG_NAME} characters or fewer`);
      const [dupe] = await db
        .select({ id: funnelTags.id })
        .from(funnelTags)
        .where(
          and(
            eq(funnelTags.organizationId, orgId),
            sql`lower(${funnelTags.name}) = lower(${name})`,
            sql`${funnelTags.id} <> ${id}`,
          ),
        );
      if (dupe) throw new ApiError(409, `A tag named "${name}" already exists`);
      updates.name = name;
    }
    if (body.color !== undefined) updates.color = validColor(body.color);
    if (body.sortOrder !== undefined && Number.isInteger(body.sortOrder)) updates.sortOrder = body.sortOrder;

    if (Object.keys(updates).length) {
      await db.update(funnelTags).set(updates).where(eq(funnelTags.id, id));
    }
    const [row] = await db.select().from(funnelTags).where(eq(funnelTags.id, id));
    res.json({ data: serialize(row) });
  }),
);

// ─── DELETE /funnel-tags/:id ─────────────────────────────────────────
// Assignments cascade away with the tag.
router.delete(
  "/funnel-tags/:id",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const id = String(req.params.id);
    await db
      .delete(funnelTags)
      .where(and(eq(funnelTags.id, id), eq(funnelTags.organizationId, orgId)));
    res.json({ data: { id, deleted: true } });
  }),
);

// ─── PUT /funnels/:funnelId/tags ─────────────────────────────────────
// Replace a campaign's tag set. Returns the full tag objects so the
// client can patch its caches without a refetch.
router.put(
  "/funnels/:funnelId/tags",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const funnelId = String(req.params.funnelId);
    const body = req.body as { tagIds?: unknown };
    if (!Array.isArray(body.tagIds) || body.tagIds.some((t) => typeof t !== "string")) {
      throw new ApiError(400, "tagIds must be an array of tag ids");
    }
    const tagIds = [...new Set(body.tagIds as string[])];

    const [funnel] = await db
      .select({ id: funnels.id })
      .from(funnels)
      .where(and(eq(funnels.id, funnelId), eq(funnels.organizationId, orgId)));
    if (!funnel) throw new ApiError(404, "Campaign not found");

    // Only this org's tags can be attached — silently dropping foreign ids
    // would mask client bugs, so reject instead.
    const ownTags = tagIds.length
      ? await db
          .select()
          .from(funnelTags)
          .where(and(eq(funnelTags.organizationId, orgId), inArray(funnelTags.id, tagIds)))
      : [];
    if (ownTags.length !== tagIds.length) throw new ApiError(400, "One or more tags do not exist");

    await db.transaction(async (tx) => {
      await tx.delete(funnelTagAssignments).where(eq(funnelTagAssignments.funnelId, funnelId));
      if (tagIds.length) {
        await tx
          .insert(funnelTagAssignments)
          .values(tagIds.map((tagId) => ({ funnelId, tagId })));
      }
    });

    const ordered = [...ownTags].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
    res.json({ data: { funnelId, tags: ordered.map((t) => ({ id: t.id, name: t.name, color: t.color })) } });
  }),
);

export default router;
