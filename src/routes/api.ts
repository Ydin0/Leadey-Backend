import { Router, Request, Response, NextFunction } from "express";
import { eq, and, or, inArray, isNull, sql, count } from "drizzle-orm";
import { db } from "../db/index";
import { funnels, funnelSteps, funnelMembers } from "../db/schema/funnels";
import { users } from "../db/schema/organizations";
import { leads, leadEvents } from "../db/schema/leads";
import { scraperSignals } from "../db/schema/scrapers";
import { masterCompanies, masterContacts } from "../db/schema/master";
import { imports } from "../db/schema/imports";

/** Free email providers — never used as a company domain. */
const FREE_EMAIL_DOMAINS = new Set([
  "gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "icloud.com",
  "aol.com", "proton.me", "protonmail.com", "gmx.com", "live.com", "msn.com",
  "me.com", "mac.com", "yandex.com", "zoho.com",
]);

function normalizeDomain(value: string): string {
  let d = (value || "").trim().toLowerCase();
  if (!d) return "";
  d = d.replace(/^https?:\/\//, "").replace(/^www\./, "");
  d = d.split("/")[0].split("?")[0].split("@").pop() || "";
  return d;
}
function domainFromEmail(email: string): string {
  const d = (email.split("@")[1] || "").toLowerCase();
  return d && !FREE_EMAIL_DOMAINS.has(d) ? d : "";
}
import {
  ApiError,
  createId,
  normalizeString,
  clamp,
  scoreLead,
  ALLOWED_CHANNELS,
  ALLOWED_STATUSES,
  ALLOWED_SOURCE_TYPES,
  TERMINAL_STATUSES,
  DAY_MS,
  mappedValue,
  dedupeKey,
  resolveAction,
  type MappingEntry,
} from "../lib/helpers";
import { getAuth } from "@clerk/express";
import {
  buildFunnelPayload,
  computeNextStepSchedule,
  sortLeadsForQueue,
  type Funnel,
  type Lead,
  type Step,
} from "../lib/funnel-service";
import { SmartleadClient, type SmartleadSequence, type SmartleadLeadInput } from "../lib/smartlead-client";
import { getSetting } from "../lib/settings-service";
import { getMergedLeadStatuses } from "../lib/lead-status-config";
import { getOrgId } from "../lib/auth";
import { flagDoNotCall } from "../lib/dnc";

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

interface FunnelParams {
  funnelId: string;
}

interface LeadAdvanceParams {
  funnelId: string;
  leadId: string;
}

/** Load a full funnel with steps, leads, and events from the DB. */
async function loadFunnel(orgId: string, funnelId: string): Promise<Funnel | null> {
  const result = await db.query.funnels.findFirst({
    where: and(eq(funnels.id, funnelId), eq(funnels.organizationId, orgId)),
    with: {
      steps: { orderBy: (s, { asc }) => [asc(s.sortOrder)] },
      leads: {
        with: { events: { orderBy: (e, { asc }) => [asc(e.timestamp)] } },
      },
    },
  });

  if (!result) return null;

  return {
    id: result.id,
    name: result.name,
    description: result.description,
    status: result.status,
    sourceTypes: result.sourceTypes,
    smartleadCampaignId: result.smartleadCampaignId,
    createdAt: result.createdAt,
    steps: result.steps.map((s) => ({
      id: s.id,
      channel: s.channel,
      label: s.label,
      dayOffset: s.dayOffset,
      sortOrder: s.sortOrder,
      subject: s.subject,
      emailBody: s.emailBody,
      action: s.action,
    })),
    leads: result.leads.map((l) => ({
      id: l.id,
      name: l.name,
      title: l.title,
      company: l.company,
      email: l.email,
      phone: l.phone,
      linkedinUrl: l.linkedinUrl,
      currentStep: l.currentStep,
      totalSteps: l.totalSteps,
      status: l.status,
      nextAction: l.nextAction,
      nextDate: l.nextDate,
      source: l.source,
      sourceType: l.sourceType,
      score: l.score,
      smartleadLeadId: l.smartleadLeadId,
      unipileProviderId: l.unipileProviderId,
      companyDomain: l.companyDomain,
      companyIndustry: l.companyIndustry,
      companyEmployeeCount: l.companyEmployeeCount,
      companyLocation: l.companyLocation,
      companyDescription: l.companyDescription,
      companyLinkedin: l.companyLinkedin,
      companyAnnualRevenue: l.companyAnnualRevenue,
      companyHiringRoles: l.companyHiringRoles,
      doNotCall: l.doNotCall,
      opportunityId: l.opportunityId,
      notes: l.notes,
      createdAt: l.createdAt,
      updatedAt: l.updatedAt,
      events: l.events.map((e) => ({
        id: e.id,
        type: e.type,
        outcome: e.outcome,
        stepIndex: e.stepIndex,
        meta: e.meta,
        timestamp: e.timestamp,
      })),
    })),
  };
}

async function loadAllFunnels(orgId: string): Promise<Funnel[]> {
  const results = await db.query.funnels.findMany({
    where: eq(funnels.organizationId, orgId),
    with: {
      steps: { orderBy: (s, { asc }) => [asc(s.sortOrder)] },
      leads: {
        with: { events: { orderBy: (e, { asc }) => [asc(e.timestamp)] } },
      },
    },
  });

  return results.map((result) => ({
    id: result.id,
    name: result.name,
    description: result.description,
    status: result.status,
    sourceTypes: result.sourceTypes,
    smartleadCampaignId: result.smartleadCampaignId,
    createdAt: result.createdAt,
    steps: result.steps.map((s) => ({
      id: s.id,
      channel: s.channel,
      label: s.label,
      dayOffset: s.dayOffset,
      sortOrder: s.sortOrder,
      subject: s.subject,
      emailBody: s.emailBody,
      action: s.action,
    })),
    leads: result.leads.map((l) => ({
      id: l.id,
      name: l.name,
      title: l.title,
      company: l.company,
      email: l.email,
      phone: l.phone,
      linkedinUrl: l.linkedinUrl,
      currentStep: l.currentStep,
      totalSteps: l.totalSteps,
      status: l.status,
      nextAction: l.nextAction,
      nextDate: l.nextDate,
      source: l.source,
      sourceType: l.sourceType,
      score: l.score,
      smartleadLeadId: l.smartleadLeadId,
      unipileProviderId: l.unipileProviderId,
      companyDomain: l.companyDomain,
      companyIndustry: l.companyIndustry,
      companyEmployeeCount: l.companyEmployeeCount,
      companyLocation: l.companyLocation,
      companyDescription: l.companyDescription,
      companyLinkedin: l.companyLinkedin,
      companyAnnualRevenue: l.companyAnnualRevenue,
      companyHiringRoles: l.companyHiringRoles,
      doNotCall: l.doNotCall,
      opportunityId: l.opportunityId,
      notes: l.notes,
      createdAt: l.createdAt,
      updatedAt: l.updatedAt,
      events: l.events.map((e) => ({
        id: e.id,
        type: e.type,
        outcome: e.outcome,
        stepIndex: e.stepIndex,
        meta: e.meta,
        timestamp: e.timestamp,
      })),
    })),
  }));
}

function getFunnelOrThrow(funnel: Funnel | null, funnelId: string): Funnel {
  if (!funnel) {
    throw new ApiError(404, "Funnel not found");
  }
  return funnel;
}

// ─── Health ──────────────────────────────────────────────────────────────

router.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "leadey-funnels-api",
    timestamp: new Date().toISOString(),
  });
});

