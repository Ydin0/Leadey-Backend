import { Router, Request, Response, NextFunction } from "express";
import { and, eq, ilike, or, sql } from "drizzle-orm";
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
  /** Company domain — the client renders its favicon as the result icon, with
   *  the group's lucide icon as a fallback. */
  domain?: string | null;
};

function joinParts(parts: Array<string | null | undefined>): string {
  return parts.filter(Boolean).join(" · ");
}

/** Best-effort domain for a person/company favicon. */
function emailDomain(email: string | null | undefined): string | null {
  if (!email || !email.includes("@")) return null;
  const d = email.split("@")[1]?.trim().toLowerCase();
  return d || null;
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
            companyDomain: leads.companyDomain,
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

    // Resolve a representative campaign lead for company/contact results so
    // clicking them opens the Lead View directly (matched by company
    // name/domain or the contact's email). Bounded: at most PER_GROUP each.
    const lookupConds = [];
    for (const c of companyRows) {
      if (c.name) lookupConds.push(sql`lower(${leads.company}) = ${c.name.toLowerCase()}`);
      if (c.domain) lookupConds.push(sql`lower(${leads.companyDomain}) = ${c.domain.toLowerCase()}`);
    }
    for (const c of contactRows) {
      if (c.email) lookupConds.push(sql`lower(${leads.email}) = ${c.email.toLowerCase()}`);
    }
    const lookupLeads = lookupConds.length
      ? await db
          .select({
            id: leads.id,
            funnelId: leads.funnelId,
            company: leads.company,
            companyDomain: leads.companyDomain,
            email: leads.email,
          })
          .from(leads)
          .innerJoin(funnels, eq(leads.funnelId, funnels.id))
          .where(and(eq(funnels.organizationId, orgId), or(...lookupConds)))
      : [];

    type LookupLead = (typeof lookupLeads)[number];
    const byCompanyName = new Map<string, LookupLead>();
    const byCompanyDomain = new Map<string, LookupLead>();
    const byEmail = new Map<string, LookupLead>();
    for (const l of lookupLeads) {
      if (l.company) {
        const k = l.company.toLowerCase();
        if (!byCompanyName.has(k)) byCompanyName.set(k, l);
      }
      if (l.companyDomain) {
        const k = l.companyDomain.toLowerCase();
        if (!byCompanyDomain.has(k)) byCompanyDomain.set(k, l);
      }
      if (l.email) {
        const k = l.email.toLowerCase();
        if (!byEmail.has(k)) byEmail.set(k, l);
      }
    }
    const leadHref = (l: LookupLead) => `/dashboard/funnels/${l.funnelId}/leads/${l.id}`;

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
        href: `/dashboard/funnels/${l.funnelId}/leads/${l.id}`,
        domain: l.companyDomain || emailDomain(l.email),
      })),
      ...oppRows.map((o) => ({
        type: "opportunity" as const,
        id: o.id,
        title: o.name,
        subtitle: "Opportunity",
        href: `/dashboard/opportunities/${o.id}`,
      })),
      ...companyRows.map((c) => {
        const match =
          (c.name && byCompanyName.get(c.name.toLowerCase())) ||
          (c.domain && byCompanyDomain.get(c.domain.toLowerCase()));
        return {
          type: "company" as const,
          id: c.id,
          title: c.name,
          subtitle: joinParts([c.industry, c.domain]) || "Company",
          href: match ? leadHref(match) : `/dashboard/companies`,
          domain: c.domain || null,
        };
      }),
      ...contactRows.map((c) => {
        const match = c.email && byEmail.get(c.email.toLowerCase());
        return {
          type: "contact" as const,
          id: c.id,
          title: c.fullName || c.email || "Unknown contact",
          subtitle: joinParts([c.title, c.company]) || "Contact",
          // Prefer the campaign lead if they're in one; otherwise the standalone
          // contact profile (works even when not added to a campaign).
          href: match ? leadHref(match) : `/dashboard/contacts/${c.id}`,
          domain: emailDomain(c.email),
        };
      }),
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
