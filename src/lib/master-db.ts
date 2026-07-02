import { eq, and, sql, inArray } from "drizzle-orm";
import { db } from "../db/index";
import { masterCompanies, masterContacts } from "../db/schema/master";
import { createId } from "./helpers";

/**
 * Upsert a company into the master companies table.
 * Returns the master company ID.
 */
export async function upsertMasterCompany(
  orgId: string,
  data: {
    name: string;
    domain?: string | null;
    linkedinUrl?: string | null;
    industry?: string | null;
    employeeCount?: number | null;
    revenue?: number | null;
    funding?: number | null;
    fundingStage?: string | null;
    country?: string | null;
    city?: string | null;
    logo?: string | null;
  },
): Promise<string> {
  if (!data.domain) {
    // Without domain we can't dedup reliably — generate a domain from name
    data.domain = `${data.name.toLowerCase().replace(/[^a-z0-9]/g, "")}.unknown`;
  }

  // Try to find existing
  const existing = await db.query.masterCompanies.findFirst({
    where: and(
      eq(masterCompanies.organizationId, orgId),
      sql`lower(${masterCompanies.domain}) = lower(${data.domain})`,
    ),
  });

  if (existing) {
    // Update with latest data (don't overwrite with nulls)
    const updates: Record<string, unknown> = {
      lastSeenAt: new Date(),
      updatedAt: new Date(),
    };
    if (data.name) updates.name = data.name;
    if (data.industry) updates.industry = data.industry;
    if (data.employeeCount) updates.employeeCount = data.employeeCount;
    if (data.revenue) updates.revenue = data.revenue;
    if (data.funding) updates.funding = data.funding;
    if (data.fundingStage) updates.fundingStage = data.fundingStage;
    if (data.country) updates.country = data.country;
    if (data.city) updates.city = data.city;
    if (data.logo) updates.logo = data.logo;
    if (data.linkedinUrl) updates.linkedinUrl = data.linkedinUrl;

    await db.update(masterCompanies).set(updates).where(eq(masterCompanies.id, existing.id));
    return existing.id;
  }

  // Insert new
  const id = createId("mc");
  await db.insert(masterCompanies).values({
    id,
    organizationId: orgId,
    name: data.name,
    domain: data.domain,
    linkedinUrl: data.linkedinUrl || null,
    industry: data.industry || null,
    employeeCount: data.employeeCount || null,
    revenue: data.revenue || null,
    funding: data.funding || null,
    fundingStage: data.fundingStage || null,
    country: data.country || null,
    city: data.city || null,
    logo: data.logo || null,
  });

  return id;
}

/** The lead-shaped company fields every write path already has on hand. */
export interface LeadCompanyInput {
  company?: string | null;
  companyDomain?: string | null;
  companyLinkedin?: string | null;
  companyIndustry?: string | null;
  companyEmployeeCount?: number | null;
}

/**
 * Resolve the canonical company (master_companies.id) for a lead being
 * created or edited. Every lead write path calls this so new rows always
 * carry `leads.master_company_id`.
 *
 * - Empty company name → null (unresolvable).
 * - With a domain → upsertMasterCompany (dedupes on lower(domain)).
 * - Without a domain → exact lower(name) lookup FIRST, so we attach to an
 *   existing real-domain row instead of minting a "<slug>.unknown" duplicate;
 *   only if no name match exists do we fall through to the slug upsert.
 */
export async function resolveCompanyForLead(
  orgId: string,
  input: LeadCompanyInput,
): Promise<string | null> {
  const name = (input.company || "").trim();
  if (!name) return null;

  if (!input.companyDomain) {
    const byName = await db
      .select({ id: masterCompanies.id })
      .from(masterCompanies)
      .where(
        and(
          eq(masterCompanies.organizationId, orgId),
          sql`lower(${masterCompanies.name}) = lower(${name})`,
        ),
      )
      .limit(1);
    if (byName.length > 0) return byName[0].id;
  }

  return upsertMasterCompany(orgId, {
    name,
    domain: input.companyDomain || null,
    linkedinUrl: input.companyLinkedin || null,
    industry: input.companyIndustry || null,
    employeeCount: input.companyEmployeeCount || null,
  });
}