// ─── GET /funnels ────────────────────────────────────────────────────────

router.get(
  "/funnels",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const allFunnels = await loadAllFunnels(orgId);
    const data = allFunnels.map((f) =>
      buildFunnelPayload(f, { includeLeads: false }),
    );
    res.json({ data });
  }),
);

// ─── GET /funnels/:funnelId ──────────────────────────────────────────────

router.get(
  "/funnels/:funnelId",
  asyncHandler<FunnelParams>(async (req, res) => {
    const orgId = getOrgId(req);
    const funnel = getFunnelOrThrow(
      await loadFunnel(orgId, req.params.funnelId),
      req.params.funnelId,
    );
    // Fetch real members
    const members = await db.select().from(funnelMembers)
      .where(eq(funnelMembers.funnelId, req.params.funnelId));
    const memberData = [];
    for (const m of members) {
      const [user] = await db.select().from(users).where(eq(users.id, m.userId));
      memberData.push({
        teamMemberId: m.userId,
        role: m.role,
        addedAt: m.createdAt.toISOString(),
        email: user?.email || "",
        firstName: user?.firstName || null,
        lastName: user?.lastName || null,
      });
    }
    const payload = buildFunnelPayload(funnel, { includeLeads: true }) as any;
    payload.members = memberData;
    res.json({ data: payload });
  }),
);

// ─── GET /funnels/:funnelId/leads ────────────────────────────────────────

router.get(
  "/funnels/:funnelId/leads",
  asyncHandler<FunnelParams>(async (req, res) => {
    const orgId = getOrgId(req);
    const funnel = getFunnelOrThrow(
      await loadFunnel(orgId, req.params.funnelId),
      req.params.funnelId,
    );
    const sorted = sortLeadsForQueue(funnel.leads);
    res.json({
      data: sorted.map((l) => ({
        id: l.id,
        name: l.name,
        title: l.title,
        company: l.company,
        email: l.email,
        phone: l.phone,
        linkedinUrl: l.linkedinUrl,
        currentStep: l.currentStep,
        totalSteps: l.totalSteps,
        status: l.status,
        nextAction: l.nextAction,
        nextDate: l.nextDate?.toISOString() ?? null,
        source: l.source,
        sourceType: l.sourceType,
        score: l.score,
        notes: l.notes,
        createdAt: l.createdAt.toISOString(),
        updatedAt: l.updatedAt.toISOString(),
        events: l.events.map((e) => ({
          id: e.id,
          type: e.type,
          outcome: e.outcome,
          stepIndex: e.stepIndex,
          meta: e.meta,
          timestamp: e.timestamp.toISOString(),
        })),
      })),
    });
  }),
);

// ─── POST /funnels ───────────────────────────────────────────────────────

router.post(
  "/funnels",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const { name, description, status, steps, sourceTypes } = req.body || {};

    if (!normalizeString(name)) {
      throw new ApiError(400, "Funnel name is required");
    }

    if (!Array.isArray(steps) || steps.length === 0) {
      throw new ApiError(400, "At least one funnel step is required");
    }

    const normalizedSteps = steps
      .map(
        (
          step: { channel?: string; label?: string; dayOffset?: number; subject?: string; emailBody?: string; action?: string },
          index: number,
        ) => {
          const channel = normalizeString(step.channel).toLowerCase();
          const label = normalizeString(step.label) || `Step ${index + 1}`;
          const dayOffset = Number(step.dayOffset);
          const subject = normalizeString(step.subject) || null;
          const emailBody = normalizeString(step.emailBody) || null;
          const action = resolveAction(channel, step.action || null);

          if (!ALLOWED_CHANNELS.has(channel)) {
            throw new ApiError(400, `Invalid channel for step ${index + 1}`);
          }

          if (!Number.isFinite(dayOffset) || dayOffset < 0) {
            throw new ApiError(400, `Invalid dayOffset for step ${index + 1}`);
          }

          return { id: createId("step"), channel, label, dayOffset, subject, emailBody, action };
        },
      )
      .sort(
        (a: { dayOffset: number }, b: { dayOffset: number }) =>
          a.dayOffset - b.dayOffset,
      );

    const normalizedStatus =
      normalizeString(status).toLowerCase() || "draft";
    if (!ALLOWED_STATUSES.has(normalizedStatus)) {
      throw new ApiError(400, "Invalid funnel status");
    }

    const normalizedSourceTypes = Array.isArray(sourceTypes)
      ? sourceTypes
          .map((st: string) => normalizeString(st).toLowerCase())
          .filter((st: string) => ALLOWED_SOURCE_TYPES.has(st))
      : [];

    const funnelId = createId("funnel");
    const now = new Date();

    await db.transaction(async (tx) => {
      await tx.insert(funnels).values({
        id: funnelId,
        organizationId: orgId,
        name: normalizeString(name),
        description: normalizeString(description),
        status: normalizedStatus,
        sourceTypes: normalizedSourceTypes,
        createdAt: now,
      });

      if (normalizedSteps.length > 0) {
        await tx.insert(funnelSteps).values(
          normalizedSteps.map(
            (
              step: {
                id: string;
                channel: string;
                label: string;
                dayOffset: number;
                subject: string | null;
                emailBody: string | null;
                action: string;
              },
              index: number,
            ) => ({
              id: step.id,
              funnelId,
              channel: step.channel,
              label: step.label,
              dayOffset: step.dayOffset,
              sortOrder: index,
              subject: step.subject,
              emailBody: step.emailBody,
              action: step.action,
            }),
          ),
        );
      }
    });

    // Auto-assign creator as funnel owner
    const auth = getAuth(req);
    if (auth?.userId) {
      await db.insert(funnelMembers).values({
        id: createId("fm"),
        funnelId,
        userId: auth.userId,
        role: "owner",
      }).onConflictDoNothing();
    }

    // Smartlead integration: create campaign if email steps have content
    const emailStepsWithContent = normalizedSteps.filter(
      (s: { channel: string; subject: string | null; emailBody: string | null }) =>
        s.channel === "email" && s.subject && s.emailBody,
    );

    if (emailStepsWithContent.length > 0) {
      try {
        const apiKey = await getSetting(orgId, "smartlead_api_key");
        if (apiKey) {
          const client = new SmartleadClient(apiKey);
          const campaign = await client.createCampaign(normalizeString(name));

          // Build sequences from email steps
          const sequences: SmartleadSequence[] = emailStepsWithContent.map(
            (step: { subject: string | null; emailBody: string | null; dayOffset: number }, seqIdx: number) => ({
              seq_number: seqIdx + 1,
              seq_type: "EMAIL",
              seq_delay_details: {
                delay_in_days: seqIdx === 0 ? 0 : step.dayOffset,
              },
              seq_variants: [
                {
                  subject: step.subject!,
                  email_body: step.emailBody!,
                  variant_label: "A",
                  variant_distribution_percentage: 100,
                },
              ],
            }),
          );

          await client.saveSequences(campaign.id, sequences);

          // Store campaign ID on funnel
          await db
            .update(funnels)
            .set({ smartleadCampaignId: String(campaign.id) })
            .where(eq(funnels.id, funnelId));

          // Attach email accounts if configured
          const emailAccountIdsRaw = await getSetting(orgId, "smartlead_email_account_ids");
          if (emailAccountIdsRaw) {
            const emailAccountIds: number[] = JSON.parse(emailAccountIdsRaw);
            if (emailAccountIds.length > 0) {
              await client.addEmailAccountsToCampaign(campaign.id, emailAccountIds);
            }
          }

          // Configure webhook if base URL is set
          const webhookBaseUrl = process.env.WEBHOOK_BASE_URL;
          if (webhookBaseUrl) {
            await client.configureWebhook(
              campaign.id,
              `${webhookBaseUrl.replace(/\/$/, "")}/webhooks/smartlead`,
            );
          }
        }
      } catch (err) {
        console.error("Smartlead campaign creation failed (non-blocking):", err);
      }
    }

    const funnel = await loadFunnel(orgId, funnelId);
    res
      .status(201)
      .json({ data: buildFunnelPayload(funnel!, { includeLeads: true }) });
  }),
);

