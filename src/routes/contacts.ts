import { Router, Request, Response, NextFunction } from "express";
import { eq, and, desc, count, inArray, sql } from "drizzle-orm";
import { db } from "../db/index";
import { scraperSignals } from "../db/schema/scrapers";
import { discoveryRuns, scraperContacts } from "../db/schema/contacts";
import { funnels, funnelSteps } from "../db/schema/funnels";
import { leads, leadEvents } from "../db/schema/leads";
import { ApifyClient, mapSeniorityLevels, type ApifyProfileItem } from "../lib/apify-client";
import { BetterContactClient, type BetterContactInput } from "../lib/bettercontact-client";
import { SmartleadClient, type SmartleadLeadInput } from "../lib/smartlead-client";
import { getSetting } from "../lib/settings-service";
import { ApiError, createId, DAY_MS, scoreLead, dedupeKey } from "../lib/helpers";
import { getOrgId } from "../lib/auth";

const router = Router();

type AsyncHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => Promise<void>;

function asyncHandler(handler: AsyncHandler) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function getApifyClient(): ApifyClient {
  const token = process.env.APIFY_API_TOKEN;
  if (!token) {
    throw new ApiError(500, "APIFY_API_TOKEN environment variable is not configured");
  }
  return new ApifyClient(token);
}

function getBetterContactClient(): BetterContactClient {
  const apiKey = process.env.BETTERCONTACT_API_KEY;
  if (!apiKey) {
    throw new ApiError(500, "BETTERCONTACT_API_KEY environment variable is not configured");
  }
  return new BetterContactClient(apiKey);
}

// ─── POST /contacts/discover/:assignmentId ──────────────────────────
// Start discovery — extract company LinkedIn URLs from signals, call Apify
router.post(
  "/contacts/discover/:assignmentId",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const assignmentId = req.params.assignmentId as string;
    const {
      targetRoles = [],
      seniorityLevels = [],
      maxPerCompany = 5,
      maxTotal = 100,
      companyLinkedinUrls: explicitUrls,
    } = req.body as {
      targetRoles?: string[];
      seniorityLevels?: string[];
      maxPerCompany?: number;
      maxTotal?: number;
      companyLinkedinUrls?: string[];
    };

    let companyUrls: string[];

    if (explicitUrls && explicitUrls.length > 0) {
      // Use explicitly provided URLs (from companies tab selection)
      companyUrls = explicitUrls.filter(Boolean);
    } else {
      // Get unique company LinkedIn URLs from all signals
      const signals = await db
        .selectDistinct({ companyLinkedinUrl: scraperSignals.companyLinkedinUrl })
        .from(scraperSignals)
        .where(
          and(
            eq(scraperSignals.assignmentId, assignmentId),
            eq(scraperSignals.organizationId, orgId),
            sql`${scraperSignals.companyLinkedinUrl} IS NOT NULL AND ${scraperSignals.companyLinkedinUrl} != ''`,
          ),
        );

      companyUrls = signals
        .map((s) => s.companyLinkedinUrl!)
        .filter(Boolean);
    }

    if (companyUrls.length === 0) {
      throw new ApiError(400, "No companies with LinkedIn URLs found in this search");
    }

    // Split companies into batches of 10 and fire all Apify runs in parallel.
    // "all_at_once" mode supports up to 10 companies per run — by batching
    // we get parallelism instead of sequential "one_by_one" processing.
    const BATCH_SIZE = 10;
    const batches: string[][] = [];
    for (let i = 0; i < companyUrls.length; i += BATCH_SIZE) {
      batches.push(companyUrls.slice(i, i + BATCH_SIZE));
    }

    const seniorityIds = mapSeniorityLevels(seniorityLevels);
    const client = getApifyClient();
    const maxItemsPerBatch = Math.ceil(maxTotal / batches.length);

    // Fire all batches in parallel
    console.log(`[Discovery] Starting ${batches.length} parallel Apify runs for ${companyUrls.length} companies`);
    const runResponses = await Promise.all(
      batches.map((batch) =>
        client.startRun({
          companies: batch,
          profileScraperMode: "Short ($4 per 1k)",
          companyBatchMode: "all_at_once",
          ...(targetRoles.length > 0 ? { jobTitles: targetRoles } : {}),
          ...(seniorityIds.length > 0 ? { seniorityLevelIds: seniorityIds } : {}),
          maxItems: maxItemsPerBatch,
        }),
      ),
    );

    // Store all run IDs and dataset IDs as JSON arrays in the existing text columns
    const apifyRunIds = runResponses.map((r) => r.data.id);
    const apifyDatasetIds = runResponses.map((r) => r.data.defaultDatasetId);

    const estimatedCost = (maxTotal / 1000) * 4 + batches.length * 0.02;

    const runId = createId("dr");
    await db.insert(discoveryRuns).values({
      id: runId,
      organizationId: orgId,
      assignmentId,
      apifyRunId: JSON.stringify(apifyRunIds),
      apifyDatasetId: JSON.stringify(apifyDatasetIds),
      targetRoles,
      seniorityLevels,
      maxPerCompany,
      maxTotal,
      companyLinkedinUrls: companyUrls,
      status: "running",
      companiesQueried: companyUrls.length,
      estimatedCost,
      startedAt: new Date(),
    });

    res.json({
      data: {
        runId,
        apifyRunId: apifyRunIds[0],
        companiesQueried: companyUrls.length,
        estimatedCost,
        batchCount: batches.length,
      },
    });
  }),
);

