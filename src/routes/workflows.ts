import { Router, Request, Response, NextFunction } from "express";
import { eq, and, sql, inArray } from "drizzle-orm";
import { db } from "../db";
import { funnels } from "../db/schema/funnels";
import { workflows, workflowEnrollments, workflowStepRuns } from "../db/schema/workflows";
import type { WorkflowGraph, WorkflowSettings } from "../db/schema/workflows";
import { leads } from "../db/schema/leads";
import { desc } from "drizzle-orm";
import { getOrgId } from "../lib/auth";
import { ApiError, createId } from "../lib/helpers";
import { enrollLeadsDirect } from "../services/workflow-engine";

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

type WfStats = { enrolled: number; active: number; completed: number; exited: number; failed: number };
const ZERO_STATS: WfStats = { enrolled: 0, active: 0, completed: 0, exited: 0, failed: 0 };

function serialize(w: typeof workflows.$inferSelect, stats?: WfStats) {
  return {
    id: w.id,
    funnelId: w.funnelId,
    name: w.name,
    status: w.status,
    graph: w.graph,
    settings: w.settings,
    stats: stats ?? { ...ZERO_STATS },
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

/** Enrolled / in-progress / completed / exited / failed counts per workflow. */
async function statsByWorkflow(workflowIds: string[]) {
  const map = new Map<string, WfStats>();
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
    const s = map.get(r.workflowId) ?? { ...ZERO_STATS };
    s.enrolled += r.n;
    if (r.status === "active") s.active += r.n;
    else if (r.status === "completed") s.completed += r.n;
    else if (r.status === "exited") s.exited += r.n;
    else if (r.status === "failed") s.failed += r.n;
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

// ─── POST /funnels/:funnelId/workflows/:workflowId/enroll ───────────────
// Manually enroll leads into a workflow (must be active to run).
router.post(
  "/funnels/:funnelId/workflows/:workflowId/enroll",
  asyncHandler<WorkflowParams>(async (req, res) => {
    const orgId = getOrgId(req);
    const w = await loadWorkflowOr404(orgId, req.params.funnelId, req.params.workflowId);
    const leadIds = Array.isArray(req.body?.leadIds) ? (req.body.leadIds as unknown[]).map(String) : [];
    if (leadIds.length === 0) throw new ApiError(400, "leadIds required");
    const enrolled = await enrollLeadsDirect(orgId, w.id, leadIds);
    res.json({ data: { enrolled } });
  }),
);

// ─── GET /funnels/:funnelId/workflows/:workflowId/enrollments ───────────
// The activity view: every lead that has run through the workflow — status,
// where they are, when they next process, and the failure reason if any.
router.get(
  "/funnels/:funnelId/workflows/:workflowId/enrollments",
  asyncHandler<WorkflowParams>(async (req, res) => {
    const orgId = getOrgId(req);
    const w = await loadWorkflowOr404(orgId, req.params.funnelId, req.params.workflowId);
    const statusFilter = typeof req.query.status === "string" ? req.query.status : "";
    const conds = [eq(workflowEnrollments.workflowId, w.id)];
    if (statusFilter) conds.push(eq(workflowEnrollments.status, statusFilter));
    const rows = await db
      .select({
        id: workflowEnrollments.id,
        status: workflowEnrollments.status,
        currentNodeId: workflowEnrollments.currentNodeId,
        nextRunAt: workflowEnrollments.nextRunAt,
        waitingFor: workflowEnrollments.waitingFor,
        lastError: workflowEnrollments.lastError,
        enteredAt: workflowEnrollments.enteredAt,
        completedAt: workflowEnrollments.completedAt,
        leadId: workflowEnrollments.leadId,
        leadName: leads.name,
        leadCompany: leads.company,
        leadEmail: leads.email,
      })
      .from(workflowEnrollments)
      .leftJoin(leads, eq(leads.id, workflowEnrollments.leadId))
      .where(and(...conds))
      .orderBy(desc(workflowEnrollments.enteredAt))
      .limit(300);
    res.json({
      data: rows.map((r) => ({
        id: r.id,
        status: r.status,
        currentNodeId: r.currentNodeId,
        nextRunAt: r.nextRunAt ? r.nextRunAt.toISOString() : null,
        waitingFor: r.waitingFor,
        lastError: r.lastError,
        enteredAt: r.enteredAt.toISOString(),
        completedAt: r.completedAt ? r.completedAt.toISOString() : null,
        lead: { id: r.leadId, name: r.leadName || "Unknown", company: r.leadCompany || "", email: r.leadEmail || "" },
      })),
    });
  }),
);

// ─── GET .../enrollments/:enrollmentId/runs ─────────────────────────────
// Per-step log for one enrollment (incl. failure detail).
router.get(
  "/funnels/:funnelId/workflows/:workflowId/enrollments/:enrollmentId/runs",
  asyncHandler<WorkflowParams & { enrollmentId: string }>(async (req, res) => {
    const orgId = getOrgId(req);
    const w = await loadWorkflowOr404(orgId, req.params.funnelId, req.params.workflowId);
    // Confirm the enrollment belongs to this workflow before returning its runs.
    const [enr] = await db
      .select({ id: workflowEnrollments.id })
      .from(workflowEnrollments)
      .where(and(eq(workflowEnrollments.id, req.params.enrollmentId), eq(workflowEnrollments.workflowId, w.id)));
    if (!enr) throw new ApiError(404, "Enrollment not found");
    const runs = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.enrollmentId, enr.id))
      .orderBy(workflowStepRuns.ranAt)
      .limit(500);
    res.json({
      data: runs.map((r) => ({
        id: r.id,
        nodeId: r.nodeId,
        type: r.type,
        status: r.status,
        detail: r.detail,
        ranAt: r.ranAt.toISOString(),
      })),
    });
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
