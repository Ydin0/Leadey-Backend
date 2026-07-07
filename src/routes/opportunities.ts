import { Router, Request, Response, NextFunction } from "express";
import { eq, and, desc, asc, sql, inArray, gte, lte, ilike, or } from "drizzle-orm";
import { getAuth } from "@clerk/express";
import { db } from "../db";
import {
  pipelines,
  pipelineStages,
  pipelineMembers,
  opportunities,
  opportunityContacts,
  opportunityEvents,
} from "../db/schema/opportunities";
import { leads, leadEvents } from "../db/schema/leads";
import { masterContacts, masterCompanies } from "../db/schema/master";
import { users } from "../db/schema/organizations";
import { getOrgId } from "../lib/auth";
import { ApiError, createId } from "../lib/helpers";
import { seedDefaultPipeline } from "../lib/opportunities-seed";
import { getPerms, requirePerm } from "../lib/permission-service";
import { hasPerm, scopeOf } from "../lib/permission-catalog";

const router = Router();

// ── Helpers ──────────────────────────────────────────────────────────

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

function getUserId(req: Request): string {
  const auth = getAuth(req);
  if (!auth?.userId) throw new ApiError(401, "Unauthorized");
  return auth.userId;
}

async function resolveUserName(userId: string | null): Promise<string | null> {
  if (!userId) return null;
  const [u] = await db
    .select({ firstName: users.firstName, lastName: users.lastName, email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!u) return null;
  const name = [u.firstName, u.lastName].filter(Boolean).join(" ").trim();
  return name || u.email || null;
}

const ALLOWED_STAGE_TYPES = new Set(["open", "won", "lost"]);

function serializePipeline(p: typeof pipelines.$inferSelect) {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    isDefault: p.isDefault,
    sortOrder: p.sortOrder,
    createdAt: p.createdAt.toISOString(),
  };
}

function serializePipelineMember(
  m: typeof pipelineMembers.$inferSelect,
  u?: typeof users.$inferSelect,
) {
  return {
    id: m.id,
    userId: m.userId,
    role: m.role,
    email: u?.email ?? null,
    firstName: u?.firstName ?? null,
    lastName: u?.lastName ?? null,
    imageUrl: u?.imageUrl ?? null,
    createdAt: m.createdAt.toISOString(),
  };
}

function serializeStage(s: typeof pipelineStages.$inferSelect) {
  return {
    id: s.id,
    pipelineId: s.pipelineId,
    slug: s.slug,
    label: s.label,
    sortOrder: s.sortOrder,
    type: s.type as "open" | "won" | "lost",
    defaultProbability: s.defaultProbability,
    color: s.color,
  };
}

function serializeOpp(
  o: typeof opportunities.$inferSelect,
  funnelId: string | null = null,
) {
  return {
    id: o.id,
    pipelineId: o.pipelineId,
    stageId: o.stageId,
    name: o.name,
    masterCompanyId: o.masterCompanyId,
    masterContactId: o.masterContactId,
    ownerId: o.ownerId,
    sourceLeadId: o.sourceLeadId,
    // The funnel (campaign) the source lead belongs to, when this opportunity
    // was converted from a campaign lead. Lets the client deep-link clicks to
    // the Lead View instead of the dedicated opportunity page.
    funnelId,
    sortOrder: o.sortOrder,
    value: Number(o.value),
    currency: o.currency,
    probabilityOverride: o.probabilityOverride,
    expectedCloseDate: o.expectedCloseDate, // already string
    closedAt: o.closedAt?.toISOString() || null,
    lostReason: o.lostReason,
    notes: o.notes,
    createdAt: o.createdAt.toISOString(),
    updatedAt: o.updatedAt.toISOString(),
  };
}

function serializeEvent(e: typeof opportunityEvents.$inferSelect) {
  return {
    id: e.id,
    opportunityId: e.opportunityId,
    type: e.type,
    meta: e.meta,
    userId: e.userId,
    userName: e.userName,
    createdAt: e.createdAt.toISOString(),
  };
}

/** Resolve sourceLeadId → funnelId for a batch of opportunity rows, so the
 *  client can route opportunity clicks straight into the Lead View. */
async function resolveLeadFunnels(
  rows: Array<{ sourceLeadId: string | null }>,
): Promise<Map<string, string>> {
  const leadIds = Array.from(
    new Set(rows.map((r) => r.sourceLeadId).filter((id): id is string => !!id)),
  );
  const map = new Map<string, string>();
  if (!leadIds.length) return map;
  const leadRows = await db
    .select({ id: leads.id, funnelId: leads.funnelId })
    .from(leads)
    .where(inArray(leads.id, leadIds));
  for (const l of leadRows) map.set(l.id, l.funnelId);
  return map;
}

// ─────────────────────────────────────────────────────────────────────
// Pipelines + Stages
// ─────────────────────────────────────────────────────────────────────

router.get(
  "/pipelines",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    // Lazy-seed if this org has no pipelines yet (e.g. existed before
    // the org.created hook was wired).
    const existingCount = await db
      .select({ id: pipelines.id })
      .from(pipelines)
      .where(eq(pipelines.organizationId, orgId))
      .limit(1);
    if (existingCount.length === 0) {
      await seedDefaultPipeline(orgId);
    }

    const rows = await db
      .select()
      .from(pipelines)
      .where(eq(pipelines.organizationId, orgId))
      .orderBy(asc(pipelines.sortOrder), asc(pipelines.createdAt));
    const pipelineIds = rows.map((p) => p.id);
    const stages = pipelineIds.length
      ? await db
          .select()
          .from(pipelineStages)
          .where(inArray(pipelineStages.pipelineId, pipelineIds))
          .orderBy(asc(pipelineStages.sortOrder))
      : [];
    const byPipeline = new Map<string, typeof stages>();
    for (const s of stages) {
      const arr = byPipeline.get(s.pipelineId) || [];
      arr.push(s);
      byPipeline.set(s.pipelineId, arr);
    }
    // Opportunity count per pipeline — the settings delete flow needs it to
    // decide whether to prompt for a move/delete strategy.
    const counts = pipelineIds.length
      ? await db
          .select({ pipelineId: opportunities.pipelineId, count: sql<number>`COUNT(*)` })
          .from(opportunities)
          .where(inArray(opportunities.pipelineId, pipelineIds))
          .groupBy(opportunities.pipelineId)
      : [];
    const countByPipeline = new Map(counts.map((c) => [c.pipelineId, Number(c.count)]));

    // Members per pipeline, enriched with the user's name/avatar in one lookup.
    const memberRows = pipelineIds.length
      ? await db.select().from(pipelineMembers).where(inArray(pipelineMembers.pipelineId, pipelineIds))
      : [];
    const memberUserIds = [...new Set(memberRows.map((m) => m.userId))];
    const userById = new Map(
      memberUserIds.length
        ? (await db.select().from(users).where(inArray(users.id, memberUserIds))).map((u) => [u.id, u])
        : [],
    );
    const membersByPipeline = new Map<string, ReturnType<typeof serializePipelineMember>[]>();
    for (const m of memberRows) {
      const arr = membersByPipeline.get(m.pipelineId) || [];
      arr.push(serializePipelineMember(m, userById.get(m.userId)));
      membersByPipeline.set(m.pipelineId, arr);
    }

    res.json({
      data: rows.map((p) => ({
        ...serializePipeline(p),
        opportunityCount: countByPipeline.get(p.id) || 0,
        stages: (byPipeline.get(p.id) || []).map(serializeStage),
        members: membersByPipeline.get(p.id) || [],
      })),
    });
  }),
);