// ─── PATCH /funnels/:funnelId ─────────────────────────────────────────────

router.patch(
  "/funnels/:funnelId",
  asyncHandler<FunnelParams>(async (req, res) => {
    const orgId = getOrgId(req);
    const body = req.body || {};
    const hasStatus = body.status !== undefined;
    const hasName = body.name !== undefined;
    const hasDescription = body.description !== undefined;
    const hasSteps = Array.isArray(body.steps);

    const funnel = getFunnelOrThrow(
      await loadFunnel(orgId, req.params.funnelId),
      req.params.funnelId,
    );

    // ── Editing name / description / steps ──────────────────────────────
    if (hasName || hasDescription || hasSteps) {
      const funnelUpdates: Record<string, unknown> = {};

      if (hasName) {
        const name = normalizeString(body.name);
        if (!name) throw new ApiError(400, "Funnel name cannot be empty");
        funnelUpdates.name = name;
      }
      if (hasDescription) {
        funnelUpdates.description = normalizeString(body.description);
      }

      let normalizedSteps: Array<{
        id: string;
        channel: string;
        label: string;
        dayOffset: number;
        subject: string | null;
        emailBody: string | null;
        action: string;
      }> | null = null;

      if (hasSteps) {
        if (body.steps.length === 0) {
          throw new ApiError(400, "At least one funnel step is required");
        }
        normalizedSteps = body.steps
          .map(
            (
              step: { channel?: string; label?: string; dayOffset?: number; subject?: string; emailBody?: string; action?: string },
              index: number,
            ) => {
              const channel = normalizeString(step.channel).toLowerCase();
              const label = normalizeString(step.label) || `Step ${index + 1}`;
              const dayOffset = Number(step.dayOffset);
              const subject = normalizeString(step.subject) || null;
              const emailBody = normalizeString(step.emailBody) || null;
              const action = resolveAction(channel, step.action || null);
              if (!ALLOWED_CHANNELS.has(channel)) {
                throw new ApiError(400, `Invalid channel for step ${index + 1}`);
              }
              if (!Number.isFinite(dayOffset) || dayOffset < 0) {
                throw new ApiError(400, `Invalid dayOffset for step ${index + 1}`);
              }
              return { id: createId("step"), channel, label, dayOffset, subject, emailBody, action };
            },
          )
          .sort((a: { dayOffset: number }, b: { dayOffset: number }) => a.dayOffset - b.dayOffset);
      }

      await db.transaction(async (tx) => {
        if (Object.keys(funnelUpdates).length > 0) {
          await tx.update(funnels).set(funnelUpdates).where(eq(funnels.id, funnel.id));
        }

        if (normalizedSteps) {
          // Replace the step set, then clamp every lead's progress to the new
          // length so currentStep can't point past the end of the sequence.
          await tx.delete(funnelSteps).where(eq(funnelSteps.funnelId, funnel.id));
          await tx.insert(funnelSteps).values(
            normalizedSteps.map((step, index) => ({
              id: step.id,
              funnelId: funnel.id,
              channel: step.channel,
              label: step.label,
              dayOffset: step.dayOffset,
              sortOrder: index,
              subject: step.subject,
              emailBody: step.emailBody,
              action: step.action,
            })),
          );
          const newLen = normalizedSteps.length;
          await tx
            .update(leads)
            .set({
              totalSteps: newLen,
              currentStep: sql`LEAST(${leads.currentStep}, ${newLen})`,
              updatedAt: new Date(),
            })
            .where(eq(leads.funnelId, funnel.id));
        }
      });

      const reloaded = await loadFunnel(orgId, req.params.funnelId);
      res.json({ data: buildFunnelPayload(reloaded!, { includeLeads: true }) });
      return;
    }

    // ── Status change (existing behavior) ───────────────────────────────
    const normalizedStatus = normalizeString(body.status).toLowerCase();

    if (!hasStatus || !normalizedStatus || !ALLOWED_STATUSES.has(normalizedStatus)) {
      throw new ApiError(400, "Invalid funnel status");
    }

    await db
      .update(funnels)
      .set({ status: normalizedStatus })
      .where(eq(funnels.id, funnel.id));

    // Sync campaign status with Smartlead
    if (funnel.smartleadCampaignId) {
      try {
        const apiKey = await getSetting(orgId, "smartlead_api_key");
        if (apiKey) {
          const client = new SmartleadClient(apiKey);
          const campaignId = Number(funnel.smartleadCampaignId);
          if (normalizedStatus === "active") {
            await client.setCampaignStatus(campaignId, "START");
          } else if (normalizedStatus === "paused") {
            await client.setCampaignStatus(campaignId, "PAUSED");
          }
        }
      } catch (err) {
        console.error("Smartlead campaign status sync failed (non-blocking):", err);
      }
    }

    const updated = await loadFunnel(orgId, req.params.funnelId);
    res.json({ data: buildFunnelPayload(updated!, { includeLeads: true }) });
  }),
);