/**
 * Bulk variant for import-sized batches: two set-based lookups (domain, then
 * name) against existing master companies, then one upsert per company that
 * is still unresolved. Returns ids positionally aligned with `rows`.
 */
export async function resolveCompaniesForLeadsBulk(
  orgId: string,
  rows: LeadCompanyInput[],
): Promise<(string | null)[]> {
  const out: (string | null)[] = rows.map(() => null);

  // Group rows by a per-company key so each distinct company resolves once.
  const groups = new Map<string, { input: LeadCompanyInput; indexes: number[] }>();
  for (let i = 0; i < rows.length; i++) {
    const name = (rows[i].company || "").trim();
    if (!name) continue;
    const key = rows[i].companyDomain
      ? `d:${rows[i].companyDomain!.toLowerCase()}`
      : `n:${name.toLowerCase()}`;
    const g = groups.get(key);
    if (g) {
      g.indexes.push(i);
      // Keep the richest input (first row with a domain wins).
      if (!g.input.companyDomain && rows[i].companyDomain) g.input = rows[i];
    } else {
      groups.set(key, { input: rows[i], indexes: [i] });
    }
  }
  if (groups.size === 0) return out;

  // Set-based lookups against existing companies.
  const domains = [...groups.values()]
    .map((g) => g.input.companyDomain?.toLowerCase())
    .filter((d): d is string => !!d);
  const names = [...groups.values()].map((g) => (g.input.company || "").trim().toLowerCase());

  const nameMatch = inArray(sql`lower(${masterCompanies.name})`, names);
  const existing = await db
    .select({ id: masterCompanies.id, name: masterCompanies.name, domain: masterCompanies.domain })
    .from(masterCompanies)
    .where(
      and(
        eq(masterCompanies.organizationId, orgId),
        domains.length
          ? sql`(${inArray(sql`lower(${masterCompanies.domain})`, domains)} OR ${nameMatch})`
          : nameMatch,
      ),
    );
  const byDomain = new Map<string, string>();
  const byName = new Map<string, string>();
  for (const c of existing) {
    if (c.domain) byDomain.set(c.domain.toLowerCase(), c.id);
    byName.set(c.name.trim().toLowerCase(), c.id);
  }

  for (const g of groups.values()) {
    const name = (g.input.company || "").trim();
    const domainKey = g.input.companyDomain?.toLowerCase();
    // Same rules as resolveCompanyForLead: a row WITH a domain matches by
    // domain only (a miss means a genuinely different company — "Acme"
    // acme.io must not merge into "Acme" acme.com by name); only domainless
    // rows fall back to the name match.
    let id = domainKey ? byDomain.get(domainKey) : byName.get(name.toLowerCase());
    if (!id) {
      id = await upsertMasterCompany(orgId, {
        name,
        domain: g.input.companyDomain || null,
        linkedinUrl: g.input.companyLinkedin || null,
        industry: g.input.companyIndustry || null,
        employeeCount: g.input.companyEmployeeCount || null,
      });
      if (g.input.companyDomain) byDomain.set(domainKey!, id);
      byName.set(name.toLowerCase(), id);
    }
    for (const i of g.indexes) out[i] = id;
  }
  return out;
}

/**
 * Upsert a contact into the master contacts table.
 * Returns the master contact ID.
 */