// ─── Pipeline members ─────────────────────────────────────────────────
async function assertPipelineInOrg(orgId: string, pipelineId: string) {
  const [p] = await db
    .select({ id: pipelines.id })
    .from(pipelines)
    .where(and(eq(pipelines.id, pipelineId), eq(pipelines.organizationId, orgId)));
  if (!p) throw new ApiError(404, "Pipeline not found");
}

router.get(
  "/pipelines/:id/members",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const pipelineId = req.params.id as string;
    await assertPipelineInOrg(orgId, pipelineId);
    const rows = await db.select().from(pipelineMembers).where(eq(pipelineMembers.pipelineId, pipelineId));
    const ids = [...new Set(rows.map((m) => m.userId))];
    const byId = new Map(
      ids.length ? (await db.select().from(users).where(inArray(users.id, ids))).map((u) => [u.id, u]) : [],
    );
    res.json({ data: rows.map((m) => serializePipelineMember(m, byId.get(m.userId))) });
  }),
);

router.post(
  "/pipelines/:id/members",
  requirePerm("opportunities.managePipelines"),
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const pipelineId = req.params.id as string;
    await assertPipelineInOrg(orgId, pipelineId);
    const userId = String(req.body?.userId || "");
    const role = String(req.body?.role || "contributor");
    if (!userId) throw new ApiError(400, "userId is required");
    // Must be an org member.
    const [u] = await db
      .select()
      .from(users)
      .where(and(eq(users.id, userId), eq(users.organizationId, orgId)));
    if (!u) throw new ApiError(400, "User is not a member of this organization");
    const [existing] = await db
      .select({ id: pipelineMembers.id })
      .from(pipelineMembers)
      .where(and(eq(pipelineMembers.pipelineId, pipelineId), eq(pipelineMembers.userId, userId)));
    if (existing) throw new ApiError(409, "Already a member of this pipeline");
    const row = { id: createId("pm"), pipelineId, userId, role, createdAt: new Date() };
    await db.insert(pipelineMembers).values(row);
    res.status(201).json({ data: serializePipelineMember(row, u) });
  }),
);

router.patch(
  "/pipelines/:id/members/:userId",
  requirePerm("opportunities.managePipelines"),
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const pipelineId = req.params.id as string;
    await assertPipelineInOrg(orgId, pipelineId);
    const role = String(req.body?.role || "contributor");
    await db
      .update(pipelineMembers)
      .set({ role })
      .where(and(eq(pipelineMembers.pipelineId, pipelineId), eq(pipelineMembers.userId, req.params.userId as string)));
    res.json({ data: { userId: req.params.userId, role } });
  }),
);

router.delete(
  "/pipelines/:id/members/:userId",
  requirePerm("opportunities.managePipelines"),
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const pipelineId = req.params.id as string;
    await assertPipelineInOrg(orgId, pipelineId);
    await db
      .delete(pipelineMembers)
      .where(and(eq(pipelineMembers.pipelineId, pipelineId), eq(pipelineMembers.userId, req.params.userId as string)));
    res.json({ data: { userId: req.params.userId, removed: true } });
  }),
);

router.post(
  "/pipelines",
  requirePerm("opportunities.managePipelines"),
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const { name, description } = req.body as { name?: string; description?: string };
    if (!name?.trim()) throw new ApiError(400, "name required");
    const id = createId("pl");
    await db.transaction(async (tx) => {
      const [maxRow] = await tx
        .select({ maxOrder: sql<number>`MAX(${pipelines.sortOrder})` })
        .from(pipelines)
        .where(eq(pipelines.organizationId, orgId));
      await tx.insert(pipelines).values({
        id,
        organizationId: orgId,
        name: name.trim(),
        description: description?.trim() || "",
        isDefault: false,
        sortOrder: (maxRow?.maxOrder ?? -1) + 1,
      });
      // Seed default stages on the new pipeline
      await tx.insert(pipelineStages).values([
        { id: createId("ps"), pipelineId: id, slug: "demo-booked", label: "Demo Booked", sortOrder: 0, type: "open", defaultProbability: 10, color: "signal-blue" },
        { id: createId("ps"), pipelineId: id, slug: "demo-completed", label: "Demo Completed", sortOrder: 1, type: "open", defaultProbability: 30, color: "signal-blue" },
        { id: createId("ps"), pipelineId: id, slug: "proposal-sent", label: "Proposal Sent", sortOrder: 2, type: "open", defaultProbability: 50, color: "signal-slate" },
        { id: createId("ps"), pipelineId: id, slug: "negotiation", label: "Negotiation", sortOrder: 3, type: "open", defaultProbability: 75, color: "signal-slate" },
        { id: createId("ps"), pipelineId: id, slug: "won", label: "Won", sortOrder: 4, type: "won", defaultProbability: 100, color: "signal-green" },
        { id: createId("ps"), pipelineId: id, slug: "lost", label: "Lost", sortOrder: 5, type: "lost", defaultProbability: 0, color: "signal-red" },
      ]);
    });
    const [created] = await db.select().from(pipelines).where(eq(pipelines.id, id));
    const stages = await db
      .select()
      .from(pipelineStages)
      .where(eq(pipelineStages.pipelineId, id))
      .orderBy(asc(pipelineStages.sortOrder));
    res.status(201).json({
      data: { ...serializePipeline(created), stages: stages.map(serializeStage) },
    });
  }),
);

router.post(
  "/pipelines/:id/duplicate",
  requirePerm("opportunities.managePipelines"),
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const sourceId = req.params.id as string;
    const [source] = await db
      .select()
      .from(pipelines)
      .where(and(eq(pipelines.id, sourceId), eq(pipelines.organizationId, orgId)));
    if (!source) throw new ApiError(404, "Pipeline not found");

    const sourceStages = await db
      .select()
      .from(pipelineStages)
      .where(eq(pipelineStages.pipelineId, sourceId))
      .orderBy(asc(pipelineStages.sortOrder));

    // Pick a unique name: "<name> (copy)", then "(copy 2)", "(copy 3)"… so
    // repeated duplication never trips the (org, name) unique constraint.
    const existingNames = new Set(
      (
        await db
          .select({ name: pipelines.name })
          .from(pipelines)
          .where(eq(pipelines.organizationId, orgId))
      ).map((r) => r.name),
    );
    let newName = `${source.name} (copy)`;
    for (let n = 2; existingNames.has(newName); n++) {
      newName = `${source.name} (copy ${n})`;
    }

    const newId = createId("pl");
    await db.transaction(async (tx) => {
      const [maxRow] = await tx
        .select({ maxOrder: sql<number>`MAX(${pipelines.sortOrder})` })
        .from(pipelines)
        .where(eq(pipelines.organizationId, orgId));
      await tx.insert(pipelines).values({
        id: newId,
        organizationId: orgId,
        name: newName,
        description: source.description,
        isDefault: false, // a duplicate is never the default
        sortOrder: (maxRow?.maxOrder ?? -1) + 1,
      });
      // Copy the stage structure (not the opportunities) with fresh ids.
      if (sourceStages.length) {
        await tx.insert(pipelineStages).values(
          sourceStages.map((s) => ({
            id: createId("ps"),
            pipelineId: newId,
            slug: s.slug,
            label: s.label,
            sortOrder: s.sortOrder,
            type: s.type,
            defaultProbability: s.defaultProbability,
            color: s.color,
          })),
        );
      }
    });

    const [created] = await db.select().from(pipelines).where(eq(pipelines.id, newId));
    const stages = await db
      .select()
      .from(pipelineStages)
      .where(eq(pipelineStages.pipelineId, newId))
      .orderBy(asc(pipelineStages.sortOrder));
    res.status(201).json({
      data: {
        ...serializePipeline(created),
        opportunityCount: 0,
        stages: stages.map(serializeStage),
      },
    });
  }),
);

