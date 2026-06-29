import { Router, Request, Response, NextFunction } from "express";
import { eq, and, or, asc, inArray, gte, ilike } from "drizzle-orm";
import { getAuth } from "@clerk/express";
import { db } from "../db";
import { leadTasks } from "../db/schema/lead-tasks";
import { leads } from "../db/schema/leads";
import { funnels } from "../db/schema/funnels";
import { users } from "../db/schema/organizations";
import { getOrgId } from "../lib/auth";
import { getUserRole } from "../lib/permissions";
import { getTaskCategories, saveTaskCategories } from "../lib/task-categories";
import { ApiError, createId } from "../lib/helpers";

// Categories are org-configurable now, so accept any non-empty key (slugified).
function normalizeCategory(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  const c = String(raw || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return c || undefined;
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

function serializeTask(t: typeof leadTasks.$inferSelect, assigneeName: string | null = null) {
  return {
    id: t.id,
    funnelId: t.funnelId,
    leadId: t.leadId,
    label: t.label,
    category: t.category,
    dueAt: t.dueAt ? t.dueAt.toISOString() : null,
    done: t.done,
    assigneeId: t.assigneeId,
    assigneeName,
    createdBy: t.createdBy,
    createdAt: t.createdAt.toISOString(),
  };
}

/** Bucket a task by its due date relative to now (matches the dashboard's
 *  grouping so the Inbox sections line up). */
function taskGroup(t: { done: boolean; dueAt: Date | null }): "overdue" | "today" | "upcoming" | "done" {
  if (t.done) return "done";
  if (!t.dueAt) return "today"; // undated open tasks surface as "today / now"
  const now = new Date();
  const startOfToday = new Date(now); startOfToday.setHours(0, 0, 0, 0);
  const endOfToday = new Date(startOfToday); endOfToday.setDate(endOfToday.getDate() + 1);
  if (t.dueAt < startOfToday) return "overdue";
  if (t.dueAt < endOfToday) return "today";
  return "upcoming";
}

function fullName(u: { firstName: string | null; lastName: string | null; email: string | null }): string | null {
  return [u.firstName, u.lastName].filter(Boolean).join(" ").trim() || u.email || null;
}

async function resolveAssigneeName(assigneeId: string | null): Promise<string | null> {
  if (!assigneeId) return null;
  const [u] = await db
    .select({ firstName: users.firstName, lastName: users.lastName, email: users.email })
    .from(users)
    .where(eq(users.id, assigneeId))
    .limit(1);
  return u ? fullName(u) : null;
}

/** Resolve a task's requested assignee, enforcing that non-admins may only
 *  assign to themselves. Returns the assignee id to store. */
async function resolveAssignee(
  req: Request,
  orgId: string,
  requestedRaw: unknown,
): Promise<string | null> {
  const userId = getAuth(req)?.userId || null;
  const requested = requestedRaw ? String(requestedRaw).trim() : "";
  // Default / self.
  if (!requested || requested === userId) return userId;
  const role = userId ? await getUserRole(userId) : "rep";
  const canAssignOthers = role === "admin" || role === "manager";
  if (!canAssignOthers) {
    throw new ApiError(403, "Only admins can assign tasks to other members");
  }
  const [m] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, requested), eq(users.organizationId, orgId)))
    .limit(1);
  if (!m) throw new ApiError(400, "Assignee is not a member of this organization");
  return requested;
}

/** Confirm the lead exists, sits in the given funnel, and belongs to the org. */
async function assertLeadInOrg(orgId: string, funnelId: string, leadId: string) {
  const [row] = await db
    .select({ id: leads.id })
    .from(leads)
    .innerJoin(funnels, eq(leads.funnelId, funnels.id))
    .where(
      and(
        eq(leads.id, leadId),
        eq(leads.funnelId, funnelId),
        eq(funnels.organizationId, orgId),
      ),
    )
    .limit(1);
  if (!row) throw new ApiError(404, "Lead not found");
}

