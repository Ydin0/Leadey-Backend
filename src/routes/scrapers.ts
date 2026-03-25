import { Router, Request, Response, NextFunction } from "express";
import { eq, and, desc, count, inArray, sql } from "drizzle-orm";
import { db } from "../db/index";
import { scraperAssignments, scraperRuns, scraperSignals } from "../db/schema/scrapers";
import {
  TheirStackClient,
  type TheirStackJobSearchParams,
  type TheirStackJob,
} from "../lib/theirstack-client";
import { scoreSignal, type NormalizedJob } from "../lib/signal-scoring";
import { ApiError, createId } from "../lib/helpers";
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

function getTheirStackClient(): TheirStackClient {
  const token = process.env.THEIRSTACK_API_KEY;
  if (!token) {
    throw new ApiError(500, "THEIRSTACK_API_KEY environment variable is not configured");
  }
  return new TheirStackClient(token);
}

// ─── TheirStack → NormalizedJob mapper ──────────────────────────────

function normalizeTheirStackJob(job: TheirStackJob): NormalizedJob {
  const salaryParts: string[] = [];
  if (job.salary_string) {
    salaryParts.push(job.salary_string);
  } else if (job.min_annual_salary_usd || job.max_annual_salary_usd) {
    const min = job.min_annual_salary_usd
      ? `$${(job.min_annual_salary_usd / 1000).toFixed(0)}k`
      : "";
    const max = job.max_annual_salary_usd
      ? `$${(job.max_annual_salary_usd / 1000).toFixed(0)}k`
      : "";
    salaryParts.push(min && max ? `${min} - ${max}` : min || max);
  }

  return {
    jobTitle: job.job_title || job.normalized_title || "",
    company: job.company || job.company_object?.name || "",
    companyDomain: job.company_domain || job.company_object?.domain || null,
    location: job.long_location || job.location || job.short_location || null,
    jobUrl: job.final_url || job.url || null,
    description: job.description || null,
    salary: salaryParts[0] || null,
    postedAt: job.date_posted ? new Date(job.date_posted) : null,
    jobType: job.employment_statuses?.[0] || null,
    isRemote: job.remote ?? false,
    seniority: job.seniority || null,
    companySize: job.company_object?.employee_count || null,
    companyIndustry: job.company_object?.industry || null,
    companyLogo: job.company_object?.logo || null,
    hiringTeam: (job.hiring_team || []).map((h) => ({
      name: h.full_name,
      role: h.role,
      linkedinUrl: h.linkedin_url,
    })),
  };
}

// ─── Build TheirStack search params from assignment config ──────────

function buildSearchParams(
  assignment: typeof scraperAssignments.$inferSelect,
  filtersOverride?: Record<string, unknown>,
): TheirStackJobSearchParams {
  // If filters JSONB is populated (new saved search model), use it directly
  const filters = filtersOverride || (assignment.filters as Record<string, unknown>);
  if (filters && Object.keys(filters).length > 0) {
    // Strip limit from stored filters — we control it via maxSignalsPerRun + pagination
    const { limit: _storedLimit, ...cleanFilters } = filters as TheirStackJobSearchParams;
    const params: TheirStackJobSearchParams = {
      ...cleanFilters,
      include_total_results: true,
      limit: Math.min(assignment.maxSignalsPerRun || 100, 500),
    };
    // Ensure a date filter is present (TheirStack requires one)
    if (!params.posted_at_max_age_days && !params.posted_at_gte && !params.discovered_at_max_age_days) {
      params.posted_at_max_age_days = assignment.lookbackDays || 7;
    }
    // Default to direct employers if not specified
    if (!params.company_type) {
      params.company_type = "direct_employer";
    }
    return params;
  }

  // Legacy: build from individual columns
  const params: TheirStackJobSearchParams = {
    posted_at_max_age_days: assignment.lookbackDays || 7,
    limit: Math.min(assignment.maxSignalsPerRun || 100, 500),
    include_total_results: true,
    page: 0,
  };

  if (assignment.keywords.length > 0) {
    params.job_title_or = assignment.keywords;
  }
  if (assignment.excludedKeywords.length > 0) {
    params.job_title_not = assignment.excludedKeywords;
  }
  if (assignment.countries.length > 0) {
    params.job_country_code_or = assignment.countries;
  }

  const seniority = assignment.jobSeniority;
  if (seniority && seniority.length > 0) {
    params.job_seniority_or = seniority;
  }

  const remoteFilter = assignment.remoteFilter;
  if (remoteFilter === "only") {
    params.remote = true;
  } else if (remoteFilter === "exclude") {
    params.remote = false;
  }

  params.company_type = "direct_employer";
  return params;
}