router.patch(
  "/pipelines/:id",
  requirePerm("opportunities.managePipelines"),
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const id = req.params.id as string;
    const [existing] = await db
      .select()
      .from(pipelines)
      .where(and(eq(pipelines.id, id), eq(pipelines.organizationId, orgId)));
    if (!existing) throw new ApiError(404, "Pipeline not found");
    const allowed = ["name", "description", "isDefault", "sortOrder"] as const;
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    for (const k of allowed) {
      if (k in req.body) updates[k] = req.body[k];
    }
    const [updated] = await db
      .update(pipelines)
      .set(updates)
      .where(eq(pipelines.id, id))
      .returning();
    res.json({ data: serializePipeline(updated) });
  }),
);

router.delete(
  "/pipelines/:id",
  requirePerm("opportunities.managePipelines"),
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const id = req.params.id as string;
    const [existing] = await db
      .select()
      .from(pipelines)
      .where(and(eq(pipelines.id, id), eq(pipelines.organizationId, orgId)));
    if (!existing) throw new ApiError(404, "Pipeline not found");
    if (existing.isDefault) {
      throw new ApiError(400, "The default pipeline can't be deleted.");
    }

    const body = (req.body || {}) as {
      strategy?: "move" | "delete";
      targetPipelineId?: string;
      targetStageId?: string;
    };

    const [{ count }] = await db
      .select({ count: sql<number>`COUNT(*)` })
      .from(opportunities)
      .where(eq(opportunities.pipelineId, id));
    const oppCount = Number(count || 0);

    await db.transaction(async (tx) => {
      if (oppCount > 0) {
        if (body.strategy === "move") {
          const targetPipelineId = (body.targetPipelineId || "").trim();
          const targetStageId = (body.targetStageId || "").trim();
          if (!targetPipelineId || !targetStageId) {
            throw new ApiError(400, "Select a pipeline and stage to move opportunities to.");
          }
          if (targetPipelineId === id) {
            throw new ApiError(400, "Choose a different pipeline to move opportunities to.");
          }
          const [target] = await tx
            .select()
            .from(pipelines)
            .where(and(eq(pipelines.id, targetPipelineId), eq(pipelines.organizationId, orgId)));
          if (!target) throw new ApiError(404, "Target pipeline not found");
          const [stage] = await tx
            .select()
            .from(pipelineStages)
            .where(and(eq(pipelineStages.id, targetStageId), eq(pipelineStages.pipelineId, targetPipelineId)));
          if (!stage) throw new ApiError(400, "The selected stage must belong to the target pipeline.");

          // Reassign every opportunity to the target pipeline + stage. Set or
          // clear closedAt to match the destination stage's terminal semantics.
          const isTerminal = stage.type === "won" || stage.type === "lost";
          await tx
            .update(opportunities)
            .set({
              pipelineId: targetPipelineId,
              stageId: targetStageId,
              closedAt: isTerminal ? sql`coalesce(${opportunities.closedAt}, now())` : null,
              updatedAt: new Date(),
            })
            .where(eq(opportunities.pipelineId, id));
        } else if (body.strategy === "delete") {
          // Cascades to opportunity_contacts + opportunity_events.
          await tx.delete(opportunities).where(eq(opportunities.pipelineId, id));
        } else {
          throw new ApiError(
            400,
            "This pipeline has opportunities. Choose to move them to another pipeline or delete them.",
          );
        }
      }
      // Stages cascade on pipeline delete; opportunities have already been
      // moved or deleted, so the restrict FK won't block.
      await tx.delete(pipelines).where(eq(pipelines.id, id));
    });

    res.status(204).end();
  }),
);

// Stages
router.post(
  "/pipelines/:id/stages",
  requirePerm("opportunities.managePipelines"),
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const pipelineId = req.params.id as string;
    const [p] = await db
      .select()
      .from(pipelines)
      .where(and(eq(pipelines.id, pipelineId), eq(pipelines.organizationId, orgId)));
    if (!p) throw new ApiError(404, "Pipeline not found");

    const { label, slug, type, defaultProbability, color } = req.body as {
      label?: string;
      slug?: string;
      type?: string;
      defaultProbability?: number;
      color?: string;
    };
    if (!label?.trim()) throw new ApiError(400, "label required");
    const stageType = type && ALLOWED_STAGE_TYPES.has(type) ? type : "open";
    const resolvedSlug = (slug?.trim() || label.toLowerCase().replace(/[^a-z0-9]+/g, "-")).slice(0, 64);

    const [maxRow] = await db
      .select({ maxOrder: sql<number>`MAX(${pipelineStages.sortOrder})` })
      .from(pipelineStages)
      .where(eq(pipelineStages.pipelineId, pipelineId));
    const id = createId("ps");
    await db.insert(pipelineStages).values({
      id,
      pipelineId,
      slug: resolvedSlug,
      label: label.trim(),
      sortOrder: (maxRow?.maxOrder ?? -1) + 1,
      type: stageType,
      defaultProbability: defaultProbability ?? 50,
      color: color || null,
    });
    const [created] = await db.select().from(pipelineStages).where(eq(pipelineStages.id, id));
    res.status(201).json({ data: serializeStage(created) });
  }),
);

router.patch(
  "/pipelines/:id/stages/reorder",
  requirePerm("opportunities.managePipelines"),
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const pipelineId = req.params.id as string;
    const { stageIds } = req.body as { stageIds: string[] };
    if (!Array.isArray(stageIds)) throw new ApiError(400, "stageIds array required");

    const [p] = await db
      .select()
      .from(pipelines)
      .where(and(eq(pipelines.id, pipelineId), eq(pipelines.organizationId, orgId)));
    if (!p) throw new ApiError(404, "Pipeline not found");

    await db.transaction(async (tx) => {
      for (let i = 0; i < stageIds.length; i++) {
        await tx
          .update(pipelineStages)
          .set({ sortOrder: i })
          .where(
            and(
              eq(pipelineStages.id, stageIds[i]),
              eq(pipelineStages.pipelineId, pipelineId),
            ),
          );
      }
    });
    res.json({ data: { ok: true } });
  }),
);