// ─── DELETE /funnels/:funnelId ────────────────────────────────────────────

router.delete(
  "/funnels/:funnelId",
  asyncHandler<FunnelParams>(async (req, res) => {
    const orgId = getOrgId(req);
    const funnel = getFunnelOrThrow(
      await loadFunnel(orgId, req.params.funnelId),
      req.params.funnelId,
    );

    await db.delete(funnels).where(eq(funnels.id, funnel.id));

    res.json({ data: { id: funnel.id, deleted: true } });
  }),
);

// ─── POST /funnels/:funnelId/imports/csv ─────────────────────────────────

router.post(
  "/funnels/:funnelId/imports/csv",
  asyncHandler<FunnelParams>(async (req, res) => {
    const orgId = getOrgId(req);
    const { fileName, mappings, rows, groupBy: groupByRaw, dryRun } = req.body || {};
    const normalizedFileName = normalizeString(fileName) || "uploaded.csv";
    const groupBy: "domain" | "name" | "linkedin" =
      groupByRaw === "name" || groupByRaw === "linkedin" ? groupByRaw : "domain";

    if (!Array.isArray(mappings) || mappings.length === 0) {
      throw new ApiError(400, "CSV mappings are required");
    }
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new ApiError(400, "CSV rows are required");
    }
    if (rows.length > 10000) {
      throw new ApiError(400, "CSV import limit is 10,000 rows per upload");
    }

    const allMappings: MappingEntry[] = mappings
      .map((entry: { csvColumn?: string; mappedField?: string }) => ({
        csvColumn: normalizeString(entry.csvColumn),
        mappedField: normalizeString(entry.mappedField),
      }))
      .filter((e: MappingEntry) => e.csvColumn && e.mappedField && e.mappedField !== "--- Skip ---");

    const fieldMappings = allMappings.filter((e) => e.mappedField !== "Notes");
    const notesMappings = allMappings.filter((e) => e.mappedField === "Notes");
    if (fieldMappings.length === 0 && notesMappings.length === 0) {
      throw new ApiError(400, "At least one valid field mapping is required");
    }

    const funnel = getFunnelOrThrow(
      await loadFunnel(orgId, req.params.funnelId),
      req.params.funnelId,
    );
    if (!funnel.steps || funnel.steps.length === 0) {
      throw new ApiError(400, "Funnel has no steps configured");
    }

    // Resolve a value by any of the accepted field labels (back-compat aware).
    const getField = (row: Record<string, unknown>, labels: string[]): string => {
      for (const m of fieldMappings) {
        if (labels.includes(m.mappedField)) {
          const v = normalizeString(row[m.csvColumn]);
          if (v) return v;
        }
      }
      return "";
    };
    const LBL = {
      name: ["Lead Name", "Name", "Full Name"],
      email: ["Lead Email", "Email", "Work Email"],
      title: ["Lead Title", "Title", "Job Title"],
      phone: ["Lead Phone", "Phone", "Mobile"],
      linkedin: ["Lead LinkedIn", "LinkedIn URL", "LinkedIn"],
      cName: ["Company Name", "Company"],
      cDomain: ["Company Domain", "Domain", "Website"],
      cLinkedin: ["Company LinkedIn"],
      cIndustry: ["Company Industry", "Industry"],
      cLocation: ["Company Location", "Location"],
      cSize: ["Company Size", "Employees", "Employee Count"],
      cDescription: ["Company Description", "Description", "About"],
      cRevenue: ["Company Annual Revenue", "Annual Revenue", "Revenue"],
      cHiring: ["Company Hiring Roles", "Hiring Roles", "Hiring For", "Open Roles", "Job Titles"],
    };

    // Hiring roles arrive as one delimited cell ("CTO; VP Sales, Account Exec").
    const parseRoles = (raw: string): string[] =>
      raw
        .split(/[;|\n]|,(?![^(]*\))/)
        .map((r) => r.trim())
        .filter(Boolean)
        .slice(0, 50);

    // Existing funnel leads → dedupe.
    const existingKeys = new Set(funnel.leads.map((l) => dedupeKey(l.name, l.company, l.email)));

    // Preload org master companies for "already exists" detection.
    const masterRows = await db
      .select()
      .from(masterCompanies)
      .where(eq(masterCompanies.organizationId, orgId));
    const masterByDomain = new Map<string, (typeof masterRows)[number]>();
    const masterByName = new Map<string, (typeof masterRows)[number]>();
    const masterByLinkedin = new Map<string, (typeof masterRows)[number]>();
    for (const mc of masterRows) {
      if (mc.domain) masterByDomain.set(mc.domain.toLowerCase(), mc);
      masterByName.set(mc.name.toLowerCase(), mc);
      if (mc.linkedinUrl) masterByLinkedin.set(mc.linkedinUrl.toLowerCase(), mc);
    }

    interface CompanyAgg {
      key: string; name: string; domain: string; linkedin: string;
      industry: string; location: string; size: number | null;
      description: string; revenue: string; hiringRoles: string[];
      existing: (typeof masterRows)[number] | null; leadCount: number;
    }
    const companyMap = new Map<string, CompanyAgg>();

    const now = Date.now();
    const importId = createId("import");
    const errors: Array<{ row: number; reason: string }> = [];
    let importedRows = 0, skippedRows = 0, duplicateLeads = 0, invalidRows = 0;
    const addedLeadIds: string[] = [];
    const newLeads: Array<typeof leads.$inferInsert> = [];
    // Each new lead's company aggregate, aligned by index — used to backfill
    // company fields AFTER all rows are processed so every lead in a company
    // gets the full, unioned company data (e.g. all hiring roles).
    const newLeadAggs: CompanyAgg[] = [];
    const newEvents: Array<typeof leadEvents.$inferInsert> = [];
    const firstStep = funnel.steps[0];

    rows.forEach((rawRow: unknown, index: number) => {
      const row = rawRow && typeof rawRow === "object" ? (rawRow as Record<string, unknown>) : {};

      const name = getField(row, LBL.name);
      const cName = getField(row, LBL.cName);
      const email = getField(row, LBL.email).toLowerCase();
      const cDomainRaw = normalizeDomain(getField(row, LBL.cDomain)) || domainFromEmail(email);
      const cLinkedin = getField(row, LBL.cLinkedin);
      const cIndustry = getField(row, LBL.cIndustry);
      const cLocation = getField(row, LBL.cLocation);
      const cSizeStr = getField(row, LBL.cSize);
      const cSize = cSizeStr ? parseInt(cSizeStr.replace(/[^0-9]/g, ""), 10) || null : null;
      const cDescription = getField(row, LBL.cDescription);
      const cRevenue = getField(row, LBL.cRevenue);
      const cHiringRoles = parseRoles(getField(row, LBL.cHiring));

      if (!name || !cName) {
        skippedRows += 1; invalidRows += 1;
        errors.push({ row: index + 2, reason: "Missing required Lead Name or Company Name" });
        return;
      }
      if (email && !/^\S+@\S+\.\S+$/.test(email)) {
        skippedRows += 1; invalidRows += 1;
        errors.push({ row: index + 2, reason: "Invalid email format" });
        return;
      }

      // Group key for the company.
      const groupVal =
        groupBy === "domain" ? (cDomainRaw || cName.toLowerCase())
        : groupBy === "linkedin" ? (cLinkedin.toLowerCase() || cDomainRaw || cName.toLowerCase())
        : cName.toLowerCase();

      let agg = companyMap.get(groupVal);
      if (!agg) {
        const existing =
          (cDomainRaw && masterByDomain.get(cDomainRaw)) ||
          masterByName.get(cName.toLowerCase()) ||
          (cLinkedin && masterByLinkedin.get(cLinkedin.toLowerCase())) ||
          null;
        agg = {
          key: groupVal,
          name: existing?.name || cName,
          domain: cDomainRaw || existing?.domain || "",
          linkedin: cLinkedin || existing?.linkedinUrl || "",
          industry: cIndustry || existing?.industry || "",
          location: cLocation || [existing?.city, existing?.country].filter(Boolean).join(", "),
          size: cSize ?? existing?.employeeCount ?? null,
          description: cDescription,
          revenue: cRevenue,
          hiringRoles: [...cHiringRoles],
          existing,
          leadCount: 0,
        };
        companyMap.set(groupVal, agg);
      } else {
        if (!agg.domain && cDomainRaw) agg.domain = cDomainRaw;
        if (!agg.linkedin && cLinkedin) agg.linkedin = cLinkedin;
        if (!agg.industry && cIndustry) agg.industry = cIndustry;
        if (!agg.location && cLocation) agg.location = cLocation;
        if (agg.size == null && cSize != null) agg.size = cSize;
        if (!agg.description && cDescription) agg.description = cDescription;
        if (!agg.revenue && cRevenue) agg.revenue = cRevenue;
        // Union the hiring roles seen across this company's rows.
        for (const role of cHiringRoles) {
          if (!agg.hiringRoles.some((r) => r.toLowerCase() === role.toLowerCase())) {
            agg.hiringRoles.push(role);
          }
        }
      }
      const canonicalCompany = agg.name; // nest under existing company name when matched

      const key = dedupeKey(name, canonicalCompany, email);
      if (existingKeys.has(key)) {
        skippedRows += 1; duplicateLeads += 1;
        errors.push({ row: index + 2, reason: "Duplicate lead already in this campaign" });
        return;
      }
      existingKeys.add(key);
      agg.leadCount += 1;

      let notes: Record<string, string> | null = null;
      if (notesMappings.length > 0) {
        const built: Record<string, string> = {};
        for (const nm of notesMappings) {
          const val = normalizeString(row[nm.csvColumn]);
          if (val) built[nm.csvColumn] = val;
        }
        if (Object.keys(built).length > 0) notes = built;
      }

      const title = getField(row, LBL.title);
      const phone = getField(row, LBL.phone);
      const linkedinUrl = getField(row, LBL.linkedin);
      const leadId = createId("lead");
      newLeads.push({
        id: leadId, funnelId: funnel.id, name, title, company: canonicalCompany, email, phone, linkedinUrl,
        currentStep: 1, totalSteps: funnel.steps.length, status: "pending",
        nextAction: firstStep.label, nextDate: new Date(now + firstStep.dayOffset * DAY_MS),
        source: "CSV Import", sourceType: "csv",
        score: scoreLead({ name, title, company: canonicalCompany, email, phone, linkedinUrl }),
        // Company fields backfilled after the loop from the final aggregate.
        notes, createdAt: new Date(now), updatedAt: new Date(now),
      });
      newLeadAggs.push(agg);
      newEvents.push({ id: createId("event"), leadId, type: "imported", outcome: null, stepIndex: 0, meta: { importId }, timestamp: new Date(now) });
      importedRows += 1;
      addedLeadIds.push(leadId);
    });

    // Backfill company fields onto each new lead from its (now-complete)
    // company aggregate so leads at the same company share consistent data.
    newLeads.forEach((lead, i) => {
      const agg = newLeadAggs[i];
      lead.companyDomain = agg.domain || null;
      lead.companyIndustry = agg.industry || null;
      lead.companyEmployeeCount = agg.size;
      lead.companyLocation = agg.location || null;
      lead.companyDescription = agg.description || null;
      lead.companyLinkedin = agg.linkedin || null;
      lead.companyAnnualRevenue = agg.revenue || null;
      lead.companyHiringRoles = agg.hiringRoles.length ? agg.hiringRoles : null;
    });

    const companies = [...companyMap.values()].filter((c) => c.leadCount > 0);
    const existingCompanies = companies.filter((c) => c.existing).length;
    const newCompanies = companies.length - existingCompanies;
    const summary = {
      totalRows: rows.length, importedRows, skippedRows, duplicateLeads, invalidRows,
      companiesTotal: companies.length, existingCompanies, newCompanies, groupBy,
    };

    // Dry run → return the review preview without writing anything.
    if (dryRun) {
      res.json({ data: { dryRun: true, ...summary, errors: errors.slice(0, 20) } });
      return;
    }

    await db.transaction(async (tx) => {
      // Upsert master companies so "company already exists" works across imports.
      for (const c of companies) {
        if (c.existing) {
          await tx.update(masterCompanies)
            .set({
              lastSeenAt: new Date(now), updatedAt: new Date(now),
              domain: c.existing.domain || c.domain || null,
              linkedinUrl: c.existing.linkedinUrl || c.linkedin || null,
              industry: c.existing.industry || c.industry || null,
              employeeCount: c.existing.employeeCount ?? c.size,
            })
            .where(eq(masterCompanies.id, c.existing.id));
        } else {
          await tx.insert(masterCompanies).values({
            id: createId("company"), organizationId: orgId, name: c.name,
            domain: c.domain || null, linkedinUrl: c.linkedin || null,
            industry: c.industry || null, employeeCount: c.size,
            lastSeenAt: new Date(now), createdAt: new Date(now), updatedAt: new Date(now),
          }).onConflictDoNothing({ target: [masterCompanies.organizationId, masterCompanies.domain] });
        }
      }
      if (newLeads.length > 0) await tx.insert(leads).values(newLeads);
      if (newEvents.length > 0) await tx.insert(leadEvents).values(newEvents);
      await tx.insert(imports).values({
        id: importId, funnelId: funnel.id, fileName: normalizedFileName,
        totalRows: rows.length, importedRows, skippedRows,
        mappings: fieldMappings, errors: errors.slice(0, 100), createdAt: new Date(now),
      });
    });

    // Push leads to Smartlead if campaign exists
    if (funnel.smartleadCampaignId && newLeads.length > 0) {
      try {
        const apiKey = await getSetting(orgId, "smartlead_api_key");
        if (apiKey) {
          const client = new SmartleadClient(apiKey);
          const campaignId = Number(funnel.smartleadCampaignId);

          // Convert leads to Smartlead format
          const smartleadLeads: SmartleadLeadInput[] = newLeads.map((l) => {
            const nameParts = (l.name || "").split(" ");
            return {
              email: l.email || "",
              first_name: nameParts[0] || "",
              last_name: nameParts.slice(1).join(" ") || "",
              company_name: l.company || "",
              phone_number: l.phone || undefined,
              linkedin_profile: l.linkedinUrl || undefined,
            };
          });

          // Batch push in groups of 100
          for (let i = 0; i < smartleadLeads.length; i += 100) {
            const batch = smartleadLeads.slice(i, i + 100);
            const result = await client.addLeads(campaignId, batch, {
              return_lead_ids: true,
            });

            // Map returned Smartlead lead IDs back to our leads
            const newlyAdded = result.emailToLeadIdMap?.newlyAddedLeads;
            if (newlyAdded) {
              for (const [email, slLeadId] of Object.entries(newlyAdded)) {
                const matchIdx = newLeads.findIndex(
                  (nl) => nl.email?.toLowerCase() === email.toLowerCase(),
                );
                if (matchIdx >= 0) {
                  await db
                    .update(leads)
                    .set({ smartleadLeadId: String(slLeadId) })
                    .where(eq(leads.id, newLeads[matchIdx].id));
                }
              }
            }
          }
        }
      } catch (err) {
        console.error("Smartlead lead push failed (non-blocking):", err);
      }
    }

    res.status(201).json({
      data: {
        importId,
        funnelId: funnel.id,
        fileName: normalizedFileName,
        ...summary,
        errors: errors.slice(0, 20),
        addedLeadIds,
      },
    });
  }),
);