// ═══════════════════════════════════════════════════════════════════════
// Assignments
// ═══════════════════════════════════════════════════════════════════════

// GET /scrapers/assignments
router.get(
  "/scrapers/assignments",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const rows = await db.query.scraperAssignments.findMany({
      where: eq(scraperAssignments.organizationId, orgId),
      orderBy: desc(scraperAssignments.createdAt),
    });
    res.json({ data: rows });
  }),
);

// POST /scrapers/assignments
router.post(
  "/scrapers/assignments",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const body = req.body || {};

    // scraperId and scraperName are optional for new saved search model
    // (defaults to "scraper_job_board" / "Job Board Monitor")

    const id = createId("sa");

    // When filters JSONB is provided, also populate legacy columns for backward compat
    const filters = body.filters || {};
    const keywords = body.keywords || filters.job_title_or || [];
    const excludedKeywords = body.excludedKeywords || filters.job_title_not || [];
    const countries = body.countries || filters.job_country_code_or || [];
    const jobSeniority = body.jobSeniority || filters.job_seniority_or || [];

    await db.insert(scraperAssignments).values({
      id,
      organizationId: orgId,
      scraperId: body.scraperId || "scraper_job_board",
      scraperName: body.scraperName || "Job Board Monitor",
      searchName: body.searchName || "Untitled Search",
      enabled: body.enabled ?? true,
      frequency: body.frequency || "daily",
      status: "idle",
      filters,
      keywords,
      excludedKeywords,
      keywordMatchMode: body.keywordMatchMode || "any",
      countries,
      languages: body.languages || ["English"],
      sourceIds: body.sourceIds || [],
      sourceSignalLimits: body.sourceSignalLimits || {},
      lookbackDays: body.lookbackDays ?? 7,
      maxSignalsPerRun: body.maxSignalsPerRun ?? 100,
      minSignalScore: body.minSignalScore ?? 0,
      jobSeniority,
      remoteFilter: body.remoteFilter || "include",
      onlyDecisionMakers: body.onlyDecisionMakers ?? false,
      dedupeCompanies: body.dedupeCompanies ?? false,
      includeRemoteRoles: body.includeRemoteRoles ?? true,
      notifyOnHighIntent: body.notifyOnHighIntent ?? false,
      creditsPerRun: body.creditsPerRun ?? 0,
    });

    const row = await db.query.scraperAssignments.findFirst({
      where: eq(scraperAssignments.id, id),
    });
    res.status(201).json({ data: row });
  }),
);

// PUT /scrapers/assignments/:id
router.put(
  "/scrapers/assignments/:id",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const id = String(req.params.id);
    const body = req.body || {};

    const existing = await db.query.scraperAssignments.findFirst({
      where: and(
        eq(scraperAssignments.id, id),
        eq(scraperAssignments.organizationId, orgId),
      ),
    });
    if (!existing) throw new ApiError(404, "Assignment not found");

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    const allowedFields = [
      "enabled", "frequency", "keywords", "excludedKeywords", "keywordMatchMode",
      "countries", "languages", "sourceIds", "sourceSignalLimits", "lookbackDays",
      "maxSignalsPerRun", "minSignalScore", "jobSeniority", "remoteFilter",
      "onlyDecisionMakers", "dedupeCompanies",
      "includeRemoteRoles", "notifyOnHighIntent", "creditsPerRun",
      "filters", "searchName",
    ];
    for (const field of allowedFields) {
      if (body[field] !== undefined) {
        updates[field] = body[field];
      }
    }

    await db
      .update(scraperAssignments)
      .set(updates)
      .where(eq(scraperAssignments.id, id));

    const row = await db.query.scraperAssignments.findFirst({
      where: eq(scraperAssignments.id, id),
    });
    res.json({ data: row });
  }),
);

