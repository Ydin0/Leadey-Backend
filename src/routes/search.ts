import { Router, Request, Response, NextFunction } from "express";
import { and, eq, ilike, or } from "drizzle-orm";
import { db } from "../db";
import { funnels } from "../db/schema/funnels";
import { leads } from "../db/schema/leads";
import { opportunities } from "../db/schema/opportunities";
import { masterCompanies } from "../db/schema/master";
import { scraperContacts } from "../db/schema/contacts";
import { users } from "../db/schema/organizations";
import { getOrgId } from "../lib/auth";

const router = Router();

function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

/** Max results returned per entity group. */
const PER_GROUP = 5;

type SearchResult = {
  type: "campaign" | "lead" | "opportunity" | "company" | "contact" | "member";
  id: string;
  title: string;
  subtitle: string;
  href: string;
  imageUrl?: string | null;
};

function joinParts(parts: Array<string | null | undefined>): string {
  return parts.filter(Boolean).join(" · ");
}

// GET /api/search?q=... — org-scoped global search across the core entities.
router.get(
  "/search",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const q = ((req.query.q as string) || "").trim();

    // Require at least 2 chars to avoid scanning on every keystroke.
    if (q.length < 2) {
      res.json({ data: { query: q, results: [] } });
      return;
    }

    const term = `%${q}%`;

    const [campaigns, leadRows, oppRows, companyRows, contactRows, memberRows] =
      await Promise.all([
        db
          .select({
            id: funnels.id,
            name: funnels.name,
            status: funnels.status,
          })
          .from(funnels)
          .where(and(eq(funnels.organizationId, orgId), ilike(funnels.name, term)))
          .limit(PER_GROUP),

        db
          .select({
            id: leads.id,
            name: leads.name,
            company: leads.company,
            email: leads.email,
            funnelId: leads.funnelId,
          })
          .from(leads)
          .innerJoin(funnels, eq(leads.funnelId, funnels.id))
          .where(
            and(
              eq(funnels.organizationId, orgId),
              or(
                ilike(leads.name, term),
                ilike(leads.email, term),
                ilike(leads.company, term),
              ),
            ),
          )
          .limit(PER_GROUP),

        db
          .select({ id: opportunities.id, name: opportunities.name })
          .from(opportunities)
          .where(
            and(
              eq(opportunities.organizationId, orgId),
              ilike(opportunities.name, term),
            ),
          )
          .limit(PER_GROUP),

        db
          .select({
            id: masterCompanies.id,
            name: masterCompanies.name,
            domain: masterCompanies.domain,
            industry: masterCompanies.industry,
          })
          .from(masterCompanies)
          .where(
            and(
              eq(masterCompanies.organizationId, orgId),
              or(
                ilike(masterCompanies.name, term),
                ilike(masterCompanies.domain, term),
              ),
            ),
          )
          .limit(PER_GROUP),

        db
          .select({
            id: scraperContacts.id,
            fullName: scraperContacts.fullName,
            title: scraperContacts.currentTitle,
            company: scraperContacts.currentCompany,
            email: scraperContacts.email,
            assignmentId: scraperContacts.assignmentId,
          })
          .from(scraperContacts)
          .where(
            and(
              eq(scraperContacts.organizationId, orgId),
              or(
                ilike(scraperContacts.fullName, term),
                ilike(scraperContacts.email, term),
                ilike(scraperContacts.currentCompany, term),
              ),
            ),
          )
          .limit(PER_GROUP),

        db
          .select({
            id: users.id,
            firstName: users.firstName,
            lastName: users.lastName,
            email: users.email,
            imageUrl: users.imageUrl,
          })
          .from(users)
          .where(
            and(
              eq(users.organizationId, orgId),
              or(
                ilike(users.firstName, term),
                ilike(users.lastName, term),
                ilike(users.email, term),
              ),
            ),
          )
          .limit(PER_GROUP),
      ]);

    const results: SearchResult[] = [
      ...campaigns.map((c) => ({
        type: "campaign" as const,
        id: c.id,
        title: c.name,
        subtitle: `Campaign · ${c.status}`,
        href: `/dashboard/funnels/${c.id}`,
      })),
      ...leadRows.map((l) => ({
        type: "lead" as const,
        id: l.id,
        title: l.name,
        subtitle: joinParts([l.company, l.email]) || "Lead",
        href: `/dashboard/funnels/${l.funnelId}`,
      })),
      ...oppRows.map((o) => ({
        type: "opportunity" as const,
        id: o.id,
        title: o.name,
        subtitle: "Opportunity",
        href: `/dashboard/opportunities/${o.id}`,
      })),
      ...companyRows.map((c) => ({
        type: "company" as const,
        id: c.id,
        title: c.name,
        subtitle: joinParts([c.industry, c.domain]) || "Company",
        href: `/dashboard/companies`,
      })),
      ...contactRows.map((c) => ({
        type: "contact" as const,
        id: c.id,
        title: c.fullName || c.email || "Unknown contact",
        subtitle: joinParts([c.title, c.company]) || "Contact",
        href: c.assignmentId
          ? `/dashboard/scrapers/${c.assignmentId}`
          : `/dashboard/companies`,
      })),
      ...memberRows.map((m) => ({
        type: "member" as const,
        id: m.id,
        title:
          [m.firstName, m.lastName].filter(Boolean).join(" ").trim() || m.email,
        subtitle: m.email,
        href: `/dashboard/settings?tab=team`,
        imageUrl: m.imageUrl,
      })),
    ];

    res.json({ data: { query: q, results } });
  }),
);

export default router;