// ─── PATCH /funnels/:funnelId/leads/:leadId/status ───────────────────────
// Manually set a lead's status (built-in or custom) and record the change.

router.patch(
  "/funnels/:funnelId/leads/:leadId/status",
  asyncHandler<LeadAdvanceParams>(async (req, res) => {
    const orgId = getOrgId(req);
    const status = normalizeString(req.body && req.body.status).toLowerCase();

    const statuses = await getMergedLeadStatuses(orgId);
    if (!status || !statuses.some((s) => s.key === status)) {
      throw new ApiError(400, "Invalid lead status");
    }

    const funnel = getFunnelOrThrow(
      await loadFunnel(orgId, req.params.funnelId),
      req.params.funnelId,
    );
    const lead = funnel.leads.find((l) => l.id === req.params.leadId);
    if (!lead) {
      throw new ApiError(404, "Lead not found in funnel");
    }

    const now = Date.now();
    await db.insert(leadEvents).values({
      id: createId("event"),
      leadId: lead.id,
      type: "status_change",
      outcome: status,
      stepIndex: Math.max((lead.currentStep || 1) - 1, 0),
      meta: { manual: true },
      timestamp: new Date(now),
    });

    // Status is company-level: apply to EVERY contact at this company in the
    // funnel so the company reads as one status.
    await db
      .update(leads)
      .set({ status, updatedAt: new Date(now) })
      .where(
        and(
          eq(leads.funnelId, funnel.id),
          sql`lower(${leads.company}) = lower(${lead.company})`,
        ),
      );

    res.json({ data: { id: lead.id, status, company: lead.company } });
  }),
);