router.patch(
  "/pipelines/:id/stages/:stageId",
  requirePerm("opportunities.managePipelines"),
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const pipelineId = req.params.id as string;
    const stageId = (req.params as any).stageId as string;
    const [p] = await db
      .select()
      .from(pipelines)
      .where(and(eq(pipelines.id, pipelineId), eq(pipelines.organizationId, orgId)));
    if (!p) throw new ApiError(404, "Pipeline not found");

    const allowed = ["label", "type", "defaultProbability", "color"] as const;
    const updates: Record<string, unknown> = {};
    for (const k of allowed) {
      if (k in req.body) updates[k] = req.body[k];
    }
    if (updates.type && !ALLOWED_STAGE_TYPES.has(updates.type as string)) {
      throw new ApiError(400, "Invalid stage type");
    }
    const [updated] = await db
      .update(pipelineStages)
      .set(updates)
      .where(and(eq(pipelineStages.id, stageId), eq(pipelineStages.pipelineId, pipelineId)))
      .returning();
    if (!updated) throw new ApiError(404, "Stage not found");
    res.json({ data: serializeStage(updated) });
  }),
);

router.delete(
  "/pipelines/:id/stages/:stageId",
  requirePerm("opportunities.managePipelines"),
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const pipelineId = req.params.id as string;
    const stageId = (req.params as any).stageId as string;
    const [p] = await db
      .select()
      .from(pipelines)
      .where(and(eq(pipelines.id, pipelineId), eq(pipelines.organizationId, orgId)));
    if (!p) throw new ApiError(404, "Pipeline not found");

    const [openCount] = await db
      .select({ count: sql<number>`COUNT(*)` })
      .from(opportunities)
      .where(eq(opportunities.stageId, stageId));
    if (Number(openCount?.count || 0) > 0) {
      throw new ApiError(400, "Cannot delete a stage with opportunities. Move them first.");
    }
    await db.delete(pipelineStages).where(eq(pipelineStages.id, stageId));
    res.status(204).end();
  }),
);

// ─────────────────────────────────────────────────────────────────────
// Opportunities
// ─────────────────────────────────────────────────────────────────────

// POST /opportunities/reorder — persist the kanban order of a stage column.
// Body: { stageId, orderedIds }. Each id gets sortOrder = its index and its
// stageId set to the target (so a cross-column drag lands + orders in one call).
router.post(
  "/opportunities/reorder",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const perms = await getPerms(req);
    if (scopeOf(perms.permissions, "opportunities.view") === "none") {
      throw new ApiError(403, "Not allowed");
    }
    const stageId = String(req.body?.stageId || "");
    const orderedIds: string[] = Array.isArray(req.body?.orderedIds)
      ? (req.body.orderedIds as unknown[]).map(String)
      : [];
    if (!stageId || orderedIds.length === 0) {
      throw new ApiError(400, "stageId and orderedIds are required");
    }

    // The target stage must belong to this org (via its pipeline); its type
    // drives terminal semantics (won/lost set closedAt, open clears it).
    const [stage] = await db
      .select({ id: pipelineStages.id, type: pipelineStages.type })
      .from(pipelineStages)
      .innerJoin(pipelines, eq(pipelines.id, pipelineStages.pipelineId))
      .where(and(eq(pipelineStages.id, stageId), eq(pipelines.organizationId, orgId)));
    if (!stage) throw new ApiError(404, "Stage not found");
    const isTerminal = stage.type !== "open";

    await db.transaction(async (tx) => {
      for (let i = 0; i < orderedIds.length; i++) {
        await tx
          .update(opportunities)
          .set({
            stageId,
            sortOrder: i,
            updatedAt: new Date(),
            // Keep won/lost closed (idempotent); reopen when dropped into open.
            closedAt: isTerminal ? sql`coalesce(${opportunities.closedAt}, now())` : null,
            ...(isTerminal ? {} : { lostReason: null }),
          })
          .where(and(eq(opportunities.id, orderedIds[i]), eq(opportunities.organizationId, orgId)));
      }
    });

    res.json({ data: { ok: true } });
  }),
);

router.get(
  "/opportunities",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const {
      pipelineId,
      stageId,
      ownerId,
      q,
      closeDateBefore,
      summary,
    } = req.query as Record<string, string | undefined>;

    // Visibility: "assigned" forces own-only (ignoring any client ownerId),
    // "none" returns nothing, "all" honors the client owner filter.
    const perms = await getPerms(req);
    const oppScope = scopeOf(perms.permissions, "opportunities.view");
    if (oppScope === "none") {
      res.json({ data: [], summary: null });
      return;
    }

    const conditions = [eq(opportunities.organizationId, orgId)];
    if (pipelineId) conditions.push(eq(opportunities.pipelineId, pipelineId));
    if (stageId) conditions.push(eq(opportunities.stageId, stageId));
    if (oppScope === "assigned") {
      // Own deals OR deals in a pipeline this user is a member of.
      const me = getUserId(req);
      const myPipelines = await db
        .select({ pipelineId: pipelineMembers.pipelineId })
        .from(pipelineMembers)
        .where(eq(pipelineMembers.userId, me));
      const ids = myPipelines.map((p) => p.pipelineId);
      conditions.push(
        ids.length
          ? or(eq(opportunities.ownerId, me), inArray(opportunities.pipelineId, ids))!
          : eq(opportunities.ownerId, me),
      );
    } else if (ownerId) {
      // ownerId may be a single id or a comma-separated list (multi-select).
      const ownerIds = ownerId.split(",").map((s) => s.trim()).filter(Boolean);
      if (ownerIds.length === 1) conditions.push(eq(opportunities.ownerId, ownerIds[0]));
      else if (ownerIds.length > 1) conditions.push(inArray(opportunities.ownerId, ownerIds));
    }
    if (q) {
      // Search by opp name OR linked company name
      conditions.push(
        or(
          ilike(opportunities.name, `%${q}%`),
          ilike(opportunities.notes, `%${q}%`),
        )!,
      );
    }
    if (closeDateBefore) {
      conditions.push(lte(opportunities.expectedCloseDate, closeDateBefore));
    }

    const rows = await db
      .select()
      .from(opportunities)
      .where(and(...conditions))
      // Board order: manual position within a stage first, newest as tiebreak.
      .orderBy(asc(opportunities.sortOrder), desc(opportunities.updatedAt));

    let summaryPayload: any = null;
    if (summary === "1" || summary === "true") {
      // Pull stages so we can compute weighted value using each opp's
      // probability (override OR stage default).
      const allStages = await db
        .select()
        .from(pipelineStages)
        .innerJoin(pipelines, eq(pipelines.id, pipelineStages.pipelineId))
        .where(eq(pipelines.organizationId, orgId));
      const stageById = new Map<string, typeof allStages[number]["pipeline_stages"]>();
      for (const s of allStages) stageById.set(s.pipeline_stages.id, s.pipeline_stages);

      let totalValue = 0;
      let weightedValue = 0;
      const byStage = new Map<string, { stageId: string; count: number; totalValue: number }>();
      let wonCount = 0;
      let wonValue = 0;
      let lostCount = 0;
      let lostValue = 0;
      let wonThisMonthCount = 0;
      let wonThisMonthValue = 0;
      const now = new Date();
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
      const ninetyDaysAgo = Date.now() - 90 * 86400000;
      for (const o of rows) {
        const stage = stageById.get(o.stageId);
        const val = Number(o.value);
        const probability = o.probabilityOverride ?? stage?.defaultProbability ?? 50;
        if (stage?.type === "open") {
          totalValue += val;
          weightedValue += val * (probability / 100);
        }
        if (stage?.type === "won") {
          wonCount++;
          wonValue += val;
          if (o.closedAt && o.closedAt.getTime() >= startOfMonth) {
            wonThisMonthCount++;
            wonThisMonthValue += val;
          }
        }
        if (stage?.type === "lost") {
          lostCount++;
          lostValue += val;
        }
        const bucket = byStage.get(o.stageId) || { stageId: o.stageId, count: 0, totalValue: 0 };
        bucket.count++;
        bucket.totalValue += val;
        byStage.set(o.stageId, bucket);
      }
      const recentWon = rows.filter(
        (o) => stageById.get(o.stageId)?.type === "won" && o.closedAt && o.closedAt.getTime() >= ninetyDaysAgo,
      ).length;
      const recentLost = rows.filter(
        (o) => stageById.get(o.stageId)?.type === "lost" && o.closedAt && o.closedAt.getTime() >= ninetyDaysAgo,
      ).length;
      const winRate = recentWon + recentLost > 0 ? recentWon / (recentWon + recentLost) : 0;
      const openCount = rows.filter((o) => stageById.get(o.stageId)?.type === "open").length;

      summaryPayload = {
        totalCount: rows.length,
        openCount,
        totalValue,
        weightedValue,
        byStage: Array.from(byStage.values()),
        won: { count: wonCount, totalValue: wonValue },
        lost: { count: lostCount, totalValue: lostValue },
        wonThisMonth: { count: wonThisMonthCount, totalValue: wonThisMonthValue },
        avgDealSize: wonCount > 0 ? wonValue / wonCount : 0,
        winRate,
      };
    }

    const leadFunnels = await resolveLeadFunnels(rows);
    res.json({
      data: rows.map((o) => serializeOpp(o, o.sourceLeadId ? leadFunnels.get(o.sourceLeadId) ?? null : null)),
      summary: summaryPayload,
    });
  }),
);

