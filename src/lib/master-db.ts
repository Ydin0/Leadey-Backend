import { eq, and, sql } from "drizzle-orm";
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