// DELETE /scrapers/assignments/:id
router.delete(
  "/scrapers/assignments/:id",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const id = String(req.params.id);

    const existing = await db.query.scraperAssignments.findFirst({
      where: and(
        eq(scraperAssignments.id, id),
        eq(scraperAssignments.organizationId, orgId),
      ),
    });
    if (!existing) throw new ApiError(404, "Assignment not found");

    await db.delete(scraperAssignments).where(eq(scraperAssignments.id, id));
    res.json({ data: { deleted: true } });
  }),
);

// ═══════════════════════════════════════════════════════════════════════
// Run Execution — TheirStack (synchronous)
// ═══════════════════════════════════════════════════════════════════════

// POST /scrapers/assignments/:id/run
router.post(
  "/scrapers/assignments/:id/run",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const id = String(req.params.id);

    const assignment = await db.query.scraperAssignments.findFirst({
      where: and(
        eq(scraperAssignments.id, id),
        eq(scraperAssignments.organizationId, orgId),
      ),
    });
    if (!assignment) throw new ApiError(404, "Assignment not found");

    const hasFilters = assignment.filters && Object.keys(assignment.filters as Record<string, unknown>).length > 0;
    if (!hasFilters && assignment.keywords.length === 0) {
      throw new ApiError(400, "Cannot run scraper with no keywords or filters configured");
    }

    const client = getTheirStackClient();
    const searchParams = buildSearchParams(assignment);
    const runId = createId("sr");

    // Mark assignment as running
    await db
      .update(scraperAssignments)
      .set({ status: "running", lastRunAt: new Date(), updatedAt: new Date() })
      .where(eq(scraperAssignments.id, id));

    // Create run record
    await db.insert(scraperRuns).values({
      id: runId,
      organizationId: orgId,
      assignmentId: id,
      sourceId: "theirstack",
      status: "running",
      inputPayload: searchParams as Record<string, unknown>,
      startedAt: new Date(),
    });

    try {
      // Step 1: Count query (limit=1) to find actual available results — costs only 1 credit
      const countParams = { ...searchParams, limit: 1, include_total_results: true };
      const countResponse = await client.searchJobs(countParams);
      const availableResults = countResponse.metadata?.total_results || 0;

      // Step 2: Fetch with limit = min(available, requested) to avoid wasting credits
      // Use maxSignalsPerRun as the total desired (searchParams.limit may be capped at 500)
      const requestedTotal = assignment.maxSignalsPerRun || searchParams.limit || 100;
      const actualLimit = Math.min(availableResults, requestedTotal);

      let jobs: typeof countResponse.data = [];
      let response = countResponse;

      console.log(`[Run] Count query: ${availableResults} available, requested limit: ${searchParams.limit}, actual fetch limit: ${actualLimit}`);

      if (actualLimit > 0) {
        const PAGE_SIZE = 500; // TheirStack max per request
        // Strip page/offset from base params — we control pagination ourselves
        const { page: _p, offset: _o, ...baseParams } = searchParams;

        if (actualLimit <= PAGE_SIZE) {
          const fetchParams = { ...baseParams, limit: actualLimit, include_total_results: true };
          response = await client.searchJobs(fetchParams);
          jobs = response.data || [];
        } else {
          // Paginate in batches of 500 using offset for deterministic pagination
          let offset = 0;
          while (offset < actualLimit) {
            const batchLimit = Math.min(PAGE_SIZE, actualLimit - offset);
            const fetchParams = { ...baseParams, limit: batchLimit, offset, include_total_results: true };
            const batchResponse = await client.searchJobs(fetchParams);
            response = batchResponse;
            const batchJobs = batchResponse.data || [];
            jobs.push(...batchJobs);
            console.log(`[Run] offset=${offset}: fetched ${batchJobs.length} jobs (total so far: ${jobs.length})`);
            if (batchJobs.length < batchLimit) break; // no more results
            offset += batchJobs.length;
          }
        }
      }

      console.log(`[Run] TheirStack returned ${jobs.length} jobs total`);

      let signalsCreated = 0;
      const seenCompanies = new Set<string>();
      let skippedNoTitle = 0;
      let skippedDedupe = 0;
      let skippedScore = 0;

      // For filter-based searches (no legacy keywords), use all job_title_or as scoring keywords
      const scoringKeywords = assignment.keywords.length > 0
        ? assignment.keywords
        : ((assignment.filters as any)?.job_title_or || []);

      for (const job of jobs) {
        const normalized = normalizeTheirStackJob(job);
        if (!normalized.jobTitle || !normalized.company) { skippedNoTitle++; continue; }

        // Dedupe by company if enabled
        if (assignment.dedupeCompanies) {
          const key = normalized.company.toLowerCase();
          if (seenCompanies.has(key)) { skippedDedupe++; continue; }
          seenCompanies.add(key);
        }

        const score = scoreSignal(normalized, {
          keywords: scoringKeywords,
          excludedKeywords: assignment.excludedKeywords,
        });

        // Filter by min score
        if (score < assignment.minSignalScore) { skippedScore++; continue; }

        // Determine source from URL domain
        let sourceId = "theirstack";
        const jobUrl = normalized.jobUrl || "";
        if (jobUrl.includes("linkedin.com")) sourceId = "linkedin";
        else if (jobUrl.includes("indeed.com")) sourceId = "indeed";
        else if (jobUrl.includes("glassdoor.com")) sourceId = "glassdoor";
        else if (jobUrl.includes("greenhouse.io")) sourceId = "greenhouse";
        else if (jobUrl.includes("lever.co")) sourceId = "lever";

        await db.insert(scraperSignals).values({
          id: createId("ss"),
          organizationId: orgId,
          assignmentId: id,
          runId,
          sourceId,
          jobTitle: normalized.jobTitle,
          company: normalized.company,
          companyDomain: normalized.companyDomain,
          location: normalized.location,
          jobUrl: normalized.jobUrl,
          description: normalized.description,
          salary: normalized.salary,
          postedAt: normalized.postedAt,
          jobType: normalized.jobType,
          isRemote: normalized.isRemote,
          // Rich signal data
          companyLogo: job.company_object?.logo || null,
          companyIndustry: job.company_object?.industry || null,
          companyEmployeeCount: job.company_object?.employee_count != null ? Math.round(job.company_object.employee_count) : null,
          companyRevenue: job.company_object?.annual_revenue_usd != null ? Math.round(job.company_object.annual_revenue_usd) : null,
          companyFunding: job.company_object?.total_funding_usd != null ? Math.round(job.company_object.total_funding_usd) : null,
          companyFundingStage: job.company_object?.funding_stage || null,
          companyCountry: job.company_object?.country || job.country || null,
          companyCity: job.company_object?.city || job.cities?.[0] || null,
          companyLinkedinUrl: job.company_object?.linkedin_url || null,
          hiringTeam: (job.hiring_team || []).map((h) => ({
            name: h.full_name,
            role: h.role,
            linkedinUrl: h.linkedin_url,
            imageUrl: h.image_url,
          })),
          seniority: job.seniority || null,
          technologySlugs: job.technology_slugs || [],
          minSalaryUsd: job.min_annual_salary_usd != null ? Math.round(job.min_annual_salary_usd) : null,
          maxSalaryUsd: job.max_annual_salary_usd != null ? Math.round(job.max_annual_salary_usd) : null,
          employmentStatus: job.employment_statuses?.[0] || null,
          discoveredAt: job.discovered_at ? new Date(job.discovered_at) : null,
          enrichmentStatus: "none",
          score,
          signalType: "hiring",
          status: "new",
          rawData: job as unknown as Record<string, unknown>,
        });
        signalsCreated++;
      }

      // Update run record
      await db
        .update(scraperRuns)
        .set({
          status: "succeeded",
          itemsScraped: jobs.length,
          signalsCreated,
          completedAt: new Date(),
        })
        .where(eq(scraperRuns.id, runId));

      // Update assignment stats
      await db
        .update(scraperAssignments)
        .set({
          status: "completed",
          signalsFound: assignment.signalsFound + signalsCreated,
          companiesFound: assignment.companiesFound + seenCompanies.size,
          totalResults: response.metadata?.total_results || 0,
          lastRunResultCount: signalsCreated,
          updatedAt: new Date(),
        })
        .where(eq(scraperAssignments.id, id));

      console.log(`[Run ${runId}] TheirStack returned ${jobs.length} jobs, created ${signalsCreated} signals. Skipped: ${skippedNoTitle} no-title, ${skippedDedupe} dedupe, ${skippedScore} low-score. dedupeCompanies=${assignment.dedupeCompanies}, minSignalScore=${assignment.minSignalScore}`);

      res.json({
        data: {
          assignmentId: id,
          runId,
          totalResults: response.metadata?.total_results || 0,
          itemsReturned: jobs.length,
          signalsCreated,
          companiesFound: seenCompanies.size,
          debug: {
            skippedNoTitle,
            skippedDedupe,
            skippedScore,
            dedupeCompanies: assignment.dedupeCompanies,
            minSignalScore: assignment.minSignalScore,
          },
        },
      });
    } catch (err) {
      // Mark run as failed
      const errorMessage = err instanceof Error ? err.message : "TheirStack API call failed";
      await db
        .update(scraperRuns)
        .set({
          status: "failed",
          error: errorMessage,
          completedAt: new Date(),
        })
        .where(eq(scraperRuns.id, runId));

      // Reset assignment status
      await db
        .update(scraperAssignments)
        .set({ status: "idle", updatedAt: new Date() })
        .where(eq(scraperAssignments.id, id));

      throw new ApiError(502, `Scraper run failed: ${errorMessage}`);
    }
  }),
);

