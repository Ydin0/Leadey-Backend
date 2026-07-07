import { Router, Request, Response, NextFunction } from "express";
import { and, eq, ilike, or, sql, inArray } from "drizzle-orm";
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

    // Phone search: match on digits only so "+1 415 722 1246", "(415) 722-1246"
    // and "+14157221246" all hit the same stored number. We compare the last 10
    // digits when the query has enough, so a country-code difference doesn't
    // hide the lead. Only engages when the query is essentially a number.
    const qDigits = q.replace(/\D/g, "");
    const isPhoneish = qDigits.length >= 5 && qDigits.length >= q.replace(/[\s()+\-.]/g, "").length;
    const phoneNeedle = qDigits.length >= 10 ? qDigits.slice(-10) : qDigits;
    const leadPhoneMatch = isPhoneish
      ? ilike(sql`regexp_replace(${leads.phone}, '[^0-9]', '', 'g')`, `%${phoneNeedle}%`)
      : undefined;

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
            phone: leads.phone,
            companyDomain: leads.companyDomain,
            funnelId: leads.funnelId,
            masterContactId: leads.masterContactId,
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
                ...(leadPhoneMatch ? [leadPhoneMatch] : []),
              ),
            ),
          )
          // Over-fetch: the same person enrolled in N campaigns is N rows;
          // we collapse to one per person below, then slice to PER_GROUP.
          .limit(PER_GROUP * 6),

        db
          .select({ id: opportunities.id, name: opportunities.name, sourceLeadId: opportunities.sourceLeadId })
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
                ...(isPhoneish
                  ? [ilike(sql`regexp_replace(${scraperContacts.phone}, '[^0-9]', '', 'g')`, `%${phoneNeedle}%`)]
                  : []),
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

    // Collapse leads to one row PER PERSON — a person enrolled in several
    // campaigns is several lead rows, and we don't want the same human listed
    // repeatedly. Key by master contact, falling back to email/phone/id since
    // masterContactId is nullable on legacy rows. First match wins.
    const phoneDigits = (p: string | null) => (p || "").replace(/\D/g, "");
    const personKey = (l: (typeof leadRows)[number]) =>
      l.masterContactId || (l.email ? `e:${l.email.toLowerCase()}` : "") || (phoneDigits(l.phone) ? `p:${phoneDigits(l.phone)}` : "") || l.id;
    const seenPerson = new Set<string>();
    const dedupedLeads: typeof leadRows = [];
    for (const l of leadRows) {
      const key = personKey(l);
      if (seenPerson.has(key)) continue;
      seenPerson.add(key);
      dedupedLeads.push(l);
      if (dedupedLeads.length >= PER_GROUP) break;
    }
    // Suppress contact results for people already shown as a lead (an enrolled
    // contact would otherwise appear under both Leads and Contacts).
    const leadEmails = new Set(
      dedupedLeads.map((l) => l.email?.toLowerCase()).filter(Boolean) as string[],
    );
    const dedupedContacts = contactRows.filter((c) => !(c.email && leadEmails.has(c.email.toLowerCase())));

    // Resolve contact results to a campaign lead (matched by email) so they
    // open the lead view directly. Company results route to
    // /dashboard/companies/:id, which resolves to the company's most recently
    // active lead view (there is no standalone company page).
    const lookupConds = [];
    for (const c of contactRows) {
      if (c.email) lookupConds.push(sql`lower(${leads.email}) = ${c.email.toLowerCase()}`);
    }
    const lookupLeads = lookupConds.length
      ? await db
          .select({
            id: leads.id,
            funnelId: leads.funnelId,
            masterCompanyId: leads.masterCompanyId,
            masterContactId: leads.masterContactId,
            email: leads.email,
          })
          .from(leads)
          .innerJoin(funnels, eq(leads.funnelId, funnels.id))
          .where(and(eq(funnels.organizationId, orgId), or(...lookupConds)))
      : [];

    type LookupLead = (typeof lookupLeads)[number];
    const byEmail = new Map<string, LookupLead>();
    for (const l of lookupLeads) {
      if (l.email) {
        const k = l.email.toLowerCase();
        if (!byEmail.has(k)) byEmail.set(k, l);
      }
    }
    const leadHref = (l: LookupLead) => `/dashboard/funnels/${l.funnelId}/leads/${l.id}`;

    // Opportunities have no standalone page — route them to their source lead's
    // profile (org-scoped). Resolve the source lead → funnel for each.
    const oppLeadIds = [...new Set(oppRows.map((o) => o.sourceLeadId).filter(Boolean) as string[])];
    const oppLeadById = new Map<string, { id: string; funnelId: string }>();
    if (oppLeadIds.length) {
      const oppLeads = await db
        .select({ id: leads.id, funnelId: leads.funnelId })
        .from(leads)
        .innerJoin(funnels, eq(leads.funnelId, funnels.id))
        .where(and(eq(funnels.organizationId, orgId), inArray(leads.id, oppLeadIds)));
      for (const l of oppLeads) oppLeadById.set(l.id, l);
    }

    const results: SearchResult[] = [
      ...campaigns.map((c) => ({
        type: "campaign" as const,
        id: c.id,
        title: c.name,
        subtitle: `Campaign · ${c.status}`,
        href: `/dashboard/funnels/${c.id}`,
      })),
      ...dedupedLeads.map((l) => ({
        type: "lead" as const,
        id: l.id,
        title: l.name,
        // When the user searched a phone number, surface it so the match is
        // obvious; otherwise show company/email as before.
        subtitle: isPhoneish
          ? joinParts([l.phone, l.company]) || "Lead"
          : joinParts([l.company, l.email]) || "Lead",
        href: `/dashboard/funnels/${l.funnelId}/leads/${l.id}`,
        domain: l.companyDomain || emailDomain(l.email),
      })),
      ...oppRows.map((o) => {
        const lead = o.sourceLeadId ? oppLeadById.get(o.sourceLeadId) : undefined;
        return {
          type: "opportunity" as const,
          id: o.id,
          title: o.name,
          subtitle: "Opportunity",
          // No opportunity detail page — open the source lead's profile, else
          // fall back to the opportunities board rather than 404.
          href: lead ? `/dashboard/funnels/${lead.funnelId}/leads/${lead.id}` : `/dashboard/opportunities`,
        };
      }),
      ...companyRows.map((c) => ({
        type: "company" as const,
        id: c.id,
        title: c.name,
        subtitle: joinParts([c.industry, c.domain]) || "Company",
        // Resolves to the company's most recently active lead view.
        href: `/dashboard/companies/${c.id}`,
        domain: c.domain || null,
      })),
      ...dedupedContacts.map((c) => {
        const match = c.email ? byEmail.get(c.email.toLowerCase()) : undefined;
        return {
          type: "contact" as const,
          id: c.id,
          title: c.fullName || c.email || "Unknown contact",
          subtitle: joinParts([c.title, c.company]) || "Contact",
          // Enrolled in a campaign → straight to the lead view; otherwise
          // the standalone discovered-contact profile.
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