// GET tasks for a lead
router.get(
  "/funnels/:funnelId/leads/:leadId/tasks",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const { funnelId, leadId } = req.params as { funnelId: string; leadId: string };
    await assertLeadInOrg(orgId, funnelId, leadId);
    const rows = await db
      .select({
        task: leadTasks,
        firstName: users.firstName,
        lastName: users.lastName,
        email: users.email,
      })
      .from(leadTasks)
      .leftJoin(users, eq(users.id, leadTasks.assigneeId))
      .where(and(eq(leadTasks.organizationId, orgId), eq(leadTasks.leadId, leadId)))
      .orderBy(asc(leadTasks.done), asc(leadTasks.dueAt), asc(leadTasks.createdAt));
    res.json({
      data: rows.map((r) =>
        serializeTask(
          r.task,
          r.firstName || r.lastName || r.email ? fullName({ firstName: r.firstName, lastName: r.lastName, email: r.email }) : null,
        ),
      ),
    });
  }),
);

// Create a task for a lead
router.post(
  "/funnels/:funnelId/leads/:leadId/tasks",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const { funnelId, leadId } = req.params as { funnelId: string; leadId: string };
    await assertLeadInOrg(orgId, funnelId, leadId);
    const { label, dueAt, assigneeId: requestedAssignee, category } = req.body as {
      label?: string;
      dueAt?: string | null;
      assigneeId?: string | null;
      category?: string;
    };
    if (!label?.trim()) throw new ApiError(400, "label required");
    const auth = getAuth(req);
    const assigneeId = await resolveAssignee(req, orgId, requestedAssignee);
    const id = createId("ltask");
    await db.insert(leadTasks).values({
      id,
      organizationId: orgId,
      funnelId,
      leadId,
      label: label.trim(),
      category: normalizeCategory(category) ?? "follow_up",
      dueAt: dueAt ? new Date(dueAt) : null,
      assigneeId,
      createdBy: auth?.userId || null,
    });
    const [created] = await db.select().from(leadTasks).where(eq(leadTasks.id, id));
    res.status(201).json({ data: serializeTask(created, await resolveAssigneeName(assigneeId)) });
  }),
);

// Update a task (toggle done / edit label, due date, or assignee)
router.patch(
  "/lead-tasks/:taskId",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const taskId = req.params.taskId as string;
    const [existing] = await db
      .select()
      .from(leadTasks)
      .where(and(eq(leadTasks.id, taskId), eq(leadTasks.organizationId, orgId)));
    if (!existing) throw new ApiError(404, "Task not found");

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if ("label" in req.body) {
      const label = String(req.body.label || "").trim();
      if (!label) throw new ApiError(400, "label cannot be empty");
      updates.label = label;
    }
    if ("done" in req.body) updates.done = !!req.body.done;
    if ("category" in req.body) updates.category = normalizeCategory(req.body.category);
    if ("dueAt" in req.body) {
      updates.dueAt = req.body.dueAt ? new Date(req.body.dueAt) : null;
    }
    if ("assigneeId" in req.body) {
      updates.assigneeId = await resolveAssignee(req, orgId, req.body.assigneeId);
    }

    const [updated] = await db
      .update(leadTasks)
      .set(updates)
      .where(eq(leadTasks.id, taskId))
      .returning();
    res.json({ data: serializeTask(updated, await resolveAssigneeName(updated.assigneeId)) });
  }),
);

// ─── GET /task-categories ───────────────────────────────────────────
router.get(
  "/task-categories",
  asyncHandler(async (req, res) => {
    res.json({ data: await getTaskCategories(getOrgId(req)) });
  }),
);

// ─── PUT /task-categories ───────────────────────────────────────────
router.put(
  "/task-categories",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const input = Array.isArray(req.body?.categories) ? req.body.categories : req.body;
    res.json({ data: await saveTaskCategories(orgId, input) });
  }),
);

