import { Router, Request, Response, NextFunction } from "express";
import { eq, and, desc, ilike, or, count } from "drizzle-orm";
import { db } from "../db/index";
import { masterCompanies, masterContacts } from "../db/schema/master";
import { getOrgId } from "../lib/auth";
import { ApiError } from "../lib/helpers";

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

// ─── GET /master/companies ──────────────────────────────────────────
router.get(
  "/master/companies",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const search = req.query.search as string | undefined;
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 25));

    const conditions = [eq(masterCompanies.organizationId, orgId)];
    if (search) {
      conditions.push(
        or(
          ilike(masterCompanies.name, `%${search}%`),
          ilike(masterCompanies.domain, `%${search}%`),
          ilike(masterCompanies.industry, `%${search}%`),
        )!,
      );
    }

    const whereClause = and(...conditions);

    const [{ total }] = await db.select({ total: count() }).from(masterCompanies).where(whereClause);
    const totalCount = Number(total);

    const rows = await db
      .select()
      .from(masterCompanies)
      .where(whereClause)
      .orderBy(desc(masterCompanies.lastSeenAt))
      .limit(limit)
      .offset((page - 1) * limit);

    res.json({
      data: rows.map((r) => ({
        id: r.id,
        name: r.name,
        domain: r.domain,
        linkedinUrl: r.linkedinUrl,
        industry: r.industry,
        employeeCount: r.employeeCount,
        revenue: r.revenue,
        funding: r.funding,
        fundingStage: r.fundingStage,
        country: r.country,
        city: r.city,
        logo: r.logo,
        lastSeenAt: r.lastSeenAt.toISOString(),
        createdAt: r.createdAt.toISOString(),
      })),
      meta: { page, pageSize: limit, totalCount, totalPages: Math.ceil(totalCount / limit) },
    });
  }),
);

// ─── GET /master/companies/:id/contacts ─────────────────────────────
router.get(
  "/master/companies/:id/contacts",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const companyId = req.params.id;

    const contacts = await db
      .select()
      .from(masterContacts)
      .where(
        and(
          eq(masterContacts.organizationId, orgId),
          eq(masterContacts.masterCompanyId, companyId),
        ),
      )
      .orderBy(desc(masterContacts.lastDiscoveredAt));

    res.json({
      data: contacts.map((c) => ({
        id: c.id,
        firstName: c.firstName,
        lastName: c.lastName,
        fullName: c.fullName,
        headline: c.headline,
        profileImageUrl: c.profileImageUrl,
        currentTitle: c.currentTitle,
        currentCompany: c.currentCompany,
        linkedinUrl: c.linkedinUrl,
        location: c.location,
        email: c.email,
        phone: c.phone,
        enrichmentStatus: c.enrichmentStatus,
        lastDiscoveredAt: c.lastDiscoveredAt.toISOString(),
      })),
    });
  }),
);

// ─── GET /master/stats ──────────────────────────────────────────────
router.get(
  "/master/stats",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);

    const [{ companyCount }] = await db
      .select({ companyCount: count() })
      .from(masterCompanies)
      .where(eq(masterCompanies.organizationId, orgId));

    const [{ contactCount }] = await db
      .select({ contactCount: count() })
      .from(masterContacts)
      .where(eq(masterContacts.organizationId, orgId));

    res.json({
      data: {
        companies: Number(companyCount),
        contacts: Number(contactCount),
      },
    });
  }),
);

export default router;