// ─── POST /funnels/:funnelId/leads/:leadId/advance ───────────────────────

router.post(
  "/funnels/:funnelId/leads/:leadId/advance",
  asyncHandler<LeadAdvanceParams>(async (req, res) => {
    const orgId = getOrgId(req);
    const outcome =
      normalizeString(req.body && req.body.outcome).toLowerCase() || "sent";
    const allowedOutcomes = new Set([
      "sent",
      "opened",
      "clicked",
      "replied",
      "bounced",
      "completed",
    ]);

    if (!allowedOutcomes.has(outcome)) {
      throw new ApiError(400, "Invalid lead outcome");
    }

    const funnel = getFunnelOrThrow(
      await loadFunnel(orgId, req.params.funnelId),
      req.params.funnelId,
    );

    const lead = funnel.leads.find((l) => l.id === req.params.leadId);
    if (!lead) {
      throw new ApiError(404, "Lead not found in funnel");
    }

    const now = Date.now();
    const currentStepIndex = clamp(
      (lead.currentStep || 1) - 1,
      0,
      Math.max(funnel.steps.length - 1, 0),
    );

    // Insert the event
    const step = funnel.steps[currentStepIndex];
    const eventId = createId("event");
    await db.insert(leadEvents).values({
      id: eventId,
      leadId: lead.id,
      type: "step_outcome",
      outcome,
      stepIndex: currentStepIndex,
      meta: {
        channel: step?.channel ?? null,
        action: step?.action ?? null,
      },
      timestamp: new Date(now),
    });

    // Determine new lead state
    let newStatus: string;
    let newNextAction: string;
    let newNextDate: Date;
    let newCurrentStep = lead.currentStep;

    if (TERMINAL_STATUSES.has(outcome)) {
      newStatus = outcome;
      newNextDate = new Date(now);

      if (outcome === "replied") {
        newNextAction = "Review reply and route to owner";
      } else if (outcome === "bounced") {
        newNextAction = "Fix contact data and retry";
      } else {
        newNextAction = "Sequence complete";
      }
    } else {
      const schedule = computeNextStepSchedule(
        funnel.steps,
        currentStepIndex,
        now,
      );

      if (schedule.completed) {
        newStatus = "completed";
        newNextAction = schedule.nextAction;
        newNextDate = new Date(schedule.nextDate);
        newCurrentStep = funnel.steps.length;
      } else {
        newCurrentStep = clamp(
          (lead.currentStep || 1) + 1,
          1,
          funnel.steps.length,
        );
        newStatus = "pending";
        newNextAction = schedule.nextAction;
        newNextDate = new Date(schedule.nextDate);
      }
    }

    await db
      .update(leads)
      .set({
        status: newStatus,
        nextAction: newNextAction,
        nextDate: newNextDate,
        currentStep: newCurrentStep,
        updatedAt: new Date(now),
      })
      .where(eq(leads.id, lead.id));

    // Reload the full funnel to build the response payload
    const updatedFunnel = await loadFunnel(orgId, req.params.funnelId);
    const updatedLead = updatedFunnel!.leads.find(
      (l) => l.id === req.params.leadId,
    );

    res.json({
      data: {
        lead: updatedLead
          ? {
              id: updatedLead.id,
              name: updatedLead.name,
              title: updatedLead.title,
              company: updatedLead.company,
              email: updatedLead.email,
              phone: updatedLead.phone,
              linkedinUrl: updatedLead.linkedinUrl,
              currentStep: updatedLead.currentStep,
              totalSteps: updatedLead.totalSteps,
              status: updatedLead.status,
              nextAction: updatedLead.nextAction,
              nextDate: updatedLead.nextDate?.toISOString() ?? null,
              source: updatedLead.source,
              sourceType: updatedLead.sourceType,
              score: updatedLead.score,
              notes: updatedLead.notes,
              createdAt: updatedLead.createdAt.toISOString(),
              updatedAt: updatedLead.updatedAt.toISOString(),
              events: updatedLead.events.map((e) => ({
                id: e.id,
                type: e.type,
                outcome: e.outcome,
                stepIndex: e.stepIndex,
                meta: e.meta,
                timestamp: e.timestamp.toISOString(),
              })),
            }
          : null,
        funnel: buildFunnelPayload(updatedFunnel!, { includeLeads: true }),
      },
    });
  }),
);

