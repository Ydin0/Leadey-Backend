import { Router, Request, Response, NextFunction } from "express";
import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "../db/index";
import { leads } from "../db/schema/leads";
import { funnels, funnelSteps } from "../db/schema/funnels";
import { getOrgId } from "../lib/auth";
import { ApiError, createId, phoneKey } from "../lib/helpers";
import { fireTrigger } from "../services/workflow-engine";

const router = Router();

function asyncHandler(handler: (req: Request, res: Response, next: NextFunction) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

/** The base lead row, verified against the caller's org. */
async function getBaseLeadOrThrow(orgId: string, funnelId: string, leadId: string) {
  const [row] = await db
    .select({ lead: leads })
    .from(leads)
    .innerJoin(funnels, eq(leads.funnelId, funnels.id))
    .where(and(eq(leads.id, leadId), eq(funnels.id, funnelId), eq(funnels.organizationId, orgId)))
    .limit(1);
  if (!row) throw new ApiError(404, "Lead not found");
  return row.lead;
}

/** Normalised LinkedIn key — protocol/trailing-slash/case insensitive. */
function linkedinKey(url: string | null | undefined): string | null {
  const v = (url || "").trim().toLowerCase().replace(/^https?:\/\/(www\.)?/, "").replace(/\/+$/, "");
  return v || null;
}

/**
 * All lead rows across the org's campaigns that are the SAME PERSON as the
 * base lead. Person identity is the canonical master_contact_id link; the
 * key-based heuristic (email / phone last-9 / LinkedIn) remains as the
 * fallback for rows the identity backfill couldn't resolve (no usable keys).
 * The base row always matches.
 */
export async function findMemberships(orgId: string, base: typeof leads.$inferSelect) {
  const identity = [sql`${leads.id} = ${base.id}`];
  if (base.masterContactId) {
    identity.push(sql`${leads.masterContactId} = ${base.masterContactId}`);
  } else {
    const email = (base.email || "").trim().toLowerCase();
    const phone = phoneKey(base.phone);
    const linkedin = linkedinKey(base.linkedinUrl);
    if (email) identity.push(sql`lower(${leads.email}) = ${email}`);
    if (phone) identity.push(sql`right(regexp_replace(${leads.phone}, '\\D', '', 'g'), 9) = ${phone}`);
    if (linkedin) {
      identity.push(
        sql`lower(regexp_replace(regexp_replace(${leads.linkedinUrl}, '^https?://(www\\.)?', ''), '/+$', '')) = ${linkedin}`,
      );
    }
  }

  const rows = await db
    .select({
      leadId: leads.id,
      leadStatus: leads.status,
      currentStep: leads.currentStep,
      totalSteps: leads.totalSteps,
      addedAt: leads.createdAt,
      funnelId: funnels.id,
      funnelName: funnels.name,
      funnelStatus: funnels.status,
    })
    .from(leads)
    .innerJoin(funnels, eq(leads.funnelId, funnels.id))
    .where(and(eq(funnels.organizationId, orgId), sql.join([sql`(`, sql.join(identity, sql` OR `), sql`)`])))
    .orderBy(asc(leads.createdAt));

  // One membership per campaign (a person can have duplicate rows in one
  // campaign from separate imports — show the oldest).
  const byFunnel = new Map<string, (typeof rows)[number]>();
  for (const r of rows) if (!byFunnel.has(r.funnelId)) byFunnel.set(r.funnelId, r);
  return [...byFunnel.values()];
}

function serialize(m: Awaited<ReturnType<typeof findMemberships>>[number], currentLeadId: string) {
  return {
    leadId: m.leadId,
    funnelId: m.funnelId,
    funnelName: m.funnelName,
    funnelStatus: m.funnelStatus,
    leadStatus: m.leadStatus,
    currentStep: m.currentStep,
    totalSteps: m.totalSteps,
    addedAt: m.addedAt.toISOString(),
    isCurrent: m.leadId === currentLeadId,
  };
}

// ─── GET /funnels/:funnelId/leads/:leadId/campaigns ─────────────────────────
router.get(
  "/funnels/:funnelId/leads/:leadId/campaigns",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const base = await getBaseLeadOrThrow(orgId, String(req.params.funnelId), String(req.params.leadId));
    const memberships = await findMemberships(orgId, base);
    res.json({ data: memberships.map((m) => serialize(m, base.id)) });
  }),
);