export async function upsertMasterContact(
  orgId: string,
  data: {
    linkedinUrl?: string | null;
    firstName?: string | null;
    lastName?: string | null;
    fullName?: string | null;
    headline?: string | null;
    profileImageUrl?: string | null;
    currentTitle?: string | null;
    currentCompany?: string | null;
    masterCompanyId?: string | null;
    location?: string | null;
    email?: string | null;
    emailStatus?: string | null;
    phone?: string | null;
    phoneStatus?: string | null;
    enrichmentStatus?: string;
  },
): Promise<string | null> {
  // Canonical person resolution (email / phone / linkedin — no longer
  // LinkedIn-only, which used to return null and strand phone/email-only
  // contacts without a master).
  const { findPerson } = await import("./person-resolve");
  const existing = await findPerson(orgId, {
    name: data.fullName,
    firstName: data.firstName,
    lastName: data.lastName,
    title: data.currentTitle,
    company: data.currentCompany,
    email: data.email,
    phone: data.phone,
    linkedinUrl: data.linkedinUrl,
  });

  if (existing) {
    const updates: Record<string, unknown> = {
      lastDiscoveredAt: new Date(),
      updatedAt: new Date(),
    };
    if (data.firstName) updates.firstName = data.firstName;
    if (data.lastName) updates.lastName = data.lastName;
    if (data.fullName) updates.fullName = data.fullName;
    if (data.headline) updates.headline = data.headline;
    if (data.profileImageUrl) updates.profileImageUrl = data.profileImageUrl;
    if (data.currentTitle) updates.currentTitle = data.currentTitle;
    if (data.currentCompany) updates.currentCompany = data.currentCompany;
    if (data.masterCompanyId) updates.masterCompanyId = data.masterCompanyId;
    if (data.location) updates.location = data.location;
    // Only update enrichment data if it's newer/better
    if (data.email && !existing.email) updates.email = data.email;
    if (data.emailStatus) updates.emailStatus = data.emailStatus;
    if (data.phone && !existing.phone) updates.phone = data.phone;
    if (data.phoneStatus) updates.phoneStatus = data.phoneStatus;
    if (data.enrichmentStatus && data.enrichmentStatus !== "none") updates.enrichmentStatus = data.enrichmentStatus;

    await db.update(masterContacts).set(updates).where(eq(masterContacts.id, existing.id));
    return existing.id;
  }

  // No existing person — create via the resolver (handles identity keys,
  // disputed/company LinkedIn URLs and races), then attach the discovery
  // fields the resolver doesn't know about.
  const { resolvePerson } = await import("./person-resolve");
  const id = await resolvePerson(orgId, {
    name: data.fullName,
    firstName: data.firstName,
    lastName: data.lastName,
    title: data.currentTitle,
    company: data.currentCompany,
    email: data.email,
    phone: data.phone,
    linkedinUrl: data.linkedinUrl,
  });
  if (!id) return null; // no usable identity at all

  const extras: Record<string, unknown> = {};
  if (data.headline) extras.headline = data.headline;
  if (data.profileImageUrl) extras.profileImageUrl = data.profileImageUrl;
  if (data.masterCompanyId) extras.masterCompanyId = data.masterCompanyId;
  if (data.location) extras.location = data.location;
  if (data.emailStatus) extras.emailStatus = data.emailStatus;
  if (data.phoneStatus) extras.phoneStatus = data.phoneStatus;
  if (data.enrichmentStatus && data.enrichmentStatus !== "none") extras.enrichmentStatus = data.enrichmentStatus;
  if (Object.keys(extras).length > 0) {
    await db.update(masterContacts).set({ ...extras, updatedAt: new Date() }).where(eq(masterContacts.id, id));
  }

  return id;
}

/**
 * Find cached contacts for a company from the master table.
 * Returns contacts if found AND fresh (discovered within maxAgeDays).
 */
export async function getCachedContacts(
  orgId: string,
  companyLinkedinUrl: string,
  maxAgeDays: number = 30,
): Promise<typeof masterContacts.$inferSelect[] | null> {
  const cutoff = new Date(Date.now() - maxAgeDays * 86400000);

  // Find master company
  const company = await db.query.masterCompanies.findFirst({
    where: and(
      eq(masterCompanies.organizationId, orgId),
      sql`lower(${masterCompanies.linkedinUrl}) = lower(${companyLinkedinUrl})`,
    ),
  });

  if (!company) return null;

  // Find contacts for this company that are fresh
  const contacts = await db
    .select()
    .from(masterContacts)
    .where(
      and(
        eq(masterContacts.organizationId, orgId),
        eq(masterContacts.masterCompanyId, company.id),
        sql`${masterContacts.lastDiscoveredAt} >= ${cutoff}`,
      ),
    );

  return contacts.length > 0 ? contacts : null;
}
