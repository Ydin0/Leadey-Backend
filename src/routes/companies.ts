import { Router, Request, Response, NextFunction } from "express";
import { eq, and } from "drizzle-orm";
import { db } from "../db";
import { masterCompanies } from "../db/schema/master";
import { scraperSignals } from "../db/schema/scrapers";
import { scraperContacts } from "../db/schema/contacts";
import { leads } from "../db/schema/leads";
import { funnels } from "../db/schema/funnels";
import { opportunities, pipelineStages } from "../db/schema/opportunities";
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

const DAY_MS = 24 * 60 * 60 * 1000;
const norm = (s: string | null | undefined) => (s || "").trim().toLowerCase();
const clamp = (n: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, n));

type Priority = "high" | "medium" | "low";

/**
 * GET /api/companies/command-center
 *
 * Builds the Companies Command Center snapshot from REAL org data.
 * Hard facts (name, industry, employee count, signal counts, lead counts,
 * pipeline value) come straight from the DB. Scores/risk/stage are derived
 * with the transparent formulas below — never randomised. Fields with no
 * backend model yet (per-company owner, SLA, capacity, health history) are
 * returned as null/0 rather than fabricated.
 */
router.get(
  "/companies/command-center",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const now = Date.now();
    const sevenDaysAgo = now - 7 * DAY_MS;

    const [companyRows, signalRows, contactRows, leadRows, oppRows, memberRows] =
      await Promise.all([
        db
          .select()
          .from(masterCompanies)
          .where(eq(masterCompanies.organizationId, orgId))
          .limit(500),
        db
          .select({
            id: scraperSignals.id,
            company: scraperSignals.company,
            signalType: scraperSignals.signalType,
            score: scraperSignals.score,
            jobTitle: scraperSignals.jobTitle,
            createdAt: scraperSignals.createdAt,
          })
          .from(scraperSignals)
          .where(eq(scraperSignals.organizationId, orgId))
          .limit(4000),
        db
          .select({
            company: scraperContacts.currentCompany,
            companyName: scraperContacts.companyName,
            email: scraperContacts.email,
            enrichmentStatus: scraperContacts.enrichmentStatus,
          })
          .from(scraperContacts)
          .where(eq(scraperContacts.organizationId, orgId))
          .limit(8000),
        db
          .select({
            company: leads.company,
            status: leads.status,
            funnelName: funnels.name,
          })
          .from(leads)
          .innerJoin(funnels, eq(leads.funnelId, funnels.id))
          .where(eq(funnels.organizationId, orgId))
          .limit(8000),
        db
          .select({
            masterCompanyId: opportunities.masterCompanyId,
            value: opportunities.value,
            stageType: pipelineStages.type,
          })
          .from(opportunities)
          .leftJoin(
            pipelineStages,
            eq(opportunities.stageId, pipelineStages.id),
          )
          .where(eq(opportunities.organizationId, orgId)),
        db
          .select({
            id: users.id,
            firstName: users.firstName,
            lastName: users.lastName,
            role: users.role,
          })
          .from(users)
          .where(eq(users.organizationId, orgId)),
      ]);

    // ── Bucket related rows by normalised company name ──────────────────
    const signalsByCompany = new Map<string, typeof signalRows>();
    for (const s of signalRows) {
      const key = norm(s.company);
      if (!key) continue;
      (signalsByCompany.get(key) ?? signalsByCompany.set(key, []).get(key)!).push(s);
    }

    const contactsByCompany = new Map<string, typeof contactRows>();
    for (const c of contactRows) {
      const key = norm(c.company || c.companyName);
      if (!key) continue;
      (contactsByCompany.get(key) ?? contactsByCompany.set(key, []).get(key)!).push(c);
    }

    const leadsByCompany = new Map<string, typeof leadRows>();
    for (const l of leadRows) {
      const key = norm(l.company);
      if (!key) continue;
      (leadsByCompany.get(key) ?? leadsByCompany.set(key, []).get(key)!).push(l);
    }

    // Pipeline value (open) + customer flag (any won opp) keyed by company id.
    const pipelineByCompany = new Map<string, number>();
    const customerCompanyIds = new Set<string>();
    for (const o of oppRows) {
      if (!o.masterCompanyId) continue;
      if (o.stageType === "won") customerCompanyIds.add(o.masterCompanyId);
      if (o.stageType !== "lost") {
        pipelineByCompany.set(
          o.masterCompanyId,
          (pipelineByCompany.get(o.masterCompanyId) ?? 0) +
            Number(o.value ?? 0),
        );
      }
    }

    // ── Build one account per company ───────────────────────────────────
    const accounts = companyRows.map((mc) => {
      const key = norm(mc.name);
      const sigs = signalsByCompany.get(key) ?? [];
      const contacts = contactsByCompany.get(key) ?? [];
      const companyLeads = leadsByCompany.get(key) ?? [];

      const totalSignals = sigs.length;
      const signalsLast7d = sigs.filter(
        (s) => s.createdAt && s.createdAt.getTime() >= sevenDaysAgo,
      ).length;
      const lastSignalAt =
        sigs.reduce<Date | null>((latest, s) => {
          if (!s.createdAt) return latest;
          return !latest || s.createdAt > latest ? s.createdAt : latest;
        }, null) ?? mc.lastSeenAt;
      const relevanceScore = totalSignals
        ? Math.round(
            sigs.reduce((sum, s) => sum + (s.score ?? 0), 0) / totalSignals,
          )
        : 0;

      const discoveredLeads = contacts.length;
      const leadsEnriched = contacts.filter(
        (c) => !!c.email || c.enrichmentStatus === "enriched",
      ).length;
      const inFunnelLeads = companyLeads.length;
      const leadTarget = mc.employeeCount
        ? clamp(Math.round(mc.employeeCount / 40), 3, 30)
        : 5;
      const leadCoveragePct = clamp(
        Math.round((inFunnelLeads / leadTarget) * 100),
        0,
        100,
      );

      const activeFunnelNames = Array.from(
        new Set(companyLeads.map((l) => l.funnelName).filter(Boolean)),
      ) as string[];

      let enrichmentStatus:
        | "not_enriched"
        | "partial"
        | "full"
        | "pending_review";
      if (discoveredLeads === 0) enrichmentStatus = "not_enriched";
      else if (leadsEnriched >= discoveredLeads) enrichmentStatus = "full";
      else if (leadsEnriched > 0) enrichmentStatus = "partial";
      else enrichmentStatus = "pending_review";

      // Transparent health formula (0–100), no randomness.
      let health = 50;
      health += Math.min(leadCoveragePct, 100) * 0.3;
      if (signalsLast7d > 0) health += 12;
      if (inFunnelLeads > 0) health += 8;
      if (totalSignals === 0) health -= 10;
      const healthScore = clamp(Math.round(health), 5, 99);

      const riskLevel =
        healthScore >= 70 ? "healthy" : healthScore >= 50 ? "watch" : "at_risk";

      const isCustomer = customerCompanyIds.has(mc.id);
      const stage = isCustomer
        ? "customer"
        : inFunnelLeads > 0
          ? "in_funnel"
          : discoveredLeads > 0
            ? "engaging"
            : totalSignals > 0
              ? "monitoring"
              : "new";

      // Next best action derived from real state.
      let nextAction: string;
      let nextActionPriority: Priority;
      if (riskLevel === "at_risk") {
        nextAction = "Re-engage — account health is declining";
        nextActionPriority = "high";
      } else if (signalsLast7d > 0 && inFunnelLeads === 0) {
        nextAction = "Push discovered leads into a funnel";
        nextActionPriority = "high";
      } else if (discoveredLeads > 0 && leadsEnriched < discoveredLeads) {
        nextAction = "Enrich remaining contacts";
        nextActionPriority = "medium";
      } else if (signalsLast7d > 0) {
        nextAction = "Review new hiring signals";
        nextActionPriority = "medium";
      } else {
        nextAction = "Monitor for new signals";
        nextActionPriority = "low";
      }
      const dueOffsetDays =
        nextActionPriority === "high" ? 0 : nextActionPriority === "medium" ? 2 : 5;
      const nextActionDueAt = new Date(now + dueOffsetDays * DAY_MS);

      const topSignals = [...sigs]
        .sort(
          (a, b) =>
            (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0),
        )
        .slice(0, 3)
        .map((s) => ({
          id: s.id,
          type: s.signalType,
          summary: s.jobTitle,
          timestamp: s.createdAt ?? new Date(now),
        }));

      return {
        id: mc.id,
        name: mc.name,
        domain: mc.domain ?? "",
        industry: mc.industry ?? "—",
        employeeCount: mc.employeeCount ?? 0,
        fundingStage: mc.fundingStage ?? "Unknown",
        icpId: "",
        icpName: "—",
        enrichmentStatus,
        relevanceScore,
        healthScore,
        healthDelta: 0, // no historical snapshot model yet
        riskLevel,
        stage,
        ownerId: null, // per-company ownership not modelled yet
        ownerName: null,
        ownerTeam: null,
        signalsLast7d,
        totalSignals,
        lastSignalAt: lastSignalAt ?? new Date(now),
        leadCoveragePct,
        leadsEnriched,
        leadTarget,
        discoveredLeads,
        inFunnelLeads,
        activeFunnelNames,
        estimatedPipelineUsd: Math.round(pipelineByCompany.get(mc.id) ?? 0),
        lastTouchAt: null,
        nextAction,
        nextActionPriority,
        nextActionDueAt,
        topSignals,
      };
    });

    // ── Owners directory (real team members; perf metrics not modelled) ──
    const owners = memberRows.map((m) => {
      const name = [m.firstName, m.lastName].filter(Boolean).join(" ").trim();
      const initials =
        (m.firstName?.[0] ?? "") + (m.lastName?.[0] ?? "") || "?";
      const managerRoles = ["admin", "owner", "manager"];
      return {
        id: m.id,
        name: name || "Member",
        role: managerRoles.includes((m.role ?? "").toLowerCase())
          ? ("manager" as const)
          : ("rep" as const),
        team: "—",
        avatarSeed: initials.toUpperCase(),
        responseSlaHours: 0,
        capacityTarget: 0,
      };
    });

    // ── Overview rollup ─────────────────────────────────────────────────
    const endOfToday = new Date();
    endOfToday.setHours(23, 59, 59, 999);
    const overview = {
      totalCompanies: accounts.length,
      monitoredCompanies: accounts.filter((a) => a.stage !== "new").length,
      atRiskCompanies: accounts.filter((a) => a.riskLevel === "at_risk").length,
      unassignedCompanies: accounts.filter((a) => a.ownerId === null).length,
      avgHealthScore: accounts.length
        ? Math.round(
            accounts.reduce((s, a) => s + a.healthScore, 0) / accounts.length,
          )
        : 0,
      avgCoveragePct: accounts.length
        ? Math.round(
            accounts.reduce((s, a) => s + a.leadCoveragePct, 0) /
              accounts.length,
          )
        : 0,
      totalSignalsLast7d: accounts.reduce((s, a) => s + a.signalsLast7d, 0),
      dueTodayActions: accounts.filter(
        (a) => a.nextActionDueAt.getTime() <= endOfToday.getTime(),
      ).length,
    };

    // ── Priority queue: most urgent accounts first ──────────────────────
    const priorityWeight: Record<Priority, number> = { high: 0, medium: 1, low: 2 };
    const queue = [...accounts]
      .sort(
        (a, b) =>
          priorityWeight[a.nextActionPriority] -
            priorityWeight[b.nextActionPriority] ||
          a.healthScore - b.healthScore,
      )
      .slice(0, 12)
      .map((a) => ({
        id: `queue_${a.id}`,
        companyId: a.id,
        companyName: a.name,
        ownerName: a.ownerName ?? "Unassigned",
        reason:
          a.riskLevel === "at_risk"
            ? "Health declining"
            : a.signalsLast7d > 0
              ? `${a.signalsLast7d} new signal${a.signalsLast7d === 1 ? "" : "s"}`
              : "Needs attention",
        action: a.nextAction,
        priority: a.nextActionPriority,
        dueAt: a.nextActionDueAt,
        estimatedCredits: Math.max(a.leadTarget - a.inFunnelLeads, 0),
      }));

    res.json({
      data: {
        generatedAt: new Date(now),
        overview,
        owners,
        ownerPerformance: [],
        queue,
        accounts,
      },
    });
  }),
);

