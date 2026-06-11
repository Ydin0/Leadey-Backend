import { Router, Request, Response, NextFunction } from "express";
import { eq, and, sql, desc, asc } from "drizzle-orm";
import { db } from "../db";
import { imports } from "../db/schema/imports";
import { funnels } from "../db/schema/funnels";
import { leads } from "../db/schema/leads";
import { getOrgId } from "../lib/auth";
import { ApiError } from "../lib/helpers";

const router = Router();

function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

/** Parse ?page / ?pageSize with sane bounds. */
function parsePaging(req: Request, defaultSize = 25, maxSize = 100) {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(maxSize, Math.max(1, Number(req.query.pageSize) || defaultSize));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

/** Resolve an import id that belongs to the caller's org, or throw 404. */
async function loadOrgImport(orgId: string, importId: string) {
  const [row] = await db
    .select({
      id: imports.id,
      funnelId: imports.funnelId,
      rolledBackAt: imports.rolledBackAt,
    })
    .from(imports)
    .innerJoin(funnels, eq(imports.funnelId, funnels.id))
    .where(and(eq(imports.id, importId), eq(funnels.organizationId, orgId)));
  if (!row) throw new ApiError(404, "Import not found");
  return row;
}

/**
 * GET /api/imports — every CSV import for the org, newest first.
 * Org-scoped by joining imports → funnels. `liveLeadCount` is how many of the
 * import's leads still exist (0 after a rollback).
 */
router.get(
  "/imports",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const { page, pageSize, offset } = parsePaging(req);

    const [rows, [{ count }]] = await Promise.all([
      db
        .select({
          id: imports.id,
          funnelId: imports.funnelId,
          funnelName: funnels.name,
          fileName: imports.fileName,
          totalRows: imports.totalRows,
          importedRows: imports.importedRows,
          skippedRows: imports.skippedRows,
          rolledBackAt: imports.rolledBackAt,
          createdAt: imports.createdAt,
          liveLeadCount: sql<number>`(select count(*)::int from ${leads} where ${leads.importId} = ${imports.id})`,
        })
        .from(imports)
        .innerJoin(funnels, eq(imports.funnelId, funnels.id))
        .where(eq(funnels.organizationId, orgId))
        .orderBy(desc(imports.createdAt))
        .limit(pageSize)
        .offset(offset),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(imports)
        .innerJoin(funnels, eq(imports.funnelId, funnels.id))
        .where(eq(funnels.organizationId, orgId)),
    ]);

    res.json({
      data: rows,
      meta: { page, pageSize, totalCount: count, totalPages: Math.max(1, Math.ceil(count / pageSize)) },
    });
  }),
);

/**
 * GET /api/imports/:id/leads — the (still-existing) leads from one import.
 */
router.get(
  "/imports/:id/leads",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const importId = String(req.params.id);
    await loadOrgImport(orgId, importId);
    const { page, pageSize, offset } = parsePaging(req, 50);

    const [rows, [{ count }]] = await Promise.all([
      db
        .select({
          id: leads.id,
          funnelId: leads.funnelId,
          name: leads.name,
          title: leads.title,
          company: leads.company,
          email: leads.email,
          phone: leads.phone,
          status: leads.status,
          createdAt: leads.createdAt,
        })
        .from(leads)
        .where(eq(leads.importId, importId))
        .orderBy(asc(leads.createdAt))
        .limit(pageSize)
        .offset(offset),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(leads)
        .where(eq(leads.importId, importId)),
    ]);

    res.json({
      data: rows,
      meta: { page, pageSize, totalCount: count, totalPages: Math.max(1, Math.ceil(count / pageSize)) },
    });
  }),
);

/**
 * POST /api/imports/:id/rollback — delete the campaign leads this import
 * created and mark the import "rolled back". Master contacts (org-level
 * DNC/compliance/call history) are deliberately preserved. Idempotent.
 */
router.post(
  "/imports/:id/rollback",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const imp = await loadOrgImport(orgId, String(req.params.id));

    // Deleting leads cascades to lead_events / tasks / queue items via existing
    // FKs; master_contacts are org-scoped and untouched.
    const deleted = await db
      .delete(leads)
      .where(eq(leads.importId, imp.id))
      .returning({ id: leads.id });

    if (!imp.rolledBackAt) {
      await db
        .update(imports)
        .set({ rolledBackAt: new Date() })
        .where(eq(imports.id, imp.id));
    }

    res.json({ data: { deleted: deleted.length, rolledBack: true } });
  }),
);

export default router;