// ─── GET /tasks ─────────────────────────────────────────────────────
// Org-wide task list for the unified Inbox (Tasks + Reminders tabs).
// Defaults to the current user's tasks; admins/managers can view a specific
// member's or the whole team's (assigneeId=all). Returns every open task plus
// recently-completed ones, each tagged with a group (overdue/today/upcoming/done)
// and enriched with the lead/company/campaign it belongs to.
router.get(
  "/tasks",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const userId = getAuth(req)?.userId || null;
    if (!userId) { res.json({ data: [] }); return; }
    const role = await getUserRole(userId);
    const canViewOthers = role === "admin" || role === "manager";

    // Resolve whose tasks to show.
    const requested = (req.query.assigneeId as string | undefined)?.trim();
    let assigneeFilter: string | "all";
    if (!canViewOthers) assigneeFilter = userId;            // reps: always self
    else if (!requested || requested === "mine") assigneeFilter = userId;
    else assigneeFilter = requested;                        // "all" or a member id

    const category = normalizeCategory(req.query.category);
    const status = (req.query.status as string | undefined) || "all"; // open|done|all
    const search = (req.query.search as string | undefined)?.trim();
    const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);

    const conditions = [eq(leadTasks.organizationId, orgId)];
    if (assigneeFilter !== "all") conditions.push(eq(leadTasks.assigneeId, assigneeFilter));
    if (req.query.category !== undefined && category) conditions.push(eq(leadTasks.category, category));
    if (search) conditions.push(ilike(leadTasks.label, `%${search}%`));
    if (status === "open") conditions.push(eq(leadTasks.done, false));
    else if (status === "done") conditions.push(and(eq(leadTasks.done, true), gte(leadTasks.updatedAt, sixtyDaysAgo))!);
    else conditions.push(or(eq(leadTasks.done, false), gte(leadTasks.updatedAt, sixtyDaysAgo))!); // all: open + recent done

    const rows = await db
      .select({
        task: leadTasks,
        assigneeFirst: users.firstName,
        assigneeLast: users.lastName,
        assigneeEmail: users.email,
        leadName: leads.name,
        leadCompany: leads.company,
        campaignName: funnels.name,
      })
      .from(leadTasks)
      .leftJoin(users, eq(users.id, leadTasks.assigneeId))
      .leftJoin(leads, eq(leads.id, leadTasks.leadId))
      .leftJoin(funnels, eq(funnels.id, leadTasks.funnelId))
      .where(and(...conditions))
      .orderBy(asc(leadTasks.done), asc(leadTasks.dueAt), asc(leadTasks.createdAt));

    res.json({
      data: rows.map((r) => ({
        ...serializeTask(
          r.task,
          r.assigneeFirst || r.assigneeLast || r.assigneeEmail
            ? fullName({ firstName: r.assigneeFirst, lastName: r.assigneeLast, email: r.assigneeEmail })
            : null,
        ),
        group: taskGroup(r.task),
        leadName: r.leadName ?? null,
        company: r.leadCompany ?? null,
        campaignName: r.campaignName ?? null,
      })),
    });
  }),
);

// ─── POST /tasks ────────────────────────────────────────────────────
// Create a task/reminder from the Inbox. A lead is optional (standalone
// reminders); when a leadId is supplied its funnel is validated.
router.post(
  "/tasks",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const auth = getAuth(req);
    const { label, dueAt, assigneeId: requestedAssignee, category, leadId, funnelId } = req.body as {
      label?: string;
      dueAt?: string | null;
      assigneeId?: string | null;
      category?: string;
      leadId?: string | null;
      funnelId?: string | null;
    };
    if (!label?.trim()) throw new ApiError(400, "label required");
    if (leadId && funnelId) await assertLeadInOrg(orgId, funnelId, leadId);
    const assigneeId = await resolveAssignee(req, orgId, requestedAssignee);
    const id = createId("ltask");
    await db.insert(leadTasks).values({
      id,
      organizationId: orgId,
      funnelId: leadId && funnelId ? funnelId : null,
      leadId: leadId && funnelId ? leadId : null,
      label: label.trim(),
      category: normalizeCategory(category) ?? "reminder",
      dueAt: dueAt ? new Date(dueAt) : null,
      assigneeId,
      createdBy: auth?.userId || null,
    });
    const [created] = await db.select().from(leadTasks).where(eq(leadTasks.id, id));
    res.status(201).json({ data: serializeTask(created, await resolveAssigneeName(assigneeId)) });
  }),
);

// Delete a task
router.delete(
  "/lead-tasks/:taskId",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const taskId = req.params.taskId as string;
    const [existing] = await db
      .select({ id: leadTasks.id })
      .from(leadTasks)
      .where(and(eq(leadTasks.id, taskId), eq(leadTasks.organizationId, orgId)));
    if (!existing) throw new ApiError(404, "Task not found");
    await db.delete(leadTasks).where(eq(leadTasks.id, taskId));
    res.status(204).end();
  }),
);

export default router;
