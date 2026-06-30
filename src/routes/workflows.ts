import { Router, Request, Response, NextFunction } from "express";
import { eq, and, sql, inArray } from "drizzle-orm";
import { db } from "../db";
import { funnels } from "../db/schema/funnels";
import { workflows, workflowEnrollments } from "../db/schema/workflows";
import type { WorkflowGraph, WorkflowSettings } from "../db/schema/workflows";
import { getOrgId } from "../lib/auth";
import { ApiError, createId } from "../lib/helpers";

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

interface FunnelParams { funnelId: string }
interface WorkflowParams { funnelId: string; workflowId: string }

const VALID_STATUS = new Set(["draft", "active", "paused"]);
const DEFAULT_SETTINGS: WorkflowSettings = { reEnroll: false, exitOnReply: true, exitOnMeeting: true };

/** A fresh workflow opens on a single Trigger node. */
function seedGraph(): WorkflowGraph {
  return {
    nodes: [
      {
        id: createId("wfn"),
        type: "trigger",
        x: 430,
        y: 40,
        data: { label: "Lead enters campaign", sub: "" },
      },
    ],
    edges: [],
  };
}

function serialize(
  w: typeof workflows.$inferSelect,
  stats?: { enrolled: number; active: number; completed: number },
) {
  return {
    id: w.id,
    funnelId: w.funnelId,
    name: w.name,
    status: w.status,
    graph: w.graph,
    settings: w.settings,
    stats: stats ?? { enrolled: 0, active: 0, completed: 0 },
    createdAt: w.createdAt.toISOString(),
    updatedAt: w.updatedAt.toISOString(),
  };
}

/** Verify the funnel exists and belongs to the caller's org. */
async function assertFunnel(orgId: string, funnelId: string) {
  const [f] = await db
    .select({ id: funnels.id })
    .from(funnels)
    .where(and(eq(funnels.id, funnelId), eq(funnels.organizationId, orgId)));
  if (!f) throw new ApiError(404, "Campaign not found");
}

async function loadWorkflowOr404(orgId: string, funnelId: string, workflowId: string) {
  const [w] = await db
    .select()
    .from(workflows)
    .where(
      and(
        eq(workflows.id, workflowId),
        eq(workflows.funnelId, funnelId),
        eq(workflows.organizationId, orgId),
      ),
    );
  if (!w) throw new ApiError(404, "Workflow not found");
  return w;
}

/** Enrolled / in-progress / completed counts per workflow, in one query. */
async function statsByWorkflow(workflowIds: string[]) {
  const map = new Map<string, { enrolled: number; active: number; completed: number }>();
  if (workflowIds.length === 0) return map;
  const rows = await db
    .select({
      workflowId: workflowEnrollments.workflowId,
      status: workflowEnrollments.status,
      n: sql<number>`count(*)::int`,
    })
    .from(workflowEnrollments)
    .where(inArray(workflowEnrollments.workflowId, workflowIds))
    .groupBy(workflowEnrollments.workflowId, workflowEnrollments.status);
  for (const r of rows) {
    const s = map.get(r.workflowId) ?? { enrolled: 0, active: 0, completed: 0 };
    s.enrolled += r.n;
    if (r.status === "active") s.active += r.n;
    if (r.status === "completed") s.completed += r.n;
    map.set(r.workflowId, s);
  }
  return map;
}

// ─── GET /funnels/:funnelId/workflows ───────────────────────────────────
router.get(
  "/funnels/:funnelId/workflows",
  asyncHandler<FunnelParams>(async (req, res) => {
    const orgId = getOrgId(req);
    await assertFunnel(orgId, req.params.funnelId);
    const rows = await db
      .select()
      .from(workflows)
      .where(and(eq(workflows.organizationId, orgId), eq(workflows.funnelId, req.params.funnelId)))
      .orderBy(workflows.createdAt);
    const stats = await statsByWorkflow(rows.map((r) => r.id));
    res.json({ data: rows.map((w) => serialize(w, stats.get(w.id))) });
  }),
);

// ─── POST /funnels/:funnelId/workflows ──────────────────────────────────
router.post(
  "/funnels/:funnelId/workflows",
  asyncHandler<FunnelParams>(async (req, res) => {
    const orgId = getOrgId(req);
    await assertFunnel(orgId, req.params.funnelId);
    const name = (typeof req.body?.name === "string" && req.body.name.trim()) || "Untitled workflow";
    const id = createId("wf");
    await db.insert(workflows).values({
      id,
      organizationId: orgId,
      funnelId: req.params.funnelId,
      name,
      status: "draft",
      graph: seedGraph(),
      settings: DEFAULT_SETTINGS,
    });
    const w = await loadWorkflowOr404(orgId, req.params.funnelId, id);
    res.status(201).json({ data: serialize(w) });
  }),
);

// ─── GET /funnels/:funnelId/workflows/:workflowId ───────────────────────
router.get(
  "/funnels/:funnelId/workflows/:workflowId",
  asyncHandler<WorkflowParams>(async (req, res) => {
    const orgId = getOrgId(req);
    const w = await loadWorkflowOr404(orgId, req.params.funnelId, req.params.workflowId);
    const stats = await statsByWorkflow([w.id]);
    res.json({ data: serialize(w, stats.get(w.id)) });
  }),
);

// ─── PATCH /funnels/:funnelId/workflows/:workflowId ─────────────────────
// The "Save" — accepts name / status / graph / settings (any subset).
router.patch(
  "/funnels/:funnelId/workflows/:workflowId",
  asyncHandler<WorkflowParams>(async (req, res) => {
    const orgId = getOrgId(req);
    const existing = await loadWorkflowOr404(orgId, req.params.funnelId, req.params.workflowId);

    const body = (req.body || {}) as Record<string, unknown>;
    const patch: Partial<typeof workflows.$inferInsert> = { updatedAt: new Date() };
    if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim();
    if (typeof body.status === "string") {
      if (!VALID_STATUS.has(body.status)) throw new ApiError(400, "Invalid status");
      patch.status = body.status;
    }
    if (body.graph && typeof body.graph === "object") {
      const g = body.graph as Partial<WorkflowGraph>;
      patch.graph = { nodes: Array.isArray(g.nodes) ? g.nodes : [], edges: Array.isArray(g.edges) ? g.edges : [] };
    }
    if (body.settings && typeof body.settings === "object") {
      patch.settings = { ...(existing.settings || {}), ...(body.settings as WorkflowSettings) };
    }

    await db.update(workflows).set(patch).where(eq(workflows.id, existing.id));
    const w = await loadWorkflowOr404(orgId, req.params.funnelId, existing.id);
    const stats = await statsByWorkflow([w.id]);
    res.json({ data: serialize(w, stats.get(w.id)) });
  }),
);

// ─── DELETE /funnels/:funnelId/workflows/:workflowId ────────────────────
router.delete(
  "/funnels/:funnelId/workflows/:workflowId",
  asyncHandler<WorkflowParams>(async (req, res) => {
    const orgId = getOrgId(req);
    const w = await loadWorkflowOr404(orgId, req.params.funnelId, req.params.workflowId);
    await db.delete(workflows).where(eq(workflows.id, w.id));
    res.json({ data: { id: w.id, deleted: true } });
  }),
);

export default router;