// ─── GET /contacts/discovery-runs ───────────────────────────────────
// List discovery runs for an assignment
router.get(
  "/contacts/discovery-runs",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const assignmentId = req.query.assignmentId as string | undefined;

    const where = assignmentId
      ? and(eq(discoveryRuns.organizationId, orgId), eq(discoveryRuns.assignmentId, assignmentId))
      : eq(discoveryRuns.organizationId, orgId);

    const runs = await db
      .select()
      .from(discoveryRuns)
      .where(where)
      .orderBy(desc(discoveryRuns.createdAt));

    res.json({ data: runs });
  }),
);

// ─── POST /contacts/discovery-runs/:runId/poll ──────────────────────
// Check Apify status; ingest results when done
// Supports both legacy single-run and new parallel-batched (JSON array) formats
router.post(
  "/contacts/discovery-runs/:runId/poll",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const runId = req.params.runId as string;

    const [run] = await db
      .select()
      .from(discoveryRuns)
      .where(and(eq(discoveryRuns.id, runId), eq(discoveryRuns.organizationId, orgId)))
      .limit(1);

    if (!run) throw new ApiError(404, "Discovery run not found");
    if (run.status === "succeeded" || run.status === "failed") {
      return void res.json({ data: run });
    }
    if (!run.apifyRunId) throw new ApiError(400, "No Apify run ID");

    // Parse run IDs — supports JSON array (new parallel batches) or plain string (legacy single run)
    let apifyRunIds: string[];
    try {
      const parsed = JSON.parse(run.apifyRunId);
      apifyRunIds = Array.isArray(parsed) ? parsed : [run.apifyRunId];
    } catch {
      apifyRunIds = [run.apifyRunId];
    }

    // Parse dataset IDs similarly
    let storedDatasetIds: string[] = [];
    if (run.apifyDatasetId) {
      try {
        const parsed = JSON.parse(run.apifyDatasetId);
        storedDatasetIds = Array.isArray(parsed) ? parsed : [run.apifyDatasetId];
      } catch {
        storedDatasetIds = [run.apifyDatasetId];
      }
    }

    // Check status of ALL Apify runs in parallel
    const client = getApifyClient();
    const statuses = await Promise.all(
      apifyRunIds.map((id) => client.getRunStatus(id)),
    );

    const runStatuses = statuses.map((s) => s.data.status);
    const anyRunning = runStatuses.some((s) => s === "RUNNING" || s === "READY");
    const allTerminal = runStatuses.every(
      (s) => s === "SUCCEEDED" || s === "FAILED" || s === "ABORTED" || s === "TIMED-OUT",
    );
    const succeededCount = runStatuses.filter((s) => s === "SUCCEEDED").length;
    const failedStatuses = runStatuses.filter(
      (s) => s === "FAILED" || s === "ABORTED" || s === "TIMED-OUT",
    );

    console.log(`[Discovery ${runId}] Poll: ${apifyRunIds.length} runs — ${runStatuses.join(", ")}`);

    // If any are still running, return running status with progress info
    if (anyRunning || !allTerminal) {
      return void res.json({
        data: {
          ...run,
          apifyStatus: "RUNNING",
          batchProgress: { total: apifyRunIds.length, succeeded: succeededCount, running: runStatuses.filter((s) => s === "RUNNING" || s === "READY").length },
        },
      });
    }

    // All terminal — if ALL failed, mark as failed
    if (succeededCount === 0) {
      await db
        .update(discoveryRuns)
        .set({ status: "failed", error: `All ${apifyRunIds.length} Apify runs failed: ${failedStatuses.join(", ")}`, completedAt: new Date() })
        .where(eq(discoveryRuns.id, runId));

      const [updated] = await db.select().from(discoveryRuns).where(eq(discoveryRuns.id, runId));
      return void res.json({ data: updated });
    }

    // At least some succeeded — collect dataset IDs from succeeded runs
    const datasetIds: string[] = [];
    for (let i = 0; i < statuses.length; i++) {
      if (statuses[i].data.status === "SUCCEEDED") {
        const dsId = storedDatasetIds[i] || statuses[i].data.defaultDatasetId;
        if (dsId) datasetIds.push(dsId);
      }
    }

    if (datasetIds.length === 0) {
      await db
        .update(discoveryRuns)
        .set({ status: "failed", error: "No dataset IDs found from succeeded runs", completedAt: new Date() })
        .where(eq(discoveryRuns.id, runId));

      const [updated] = await db.select().from(discoveryRuns).where(eq(discoveryRuns.id, runId));
      return void res.json({ data: updated });
    }

    // Fetch items from ALL succeeded datasets in parallel
    async function fetchAllDatasetItems(dsId: string): Promise<ApifyProfileItem[]> {
      const items: ApifyProfileItem[] = [];
      let offset = 0;
      const PAGE_SIZE = 1000;
      while (true) {
        const page = await client.getDatasetItems(dsId, offset, PAGE_SIZE);
        items.push(...page);
        if (page.length < PAGE_SIZE) break;
        offset += PAGE_SIZE;
      }
      return items;
    }

    const allItemArrays = await Promise.all(datasetIds.map(fetchAllDatasetItems));
    const allItems = allItemArrays.flat();

    console.log(`[Discovery ${runId}] Fetched ${allItems.length} total items from ${datasetIds.length} datasets`);

    // Log a sample item to diagnose field names
    if (allItems.length > 0) {
      const sample = allItems[0] as Record<string, unknown>;
      console.log(`[Discovery ${runId}] Sample item keys:`, Object.keys(sample).join(", "));
      console.log(`[Discovery ${runId}] Sample profileUrl/linkedinUrl:`, sample.profileUrl, sample.linkedinUrl, sample.url, sample.link);
    }

    // Get existing LinkedIn URLs for dedup
    const existingContacts = await db
      .select({ linkedinUrl: scraperContacts.linkedinUrl })
      .from(scraperContacts)
      .where(
        and(
          eq(scraperContacts.assignmentId, run.assignmentId),
          eq(scraperContacts.organizationId, orgId),
        ),
      );
    const existingUrls = new Set(
      existingContacts.map((c) => c.linkedinUrl?.toLowerCase()).filter(Boolean),
    );
    console.log(`[Discovery ${runId}] ${existingUrls.size} existing contacts for dedup`);

    // Extract LinkedIn profile URL from item — try many known field names
    function extractProfileUrl(item: Record<string, unknown>): string {
      if (typeof item.profileUrl === "string" && item.profileUrl) return item.profileUrl;
      if (typeof item.linkedinUrl === "string" && item.linkedinUrl) return item.linkedinUrl;
      if (typeof item.linkedInUrl === "string" && item.linkedInUrl) return item.linkedInUrl;
      if (typeof item.linkedin_url === "string" && item.linkedin_url) return item.linkedin_url;
      if (typeof item.url === "string" && item.url && String(item.url).includes("linkedin.com")) return item.url as string;
      if (typeof item.link === "string" && item.link && String(item.link).includes("linkedin.com")) return item.link as string;
      if (typeof item.profile_url === "string" && item.profile_url) return item.profile_url;
      if (typeof item.publicProfileUrl === "string" && item.publicProfileUrl) return item.publicProfileUrl;
      if (typeof item.linkedinProfile === "string" && item.linkedinProfile) return item.linkedinProfile;
      return "";
    }

    // Track per-company counts for maxPerCompany limit
    const companyContactCounts = new Map<string, number>();
    let contactsInserted = 0;
    let skippedNoUrl = 0;
    let skippedDedup = 0;
    let skippedPerCompany = 0;
    let skippedMaxTotal = 0;

    for (const item of allItems) {
      const rawItem = item as Record<string, unknown>;
      const linkedinUrl = extractProfileUrl(rawItem);
      if (!linkedinUrl) {
        skippedNoUrl++;
        continue;
      }

      // Dedup
      if (existingUrls.has(linkedinUrl.toLowerCase())) {
        skippedDedup++;
        continue;
      }
      existingUrls.add(linkedinUrl.toLowerCase());

      // Extract current position data (Apify nests title/company inside currentPositions[])
      const currentPositions = Array.isArray(rawItem.currentPositions) ? rawItem.currentPositions : [];
      const primaryPosition = currentPositions[0] as Record<string, unknown> | undefined;
      const positionTitle = primaryPosition?.title as string | undefined;
      const positionCompany = primaryPosition?.companyName as string | undefined;
      const positionCompanyUrl = primaryPosition?.companyLinkedinUrl as string | undefined;

      // Location can be a string or an object { linkedinText: "..." }
      let locationStr: string | null = null;
      if (typeof item.location === "string") {
        locationStr = item.location;
      } else if (item.location && typeof item.location === "object") {
        const locObj = item.location as Record<string, unknown>;
        locationStr = (locObj.linkedinText as string) || (locObj.default as string) || null;
      }

      const companyName = item.companyName || positionCompany || null;
      // Prefer LinkedIn URL for the linkedin column; companyUrl from Apify is often the website domain
      const companyLinkedinUrlVal = item.companyLinkedinUrl || positionCompanyUrl || null;
      const companyWebsite = item.companyUrl || null;

      // Max per company limit — use LinkedIn URL or company name for grouping
      const companyKey = (companyLinkedinUrlVal || companyName || "").toLowerCase();
      if (companyKey) {
        const currentCount = companyContactCounts.get(companyKey) || 0;
        if (currentCount >= run.maxPerCompany) {
          skippedPerCompany++;
          continue;
        }
        companyContactCounts.set(companyKey, currentCount + 1);
      }

      // Max total limit
      if (contactsInserted >= run.maxTotal) {
        skippedMaxTotal++;
        continue;
      }

      await db.insert(scraperContacts).values({
        id: createId("sc"),
        organizationId: orgId,
        assignmentId: run.assignmentId,
        discoveryRunId: runId,
        firstName: item.firstName || null,
        lastName: item.lastName || null,
        fullName: item.fullName || `${item.firstName || ""} ${item.lastName || ""}`.trim() || null,
        headline: item.headline || (rawItem.summary as string) || null,
        linkedinUrl,
        location: locationStr,
        profileImageUrl: item.profileImageUrl || (rawItem.pictureUrl as string) || (rawItem.profilePicture as string) || null,
        currentTitle: item.title || positionTitle || null,
        currentCompany: companyName,
        currentCompanyLinkedinUrl: companyLinkedinUrlVal,
        companyName,
        companyLinkedinUrl: companyLinkedinUrlVal,
        companyDomain: companyWebsite || null,
        status: "discovered",
        rawData: rawItem,
      });
      contactsInserted++;
    }

    const partialFailNote = failedStatuses.length > 0
      ? ` (${failedStatuses.length}/${apifyRunIds.length} batches failed)`
      : "";
    console.log(`[Discovery ${runId}] Ingestion complete${partialFailNote}: ${contactsInserted} inserted, ${skippedNoUrl} no URL, ${skippedDedup} deduped, ${skippedPerCompany} per-company limit, ${skippedMaxTotal} max-total limit`);

    // Update run
    await db
      .update(discoveryRuns)
      .set({
        status: "succeeded",
        contactsFound: contactsInserted,
        completedAt: new Date(),
        ...(failedStatuses.length > 0 ? { error: `${failedStatuses.length}/${apifyRunIds.length} batches failed` } : {}),
      })
      .where(eq(discoveryRuns.id, runId));

    const [updated] = await db.select().from(discoveryRuns).where(eq(discoveryRuns.id, runId));
    res.json({ data: updated });
  }),
);