/**
 * GET /api/companies/list
 *
 * Flat, filterable company list for the org Leads page "Companies" table.
 * Lead counts come from scraperContacts (consistent with the Leads view and
 * company-counts); company metadata (industry, size, location, funding) is
 * pulled from scraperSignals, which carry the richest company fields.
 */
router.get(
  "/companies/list",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);

    const [contactRows, signalRows] = await Promise.all([
      db
        .select({
          company: scraperContacts.currentCompany,
          companyName: scraperContacts.companyName,
          domain: scraperContacts.companyDomain,
          linkedinUrl: scraperContacts.companyLinkedinUrl,
          email: scraperContacts.email,
          enrichmentStatus: scraperContacts.enrichmentStatus,
          status: scraperContacts.status,
        })
        .from(scraperContacts)
        .where(eq(scraperContacts.organizationId, orgId))
        .limit(20000),
      db
        .select({
          company: scraperSignals.company,
          domain: scraperSignals.companyDomain,
          linkedinUrl: scraperSignals.companyLinkedinUrl,
          industry: scraperSignals.companyIndustry,
          employeeCount: scraperSignals.companyEmployeeCount,
          fundingStage: scraperSignals.companyFundingStage,
          country: scraperSignals.companyCountry,
          city: scraperSignals.companyCity,
          logo: scraperSignals.companyLogo,
        })
        .from(scraperSignals)
        .where(eq(scraperSignals.organizationId, orgId))
        .limit(20000),
    ]);

    // Company metadata keyed by normalised name (first non-null wins).
    const meta = new Map<string, Record<string, unknown>>();
    for (const s of signalRows) {
      const key = norm(s.company);
      if (!key) continue;
      const e = meta.get(key) || {};
      meta.set(key, {
        domain: e.domain || s.domain || null,
        linkedinUrl: e.linkedinUrl || s.linkedinUrl || null,
        industry: e.industry || s.industry || null,
        employeeCount: e.employeeCount || s.employeeCount || null,
        fundingStage: e.fundingStage || s.fundingStage || null,
        country: e.country || s.country || null,
        city: e.city || s.city || null,
        logo: e.logo || s.logo || null,
      });
    }

    type Agg = {
      name: string;
      leadCount: number;
      enrichedCount: number;
      inCampaignCount: number;
      domain: string | null;
      linkedinUrl: string | null;
    };
    const map = new Map<string, Agg>();
    for (const c of contactRows) {
      const display = (c.company || c.companyName || "").trim();
      if (!display) continue;
      const key = norm(display);
      let row = map.get(key);
      if (!row) {
        row = { name: display, leadCount: 0, enrichedCount: 0, inCampaignCount: 0, domain: c.domain || null, linkedinUrl: c.linkedinUrl || null };
        map.set(key, row);
      }
      row.leadCount++;
      if (c.email || c.enrichmentStatus === "enriched") row.enrichedCount++;
      if (c.status === "in_funnel") row.inCampaignCount++;
      if (!row.domain && c.domain) row.domain = c.domain;
      if (!row.linkedinUrl && c.linkedinUrl) row.linkedinUrl = c.linkedinUrl;
    }

    const list = Array.from(map.entries())
      .map(([key, row]) => {
        const m = meta.get(key) || {};
        return {
          name: row.name,
          domain: row.domain || (m.domain as string | null) || null,
          linkedinUrl: row.linkedinUrl || (m.linkedinUrl as string | null) || null,
          industry: (m.industry as string | null) || null,
          employeeCount: (m.employeeCount as number | null) || null,
          fundingStage: (m.fundingStage as string | null) || null,
          country: (m.country as string | null) || null,
          city: (m.city as string | null) || null,
          logo: (m.logo as string | null) || null,
          leadCount: row.leadCount,
          enrichedCount: row.enrichedCount,
          inCampaignCount: row.inCampaignCount,
        };
      })
      .sort((a, b) => b.leadCount - a.leadCount);

    res.json({ data: list });
  }),
);

export default router;