// ═══════════════════════════════════════════════════════════════════════
// Runs
// ═══════════════════════════════════════════════════════════════════════

// GET /scrapers/runs
router.get(
  "/scrapers/runs",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const assignmentId = req.query.assignmentId as string | undefined;

    const conditions = [eq(scraperRuns.organizationId, orgId)];
    if (assignmentId) {
      conditions.push(eq(scraperRuns.assignmentId, assignmentId));
    }

    const rows = await db.query.scraperRuns.findMany({
      where: and(...conditions),
      orderBy: desc(scraperRuns.startedAt),
    });
    res.json({ data: rows });
  }),
);

// GET /scrapers/runs/:runId/status
router.get(
  "/scrapers/runs/:runId/status",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const runId = String(req.params.runId);

    const run = await db.query.scraperRuns.findFirst({
      where: and(
        eq(scraperRuns.id, runId),
        eq(scraperRuns.organizationId, orgId),
      ),
    });
    if (!run) throw new ApiError(404, "Run not found");

    // TheirStack runs complete synchronously, so just return current status
    res.json({ data: run });
  }),
);

// ═══════════════════════════════════════════════════════════════════════
// Signals
// ═══════════════════════════════════════════════════════════════════════

// GET /scrapers/signals
router.get(
  "/scrapers/signals",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const assignmentId = req.query.assignmentId as string | undefined;
    const sourceId = req.query.sourceId as string | undefined;
    const status = req.query.status as string | undefined;

    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const pageSize = Math.min(5000, Math.max(1, parseInt(req.query.pageSize as string) || 25));
    const sortBy = (req.query.sortBy as string) || "createdAt";
    const sortOrder = (req.query.sortOrder as string) === "asc" ? "asc" : "desc";

    const conditions = [eq(scraperSignals.organizationId, orgId)];
    if (assignmentId) conditions.push(eq(scraperSignals.assignmentId, assignmentId));
    if (sourceId) conditions.push(eq(scraperSignals.sourceId, sourceId));
    if (status) conditions.push(eq(scraperSignals.status, status));

    const whereClause = and(...conditions);

    // Get total count
    const [{ total }] = await db
      .select({ total: count() })
      .from(scraperSignals)
      .where(whereClause);

    const totalCount = Number(total);
    const totalPages = Math.ceil(totalCount / pageSize);

    // Determine sort column
    const sortColumn = sortBy === "score" ? scraperSignals.score
      : sortBy === "postedAt" ? scraperSignals.postedAt
      : scraperSignals.createdAt;

    const rows = await db.query.scraperSignals.findMany({
      where: whereClause,
      orderBy: sortOrder === "asc" ? sortColumn : desc(sortColumn),
      limit: pageSize,
      offset: (page - 1) * pageSize,
    });

    res.json({
      data: rows,
      meta: { page, pageSize, totalCount, totalPages },
    });
  }),
);