// ─── POST /funnels/:funnelId/leads/:leadId/log-call ──────────────────────
// Records a real phone call against a lead. Always logs a call touch (so the
// call counter increments), and ticks the step forward ONLY when the lead's
// current step is a call-channel step — so repeat calls on a later step don't
// over-advance the sequence.
router.post(
  "/funnels/:funnelId/leads/:leadId/log-call",
  asyncHandler<LeadAdvanceParams>(async (req, res) => {
    const orgId = getOrgId(req);
    const outcome =
      normalizeString(req.body && req.body.outcome).toLowerCase() || "completed";

    const funnel = getFunnelOrThrow(
      await loadFunnel(orgId, req.params.funnelId),
      req.params.funnelId,
    );

    const lead = funnel.leads.find((l) => l.id === req.params.leadId);
    if (!lead) {
      throw new ApiError(404, "Lead not found in funnel");
    }

    const now = Date.now();
    const currentStepIndex = clamp(
      (lead.currentStep || 1) - 1,
      0,
      Math.max(funnel.steps.length - 1, 0),
    );
    const step = funnel.steps[currentStepIndex];
    const isCallStep = (step?.channel ?? "").toLowerCase() === "call";

    // Always log the call as a call-channel touch so it counts toward the
    // lead's call activity, regardless of which step they're on.
    await db.insert(leadEvents).values({
      id: createId("event"),
      leadId: lead.id,
      type: "step_outcome",
      outcome,
      stepIndex: currentStepIndex,
      meta: { channel: "call", action: step?.action ?? "call" },
      timestamp: new Date(now),
    });

    // Tick the step forward only when the current step is a call step and the
    // lead isn't already in a terminal state.
    let newCurrentStep = lead.currentStep;
    let newStatus = lead.status;
    let newNextAction = lead.nextAction;
    let newNextDate = lead.nextDate ?? new Date(now);

    if (isCallStep && !TERMINAL_STATUSES.has(lead.status)) {
      const schedule = computeNextStepSchedule(funnel.steps, currentStepIndex, now);
      if (schedule.completed) {
        newStatus = "completed";
        newNextAction = schedule.nextAction;
        newNextDate = new Date(schedule.nextDate);
        newCurrentStep = funnel.steps.length;
      } else {
        newCurrentStep = clamp((lead.currentStep || 1) + 1, 1, funnel.steps.length);
        newStatus = "pending";
        newNextAction = schedule.nextAction;
        newNextDate = new Date(schedule.nextDate);
      }
    }

    await db
      .update(leads)
      .set({
        status: newStatus,
        nextAction: newNextAction,
        nextDate: newNextDate,
        currentStep: newCurrentStep,
        updatedAt: new Date(now),
      })
      .where(eq(leads.id, lead.id));

    const updatedFunnel = await loadFunnel(orgId, req.params.funnelId);
    const updatedLead = updatedFunnel!.leads.find((l) => l.id === req.params.leadId);

    res.json({
      data: {
        lead: updatedLead
          ? {
              id: updatedLead.id,
              name: updatedLead.name,
              title: updatedLead.title,
              company: updatedLead.company,
              email: updatedLead.email,
              phone: updatedLead.phone,
              linkedinUrl: updatedLead.linkedinUrl,
              currentStep: updatedLead.currentStep,
              totalSteps: updatedLead.totalSteps,
              status: updatedLead.status,
              nextAction: updatedLead.nextAction,
              nextDate: updatedLead.nextDate?.toISOString() ?? null,
              source: updatedLead.source,
              sourceType: updatedLead.sourceType,
              score: updatedLead.score,
              notes: updatedLead.notes,
              createdAt: updatedLead.createdAt.toISOString(),
              updatedAt: updatedLead.updatedAt.toISOString(),
              events: updatedLead.events.map((e) => ({
                id: e.id,
                type: e.type,
                outcome: e.outcome,
                stepIndex: e.stepIndex,
                meta: e.meta,
                timestamp: e.timestamp.toISOString(),
              })),
            }
          : null,
        funnel: buildFunnelPayload(updatedFunnel!, { includeLeads: true }),
      },
    });
  }),
);

// ─── POST /funnels/:funnelId/leads/:leadId/dnc ───────────────────────────
// Toggles a single PERSON's Do-Not-Contact flag (compliance). NON-DESTRUCTIVE:
// the person STAYS in every campaign — their lead rows just get flagged (shown
// in red, with a confirm before any call). Matched by email/linkedin/phone so
// the flag follows the person everywhere; mirrored onto the master contact.
// Body: { value?: boolean } (default true).
router.post(
  "/funnels/:funnelId/leads/:leadId/dnc",
  asyncHandler<LeadAdvanceParams>(async (req, res) => {
    const orgId = getOrgId(req);
    const value = req.body?.value === undefined ? true : !!req.body.value;

    const funnel = getFunnelOrThrow(
      await loadFunnel(orgId, req.params.funnelId),
      req.params.funnelId,
    );
    const lead = funnel.leads.find((l) => l.id === req.params.leadId);
    if (!lead) throw new ApiError(404, "Lead not found in funnel");

    const result = await db.transaction((tx) =>
      flagDoNotCall(tx, orgId, lead, value),
    );

    const refreshed = await loadFunnel(orgId, req.params.funnelId);
    res.json({
      data: {
        name: lead.name,
        doNotCall: value,
        flaggedLeads: result.flaggedLeads,
        funnel: buildFunnelPayload(refreshed!, { includeLeads: true }),
      },
    });
  }),
);