// ─── GET /contacts/company-counts ────────────────────────────────────
// Get per-company contact counts for a given assignment
router.get(
  "/contacts/company-counts",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const assignmentId = req.query.assignmentId as string | undefined;
    if (!assignmentId) {
      throw new ApiError(400, "assignmentId is required");
    }

    const rows = await db
      .select({
        companyLinkedinUrl: scraperContacts.companyLinkedinUrl,
        companyName: scraperContacts.companyName,
        count: count(),
      })
      .from(scraperContacts)
      .where(
        and(
          eq(scraperContacts.organizationId, orgId),
          eq(scraperContacts.assignmentId, assignmentId),
        ),
      )
      .groupBy(scraperContacts.companyLinkedinUrl, scraperContacts.companyName);

    res.json({
      data: rows.map((r) => ({
        companyLinkedinUrl: r.companyLinkedinUrl,
        companyName: r.companyName,
        count: Number(r.count),
      })),
    });
  }),
);

// ─── GET /contacts ──────────────────────────────────────────────────
// List contacts (paginated, filterable)
router.get(
  "/contacts",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const assignmentId = req.query.assignmentId as string | undefined;
    const status = req.query.status as string | undefined;
    const enrichmentStatus = req.query.enrichmentStatus as string | undefined;
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const pageSize = Math.min(500, Math.max(1, parseInt(req.query.pageSize as string) || 25));

    const conditions = [eq(scraperContacts.organizationId, orgId)];
    if (assignmentId) conditions.push(eq(scraperContacts.assignmentId, assignmentId));
    if (status) conditions.push(eq(scraperContacts.status, status));
    if (enrichmentStatus) conditions.push(eq(scraperContacts.enrichmentStatus, enrichmentStatus));

    const whereClause = and(...conditions);

    const [{ total }] = await db
      .select({ total: count() })
      .from(scraperContacts)
      .where(whereClause);

    const totalCount = Number(total);
    const totalPages = Math.ceil(totalCount / pageSize);

    const rows = await db
      .select()
      .from(scraperContacts)
      .where(whereClause)
      .orderBy(desc(scraperContacts.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    res.json({
      data: rows,
      meta: { page, pageSize, totalCount, totalPages },
    });
  }),
);

