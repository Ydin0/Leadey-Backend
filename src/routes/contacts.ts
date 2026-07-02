import { Router, Request, Response, NextFunction } from "express";
import { eq, and, or, desc, count, inArray, sql, ilike, isNotNull, isNull } from "drizzle-orm";
import { db } from "../db/index";
import { scraperSignals } from "../db/schema/scrapers";
import { discoveryRuns, scraperContacts } from "../db/schema/contacts";
import { funnels, funnelSteps } from "../db/schema/funnels";
import { leads, leadEvents } from "../db/schema/leads";
import { masterContacts, masterCompanies } from "../db/schema/master";
import { callRecords } from "../db/schema/call-records";
import { leadHiringRoles } from "../db/schema/hiring-roles";
import { ApifyClient, mapSeniorityLevels, type ApifyProfileItem } from "../lib/apify-client";
import { BetterContactClient, type BetterContactInput } from "../lib/bettercontact-client";
import { SmartleadClient, type SmartleadLeadInput } from "../lib/smartlead-client";
import { getSmartleadApiKey } from "../lib/settings-service";
import { ApiError, createId, DAY_MS, scoreLead, dedupeKey } from "../lib/helpers";
import { getOrgId } from "../lib/auth";
import { upsertMasterContact } from "../lib/master-db";
import { getAuth } from "@clerk/express";
import { CREDIT_COSTS, getBalance, billEnrichmentResults, InsufficientCreditsError } from "../lib/credits";

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

/** Filter params shared by the contacts list and bulk actions. */
interface ContactFilterQuery {
  assignmentId?: string;
  status?: string;
  enrichmentStatus?: string;
  company?: string;
  /** Comma-joined LinkedIn company URLs to match against searched_company_url —
   *  the reliable, naming-independent way to scope to the searched companies. */
  companyUrls?: string;
  title?: string;
  location?: string;
  hasEmail?: string;
  hasPhone?: string;
}

/** Builds the WHERE conditions for scraper contacts from a filter set —
 *  the single source of truth for both `GET /contacts` and the
 *  "all matching" bulk actions, so the two never drift apart. */
function buildContactConditions(orgId: string, q: ContactFilterQuery) {
  const conditions = [eq(scraperContacts.organizationId, orgId)];
  if (q.assignmentId) conditions.push(eq(scraperContacts.assignmentId, q.assignmentId));
  if (q.status) conditions.push(eq(scraperContacts.status, q.status));
  if (q.enrichmentStatus) conditions.push(eq(scraperContacts.enrichmentStatus, q.enrichmentStatus));
  // Scope to specific companies. Two matchers, OR'd together:
  //  1. searched_company_url (reliable) — the exact URL the contact was
  //     discovered under, compared by normalised /company/<slug>.
  //  2. company name (fallback for older/untagged contacts) — normalised,
  //     bidirectional, so "Kensa" ↔ "Kensa Heat Pumps" etc. still match.
  const companyConds: (ReturnType<typeof ilike> | ReturnType<typeof sql>)[] = [];
  if (q.companyUrls) {
    const urlSlugs = q.companyUrls
      .split(",")
      .map((u) => normCompany(slugFromUrl(u.trim())))
      .filter((s) => s.length >= 2);
    if (urlSlugs.length > 0) {
      const searchedSlug = sql`lower(regexp_replace(regexp_replace(coalesce(${scraperContacts.searchedCompanyUrl}, ''), '^.*/company/([^/?#]+).*$', '\\1'), '[^a-zA-Z0-9]', '', 'g'))`;
      for (const s of urlSlugs) companyConds.push(sql`${searchedSlug} = ${s}`);
    }
  }
  if (q.company) {
    const companies = q.company.split(",").map((c) => c.trim()).filter(Boolean);
    const contactNorm = sql`lower(regexp_replace(coalesce(${scraperContacts.companyName}, ''), '[^a-zA-Z0-9]', '', 'g'))`;
    for (const c of companies) {
      const n = normCompany(c);
      if (n.length < 3) companyConds.push(ilike(scraperContacts.companyName, `%${c}%`));
      else companyConds.push(sql`(${contactNorm} LIKE ${`%${n}%`} OR (length(${contactNorm}) >= 3 AND ${n} LIKE '%' || ${contactNorm} || '%'))`);
    }
  }
  if (companyConds.length === 1) conditions.push(companyConds[0]);
  else if (companyConds.length > 1) conditions.push(or(...companyConds)!);
  if (q.title) conditions.push(ilike(scraperContacts.currentTitle, `%${q.title}%`));
  if (q.location) conditions.push(ilike(scraperContacts.location, `%${q.location}%`));
  if (q.hasEmail === "true") conditions.push(isNotNull(scraperContacts.email));
  else if (q.hasEmail === "false") conditions.push(isNull(scraperContacts.email));
  if (q.hasPhone === "true") conditions.push(isNotNull(scraperContacts.phone));
  else if (q.hasPhone === "false") conditions.push(isNull(scraperContacts.phone));
  return conditions;
}