// ─── POST /funnels/:funnelId/leads/:leadId/campaigns ────────────────────────
// Add this person to another campaign: copies the contact + company fields
// into a fresh lead row in the target campaign (leads are per-campaign rows).
router.post(
  "/funnels/:funnelId/leads/:leadId/campaigns",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const base = await getBaseLeadOrThrow(orgId, String(req.params.funnelId), String(req.params.leadId));
    const targetFunnelId = String(req.body?.targetFunnelId || "");
    if (!targetFunnelId) throw new ApiError(400, "targetFunnelId is required");

    const [target] = await db
      .select({ id: funnels.id })
      .from(funnels)
      .where(and(eq(funnels.id, targetFunnelId), eq(funnels.organizationId, orgId)))
      .limit(1);
    if (!target) throw new ApiError(404, "Target campaign not found");

    // Already in the target campaign? Return the existing membership.
    const memberships = await findMemberships(orgId, base);
    const existing = memberships.find((m) => m.funnelId === targetFunnelId);
    if (existing) {
      res.json({ data: { ...serialize(existing, base.id), alreadyExists: true } });
      return;
    }

    const steps = await db
      .select({ label: funnelSteps.label })
      .from(funnelSteps)
      .where(eq(funnelSteps.funnelId, targetFunnelId));

    // Same person, new enrollment — carry the canonical person id (resolving
    // it now if this base row predates person linking).
    const { resolvePerson } = await import("../lib/person-resolve");
    const masterContactId =
      base.masterContactId ||
      (await resolvePerson(orgId, {
        name: base.name,
        firstName: base.firstName,
        lastName: base.lastName,
        title: base.title,
        company: base.company,
        email: base.email,
        phone: base.phone,
        linkedinUrl: base.linkedinUrl,
      }).catch(() => null));

    const id = createId("lead");
    await db.insert(leads).values({
      id,
      funnelId: targetFunnelId,
      masterContactId,
      name: base.name,
      firstName: base.firstName,
      lastName: base.lastName,
      title: base.title,
      company: base.company,
      email: base.email,
      phone: base.phone,
      linkedinUrl: base.linkedinUrl,
      source: "Added from lead profile",
      sourceType: "manual",
      status: "pending",
      currentStep: 1,
      totalSteps: steps.length || 1,
      companyDomain: base.companyDomain,
      companyIndustry: base.companyIndustry,
      companyEmployeeCount: base.companyEmployeeCount,
      companyLocation: base.companyLocation,
      companyDescription: base.companyDescription,
      companyLinkedin: base.companyLinkedin,
      companyAnnualRevenue: base.companyAnnualRevenue,
      companyHiringRoles: base.companyHiringRoles,
      doNotCall: base.doNotCall,
    });

    // Enroll into any "lead enters campaign" workflows (fire-and-forget).
    void fireTrigger(orgId, targetFunnelId, id, "lead_enters_campaign");

    const refreshed = await findMemberships(orgId, base);
    res.status(201).json({ data: refreshed.map((m) => serialize(m, base.id)) });
  }),
);

// ─── DELETE /funnels/:funnelId/leads/:leadId/campaigns/:membershipLeadId ────
// Remove this person from a campaign by deleting that campaign's lead row
// (events/notes cascade). Removing the row being viewed is allowed — the
// client navigates away afterwards.
router.delete(
  "/funnels/:funnelId/leads/:leadId/campaigns/:membershipLeadId",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const base = await getBaseLeadOrThrow(orgId, String(req.params.funnelId), String(req.params.leadId));

    const membershipLeadId = String(req.params.membershipLeadId);
    // The row must actually be one of this person's memberships (and org-owned).
    const memberships = await findMemberships(orgId, base);
    const membership = memberships.find((m) => m.leadId === membershipLeadId);
    if (!membership) throw new ApiError(404, "Campaign membership not found");

    await db.delete(leads).where(eq(leads.id, membershipLeadId));
    res.json({ data: { id: membershipLeadId, deleted: true, wasCurrent: membershipLeadId === base.id } });
  }),
);

export default router;