// ─── POST /contacts/enrich ──────────────────────────────────────────
// Send contactIds to BetterContact (auto-chunks batches of 100)
router.post(
  "/contacts/enrich",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const { contactIds } = req.body as { contactIds: string[] };

    if (!contactIds?.length) {
      throw new ApiError(400, "contactIds is required");
    }

    // Fetch contacts
    const contacts = await db
      .select()
      .from(scraperContacts)
      .where(
        and(
          eq(scraperContacts.organizationId, orgId),
          inArray(scraperContacts.id, contactIds),
        ),
      );

    if (contacts.length === 0) {
      throw new ApiError(404, "No contacts found");
    }

    // Build BetterContact input
    const bcInput: BetterContactInput[] = contacts.map((c) => ({
      first_name: c.firstName || "",
      last_name: c.lastName || "",
      company: c.companyName || c.currentCompany || "",
      company_domain: c.companyDomain || "",
      linkedin_url: c.linkedinUrl || "",
    }));

    const client = getBetterContactClient();
    const responses = await client.submitAll(bcInput);
    const requestIds = responses.map((r) => r.id);

    // Mark contacts as pending enrichment, assigning requestId per chunk
    for (let i = 0; i < contacts.length; i += 100) {
      const chunkIds = contacts.slice(i, i + 100).map((c) => c.id);
      const requestId = requestIds[Math.floor(i / 100)] || requestIds[requestIds.length - 1];
      await db
        .update(scraperContacts)
        .set({
          enrichmentStatus: "pending",
          bettercontactRequestId: requestId,
          updatedAt: new Date(),
        })
        .where(inArray(scraperContacts.id, chunkIds));
    }

    res.json({
      data: {
        requestIds,
        contactCount: contacts.length,
      },
    });
  }),
);