/** Lowercased alphanumerics only — the canonical form for fuzzy company name /
 *  slug comparison ("Oxford Biomedica" / "oxford-biomedica" → "oxfordbiomedica"). */
function normCompany(s: string): string {
  return (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** The `/company/<slug>` segment of a LinkedIn company URL. */
function slugFromUrl(url: string): string {
  const m = /\/company\/([^/?#]+)/i.exec(url || "");
  return m ? m[1] : "";
}

/**
 * Pick the exact searched company URL a discovered contact belongs to, from the
 * discovery query stored in the Apify result's `_meta`. We match the contact's
 * current-company name against the searched company SLUGS (which are derived
 * from the real LinkedIn name), constrained to the ≤10 companies in the
 * contact's own batch — so this is reliable even when the scraper's display
 * name is an abbreviation (e.g. "OXB" → slug "oxford-biomedica" → name
 * "Oxford Biomedica").
 */
function pickSearchedCompanyUrl(rawItem: Record<string, unknown>): string | null {
  const meta = rawItem._meta as { query?: { currentCompanies?: unknown } } | undefined;
  const searched = meta?.query?.currentCompanies;
  if (!Array.isArray(searched) || searched.length === 0) return null;
  const urls = searched.filter((u): u is string => typeof u === "string" && !!u);
  if (urls.length === 0) return null;
  if (urls.length === 1) return urls[0];

  const positions = Array.isArray(rawItem.currentPositions) ? rawItem.currentPositions : [];
  const pos = positions[0] as Record<string, unknown> | undefined;
  const compId = String(pos?.companyId || "");
  const compNorm = normCompany((pos?.companyName as string) || (rawItem.companyName as string) || "");

  let best: { url: string; score: number } | null = null;
  for (const url of urls) {
    const slugRaw = slugFromUrl(url);
    if (compId && slugRaw === compId) return url; // exact numeric company-id match
    const slug = normCompany(slugRaw);
    if (!slug || !compNorm) continue;
    let score = 0;
    if (slug === compNorm) score = 1000;
    else if (slug.includes(compNorm)) score = compNorm.length;
    else if (compNorm.includes(slug)) score = slug.length;
    if (score > 0 && (!best || score > best.score)) best = { url, score };
  }
  return best?.url ?? null;
}

/** "3 days ago" / "2 weeks ago" label from a posted-at timestamp. */
function relTime(d: Date | null): string {
  if (!d) return "";
  const days = Math.floor((Date.now() - new Date(d).getTime()) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "1 day ago";
  if (days < 7) return `${days} days ago`;
  if (days < 30) { const w = Math.floor(days / 7); return `${w} week${w > 1 ? "s" : ""} ago`; }
  const m = Math.floor(days / 30);
  return `${m} month${m > 1 ? "s" : ""} ago`;
}

export interface DerivedHiringRole {
  title: string;
  description: string;
  salaryRange: string;
  location: string;
  postedAgo: string;
  seniority: string;
  url: string;
}

/** The company's scraped JOB POSTS, mapped to hiring-role shape and grouped by
 *  lower(company). This is how scraped jobs become a lead's hiring roles — both
 *  when sending to a funnel and on the standalone contact profile. */
async function loadCompanyJobs(
  orgId: string,
  assignmentIds: string[],
): Promise<Map<string, DerivedHiringRole[]>> {
  const out = new Map<string, DerivedHiringRole[]>();
  if (!assignmentIds.length) return out;
  const rows = await db
    .select({
      company: scraperSignals.company,
      jobTitle: scraperSignals.jobTitle,
      salary: scraperSignals.salary,
      location: scraperSignals.location,
      jobUrl: scraperSignals.jobUrl,
      description: scraperSignals.description,
      postedAt: scraperSignals.postedAt,
      seniority: scraperSignals.seniority,
    })
    .from(scraperSignals)
    .where(and(eq(scraperSignals.organizationId, orgId), inArray(scraperSignals.assignmentId, assignmentIds)));
  for (const s of rows) {
    const key = (s.company || "").toLowerCase();
    const title = (s.jobTitle || "").trim();
    if (!key || !title) continue;
    const arr = out.get(key) ?? [];
    if (arr.length >= 15 || arr.some((r) => r.title.toLowerCase() === title.toLowerCase())) {
      out.set(key, arr);
      continue;
    }
    arr.push({
      title,
      description: (s.description || "").slice(0, 800),
      salaryRange: s.salary || "",
      location: s.location || "",
      postedAgo: relTime(s.postedAt),
      seniority: s.seniority || "",
      url: s.jobUrl || "",
    });
    out.set(key, arr);
  }
  return out;
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
  const webhookBase = process.env.WEBHOOK_BASE_URL;
  const webhookUrl = webhookBase ? `${webhookBase}/webhooks/bettercontact` : undefined;
  return new BetterContactClient(apiKey, webhookUrl);
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

    // Fire all batches in parallel. Tolerate partial failures (e.g. an Apify
    // rate-limit on one batch) so the discovery still runs for the rest — only
    // fail outright if EVERY batch failed, surfacing the real Apify error.
    console.log(`[Discovery] Starting ${batches.length} parallel Apify runs for ${companyUrls.length} companies`);
    const settled = await Promise.allSettled(
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
    const runResponses = settled
      .filter((s): s is PromiseFulfilledResult<Awaited<ReturnType<typeof client.startRun>>> => s.status === "fulfilled")
      .map((s) => s.value);
    if (runResponses.length === 0) {
      const firstErr = settled.find((s) => s.status === "rejected") as PromiseRejectedResult | undefined;
      const detail = firstErr?.reason instanceof Error ? firstErr.reason.message : "Apify run failed to start";
      throw new ApiError(502, `Could not start contact discovery: ${detail}`);
    }

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
        searchedCompanyUrl: pickSearchedCompanyUrl(rawItem),
        status: "discovered",
        rawData: rawItem,
      });
      contactsInserted++;

      // Upsert to master contacts (best-effort)
      try {
        await upsertMasterContact(orgId, {
          linkedinUrl,
          firstName: item.firstName || null,
          lastName: item.lastName || null,
          fullName: item.fullName || null,
          headline: item.headline || (rawItem.summary as string) || null,
          profileImageUrl: item.profileImageUrl || null,
          currentTitle: item.title || null,
          currentCompany: companyName,
          location: locationStr,
        });
      } catch {}
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
// Per-company contact counts. Scoped to an assignment when assignmentId is
// provided, otherwise org-wide (used by the org Leads page).
router.get(
  "/contacts/company-counts",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const assignmentId = req.query.assignmentId as string | undefined;

    const conditions = [eq(scraperContacts.organizationId, orgId)];
    if (assignmentId) conditions.push(eq(scraperContacts.assignmentId, assignmentId));

    const rows = await db
      .select({
        companyLinkedinUrl: scraperContacts.companyLinkedinUrl,
        companyName: scraperContacts.companyName,
        count: count(),
      })
      .from(scraperContacts)
      .where(and(...conditions))
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
    const company = req.query.company as string | undefined;
    const companyUrls = req.query.companyUrls as string | undefined;
    const title = req.query.title as string | undefined;
    const location = req.query.location as string | undefined;
    const hasEmail = req.query.hasEmail as string | undefined;
    const hasPhone = req.query.hasPhone as string | undefined;
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const pageSize = Math.min(500, Math.max(1, parseInt(req.query.pageSize as string) || 25));

    // When scoping by company NAMES within an assignment, also resolve those
    // names to the assignment's company LinkedIn URLs (via signals) so we can
    // match contacts by their reliable searched_company_url — a discovered
    // contact's stored company name ("Kensa Group") often differs from the
    // scraper's ("Kensa Heat Pumps") and would otherwise be hidden.
    let resolvedCompanyUrls = companyUrls;
    if (company && assignmentId && !companyUrls) {
      const names = company.split(",").map((c) => c.trim()).filter(Boolean);
      const nameNorms = names.map((n) => normCompany(n)).filter((n) => n.length >= 2);
      if (nameNorms.length > 0) {
        const sigs = await db
          .selectDistinct({ company: scraperSignals.company, url: scraperSignals.companyLinkedinUrl })
          .from(scraperSignals)
          .where(
            and(
              eq(scraperSignals.assignmentId, assignmentId),
              eq(scraperSignals.organizationId, orgId),
              sql`${scraperSignals.companyLinkedinUrl} ~ '/company/'`,
            ),
          );
        const urls = sigs
          .filter((s) => {
            const cn = normCompany(s.company || "");
            return cn.length >= 2 && nameNorms.some((n) => cn === n || cn.includes(n) || n.includes(cn));
          })
          .map((s) => s.url as string)
          .filter(Boolean);
        if (urls.length > 0) resolvedCompanyUrls = urls.join(",");
      }
    }

    const conditions = buildContactConditions(orgId, {
      assignmentId,
      status,
      enrichmentStatus,
      company,
      companyUrls: resolvedCompanyUrls,
      title,
      location,
      hasEmail,
      hasPhone,
    });

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
    const { contactIds, allMatching, filters } = req.body as {
      contactIds?: string[];
      allMatching?: boolean;
      filters?: ContactFilterQuery;
    };

    // Resolve the target contacts — either an explicit id list, or EVERY contact
    // matching the current filters ("select all matching"), restricted to the
    // not-yet-enriched ones so we never re-bill already-enriched people.
    let contacts;
    if (allMatching) {
      const conds = buildContactConditions(orgId, { ...(filters || {}), enrichmentStatus: "none" });
      contacts = await db.select().from(scraperContacts).where(and(...conds)).limit(5000);
    } else {
      if (!contactIds?.length) {
        throw new ApiError(400, "contactIds or allMatching+filters is required");
      }
      contacts = await db
        .select()
        .from(scraperContacts)
        .where(and(eq(scraperContacts.organizationId, orgId), inArray(scraperContacts.id, contactIds)));
    }

    if (contacts.length === 0) {
      res.json({ data: { requestIds: [], contactCount: 0 } });
      return;
    }

    // Credit pre-flight (hard block): reserve the worst-case cost — every
    // contact could return both a phone (33) and an email (3) = 36 credits.
    // Actuals are billed per result, so the wallet never goes negative.
    const worstCase = contacts.length * (CREDIT_COSTS.phone_enrichment + CREDIT_COSTS.email_enrichment);
    {
      const bal = await getBalance(orgId);
      if (bal < worstCase) throw new InsufficientCreditsError(worstCase, bal);
    }

    // Look up missing company domains from scraper signals
    const missingDomainCompanies = contacts
      .filter((c) => !c.companyDomain && c.companyName)
      .map((c) => c.companyName!.toLowerCase());

    const domainLookup = new Map<string, string>();
    if (missingDomainCompanies.length > 0) {
      // Get unique company names that need domain lookup
      const uniqueCompanies = [...new Set(missingDomainCompanies)];
      for (const companyName of uniqueCompanies) {
        const signal = await db.query.scraperSignals.findFirst({
          where: and(
            eq(scraperSignals.organizationId, orgId),
            sql`lower(${scraperSignals.company}) = lower(${companyName})`,
          ),
          columns: { companyDomain: true },
        });
        if (signal?.companyDomain) {
          domainLookup.set(companyName, signal.companyDomain);
        }
      }
    }

    // Build BetterContact input
    const bcInput: BetterContactInput[] = contacts.map((c) => {
      let domain = c.companyDomain || "";
      if (!domain && c.companyName) {
        domain = domainLookup.get(c.companyName.toLowerCase()) || "";
      }
      return {
        first_name: c.firstName || "",
        last_name: c.lastName || "",
        company: c.companyName || c.currentCompany || "",
        company_domain: domain,
        linkedin_url: c.linkedinUrl || "",
      };
    });

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

      if (result.status !== "finished" && result.status !== "completed") {
        allFinished = false;
        continue;
      }

      // Update contacts with results — support both polling and webhook field names
      if (result.data) {
        for (const item of result.data) {
          const email = (item as any).contact_email_address || item.email || null;
          const emailStatus = (item as any).contact_email_address_status || item.email_status || null;
          const phone = (item as any).contact_phone_number || item.phone || null;
          const phoneStatus = (item as any).contact_phone_number_status || item.phone_status || null;
          const linkedinUrl = (item as any).contact_linkedin_profile_url || item.linkedin_url || null;
          const firstName = (item as any).contact_first_name || (item as any).first_name || "";
          const lastName = (item as any).contact_last_name || (item as any).last_name || "";

          const hasContactData = !!(email || phone);

          // Try matching by linkedin_url first
          let matched = false;
          if (linkedinUrl) {
            const res = await db
              .update(scraperContacts)
              .set({
                email, emailStatus, phone, phoneStatus,
                enrichmentStatus: hasContactData ? "enriched" : "failed",
                enrichedAt: new Date(), updatedAt: new Date(),
              })
              .where(
                and(
                  eq(scraperContacts.organizationId, orgId),
                  eq(scraperContacts.bettercontactRequestId, requestId),
                  sql`lower(${scraperContacts.linkedinUrl}) = lower(${linkedinUrl})`,
                ),
              )
              .returning({ id: scraperContacts.id });
            matched = res.length > 0;
          }

          // Fallback: match by first_name + last_name
          if (!matched && firstName && lastName) {
            await db
              .update(scraperContacts)
              .set({
                email, emailStatus, phone, phoneStatus,
                enrichmentStatus: hasContactData ? "enriched" : "failed",
                enrichedAt: new Date(), updatedAt: new Date(),
              })
              .where(
                and(
                  eq(scraperContacts.organizationId, orgId),
                  eq(scraperContacts.bettercontactRequestId, requestId),
                  sql`lower(${scraperContacts.firstName}) = lower(${firstName})`,
                  sql`lower(${scraperContacts.lastName}) = lower(${lastName})`,
                ),
              );
          }

          totalEnriched++;
        }
      }
    }

    // Bill any contacts that are now enriched but not yet charged for these
    // batches (33/phone, 3/email). Idempotent — the webhook path bills the same
    // way, and billEnrichmentResults claims each contact exactly once.
    const toBill = await db
      .select({ id: scraperContacts.id })
      .from(scraperContacts)
      .where(
        and(
          eq(scraperContacts.organizationId, orgId),
          inArray(scraperContacts.bettercontactRequestId, requestIds),
          eq(scraperContacts.enrichmentStatus, "enriched"),
          isNull(scraperContacts.creditsBilledAt),
        ),
      );
    if (toBill.length > 0) {
      await billEnrichmentResults(orgId, toBill.map((c) => c.id), getAuth(req)?.userId ?? null);
    }

    res.json({
      data: {
        status: allFinished ? "finished" : "processing",
        enrichedCount: totalEnriched,
      },
    });
  }),
);

// ─── GET /contacts/:id/profile ──────────────────────────────────────
// Full standalone profile for a discovered contact — works whether or not the
// contact has been added to a campaign. Merges the org-wide master_contacts
// record (DNC / enrichment), the campaigns the person is in (leads matched by
// LinkedIn or email), and their call activity. Powers /dashboard/contacts/[id].
router.get(
  "/contacts/:id/profile",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const id = req.params.id as string;

    const [c] = await db
      .select()
      .from(scraperContacts)
      .where(and(eq(scraperContacts.id, id), eq(scraperContacts.organizationId, orgId)))
      .limit(1);
    if (!c) throw new ApiError(404, "Contact not found");

    // Org-wide master record (DNC, timezone, best enrichment) — canonical
    // person match on any identity key, not LinkedIn-only.
    const { findPerson } = await import("../lib/person-resolve");
    const master =
      (await findPerson(orgId, {
        name: c.fullName,
        firstName: c.firstName,
        lastName: c.lastName,
        email: c.email,
        phone: c.phone,
        linkedinUrl: c.linkedinUrl,
      })) ?? undefined;

    const email = (c.email || master?.email || "").toLowerCase();
    const phone = c.phone || master?.phone || null;
    const digits = (phone || "").replace(/[^0-9]/g, "");

    // Campaigns this person is in — leads matched by LinkedIn URL or email.
    const matchConds = [];
    if (c.linkedinUrl) matchConds.push(eq(leads.linkedinUrl, c.linkedinUrl));
    if (email) matchConds.push(sql`LOWER(${leads.email}) = ${email}`);
    const campaigns = matchConds.length
      ? await db
          .select({
            leadId: leads.id,
            funnelId: leads.funnelId,
            funnelName: funnels.name,
            status: leads.status,
            currentStep: leads.currentStep,
            totalSteps: leads.totalSteps,
          })
          .from(leads)
          .innerJoin(funnels, eq(leads.funnelId, funnels.id))
          .where(and(eq(funnels.organizationId, orgId), or(...matchConds)))
      : [];

    // Call activity (org-wide, by phone) — most recent first.
    const calls = digits.length > 5
      ? await db
          .select({
            id: callRecords.id,
            direction: callRecords.direction,
            toNumber: callRecords.toNumber,
            fromNumber: callRecords.fromNumber,
            duration: callRecords.duration,
            disposition: callRecords.disposition,
            calledAt: callRecords.calledAt,
          })
          .from(callRecords)
          .where(
            and(
              eq(callRecords.organizationId, orgId),
              // The contact's number is the COUNTERPARTY: toNumber on outbound,
              // fromNumber on inbound. Match either column so inbound calls
              // (where the caller is in fromNumber) also show on the profile.
              sql`(
                regexp_replace(COALESCE(${callRecords.toNumber}, ''), '[^0-9]', '', 'g') = ${digits}
                OR regexp_replace(COALESCE(${callRecords.fromNumber}, ''), '[^0-9]', '', 'g') = ${digits}
              )`,
            ),
          )
          .orderBy(desc(callRecords.calledAt))
          .limit(25)
      : [];

    // Hiring roles inherited from the company's scraped job posts.
    const jobsMap = await loadCompanyJobs(orgId, c.assignmentId ? [c.assignmentId] : []);
    const companyKey = (c.companyName || c.currentCompany || "").toLowerCase();
    const hiringRoles = (jobsMap.get(companyKey) ?? []).map((r, i) => ({
      id: `${c.id}:role:${i}`,
      ...r,
    }));

    res.json({
      data: {
        id: c.id,
        hiringRoles,
        assignmentId: c.assignmentId,
        fullName: c.fullName,
        firstName: c.firstName,
        lastName: c.lastName,
        headline: c.headline,
        title: c.currentTitle,
        company: c.currentCompany || c.companyName,
        companyDomain: c.companyDomain,
        companyLinkedinUrl: c.companyLinkedinUrl || c.currentCompanyLinkedinUrl,
        linkedinUrl: c.linkedinUrl,
        location: c.location || master?.location || null,
        profileImageUrl: c.profileImageUrl || master?.profileImageUrl || null,
        email: c.email || master?.email || null,
        emailStatus: c.emailStatus || master?.emailStatus || null,
        phone,
        phoneStatus: c.phoneStatus || master?.phoneStatus || null,
        enrichmentStatus: c.enrichmentStatus,
        status: c.status,
        doNotCall: master?.doNotCall ?? false,
        callsTotal: calls.length,
        campaigns,
        calls: calls.map((cr) => ({
          id: cr.id,
          direction: cr.direction,
          number: cr.direction === "inbound" ? cr.fromNumber : cr.toNumber,
          duration: cr.duration,
          disposition: cr.disposition,
          calledAt: cr.calledAt?.toISOString() ?? null,
        })),
      },
    });
  }),
);

