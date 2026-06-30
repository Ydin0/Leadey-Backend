import { Router, Request, Response, NextFunction } from "express";
import { and, count, desc, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import { db } from "../../db/index";
import { organizations } from "../../db/schema/organizations";
import { leads } from "../../db/schema/leads";
import { funnels } from "../../db/schema/funnels";
import { masterCompanies, masterContacts } from "../../db/schema/master";
import { ApiError } from "../../lib/helpers";
import { getApiOrgId } from "../../lib/api-key-auth";

const router = Router();

function asyncHandler(handler: (req: Request, res: Response, next: NextFunction) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** Shared pagination — `page` (1-based) + `pageSize` (max 100, default 25). */
function paginate(q: Record<string, unknown>) {
  const page = Math.max(1, Number(q.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(q.pageSize) || 25));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

function meta(page: number, pageSize: number, totalCount: number) {
  return { page, pageSize, totalCount, totalPages: Math.ceil(totalCount / pageSize) || 0 };
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

// ─── GET /v1/me — the authenticated organization ──────────────────────────────
router.get(
  "/me",
  asyncHandler(async (req, res) => {
    const orgId = getApiOrgId(req);
    const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId)).limit(1);
    if (!org) throw new ApiError(404, "Organization not found");
    res.json({
      data: {
        id: org.id,
        name: org.name,
        plan: org.plan,
        planStatus: org.planStatus,
        credits: {
          balance: org.creditBalance,
          included: org.creditsIncluded,
          used: org.creditsUsed,
        },
        createdAt: iso(org.createdAt),
      },
    });
  }),
);

// ─── Leads ────────────────────────────────────────────────────────────────────
function serializeLead(l: typeof leads.$inferSelect, campaignName: string | null) {
  return {
    id: l.id,
    name: l.name,
    firstName: l.firstName ?? null,
    lastName: l.lastName ?? null,
    title: l.title,
    company: l.company,
    email: l.email || null,
    phone: l.phone || null,
    linkedinUrl: l.linkedinUrl || null,
    status: l.status,
    source: l.source,
    score: l.score,
    campaignId: l.funnelId,
    campaignName,
    createdAt: iso(l.createdAt),
  };
}

router.get(
  "/leads",
  asyncHandler(async (req, res) => {
    const orgId = getApiOrgId(req);
    const { page, pageSize, offset } = paginate(req.query as Record<string, unknown>);

    const conds: SQL[] = [eq(funnels.organizationId, orgId)];
    const search = str(req.query.search);
    if (search) {
      const like = `%${search}%`;
      conds.push(or(ilike(leads.name, like), ilike(leads.company, like), ilike(leads.email, like))!);
    }
    const campaignId = str(req.query.campaignId);
    if (campaignId) conds.push(eq(leads.funnelId, campaignId));
    const status = str(req.query.status);
    if (status) conds.push(eq(leads.status, status));

    const [{ total }] = await db
      .select({ total: count() })
      .from(leads)
      .innerJoin(funnels, eq(leads.funnelId, funnels.id))
      .where(and(...conds));

    const rows = await db
      .select({ lead: leads, campaignName: funnels.name })
      .from(leads)
      .innerJoin(funnels, eq(leads.funnelId, funnels.id))
      .where(and(...conds))
      .orderBy(desc(leads.createdAt))
      .limit(pageSize)
      .offset(offset);

    res.json({
      data: rows.map((r) => serializeLead(r.lead, r.campaignName)),
      meta: meta(page, pageSize, Number(total)),
    });
  }),
);

router.get(
  "/leads/:id",
  asyncHandler(async (req, res) => {
    const orgId = getApiOrgId(req);
    const [row] = await db
      .select({ lead: leads, campaignName: funnels.name })
      .from(leads)
      .innerJoin(funnels, eq(leads.funnelId, funnels.id))
      .where(and(eq(leads.id, req.params.id as string), eq(funnels.organizationId, orgId)))
      .limit(1);
    if (!row) throw new ApiError(404, "Lead not found");
    res.json({ data: serializeLead(row.lead, row.campaignName) });
  }),
);

// ─── Campaigns (funnels, surfaced under the product term) ─────────────────────
function serializeCampaign(f: typeof funnels.$inferSelect) {
  return {
    id: f.id,
    name: f.name,
    description: f.description || null,
    status: f.status,
    createdAt: iso(f.createdAt),
  };
}

router.get(
  "/campaigns",
  asyncHandler(async (req, res) => {
    const orgId = getApiOrgId(req);
    const { page, pageSize, offset } = paginate(req.query as Record<string, unknown>);

    const conds: SQL[] = [eq(funnels.organizationId, orgId)];
    const status = str(req.query.status);
    if (status) conds.push(eq(funnels.status, status));
    const search = str(req.query.search);
    if (search) conds.push(ilike(funnels.name, `%${search}%`));

    const [{ total }] = await db.select({ total: count() }).from(funnels).where(and(...conds));
    const rows = await db
      .select()
      .from(funnels)
      .where(and(...conds))
      .orderBy(desc(funnels.createdAt))
      .limit(pageSize)
      .offset(offset);

    res.json({ data: rows.map(serializeCampaign), meta: meta(page, pageSize, Number(total)) });
  }),
);

router.get(
  "/campaigns/:id",
  asyncHandler(async (req, res) => {
    const orgId = getApiOrgId(req);
    const [row] = await db
      .select()
      .from(funnels)
      .where(and(eq(funnels.id, req.params.id as string), eq(funnels.organizationId, orgId)))
      .limit(1);
    if (!row) throw new ApiError(404, "Campaign not found");
    res.json({ data: serializeCampaign(row) });
  }),
);

// ─── Companies (master_companies) ─────────────────────────────────────────────
function serializeCompany(c: typeof masterCompanies.$inferSelect) {
  return {
    id: c.id,
    name: c.name,
    domain: c.domain ?? null,
    industry: c.industry ?? null,
    employeeCount: c.employeeCount ?? null,
    fundingStage: c.fundingStage ?? null,
    country: c.country ?? null,
    city: c.city ?? null,
    linkedinUrl: c.linkedinUrl ?? null,
    createdAt: iso(c.createdAt),
  };
}

router.get(
  "/companies",
  asyncHandler(async (req, res) => {
    const orgId = getApiOrgId(req);
    const { page, pageSize, offset } = paginate(req.query as Record<string, unknown>);

    const conds: SQL[] = [eq(masterCompanies.organizationId, orgId)];
    const search = str(req.query.search);
    if (search) {
      const like = `%${search}%`;
      conds.push(or(ilike(masterCompanies.name, like), ilike(masterCompanies.domain, like))!);
    }
    const industry = str(req.query.industry);
    if (industry) conds.push(ilike(masterCompanies.industry, `%${industry}%`));

    const [{ total }] = await db
      .select({ total: count() })
      .from(masterCompanies)
      .where(and(...conds));
    const rows = await db
      .select()
      .from(masterCompanies)
      .where(and(...conds))
      .orderBy(sql`lower(${masterCompanies.name})`)
      .limit(pageSize)
      .offset(offset);

    res.json({ data: rows.map(serializeCompany), meta: meta(page, pageSize, Number(total)) });
  }),
);

router.get(
  "/companies/:id",
  asyncHandler(async (req, res) => {
    const orgId = getApiOrgId(req);
    const [row] = await db
      .select()
      .from(masterCompanies)
      .where(and(eq(masterCompanies.id, req.params.id as string), eq(masterCompanies.organizationId, orgId)))
      .limit(1);
    if (!row) throw new ApiError(404, "Company not found");
    res.json({ data: serializeCompany(row) });
  }),
);

// ─── Contacts (master_contacts) ───────────────────────────────────────────────
function serializeContact(c: typeof masterContacts.$inferSelect) {
  return {
    id: c.id,
    firstName: c.firstName ?? null,
    lastName: c.lastName ?? null,
    fullName: c.fullName ?? null,
    title: c.currentTitle ?? null,
    company: c.currentCompany ?? null,
    email: c.email ?? null,
    emailStatus: c.emailStatus ?? null,
    phone: c.phone ?? null,
    phoneStatus: c.phoneStatus ?? null,
    linkedinUrl: c.linkedinUrl ?? null,
    location: c.location ?? null,
    createdAt: iso(c.createdAt),
  };
}

router.get(
  "/contacts",
  asyncHandler(async (req, res) => {
    const orgId = getApiOrgId(req);
    const { page, pageSize, offset } = paginate(req.query as Record<string, unknown>);

    const conds: SQL[] = [eq(masterContacts.organizationId, orgId)];
    const search = str(req.query.search);
    if (search) {
      const like = `%${search}%`;
      conds.push(
        or(
          ilike(masterContacts.fullName, like),
          ilike(masterContacts.email, like),
          ilike(masterContacts.currentCompany, like),
        )!,
      );
    }
    const company = str(req.query.company);
    if (company) conds.push(ilike(masterContacts.currentCompany, `%${company}%`));

    const [{ total }] = await db
      .select({ total: count() })
      .from(masterContacts)
      .where(and(...conds));
    const rows = await db
      .select()
      .from(masterContacts)
      .where(and(...conds))
      .orderBy(desc(masterContacts.createdAt))
      .limit(pageSize)
      .offset(offset);

    res.json({ data: rows.map(serializeContact), meta: meta(page, pageSize, Number(total)) });
  }),
);

router.get(
  "/contacts/:id",
  asyncHandler(async (req, res) => {
    const orgId = getApiOrgId(req);
    const [row] = await db
      .select()
      .from(masterContacts)
      .where(and(eq(masterContacts.id, req.params.id as string), eq(masterContacts.organizationId, orgId)))
      .limit(1);
    if (!row) throw new ApiError(404, "Contact not found");
    res.json({ data: serializeContact(row) });
  }),
);

export default router;