// ─── POST /contacts/enrich/poll-all ─────────────────────────────────
// Poll all active enrichment batches for an assignment
// MUST be defined before /contacts/enrich/:requestId/poll to avoid Express matching "poll-all" as :requestId
router.post(
  "/contacts/enrich/poll-all",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const { requestIds } = req.body as { requestIds: string[] };

    if (!requestIds?.length) {
      throw new ApiError(400, "requestIds is required");
    }

    const client = getBetterContactClient();
    let allFinished = true;
    let totalEnriched = 0;

    for (const requestId of requestIds) {
      const result = await client.getBatchResults(requestId);

      // Treat terminated/failed as finished (no results to process)
      if (result.status === "terminated" || result.status === "failed") {
        // Mark these contacts as failed enrichment
        await db
          .update(scraperContacts)
          .set({ enrichmentStatus: "failed", updatedAt: new Date() })
          .where(
            and(
              eq(scraperContacts.organizationId, orgId),
              eq(scraperContacts.bettercontactRequestId, requestId),
              eq(scraperContacts.enrichmentStatus, "pending"),
            ),
          );
        continue;
      }

      if (result.status !== "finished") {
        allFinished = false;
        continue;
      }

      // Update contacts with results — match by requestId + linkedin_url (case-insensitive)
      if (result.data) {
        for (const item of result.data) {
          const linkedinUrl = item.linkedin_url;
          if (!linkedinUrl) continue;

          await db
            .update(scraperContacts)
            .set({
              email: item.email || null,
              emailStatus: item.email_status || null,
              phone: item.phone || null,
              phoneStatus: item.phone_status || null,
              enrichmentStatus: item.email || item.phone ? "enriched" : "failed",
              enrichedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(scraperContacts.organizationId, orgId),
                eq(scraperContacts.bettercontactRequestId, requestId),
                sql`lower(${scraperContacts.linkedinUrl}) = lower(${linkedinUrl})`,
              ),
            );
          totalEnriched++;
        }
      }
    }

    res.json({
      data: {
        status: allFinished ? "finished" : "processing",
        enrichedCount: totalEnriched,
      },
    });
  }),
);