// ─── GET /companies/profile ─────────────────────────────────────────
// Standalone company profile keyed by domain or LinkedIn URL — the master
// company record, the discovered contacts at that company, and any campaign
// leads there. Powers /dashboard/companies/[key].
router.get(
  "/companies/profile",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const key = (req.query.key as string | undefined)?.trim();
    if (!key) throw new ApiError(400, "key (domain or linkedin url) is required");
    const isUrl = key.includes("linkedin.com");

    const [company] = await db
      .select()
      .from(masterCompanies)
      .where(
        and(
          eq(masterCompanies.organizationId, orgId),
          isUrl ? eq(masterCompanies.linkedinUrl, key) : eq(masterCompanies.domain, key),
        ),
      )
      .limit(1);

    // Discovered contacts at this company (by linkedin url or name).
    const contactConds = [eq(scraperContacts.organizationId, orgId)];
    if (isUrl) contactConds.push(eq(scraperContacts.companyLinkedinUrl, key));
    else if (company) contactConds.push(ilike(scraperContacts.companyName, `%${company.name}%`));
    else contactConds.push(ilike(scraperContacts.companyDomain, `%${key}%`));
    const contacts = await db
      .select({
        id: scraperContacts.id,
        fullName: scraperContacts.fullName,
        title: scraperContacts.currentTitle,
        linkedinUrl: scraperContacts.linkedinUrl,
        email: scraperContacts.email,
        phone: scraperContacts.phone,
        status: scraperContacts.status,
      })
      .from(scraperContacts)
      .where(and(...contactConds))
      .limit(200);

    // Campaign leads at this company.
    const companyLeads = company
      ? await db
          .select({
            leadId: leads.id,
            funnelId: leads.funnelId,
            name: leads.name,
            title: leads.title,
            status: leads.status,
          })
          .from(leads)
          .innerJoin(funnels, eq(leads.funnelId, funnels.id))
          .where(and(eq(funnels.organizationId, orgId), ilike(leads.company, `%${company.name}%`)))
          .limit(200)
      : [];

    // The company's scraped JOB POSTS → hiring roles. Matched org-wide by company
    // name (or domain) so a company that has only jobs (no discovered contacts)
    // still surfaces its open roles on the profile's Hiring Roles section.
    const companyName = company?.name || (isUrl ? "" : key);
    const jobConds = [eq(scraperSignals.organizationId, orgId)];
    const jobMatch = [];
    if (companyName) jobMatch.push(sql`lower(${scraperSignals.company}) = lower(${companyName})`);
    if (!isUrl) jobMatch.push(ilike(scraperSignals.companyDomain, `%${key}%`));
    if (isUrl) jobMatch.push(eq(scraperSignals.companyLinkedinUrl, key));
    if (jobMatch.length) jobConds.push(or(...jobMatch)!);
    const jobRows = jobMatch.length
      ? await db
          .select({
            jobTitle: scraperSignals.jobTitle,
            salary: scraperSignals.salary,
            location: scraperSignals.location,
            jobUrl: scraperSignals.jobUrl,
            description: scraperSignals.description,
            postedAt: scraperSignals.postedAt,
            seniority: scraperSignals.seniority,
          })
          .from(scraperSignals)
          .where(and(...jobConds))
          .orderBy(desc(scraperSignals.postedAt))
          .limit(60)
      : [];
    const seenTitles = new Set<string>();
    const hiringRoles: Array<{ id: string } & DerivedHiringRole> = [];
    for (const s of jobRows) {
      const title = (s.jobTitle || "").trim();
      const tk = title.toLowerCase();
      if (!title || seenTitles.has(tk) || hiringRoles.length >= 15) continue;
      seenTitles.add(tk);
      hiringRoles.push({
        id: `${key}:role:${hiringRoles.length}`,
        title,
        description: (s.description || "").slice(0, 800),
        salaryRange: s.salary || "",
        location: s.location || "",
        postedAgo: relTime(s.postedAt),
        seniority: s.seniority || "",
        url: s.jobUrl || "",
      });
    }

    res.json({
      data: {
        hiringRoles,
        company: company
          ? {
              id: company.id,
              name: company.name,
              domain: company.domain,
              linkedinUrl: company.linkedinUrl,
              industry: company.industry,
              employeeCount: company.employeeCount,
              fundingStage: company.fundingStage,
              country: company.country,
              city: company.city,
              logo: company.logo,
              description: company.description,
            }
          : { name: key, domain: isUrl ? null : key, linkedinUrl: isUrl ? key : null },
        contacts,
        leads: companyLeads,
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

// ─── PATCH /contacts/:id ─────────────────────────────────────────────
// Edit a discovered contact's details (name / title / email / phone / LinkedIn)
// from the standalone lead profile view. Mirrors to the master contact.
router.patch(
  "/contacts/:id",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const id = req.params.id as string;
    const body = (req.body || {}) as Partial<Record<"name" | "title" | "email" | "phone" | "linkedinUrl", string>>;

    const [existing] = await db
      .select()
      .from(scraperContacts)
      .where(and(eq(scraperContacts.id, id), eq(scraperContacts.organizationId, orgId)))
      .limit(1);
    if (!existing) throw new ApiError(404, "Contact not found");

    const updates: Record<string, unknown> = {};
    if (body.name !== undefined) {
      const fullName = body.name.trim();
      if (!fullName) throw new ApiError(400, "Name cannot be empty");
      const [firstName, ...rest] = fullName.split(" ");
      updates.fullName = fullName;
      updates.firstName = firstName || null;
      updates.lastName = rest.join(" ") || null;
    }
    if (body.title !== undefined) updates.currentTitle = body.title.trim();
    if (body.email !== undefined) updates.email = body.email.trim().toLowerCase();
    if (body.phone !== undefined) updates.phone = body.phone.trim();
    if (body.linkedinUrl !== undefined) updates.linkedinUrl = body.linkedinUrl.trim();
    if (Object.keys(updates).length === 0) throw new ApiError(400, "Nothing to update");
    updates.updatedAt = new Date();

    await db.update(scraperContacts).set(updates).where(eq(scraperContacts.id, id));

    // Sync the canonical person — resolved by any identity key (email/phone/
    // LinkedIn), not LinkedIn-only as before, and explicit edits overwrite.
    try {
      const { resolvePerson, emailKeyOf, linkedinKeyOf, phoneKeyOf } = await import("../lib/person-resolve");
      const merged = {
        name: (updates.fullName as string) ?? existing.fullName ?? "",
        firstName: (updates.firstName as string) ?? existing.firstName,
        lastName: (updates.lastName as string) ?? existing.lastName,
        title: (updates.currentTitle as string) ?? existing.currentTitle,
        email: (updates.email as string) ?? existing.email,
        phone: (updates.phone as string) ?? existing.phone,
        linkedinUrl: (updates.linkedinUrl as string) ?? existing.linkedinUrl,
      };
      const personId = await resolvePerson(orgId, merged);
      if (personId) {
        const masterUpdates: Record<string, unknown> = { updatedAt: new Date() };
        if (updates.fullName !== undefined) {
          masterUpdates.fullName = updates.fullName;
          masterUpdates.firstName = updates.firstName;
          masterUpdates.lastName = updates.lastName;
        }
        if (updates.currentTitle !== undefined) masterUpdates.currentTitle = updates.currentTitle || null;
        if (updates.email !== undefined) {
          masterUpdates.email = (updates.email as string) || null;
          masterUpdates.emailKey = emailKeyOf(updates.email as string);
        }
        if (updates.phone !== undefined) {
          masterUpdates.phone = (updates.phone as string) || null;
          masterUpdates.phoneKey = phoneKeyOf(updates.phone as string);
        }
        if (updates.linkedinUrl !== undefined) {
          masterUpdates.linkedinUrl = (updates.linkedinUrl as string) || null;
          masterUpdates.linkedinKey = linkedinKeyOf(updates.linkedinUrl as string);
        }
        await db
          .update(masterContacts)
          .set(masterUpdates)
          .where(and(eq(masterContacts.id, personId), eq(masterContacts.organizationId, orgId)));
      }
    } catch (err) {
      console.warn("[contact-edit] person sync failed:", err instanceof Error ? err.message : err);
    }

    res.json({
      data: {
        id,
        name: (updates.fullName as string) ?? existing.fullName,
        title: (updates.currentTitle as string) ?? existing.currentTitle,
        email: (updates.email as string) ?? existing.email,
        phone: (updates.phone as string) ?? existing.phone,
        linkedinUrl: (updates.linkedinUrl as string) ?? existing.linkedinUrl,
      },
    });
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
    const { contactIds, funnelId, allMatching, filters } = req.body as {
      contactIds?: string[];
      funnelId: string;
      allMatching?: boolean;
      filters?: ContactFilterQuery;
    };

    if (!funnelId) throw new ApiError(400, "funnelId is required");
    if (!allMatching && !contactIds?.length) {
      throw new ApiError(400, "contactIds or allMatching is required");
    }

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

    // Resolve the contacts: either the explicit selection, or every contact
    // matching the current filter set ("Select all matching").
    const contactWhere = allMatching
      ? and(...buildContactConditions(orgId, filters || {}))
      : and(
          eq(scraperContacts.organizationId, orgId),
          inArray(scraperContacts.id, contactIds!),
        );

    const contacts = await db
      .select()
      .from(scraperContacts)
      .where(contactWhere);
    if (contacts.length === 0) throw new ApiError(404, "No contacts found");

    // Load existing leads for dedup
    const existingLeads = await db
      .select({ name: leads.name, company: leads.company, email: leads.email })
      .from(leads)
      .where(eq(leads.funnelId, funnelId));
    const existingKeys = new Set(
      existingLeads.map((l) => dedupeKey(l.name, l.company, l.email)),
    );

    // Look up company metadata from scraper signals for enrichment
    const companyNames = [...new Set(contacts.map((c) => c.currentCompany || c.companyName || "").filter(Boolean))];
    const companyMeta = new Map<string, { domain?: string; industry?: string; employeeCount?: number; location?: string }>();
    for (const companyName of companyNames) {
      const signal = await db.query.scraperSignals.findFirst({
        where: sql`lower(${scraperSignals.company}) = lower(${companyName})`,
        columns: { companyDomain: true, companyIndustry: true, companyEmployeeCount: true, location: true },
      });
      if (signal) {
        companyMeta.set(companyName.toLowerCase(), {
          domain: signal.companyDomain || undefined,
          industry: signal.companyIndustry || undefined,
          employeeCount: signal.companyEmployeeCount || undefined,
          location: signal.location || undefined,
        });
      }
    }

    // The companies' scraped JOB POSTS → hiring roles, so each lead inherits the
    // jobs data from the scrape. Keyed by lower(company) from the contacts' runs.
    const assignmentIds = [...new Set(contacts.map((c) => c.assignmentId).filter(Boolean) as string[])];
    const companyJobs = await loadCompanyJobs(orgId, assignmentIds);

    const now = Date.now();
    const firstStep = steps[0];
    const newLeads: Array<typeof leads.$inferInsert> = [];
    const newEvents: Array<typeof leadEvents.$inferInsert> = [];
    const newHiringRoles: Array<typeof leadHiringRoles.$inferInsert> = [];
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
      const meta = companyMeta.get(company.toLowerCase());
      // Inherit the company's scraped job posts as this lead's hiring roles.
      const jobs = companyJobs.get((c.companyName || company).toLowerCase()) ?? [];

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
        companyDomain: c.companyDomain || meta?.domain || null,
        companyIndustry: meta?.industry || null,
        companyEmployeeCount: meta?.employeeCount || null,
        companyLocation: meta?.location || null,
        companyHiringRoles: jobs.length ? jobs.map((j) => j.title) : null,
        createdAt: new Date(now),
        updatedAt: new Date(now),
      });

      for (const j of jobs) {
        newHiringRoles.push({
          id: createId("hrole"),
          organizationId: orgId,
          funnelId,
          leadId,
          title: j.title,
          description: j.description,
          salaryRange: j.salaryRange,
          location: j.location,
          postedAgo: j.postedAgo,
          seniority: j.seniority,
          url: j.url,
        });
      }

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
      // Link every enrollment to its canonical person (bulk resolution).
      const { resolvePersonsBulk } = await import("../lib/person-resolve");
      const personIds = await resolvePersonsBulk(orgId, newLeads);
      for (let i = 0; i < newLeads.length; i++) {
        newLeads[i].masterContactId = personIds[i];
      }
      await db.transaction(async (tx) => {
        // Chunk inserts — Postgres caps a statement at 65534 bind params, so
        // large batches must be split or they hit MAX_PARAMETERS_EXCEEDED.
        const INSERT_CHUNK = 500;
        for (let i = 0; i < newLeads.length; i += INSERT_CHUNK) {
          await tx.insert(leads).values(newLeads.slice(i, i + INSERT_CHUNK));
        }
        for (let i = 0; i < newEvents.length; i += INSERT_CHUNK) {
          await tx.insert(leadEvents).values(newEvents.slice(i, i + INSERT_CHUNK));
        }
        for (let i = 0; i < newHiringRoles.length; i += INSERT_CHUNK) {
          await tx.insert(leadHiringRoles).values(newHiringRoles.slice(i, i + INSERT_CHUNK));
        }
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
        const apiKey = await getSmartleadApiKey(orgId);
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
// Reset enrichment so contacts can be re-enriched (works for both "failed" and "pending" states)
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

// ─── POST /contacts/reset-stuck ─────────────────────────────────────
// Reset all contacts stuck in "pending" enrichment for a given assignment
router.post(
  "/contacts/reset-stuck",
  asyncHandler(async (req, res) => {
    const orgId = getOrgId(req);
    const { assignmentId } = req.body as { assignmentId: string };

    if (!assignmentId) throw new ApiError(400, "assignmentId is required");

    const result = await db
      .update(scraperContacts)
      .set({
        enrichmentStatus: "none",
        bettercontactRequestId: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(scraperContacts.organizationId, orgId),
          eq(scraperContacts.assignmentId, assignmentId),
          eq(scraperContacts.enrichmentStatus, "pending"),
        ),
      )
      .returning({ id: scraperContacts.id });

    console.log(`[Reset Stuck] Reset ${result.length} pending contacts for assignment ${assignmentId}`);
    res.json({ data: { reset: result.length } });
  }),
);

export default router;
