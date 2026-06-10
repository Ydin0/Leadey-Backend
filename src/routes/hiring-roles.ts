import { Router, Request, Response, NextFunction } from "express";
import { eq, and, desc } from "drizzle-orm";
import { getAuth } from "@clerk/express";
import { db } from "../db";
import { leadHiringRoles } from "../db/schema/hiring-roles";
import { leads } from "../db/schema/leads";
import { funnels } from "../db/schema/funnels";
import { getOrgId } from "../lib/auth";
import { ApiError, createId, normalizeString } from "../lib/helpers";

const router = Router();

function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function serialize(r: typeof leadHiringRoles.$inferSelect) {
  return {
    id: r.id,
    funnelId: r.funnelId,
    leadId: r.leadId,
    title: r.title,
    description: r.description,
    salaryRange: r.salaryRange,
    location: r.location,
    postedAgo: r.postedAgo,
    seniority: r.seniority,
    url: r.url,
    createdAt: r.createdAt.toISOString(),
  };
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

/** Pull the editable role fields off a request body. */
function roleFields(body: Record<string, unknown>) {
  return {
    description: normalizeString(body.description),
    salaryRange: normalizeString(body.salaryRange),
    location: normalizeString(body.location),
    postedAgo: normalizeString(body.postedAgo),
    seniority: normalizeString(body.seniority),
    url: normalizeString(body.url),
  };
}

// GET hiring roles for a lead
router.get(
  "/funnels/:funnelId/leads/:leadId/hiring-roles",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const funnelId = String(req.params.funnelId);
    const leadId = String(req.params.leadId);
    await assertLeadInOrg(orgId, funnelId, leadId);
    const rows = await db
      .select()
      .from(leadHiringRoles)
      .where(and(eq(leadHiringRoles.organizationId, orgId), eq(leadHiringRoles.leadId, leadId)))
      .orderBy(desc(leadHiringRoles.createdAt));
    res.json({ data: rows.map(serialize) });
  }),
);

// Create a hiring role for a lead
router.post(
  "/funnels/:funnelId/leads/:leadId/hiring-roles",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const funnelId = String(req.params.funnelId);
    const leadId = String(req.params.leadId);
    await assertLeadInOrg(orgId, funnelId, leadId);

    const title = normalizeString(req.body?.title);
    if (!title) throw new ApiError(400, "title is required");

    const id = createId("hrole");
    await db.insert(leadHiringRoles).values({
      id,
      organizationId: orgId,
      funnelId,
      leadId,
      title,
      ...roleFields(req.body || {}),
      createdBy: getAuth(req)?.userId || null,
    });
    const [created] = await db.select().from(leadHiringRoles).where(eq(leadHiringRoles.id, id));
    res.status(201).json({ data: serialize(created) });
  }),
);

// Update a hiring role
router.patch(
  "/hiring-roles/:id",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const id = String(req.params.id);
    const [existing] = await db
      .select()
      .from(leadHiringRoles)
      .where(and(eq(leadHiringRoles.id, id), eq(leadHiringRoles.organizationId, orgId)));
    if (!existing) throw new ApiError(404, "Hiring role not found");

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if ("title" in (req.body || {})) {
      const title = normalizeString(req.body.title);
      if (!title) throw new ApiError(400, "title cannot be empty");
      updates.title = title;
    }
    for (const k of ["description", "salaryRange", "location", "postedAgo", "seniority", "url"] as const) {
      if (k in (req.body || {})) updates[k] = normalizeString(req.body[k]);
    }

    const [updated] = await db
      .update(leadHiringRoles)
      .set(updates)
      .where(eq(leadHiringRoles.id, id))
      .returning();
    res.json({ data: serialize(updated) });
  }),
);

// Delete a hiring role
router.delete(
  "/hiring-roles/:id",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const id = String(req.params.id);
    const [existing] = await db
      .select({ id: leadHiringRoles.id })
      .from(leadHiringRoles)
      .where(and(eq(leadHiringRoles.id, id), eq(leadHiringRoles.organizationId, orgId)));
    if (!existing) throw new ApiError(404, "Hiring role not found");
    await db.delete(leadHiringRoles).where(eq(leadHiringRoles.id, id));
    res.status(204).end();
  }),
);

export default router;