// ─── PATCH /contacts/:id/status ─────────────────────────────────────
// Update single contact status
router.patch(
  "/contacts/:id/status",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const id = req.params.id as string;
    const { status } = req.body as { status: string };

    await db
      .update(scraperContacts)
      .set({ status, updatedAt: new Date() })
      .where(and(eq(scraperContacts.id, id), eq(scraperContacts.organizationId, orgId)));

    res.json({ data: { id, status } });
  }),
);

// ─── POST /contacts/bulk-status ─────────────────────────────────────
// Bulk update contact statuses
router.post(
  "/contacts/bulk-status",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const { contactIds, status } = req.body as { contactIds: string[]; status: string };

    if (!contactIds?.length) {
      throw new ApiError(400, "contactIds is required");
    }

    const result = await db
      .update(scraperContacts)
      .set({ status, updatedAt: new Date() })
      .where(
        and(
          eq(scraperContacts.organizationId, orgId),
          inArray(scraperContacts.id, contactIds),
        ),
      );

    res.json({ data: { updated: contactIds.length, status } });
  }),
);

// ─── POST /contacts/send-to-funnel ──────────────────────────────────
// Create lead records from discovered contacts
router.post(
  "/contacts/send-to-funnel",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const { contactIds, funnelId } = req.body as { contactIds: string[]; funnelId: string };

    if (!contactIds?.length) throw new ApiError(400, "contactIds is required");
    if (!funnelId) throw new ApiError(400, "funnelId is required");

    // Load funnel with steps
    const [funnel] = await db
      .select()
      .from(funnels)
      .where(and(eq(funnels.id, funnelId), eq(funnels.organizationId, orgId)))
      .limit(1);
    if (!funnel) throw new ApiError(404, "Funnel not found");

    const steps = await db
      .select()
      .from(funnelSteps)
      .where(eq(funnelSteps.funnelId, funnelId))
      .orderBy(funnelSteps.sortOrder);
    if (steps.length === 0) throw new ApiError(400, "Funnel has no steps configured");

    // Fetch contacts
    const contacts = await db
      .select()
      .from(scraperContacts)
      .where(
        and(
          eq(scraperContacts.organizationId, orgId),
          inArray(scraperContacts.id, contactIds),
        ),
      );
    if (contacts.length === 0) throw new ApiError(404, "No contacts found");

    // Load existing leads for dedup
    const existingLeads = await db
      .select({ name: leads.name, company: leads.company, email: leads.email })
      .from(leads)
      .where(eq(leads.funnelId, funnelId));
    const existingKeys = new Set(
      existingLeads.map((l) => dedupeKey(l.name, l.company, l.email)),
    );

    const now = Date.now();
    const firstStep = steps[0];
    const newLeads: Array<typeof leads.$inferInsert> = [];
    const newEvents: Array<typeof leadEvents.$inferInsert> = [];
    let skipped = 0;

    for (const c of contacts) {
      const name = c.fullName || `${c.firstName || ""} ${c.lastName || ""}`.trim() || "Unknown";
      const company = c.currentCompany || c.companyName || "";
      const email = (c.email || "").toLowerCase();

      const key = dedupeKey(name, company, email);
      if (existingKeys.has(key)) {
        skipped++;
        continue;
      }
      existingKeys.add(key);

      const leadId = createId("lead");
      const initialDue = new Date(now + firstStep.dayOffset * DAY_MS);

      newLeads.push({
        id: leadId,
        funnelId,
        name,
        title: c.currentTitle || "",
        company,
        email,
        phone: c.phone || "",
        linkedinUrl: c.linkedinUrl || "",
        currentStep: 1,
        totalSteps: steps.length,
        status: "pending",
        nextAction: firstStep.label,
        nextDate: initialDue,
        source: "Contact Discovery",
        sourceType: "companies",
        score: scoreLead({ name, title: c.currentTitle || "", company, email, phone: c.phone || "", linkedinUrl: c.linkedinUrl || "" }),
        createdAt: new Date(now),
        updatedAt: new Date(now),
      });

      newEvents.push({
        id: createId("event"),
        leadId,
        type: "imported",
        outcome: null,
        stepIndex: 0,
        meta: { source: "contact_discovery" },
        timestamp: new Date(now),
      });
    }

    if (newLeads.length > 0) {
      await db.transaction(async (tx) => {
        await tx.insert(leads).values(newLeads);
        await tx.insert(leadEvents).values(newEvents);
      });

      // Mark contacts as in_funnel
      const insertedIds = contacts
        .filter((c) => {
          const name = c.fullName || `${c.firstName || ""} ${c.lastName || ""}`.trim() || "Unknown";
          const company = c.currentCompany || c.companyName || "";
          const email = (c.email || "").toLowerCase();
          // Check if this contact was not skipped (it has a lead in newLeads)
          return newLeads.some((l) => l.name === name && l.company === company);
        })
        .map((c) => c.id);

      if (insertedIds.length > 0) {
        await db
          .update(scraperContacts)
          .set({ status: "in_funnel", updatedAt: new Date() })
          .where(inArray(scraperContacts.id, insertedIds));
      }
    }

    // Push to Smartlead if campaign exists
    if (funnel.smartleadCampaignId && newLeads.length > 0) {
      try {
        const apiKey = await getSetting(orgId, "smartlead_api_key");
        if (apiKey) {
          const client = new SmartleadClient(apiKey);
          const campaignId = Number(funnel.smartleadCampaignId);
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
          for (let i = 0; i < smartleadLeads.length; i += 100) {
            const batch = smartleadLeads.slice(i, i + 100);
            await client.addLeads(campaignId, batch, { return_lead_ids: true });
          }
        }
      } catch (err) {
        console.error("Smartlead push failed (non-blocking):", err);
      }
    }

    res.json({
      data: {
        created: newLeads.length,
        skipped,
        funnelId,
        funnelName: funnel.name,
      },
    });
  }),
);