router.post(
  "/opportunities",
  requirePerm("opportunities.create"),
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const userId = getUserId(req);
    const perms = await getPerms(req);
    const {
      pipelineId,
      stageId,
      name,
      masterCompanyId,
      masterContactId,
      ownerId,
      sourceLeadId,
      value,
      currency,
      probabilityOverride,
      expectedCloseDate,
      notes,
    } = req.body as Record<string, any>;

    // Without editAll, an opp can only be created owned by yourself.
    const resolvedOwner = hasPerm(perms.permissions, "opportunities.editAll") ? (ownerId || userId) : userId;

    if (!pipelineId) throw new ApiError(400, "pipelineId required");
    if (!stageId) throw new ApiError(400, "stageId required");
    if (!name?.trim()) throw new ApiError(400, "name required");

    // Verify pipeline + stage belong to this org
    const [p] = await db
      .select()
      .from(pipelines)
      .where(and(eq(pipelines.id, pipelineId), eq(pipelines.organizationId, orgId)));
    if (!p) throw new ApiError(404, "Pipeline not found");
    const [stage] = await db
      .select()
      .from(pipelineStages)
      .where(and(eq(pipelineStages.id, stageId), eq(pipelineStages.pipelineId, pipelineId)));
    if (!stage) throw new ApiError(404, "Stage not found in pipeline");

    const id = createId("opp");
    const userName = await resolveUserName(userId);
    await db.transaction(async (tx) => {
      await tx.insert(opportunities).values({
        id,
        organizationId: orgId,
        pipelineId,
        stageId,
        name: name.trim(),
        masterCompanyId: masterCompanyId || null,
        masterContactId: masterContactId || null,
        ownerId: resolvedOwner,
        sourceLeadId: sourceLeadId || null,
        value: value != null ? String(value) : "0",
        currency: currency || "USD",
        probabilityOverride: probabilityOverride ?? null,
        expectedCloseDate: expectedCloseDate || null,
        closedAt: stage.type === "open" ? null : new Date(),
        notes: notes || null,
      });
      await tx.insert(opportunityEvents).values({
        id: createId("oe"),
        opportunityId: id,
        organizationId: orgId,
        type: "created",
        meta: { sourceLeadId: sourceLeadId || null, stageSlug: stage.slug },
        userId,
        userName,
      });
    });
    const [created] = await db.select().from(opportunities).where(eq(opportunities.id, id));
    res.status(201).json({ data: serializeOpp(created) });
  }),
);

router.get(
  "/opportunities/:id",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const id = req.params.id as string;
    const [opp] = await db
      .select()
      .from(opportunities)
      .where(and(eq(opportunities.id, id), eq(opportunities.organizationId, orgId)));
    if (!opp) throw new ApiError(404, "Opportunity not found");

    // Visibility: "none" can't open any; "assigned" can open their own deals
    // or any deal in a pipeline they're a member of.
    const perms = await getPerms(req);
    const oppScope = scopeOf(perms.permissions, "opportunities.view");
    if (oppScope === "none") throw new ApiError(404, "Opportunity not found");
    if (oppScope === "assigned" && opp.ownerId !== getUserId(req)) {
      const [member] = await db
        .select({ id: pipelineMembers.id })
        .from(pipelineMembers)
        .where(and(eq(pipelineMembers.pipelineId, opp.pipelineId), eq(pipelineMembers.userId, getUserId(req))));
      if (!member) throw new ApiError(404, "Opportunity not found");
    }

    // Join company + primary contact + additional contacts
    const company = opp.masterCompanyId
      ? (await db.select().from(masterCompanies).where(eq(masterCompanies.id, opp.masterCompanyId)))[0]
      : null;
    const primaryContact = opp.masterContactId
      ? (await db.select().from(masterContacts).where(eq(masterContacts.id, opp.masterContactId)))[0]
      : null;
    const additionalContactRows = await db
      .select()
      .from(opportunityContacts)
      .innerJoin(masterContacts, eq(masterContacts.id, opportunityContacts.masterContactId))
      .where(eq(opportunityContacts.opportunityId, id));

    const leadFunnels = await resolveLeadFunnels([opp]);

    res.json({
      data: {
        ...serializeOpp(opp, opp.sourceLeadId ? leadFunnels.get(opp.sourceLeadId) ?? null : null),
        company: company
          ? { id: company.id, name: company.name, domain: company.domain, logo: company.logo, industry: company.industry }
          : null,
        primaryContact: primaryContact
          ? {
              id: primaryContact.id,
              fullName: primaryContact.fullName,
              firstName: primaryContact.firstName,
              lastName: primaryContact.lastName,
              email: primaryContact.email,
              phone: primaryContact.phone,
              currentTitle: primaryContact.currentTitle,
              linkedinUrl: primaryContact.linkedinUrl,
            }
          : null,
        additionalContacts: additionalContactRows.map((row) => ({
          id: row.master_contacts.id,
          fullName: row.master_contacts.fullName,
          email: row.master_contacts.email,
          phone: row.master_contacts.phone,
          currentTitle: row.master_contacts.currentTitle,
          role: row.opportunity_contacts.role,
        })),
      },
    });
  }),
);