// PATCH /scrapers/signals/:id/status
router.patch(
  "/scrapers/signals/:id/status",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const id = String(req.params.id);
    const { status } = req.body || {};

    const valid = ["new", "enriched", "in_funnel", "dismissed"];
    if (!status || !valid.includes(status)) {
      throw new ApiError(400, "Invalid status. Must be one of: " + valid.join(", "));
    }

    const existing = await db.query.scraperSignals.findFirst({
      where: and(
        eq(scraperSignals.id, id),
        eq(scraperSignals.organizationId, orgId),
      ),
    });
    if (!existing) throw new ApiError(404, "Signal not found");

    await db
      .update(scraperSignals)
      .set({ status })
      .where(eq(scraperSignals.id, id));

    res.json({ data: { id, status } });
  }),
);

// ═══════════════════════════════════════════════════════════════════════
// Preview & Bulk Operations
// ═══════════════════════════════════════════════════════════════════════

// POST /scrapers/assignments/:id/preview
// Runs TheirStack search without persisting results
router.post(
  "/scrapers/assignments/:id/preview",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const id = String(req.params.id);

    const assignment = await db.query.scraperAssignments.findFirst({
      where: and(
        eq(scraperAssignments.id, id),
        eq(scraperAssignments.organizationId, orgId),
      ),
    });
    if (!assignment) throw new ApiError(404, "Assignment not found");

    const client = getTheirStackClient();
    const filtersOverride = req.body?.filters as Record<string, unknown> | undefined;
    const searchParams = buildSearchParams(assignment, filtersOverride);

    // Limit preview to 25 results to conserve credits
    searchParams.limit = Math.min(searchParams.limit || 25, 25);

    const response = await client.searchJobs(searchParams);
    res.json({
      data: response.data || [],
      meta: {
        totalResults: response.metadata?.total_results || 0,
        totalCompanies: response.metadata?.total_companies || 0,
        returned: (response.data || []).length,
      },
    });
  }),
);

