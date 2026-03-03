import { Router, Request, Response, NextFunction } from "express";
import { eq, and } from "drizzle-orm";
import { db } from "../db/index";
import { funnels, funnelSteps } from "../db/schema/funnels";
import { leads, leadEvents } from "../db/schema/leads";
import { imports } from "../db/schema/imports";
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
import { getOrgId } from "../lib/auth";

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
    res.json({ data: buildFunnelPayload(funnel, { includeLeads: true }) });
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
    const { status } = req.body || {};
    const normalizedStatus = normalizeString(status).toLowerCase();

    if (!normalizedStatus || !ALLOWED_STATUSES.has(normalizedStatus)) {
      throw new ApiError(400, "Invalid funnel status");
    }

    const funnel = getFunnelOrThrow(
      await loadFunnel(orgId, req.params.funnelId),
      req.params.funnelId,
    );

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
    const { fileName, mappings, rows } = req.body || {};
    const normalizedFileName =
      normalizeString(fileName) || "uploaded.csv";

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
      .filter(
        (entry: MappingEntry) =>
          entry.csvColumn &&
          entry.mappedField &&
          entry.mappedField !== "--- Skip ---",
      );

    const validMappings = allMappings.filter((e) => e.mappedField !== "Notes");
    const notesMappings = allMappings.filter((e) => e.mappedField === "Notes");

    if (validMappings.length === 0 && notesMappings.length === 0) {
      throw new ApiError(400, "At least one valid field mapping is required");
    }

    const funnel = getFunnelOrThrow(
      await loadFunnel(orgId, req.params.funnelId),
      req.params.funnelId,
    );

    if (!funnel.steps || funnel.steps.length === 0) {
      throw new ApiError(400, "Funnel has no steps configured");
    }

    const existingKeys = new Set(
      funnel.leads.map((l) => dedupeKey(l.name, l.company, l.email)),
    );

    const now = Date.now();
    const importId = createId("import");
    const errors: Array<{ row: number; reason: string }> = [];
    let importedRows = 0;
    let skippedRows = 0;

    const addedLeadIds: string[] = [];
    const newLeads: Array<typeof leads.$inferInsert> = [];
    const newEvents: Array<typeof leadEvents.$inferInsert> = [];

    rows.forEach((rawRow: unknown, index: number) => {
      const row =
        rawRow && typeof rawRow === "object"
          ? (rawRow as Record<string, unknown>)
          : {};

      const name = mappedValue(row, validMappings, "Name");
      const company = mappedValue(row, validMappings, "Company");
      const email = mappedValue(row, validMappings, "Email").toLowerCase();
      const title = mappedValue(row, validMappings, "Title");
      const phone = mappedValue(row, validMappings, "Phone");
      const linkedinUrl = mappedValue(row, validMappings, "LinkedIn URL");

      if (!name || !company) {
        skippedRows += 1;
        errors.push({
          row: index + 2,
          reason: "Missing required Name or Company",
        });
        return;
      }

      if (email && !/^\S+@\S+\.\S+$/.test(email)) {
        skippedRows += 1;
        errors.push({ row: index + 2, reason: "Invalid email format" });
        return;
      }

      const key = dedupeKey(name, company, email);
      if (existingKeys.has(key)) {
        skippedRows += 1;
        errors.push({
          row: index + 2,
          reason: "Duplicate lead already exists in this funnel",
        });
        return;
      }

      existingKeys.add(key);

      // Build notes from notesMappings
      let notes: Record<string, string> | null = null;
      if (notesMappings.length > 0) {
        const built: Record<string, string> = {};
        for (const nm of notesMappings) {
          const val = normalizeString(row[nm.csvColumn]);
          if (val) built[nm.csvColumn] = val;
        }
        if (Object.keys(built).length > 0) notes = built;
      }

      const firstStep = funnel.steps[0];
      const initialDue = new Date(now + firstStep.dayOffset * DAY_MS);
      const leadId = createId("lead");
      const eventId = createId("event");

      newLeads.push({
        id: leadId,
        funnelId: funnel.id,
        name,
        title,
        company,
        email,
        phone,
        linkedinUrl,
        currentStep: 1,
        totalSteps: funnel.steps.length,
        status: "pending",
        nextAction: firstStep.label,
        nextDate: initialDue,
        source: "CSV Import",
        sourceType: "csv",
        score: scoreLead({ name, title, company, email, phone, linkedinUrl }),
        notes,
        createdAt: new Date(now),
        updatedAt: new Date(now),
      });

      newEvents.push({
        id: eventId,
        leadId,
        type: "imported",
        outcome: null,
        stepIndex: 0,
        meta: { importId },
        timestamp: new Date(now),
      });

      importedRows += 1;
      addedLeadIds.push(leadId);
    });

    await db.transaction(async (tx) => {
      // Batch insert leads (postgres.js supports large batch inserts)
      if (newLeads.length > 0) {
        await tx.insert(leads).values(newLeads);
      }

      if (newEvents.length > 0) {
        await tx.insert(leadEvents).values(newEvents);
      }

      await tx.insert(imports).values({
        id: importId,
        funnelId: funnel.id,
        fileName: normalizedFileName,
        totalRows: rows.length,
        importedRows,
        skippedRows,
        mappings: validMappings,
        errors: errors.slice(0, 100),
        createdAt: new Date(now),
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
        totalRows: rows.length,
        importedRows,
        skippedRows,
        errors: errors.slice(0, 20),
        addedLeadIds,
      },
    });
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

export default router;