/** Mirror an opportunity stage/pipeline move onto the source lead's timeline
 *  so the lead view (and universal company profile) shows
 *  "Opportunity status changed from [pipeline · stage] → [pipeline · stage]".
 *  Best-effort: no-op when the opp has no (living) source lead. */
async function logStageChangeOnLead(opts: {
  opp: { id: string; name: string; sourceLeadId: string | null };
  fromPipelineId: string;
  fromStageId: string;
  toPipelineId: string;
  toStageId: string;
  userId: string | null;
  userName: string | null;
}) {
  const { opp } = opts;
  if (!opp.sourceLeadId) return;
  if (opts.fromStageId === opts.toStageId && opts.fromPipelineId === opts.toPipelineId) return;
  try {
    // sourceLeadId has no FK — verify the lead still exists before inserting
    // an event that carries a hard FK to it.
    const [leadRow] = await db
      .select({ id: leads.id, currentStep: leads.currentStep })
      .from(leads)
      .where(eq(leads.id, opp.sourceLeadId))
      .limit(1);
    if (!leadRow) return;

    const pipelineIds = [...new Set([opts.fromPipelineId, opts.toPipelineId])];
    const stageIds = [...new Set([opts.fromStageId, opts.toStageId])];
    const [pipes, stages] = await Promise.all([
      db.select({ id: pipelines.id, name: pipelines.name }).from(pipelines).where(inArray(pipelines.id, pipelineIds)),
      db.select({ id: pipelineStages.id, label: pipelineStages.label }).from(pipelineStages).where(inArray(pipelineStages.id, stageIds)),
    ]);
    const pipelineName = new Map(pipes.map((p) => [p.id, p.name]));
    const stageLabel = new Map(stages.map((s) => [s.id, s.label]));

    await db.insert(leadEvents).values({
      id: createId("event"),
      leadId: leadRow.id,
      type: "opportunity_stage_change",
      outcome: stageLabel.get(opts.toStageId) ?? null,
      stepIndex: Math.max((leadRow.currentStep || 1) - 1, 0),
      meta: {
        opportunityId: opp.id,
        oppName: opp.name,
        fromPipeline: pipelineName.get(opts.fromPipelineId) ?? null,
        fromStage: stageLabel.get(opts.fromStageId) ?? null,
        toPipeline: pipelineName.get(opts.toPipelineId) ?? null,
        toStage: stageLabel.get(opts.toStageId) ?? null,
        userId: opts.userId,
        userName: opts.userName,
      },
    });
  } catch (err) {
    console.warn("[opportunities] lead timeline mirror failed:", err instanceof Error ? err.message : err);
  }
}

router.patch(
  "/opportunities/:id",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const userId = getUserId(req);
    const id = req.params.id as string;
    const [existing] = await db
      .select()
      .from(opportunities)
      .where(and(eq(opportunities.id, id), eq(opportunities.organizationId, orgId)));
    if (!existing) throw new ApiError(404, "Opportunity not found");

    // Editing is allowed on your own opp; touching others' requires editAll.
    const perms = await getPerms(req);
    const canEditAll = hasPerm(perms.permissions, "opportunities.editAll");
    if (!canEditAll && existing.ownerId !== userId) {
      throw new ApiError(403, "You can only edit opportunities assigned to you");
    }
    // Reassigning ownership to someone else also requires editAll.
    if (!canEditAll && "ownerId" in req.body && req.body.ownerId && req.body.ownerId !== userId) {
      throw new ApiError(403, "You can't reassign this opportunity");
    }

    const allowed = [
      "name", "pipelineId", "stageId", "masterCompanyId", "masterContactId", "ownerId",
      "value", "currency", "probabilityOverride", "expectedCloseDate",
      "notes", "lostReason",
    ] as const;
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    const events: Array<{ type: string; meta: Record<string, unknown> }> = [];

    for (const k of allowed) {
      if (k in req.body) {
        let value = req.body[k];
        if (k === "value" && value != null) value = String(value);
        updates[k] = value === "" ? null : value;
        if (k === "stageId" && value !== existing.stageId) {
          events.push({ type: "stage_changed", meta: { from: existing.stageId, to: value } });
        }
        if (k === "ownerId" && value !== existing.ownerId) {
          events.push({ type: "owner_changed", meta: { from: existing.ownerId, to: value } });
        }
        if (k === "value" && Number(value) !== Number(existing.value)) {
          events.push({ type: "value_changed", meta: { from: Number(existing.value), to: Number(value) } });
        }
        if (k === "expectedCloseDate" && value !== existing.expectedCloseDate) {
          events.push({ type: "close_date_changed", meta: { from: existing.expectedCloseDate, to: value } });
        }
      }
    }

    // Moving the opportunity to a different pipeline. Validate it belongs to
    // the org, and make sure the resulting stage actually lives in that
    // pipeline (auto-fall back to its first stage if the client didn't supply a
    // valid one) so the deal never points at a stage from another pipeline.
    const newPipelineId = updates.pipelineId as string | undefined;
    if (newPipelineId && newPipelineId !== existing.pipelineId) {
      const [p] = await db
        .select()
        .from(pipelines)
        .where(and(eq(pipelines.id, newPipelineId), eq(pipelines.organizationId, orgId)));
      if (!p) throw new ApiError(404, "Pipeline not found");
      events.push({ type: "pipeline_changed", meta: { from: existing.pipelineId, to: newPipelineId } });

      const targetStageId = (updates.stageId as string | undefined) ?? existing.stageId;
      const [inPipeline] = await db
        .select({ id: pipelineStages.id })
        .from(pipelineStages)
        .where(and(eq(pipelineStages.id, targetStageId), eq(pipelineStages.pipelineId, newPipelineId)));
      if (!inPipeline) {
        const [first] = await db
          .select()
          .from(pipelineStages)
          .where(eq(pipelineStages.pipelineId, newPipelineId))
          .orderBy(asc(pipelineStages.sortOrder))
          .limit(1);
        if (!first) throw new ApiError(400, "Target pipeline has no stages");
        updates.stageId = first.id;
      }
    }

    // Handle stage type transitions for closedAt
    let stageType: "open" | "won" | "lost" | null = null;
    if (updates.stageId && updates.stageId !== existing.stageId) {
      const [newStage] = await db
        .select()
        .from(pipelineStages)
        .where(eq(pipelineStages.id, updates.stageId as string));
      if (!newStage) throw new ApiError(404, "Stage not found");
      stageType = newStage.type as "open" | "won" | "lost";
      if (stageType !== "open" && !existing.closedAt) {
        updates.closedAt = new Date();
        events.push({ type: stageType, meta: { stageId: newStage.id } });
      } else if (stageType === "open" && existing.closedAt) {
        updates.closedAt = null;
        events.push({ type: "reopened", meta: { stageId: newStage.id } });
      }
    }

    const [updated] = await db
      .update(opportunities)
      .set(updates)
      .where(eq(opportunities.id, id))
      .returning();

    if (events.length > 0) {
      const userName = await resolveUserName(userId);
      await db.insert(opportunityEvents).values(
        events.map((e) => ({
          id: createId("oe"),
          opportunityId: id,
          organizationId: orgId,
          type: e.type,
          meta: e.meta,
          userId,
          userName,
        })),
      );
      // Stage / pipeline moves also land on the source lead's timeline.
      if (updated.stageId !== existing.stageId || updated.pipelineId !== existing.pipelineId) {
        await logStageChangeOnLead({
          opp: { id: updated.id, name: updated.name, sourceLeadId: updated.sourceLeadId },
          fromPipelineId: existing.pipelineId,
          fromStageId: existing.stageId,
          toPipelineId: updated.pipelineId,
          toStageId: updated.stageId,
          userId,
          userName,
        });
      }
    }

    res.json({ data: serializeOpp(updated) });
  }),
);