// ─── API Error Handler ───────────────────────────────────────────────────

router.use(
  (err: ApiError, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || 500;
    const message = err.message || "Unexpected server error";

    res.status(status).json({
      error: {
        message,
        details: err.details || null,
      },
    });
  },
);

// ─── Funnel Members ─────────────────────────────────────────────────────

// GET /funnels/:funnelId/members — list funnel members
router.get(
  "/funnels/:funnelId/members",
  asyncHandler<FunnelParams>(async (req, res) => {
    const orgId = getOrgId(req);
    const funnelId = req.params.funnelId;

    const funnel = getFunnelOrThrow(
      await loadFunnel(orgId, funnelId),
      funnelId,
    );

    const members = await db.select().from(funnelMembers)
      .where(eq(funnelMembers.funnelId, funnelId));

    // Enrich with user data
    const memberData = [];
    for (const m of members) {
      const [user] = await db.select().from(users).where(eq(users.id, m.userId));
      memberData.push({
        id: m.id,
        userId: m.userId,
        role: m.role,
        email: user?.email || "",
        firstName: user?.firstName || null,
        lastName: user?.lastName || null,
        imageUrl: user?.imageUrl || null,
        createdAt: m.createdAt.toISOString(),
      });
    }

    res.json({ data: memberData });
  }),
);

// POST /funnels/:funnelId/members — add member to funnel
router.post(
  "/funnels/:funnelId/members",
  asyncHandler<FunnelParams>(async (req, res) => {
    const orgId = getOrgId(req);
    const funnelId = req.params.funnelId;
    const { userId, role } = req.body;

    if (!userId) throw new ApiError(400, "userId is required");

    getFunnelOrThrow(await loadFunnel(orgId, funnelId), funnelId);

    // Check if already a member
    const existing = await db.query.funnelMembers.findFirst({
      where: and(eq(funnelMembers.funnelId, funnelId), eq(funnelMembers.userId, userId)),
    });
    if (existing) throw new ApiError(400, "User is already a member of this funnel");

    const id = createId("fm");
    const [member] = await db.insert(funnelMembers).values({
      id,
      funnelId,
      userId,
      role: role || "contributor",
    }).returning();

    const [user] = await db.select().from(users).where(eq(users.id, userId));

    res.status(201).json({
      data: {
        id: member.id,
        userId: member.userId,
        role: member.role,
        email: user?.email || "",
        firstName: user?.firstName || null,
        lastName: user?.lastName || null,
        imageUrl: user?.imageUrl || null,
        createdAt: member.createdAt.toISOString(),
      },
    });
  }),
);

// PATCH /funnels/:funnelId/members/:userId — update member role
router.patch(
  "/funnels/:funnelId/members/:userId",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const funnelId = req.params.funnelId as string;
    const userId = req.params.userId as string;
    const { role } = req.body;

    if (!role) throw new ApiError(400, "role is required");

    const [updated] = await db.update(funnelMembers)
      .set({ role })
      .where(and(eq(funnelMembers.funnelId, funnelId), eq(funnelMembers.userId, userId)))
      .returning();

    if (!updated) throw new ApiError(404, "Member not found");

    res.json({ data: { id: updated.id, userId: updated.userId, role: updated.role } });
  }),
);

// DELETE /funnels/:funnelId/members/:userId — remove member
router.delete(
  "/funnels/:funnelId/members/:userId",
  asyncHandler(async (req, res) => {
    const funnelId = req.params.funnelId as string;
    const userId = req.params.userId as string;

    await db.delete(funnelMembers)
      .where(and(eq(funnelMembers.funnelId, funnelId), eq(funnelMembers.userId, userId)));

    res.json({ data: { userId, removed: true } });
  }),
);

// ─── POST /funnels/backfill-company-data ─────────────────────────────────
// One-time backfill: populate company metadata on leads from scraper signals
router.post(
  "/funnels/backfill-company-data",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);

    // Fast exit: this backfill only sources data from scraper signals. If the
    // org has none (e.g. CSV-only), skip the expensive lead scan + fuzzy LIKE
    // lookups entirely.
    const [{ signalCount } = { signalCount: 0 }] = await db
      .select({ signalCount: count() })
      .from(scraperSignals)
      .where(eq(scraperSignals.organizationId, orgId));
    if (Number(signalCount) === 0) {
      res.json({ data: { total: 0, updated: 0 } });
      return;
    }

    // Get all leads missing company data
    const leadsToFix = await db
      .select({ id: leads.id, company: leads.company })
      .from(leads)
      .innerJoin(funnels, eq(leads.funnelId, funnels.id))
      .where(
        and(
          eq(funnels.organizationId, orgId),
          isNull(leads.companyDomain),
        ),
      );

    let updated = 0;
    const seen = new Map<string, { domain?: string; industry?: string; employeeCount?: number; location?: string }>();

    for (const lead of leadsToFix) {
      const key = lead.company.toLowerCase();

      if (!seen.has(key)) {
        // Try exact match first, then fuzzy (LIKE %name%)
        let signal = await db.query.scraperSignals.findFirst({
          where: and(
            eq(scraperSignals.organizationId, orgId),
            sql`lower(${scraperSignals.company}) = lower(${lead.company})`,
          ),
          columns: { companyDomain: true, companyIndustry: true, companyEmployeeCount: true, location: true },
        });
        if (!signal) {
          signal = await db.query.scraperSignals.findFirst({
            where: and(
              eq(scraperSignals.organizationId, orgId),
              sql`lower(${scraperSignals.company}) LIKE '%' || lower(${lead.company}) || '%'`,
            ),
            columns: { companyDomain: true, companyIndustry: true, companyEmployeeCount: true, location: true },
          });
        }
        seen.set(key, signal ? {
          domain: signal.companyDomain || undefined,
          industry: signal.companyIndustry || undefined,
          employeeCount: signal.companyEmployeeCount || undefined,
          location: signal.location || undefined,
        } : {});
      }

      const meta = seen.get(key)!;
      if (meta.domain || meta.industry || meta.employeeCount || meta.location) {
        await db
          .update(leads)
          .set({
            companyDomain: meta.domain || null,
            companyIndustry: meta.industry || null,
            companyEmployeeCount: meta.employeeCount || null,
            companyLocation: meta.location || null,
            updatedAt: new Date(),
          })
          .where(eq(leads.id, lead.id));
        updated++;
      }
    }

    console.log(`[Backfill] Updated ${updated}/${leadsToFix.length} leads with company data`);
    res.json({ data: { total: leadsToFix.length, updated } });
  }),
);

export default router;