// POST /scrapers/signals/bulk-status
// Batch-updates signal enrichment/status
router.post(
  "/scrapers/signals/bulk-status",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const { signalIds, status } = req.body || {};

    if (!Array.isArray(signalIds) || signalIds.length === 0) {
      throw new ApiError(400, "signalIds array is required");
    }

    const valid = ["new", "enriched", "in_funnel", "dismissed", "pending", "failed", "none"];
    if (!status || !valid.includes(status)) {
      throw new ApiError(400, "Invalid status. Must be one of: " + valid.join(", "));
    }

    // Determine whether to update status or enrichmentStatus
    const isEnrichmentStatus = ["none", "pending", "enriched", "failed"].includes(status);

    if (isEnrichmentStatus) {
      await db
        .update(scraperSignals)
        .set({ enrichmentStatus: status })
        .where(
          and(
            eq(scraperSignals.organizationId, orgId),
            inArray(scraperSignals.id, signalIds),
          ),
        );
    } else {
      await db
        .update(scraperSignals)
        .set({ status })
        .where(
          and(
            eq(scraperSignals.organizationId, orgId),
            inArray(scraperSignals.id, signalIds),
          ),
        );
    }

    res.json({ data: { updated: signalIds.length, status } });
  }),
);

// ─── Error Handler ──────────────────────────────────────────────────────
router.use(
  (err: ApiError, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || 500;
    res.status(status).json({
      error: { message: err.message, details: err.details || null },
    });
  },
);

export default router;