// ─── POST /contacts/discovery-runs/:runId/cancel ────────────────────
// Cancel an active discovery run
router.post(
  "/contacts/discovery-runs/:runId/cancel",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const runId = req.params.runId as string;

    const [run] = await db
      .select()
      .from(discoveryRuns)
      .where(and(eq(discoveryRuns.id, runId), eq(discoveryRuns.organizationId, orgId)))
      .limit(1);

    if (!run) throw new ApiError(404, "Discovery run not found");
    if (run.status !== "running" && run.status !== "pending") {
      throw new ApiError(400, "Run is not active");
    }

    // Abort all Apify runs (supports JSON array or single ID)
    if (run.apifyRunId) {
      try {
        let apifyRunIds: string[];
        try {
          const parsed = JSON.parse(run.apifyRunId);
          apifyRunIds = Array.isArray(parsed) ? parsed : [run.apifyRunId];
        } catch {
          apifyRunIds = [run.apifyRunId];
        }
        const client = getApifyClient();
        await Promise.all(apifyRunIds.map((id) => client.abortRun(id).catch(() => {})));
      } catch (err) {
        console.error("Failed to abort Apify runs:", err);
      }
    }

    await db
      .update(discoveryRuns)
      .set({ status: "failed", error: "Cancelled by user", completedAt: new Date() })
      .where(eq(discoveryRuns.id, runId));

    const [updated] = await db.select().from(discoveryRuns).where(eq(discoveryRuns.id, runId));
    res.json({ data: updated });
  }),
);

// ─── POST /contacts/reset-enrichment ────────────────────────────────
// Reset failed enrichment so contacts can be re-enriched
router.post(
  "/contacts/reset-enrichment",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const { contactIds } = req.body as { contactIds: string[] };

    if (!contactIds?.length) throw new ApiError(400, "contactIds is required");

    await db
      .update(scraperContacts)
      .set({
        enrichmentStatus: "none",
        bettercontactRequestId: null,
        email: null,
        emailStatus: null,
        phone: null,
        phoneStatus: null,
        enrichedAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(scraperContacts.organizationId, orgId),
          inArray(scraperContacts.id, contactIds),
        ),
      );

    res.json({ data: { reset: contactIds.length } });
  }),
);

export default router;