router.delete(
  "/opportunities/:id",
  requirePerm("opportunities.delete"),
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const id = req.params.id as string;
    const [existing] = await db
      .select()
      .from(opportunities)
      .where(and(eq(opportunities.id, id), eq(opportunities.organizationId, orgId)));
    if (!existing) throw new ApiError(404, "Opportunity not found");
    await db.transaction(async (tx) => {
      // Clear leads.opportunity_id pointing at this row (no FK constraint
      // by design — we manage cleanup here to keep history).
      await tx.update(leads).set({ opportunityId: null }).where(eq(leads.opportunityId, id));
      await tx.delete(opportunities).where(eq(opportunities.id, id));
    });
    res.status(204).end();
  }),
);

// Convenience: win/lose/reopen
router.post(
  "/opportunities/:id/win",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const userId = getUserId(req);
    const id = req.params.id as string;
    const [opp] = await db
      .select()
      .from(opportunities)
      .where(and(eq(opportunities.id, id), eq(opportunities.organizationId, orgId)));
    if (!opp) throw new ApiError(404, "Opportunity not found");
    const [wonStage] = await db
      .select()
      .from(pipelineStages)
      .where(and(eq(pipelineStages.pipelineId, opp.pipelineId), eq(pipelineStages.type, "won")))
      .orderBy(asc(pipelineStages.sortOrder))
      .limit(1);
    if (!wonStage) throw new ApiError(400, "Pipeline has no 'won' stage");
    const userName = await resolveUserName(userId);
    await db.transaction(async (tx) => {
      await tx
        .update(opportunities)
        .set({ stageId: wonStage.id, closedAt: new Date(), updatedAt: new Date() })
        .where(eq(opportunities.id, id));
      await tx.insert(opportunityEvents).values({
        id: createId("oe"),
        opportunityId: id,
        organizationId: orgId,
        type: "won",
        meta: { stageId: wonStage.id },
        userId,
        userName,
      });
    });
    await logStageChangeOnLead({
      opp: { id: opp.id, name: opp.name, sourceLeadId: opp.sourceLeadId },
      fromPipelineId: opp.pipelineId,
      fromStageId: opp.stageId,
      toPipelineId: opp.pipelineId,
      toStageId: wonStage.id,
      userId,
      userName,
    });
    const [updated] = await db.select().from(opportunities).where(eq(opportunities.id, id));
    res.json({ data: serializeOpp(updated) });
  }),
);

router.post(
  "/opportunities/:id/lose",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const userId = getUserId(req);
    const id = req.params.id as string;
    const { reason } = req.body as { reason?: string };
    const [opp] = await db
      .select()
      .from(opportunities)
      .where(and(eq(opportunities.id, id), eq(opportunities.organizationId, orgId)));
    if (!opp) throw new ApiError(404, "Opportunity not found");
    const [lostStage] = await db
      .select()
      .from(pipelineStages)
      .where(and(eq(pipelineStages.pipelineId, opp.pipelineId), eq(pipelineStages.type, "lost")))
      .orderBy(asc(pipelineStages.sortOrder))
      .limit(1);
    if (!lostStage) throw new ApiError(400, "Pipeline has no 'lost' stage");
    const userName = await resolveUserName(userId);
    await db.transaction(async (tx) => {
      await tx
        .update(opportunities)
        .set({ stageId: lostStage.id, closedAt: new Date(), lostReason: reason || null, updatedAt: new Date() })
        .where(eq(opportunities.id, id));
      await tx.insert(opportunityEvents).values({
        id: createId("oe"),
        opportunityId: id,
        organizationId: orgId,
        type: "lost",
        meta: { stageId: lostStage.id, reason: reason || null },
        userId,
        userName,
      });
    });
    await logStageChangeOnLead({
      opp: { id: opp.id, name: opp.name, sourceLeadId: opp.sourceLeadId },
      fromPipelineId: opp.pipelineId,
      fromStageId: opp.stageId,
      toPipelineId: opp.pipelineId,
      toStageId: lostStage.id,
      userId,
      userName,
    });
    const [updated] = await db.select().from(opportunities).where(eq(opportunities.id, id));
    res.json({ data: serializeOpp(updated) });
  }),
);

router.post(
  "/opportunities/:id/reopen",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const userId = getUserId(req);
    const id = req.params.id as string;
    const [opp] = await db
      .select()
      .from(opportunities)
      .where(and(eq(opportunities.id, id), eq(opportunities.organizationId, orgId)));
    if (!opp) throw new ApiError(404, "Opportunity not found");
    // Move to last open stage (highest sortOrder where type=open)
    const [openStage] = await db
      .select()
      .from(pipelineStages)
      .where(and(eq(pipelineStages.pipelineId, opp.pipelineId), eq(pipelineStages.type, "open")))
      .orderBy(desc(pipelineStages.sortOrder))
      .limit(1);
    if (!openStage) throw new ApiError(400, "Pipeline has no open stage to reopen into");
    const userName = await resolveUserName(userId);
    await db.transaction(async (tx) => {
      await tx
        .update(opportunities)
        .set({ stageId: openStage.id, closedAt: null, lostReason: null, updatedAt: new Date() })
        .where(eq(opportunities.id, id));
      await tx.insert(opportunityEvents).values({
        id: createId("oe"),
        opportunityId: id,
        organizationId: orgId,
        type: "reopened",
        meta: { stageId: openStage.id },
        userId,
        userName,
      });
    });
    await logStageChangeOnLead({
      opp: { id: opp.id, name: opp.name, sourceLeadId: opp.sourceLeadId },
      fromPipelineId: opp.pipelineId,
      fromStageId: opp.stageId,
      toPipelineId: opp.pipelineId,
      toStageId: openStage.id,
      userId,
      userName,
    });
    const [updated] = await db.select().from(opportunities).where(eq(opportunities.id, id));
    res.json({ data: serializeOpp(updated) });
  }),
);

