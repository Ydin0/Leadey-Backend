import { Router, Request, Response, NextFunction } from "express";
import { and, desc, eq, ilike, sql } from "drizzle-orm";
import { db } from "../db/index";
import { emailSuppressions } from "../db/schema/email-suppressions";
import { leads } from "../db/schema/leads";
import { getOrgId } from "../lib/auth";
import { requirePerm } from "../lib/permission-service";
import { ApiError, normalizeString } from "../lib/helpers";
import { suppressEmail } from "../lib/suppression";

const router = Router();

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<void>;
function asyncHandler(handler: AsyncHandler) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function serialize(row: { id: string; emailKey: string; reason: string; leadId: string | null; createdAt: Date }, leadName?: string | null) {
  return {
    id: row.id,
    email: row.emailKey,
    reason: row.reason,
    leadId: row.leadId,
    leadName: leadName ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

// ─── GET /email-suppressions ─────────────────────────────────────────
// The org's suppression list (unsubscribes, bounces, complaints, manual adds),
// newest first. Optional `?q=` substring filter on the address.
router.get(
  "/email-suppressions",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const q = normalizeString(req.query.q as string | undefined);
    const where = q
      ? and(eq(emailSuppressions.organizationId, orgId), ilike(emailSuppressions.emailKey, `%${q.toLowerCase()}%`))
      : eq(emailSuppressions.organizationId, orgId);

    const rows = await db
      .select({
        id: emailSuppressions.id,
        emailKey: emailSuppressions.emailKey,
        reason: emailSuppressions.reason,
        leadId: emailSuppressions.leadId,
        createdAt: emailSuppressions.createdAt,
        leadName: leads.name,
      })
      .from(emailSuppressions)
      .leftJoin(leads, eq(leads.id, emailSuppressions.leadId))
      .where(where)
      .orderBy(desc(emailSuppressions.createdAt))
      .limit(1000);

    res.json({ data: rows.map((r) => serialize(r, r.leadName)) });
  }),
);

// ─── POST /email-suppressions ────────────────────────────────────────
// Manually add an address to the list. Reuses suppressEmail so it also exits
// the matching lead's active workflow enrollments.
router.post(
  "/email-suppressions",
  requirePerm("settings.manageOrgConfig"),
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const email = normalizeString((req.body as { email?: string }).email)?.toLowerCase();
    if (!email || !EMAIL_RE.test(email)) throw new ApiError(400, "A valid email address is required");

    await suppressEmail(orgId, email, "manual");
    const [row] = await db
      .select({
        id: emailSuppressions.id, emailKey: emailSuppressions.emailKey,
        reason: emailSuppressions.reason, leadId: emailSuppressions.leadId, createdAt: emailSuppressions.createdAt,
      })
      .from(emailSuppressions)
      .where(and(eq(emailSuppressions.organizationId, orgId), eq(emailSuppressions.emailKey, email)));
    if (!row) throw new ApiError(500, "Could not add to suppression list");
    res.status(201).json({ data: serialize(row) });
  }),
);

// ─── DELETE /email-suppressions/:id ──────────────────────────────────
// Remove an address so it can be emailed again (undo an unsubscribe/bounce).
router.delete(
  "/email-suppressions/:id",
  requirePerm("settings.manageOrgConfig"),
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const id = String(req.params.id);
    await db.delete(emailSuppressions).where(and(eq(emailSuppressions.id, id), eq(emailSuppressions.organizationId, orgId)));
    res.status(204).end();
  }),
);

export default router;