// Events
router.get(
  "/opportunities/:id/events",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const id = req.params.id as string;
    const [opp] = await db
      .select({ id: opportunities.id })
      .from(opportunities)
      .where(and(eq(opportunities.id, id), eq(opportunities.organizationId, orgId)));
    if (!opp) throw new ApiError(404, "Opportunity not found");
    const rows = await db
      .select()
      .from(opportunityEvents)
      .where(eq(opportunityEvents.opportunityId, id))
      .orderBy(desc(opportunityEvents.createdAt))
      .limit(100);
    res.json({ data: rows.map(serializeEvent) });
  }),
);

router.post(
  "/opportunities/:id/events",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const userId = getUserId(req);
    const id = req.params.id as string;
    const { note } = req.body as { note?: string };
    if (!note?.trim()) throw new ApiError(400, "note required");

    const [opp] = await db
      .select({ id: opportunities.id })
      .from(opportunities)
      .where(and(eq(opportunities.id, id), eq(opportunities.organizationId, orgId)));
    if (!opp) throw new ApiError(404, "Opportunity not found");

    const eventId = createId("oe");
    const userName = await resolveUserName(userId);
    await db.insert(opportunityEvents).values({
      id: eventId,
      opportunityId: id,
      organizationId: orgId,
      type: "note_added",
      meta: { note: note.trim() },
      userId,
      userName,
    });
    const [created] = await db.select().from(opportunityEvents).where(eq(opportunityEvents.id, eventId));
    res.status(201).json({ data: serializeEvent(created) });
  }),
);

// Contacts
router.post(
  "/opportunities/:id/contacts",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const userId = getUserId(req);
    const id = req.params.id as string;
    const { masterContactId, role } = req.body as { masterContactId?: string; role?: string };
    if (!masterContactId) throw new ApiError(400, "masterContactId required");

    const [opp] = await db
      .select({ id: opportunities.id })
      .from(opportunities)
      .where(and(eq(opportunities.id, id), eq(opportunities.organizationId, orgId)));
    if (!opp) throw new ApiError(404, "Opportunity not found");

    await db.insert(opportunityContacts).values({
      opportunityId: id,
      masterContactId,
      role: role || null,
    });
    const userName = await resolveUserName(userId);
    await db.insert(opportunityEvents).values({
      id: createId("oe"),
      opportunityId: id,
      organizationId: orgId,
      type: "contact_added",
      meta: { masterContactId, role },
      userId,
      userName,
    });
    res.status(201).json({ data: { ok: true } });
  }),
);

router.delete(
  "/opportunities/:id/contacts/:contactId",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const id = req.params.id as string;
    const contactId = (req.params as any).contactId as string;
    const [opp] = await db
      .select({ id: opportunities.id })
      .from(opportunities)
      .where(and(eq(opportunities.id, id), eq(opportunities.organizationId, orgId)));
    if (!opp) throw new ApiError(404, "Opportunity not found");
    await db
      .delete(opportunityContacts)
      .where(
        and(
          eq(opportunityContacts.opportunityId, id),
          eq(opportunityContacts.masterContactId, contactId),
        ),
      );
    res.status(204).end();
  }),
);

// ─────────────────────────────────────────────────────────────────────
// Convert lead → opportunity (the primary v1 entry point)
// ─────────────────────────────────────────────────────────────────────

router.post(
  "/leads/:id/convert",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const userId = getUserId(req);
    const leadId = req.params.id as string;
    const {
      pipelineId,
      stageId,
      name,
      value,
      currency,
      expectedCloseDate,
      ownerId,
      notes,
    } = req.body as Record<string, any>;

    // Verify lead belongs to this org (via funnel)
    const [lead] = await db
      .select()
      .from(leads)
      .where(eq(leads.id, leadId));
    if (!lead) throw new ApiError(404, "Lead not found");

    // Verify pipeline + stage belong to this org
    const [p] = await db
      .select()
      .from(pipelines)
      .where(and(eq(pipelines.id, pipelineId), eq(pipelines.organizationId, orgId)));
    if (!p) throw new ApiError(404, "Pipeline not found");
    const [stage] = await db
      .select()
      .from(pipelineStages)
      .where(and(eq(pipelineStages.id, stageId), eq(pipelineStages.pipelineId, pipelineId)));
    if (!stage) throw new ApiError(404, "Stage not found in pipeline");

    // Canonical person link first; linkedin/email lookups remain as the
    // fallback for legacy rows the identity backfill couldn't resolve.
    let masterContactId: string | null = lead.masterContactId ?? null;
    if (!masterContactId && lead.linkedinUrl) {
      const [m] = await db
        .select({ id: masterContacts.id })
        .from(masterContacts)
        .where(
          and(
            eq(masterContacts.organizationId, orgId),
            eq(masterContacts.linkedinUrl, lead.linkedinUrl),
          ),
        )
        .limit(1);
      if (m) masterContactId = m.id;
    }
    if (!masterContactId && lead.email) {
      const [m] = await db
        .select({ id: masterContacts.id })
        .from(masterContacts)
        .where(
          and(
            eq(masterContacts.organizationId, orgId),
            sql`LOWER(${masterContacts.email}) = LOWER(${lead.email})`,
          ),
        )
        .limit(1);
      if (m) masterContactId = m.id;
    }

    // Resolve master company by domain
    let masterCompanyId: string | null = null;
    if (lead.companyDomain) {
      const [c] = await db
        .select({ id: masterCompanies.id })
        .from(masterCompanies)
        .where(
          and(
            eq(masterCompanies.organizationId, orgId),
            eq(masterCompanies.domain, lead.companyDomain),
          ),
        )
        .limit(1);
      if (c) masterCompanyId = c.id;
    }

    const oppId = createId("opp");
    const userName = await resolveUserName(userId);
    const oppName = name?.trim() || `${lead.company || lead.name} — Opportunity`;
    await db.transaction(async (tx) => {
      await tx.insert(opportunities).values({
        id: oppId,
        organizationId: orgId,
        pipelineId,
        stageId,
        name: oppName,
        masterCompanyId,
        masterContactId,
        ownerId: ownerId || userId,
        sourceLeadId: leadId,
        value: value != null ? String(value) : "0",
        currency: currency || "USD",
        expectedCloseDate: expectedCloseDate || null,
        notes: notes || null,
        closedAt: stage.type === "open" ? null : new Date(),
      });
      await tx
        .update(leads)
        .set({ opportunityId: oppId, updatedAt: new Date() })
        .where(eq(leads.id, leadId));
      // Log on both timelines
      await tx.insert(opportunityEvents).values({
        id: createId("oe"),
        opportunityId: oppId,
        organizationId: orgId,
        type: "created",
        meta: { sourceLeadId: leadId, stageSlug: stage.slug, fromConversion: true },
        userId,
        userName,
      });
      await tx.insert(leadEvents).values({
        id: createId("le"),
        leadId,
        type: "converted",
        outcome: "opportunity_created",
        stepIndex: lead.currentStep,
        meta: { opportunityId: oppId, pipelineId, stageId, oppName, userName, userId },
      });
    });
    const [created] = await db.select().from(opportunities).where(eq(opportunities.id, oppId));
    res.status(201).json({ data: serializeOpp(created, lead.funnelId) });
  }),
);

export default router;
