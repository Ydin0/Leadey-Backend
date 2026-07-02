/**
 * One-off company-identity backfill (leads.master_company_id).
 *
 *   npx tsx scripts/backfill-lead-companies.ts --dry-run   # stats only
 *   npx tsx scripts/backfill-lead-companies.ts             # apply
 *   npx tsx scripts/backfill-lead-companies.ts --validate  # post-run gate
 *
 * Point DATABASE_URL at the target database. Idempotent: only touches leads
 * with master_company_id IS NULL AND company <> '' and re-runs safely.
 *
 * Per org, four passes (matching is exact lower/trim only — fuzzy matching
 * risks merging "ACME Ltd" into "ACME Inc"):
 *  1. Domain:      lower(leads.company_domain) = lower(mc.domain)
 *  2. Exact name:  lower(trim(leads.company)) = lower(trim(mc.name))
 *  3. Slug domain: company slug + ".unknown" = mc.domain — catches companies
 *     upsertMasterCompany created name-only (lib/master-db.ts synthesizes
 *     "<slug>.unknown" when a company has no domain).
 *  4. Create missing: every remaining unlinked company gets a master row
 *     (richest lead's fields) — the universal profile URL key IS
 *     master_companies.id, so a company without a row has no profile at all.
 */
import { sql } from "drizzle-orm";
import { db } from "../src/db/index";
import { organizations } from "../src/db/schema/organizations";
import { upsertMasterCompany } from "../src/lib/master-db";

const DRY_RUN = process.argv.includes("--dry-run");
const VALIDATE = process.argv.includes("--validate");

/** Set-based UPDATE joining unlinked org leads to master companies on `cond`.
 *  Returns the number of leads linked. */
async function linkPass(orgId: string, label: string, cond: ReturnType<typeof sql>): Promise<number> {
  if (DRY_RUN) {
    const rows = (await db.execute(sql`
      SELECT count(*) AS n
      FROM leads l
      JOIN funnels f ON f.id = l.funnel_id
      JOIN master_companies mc ON mc.organization_id = f.organization_id AND ${cond}
      WHERE f.organization_id = ${orgId}
        AND l.master_company_id IS NULL AND l.company <> ''`)) as unknown as Array<Record<string, unknown>>;
    const n = Number(rows[0]?.n ?? 0);
    console.log(`  ${label}: would link ${n}`);
    return n;
  }
  const rows = (await db.execute(sql`
    WITH linked AS (
      UPDATE leads l SET master_company_id = mc.id, updated_at = now()
      FROM funnels f, master_companies mc
      WHERE f.id = l.funnel_id AND f.organization_id = ${orgId}
        AND mc.organization_id = f.organization_id
        AND l.master_company_id IS NULL AND l.company <> ''
        AND ${cond}
      RETURNING l.id
    ) SELECT count(*) AS n FROM linked`)) as unknown as Array<Record<string, unknown>>;
  const n = Number(rows[0]?.n ?? 0);
  console.log(`  ${label}: linked ${n}`);
  return n;
}

async function backfillOrg(orgId: string, orgName: string) {
  console.log(`\n═══ ${orgName} (${orgId}) ═══`);

  // Pass 1 — domain match (skip synthesized ".unknown" domains here; those
  // are name-derived and handled precisely by pass 3's slug equality).
  await linkPass(
    orgId,
    "pass 1 (domain)",
    sql`mc.domain IS NOT NULL AND mc.domain NOT LIKE '%.unknown'
        AND lower(l.company_domain) = lower(mc.domain)`,
  );

  // Pass 2 — exact normalized name match.
  await linkPass(
    orgId,
    "pass 2 (exact name)",
    sql`lower(trim(l.company)) = lower(trim(mc.name))`,
  );

  // Pass 3 — slug → synthesized ".unknown" domain match.
  await linkPass(
    orgId,
    "pass 3 (slug .unknown)",
    sql`mc.domain LIKE '%.unknown'
        AND lower(regexp_replace(l.company, '[^a-zA-Z0-9]', '', 'g')) || '.unknown' = lower(mc.domain)`,
  );

  // Pass 4 — create master rows for companies that still have none, then link.
  // DISTINCT ON picks the richest lead per company (most company fields set).
  const missing = (await db.execute(sql`
    SELECT DISTINCT ON (lower(trim(l.company)))
           l.company, l.company_domain, l.company_linkedin, l.company_industry,
           l.company_employee_count
    FROM leads l JOIN funnels f ON f.id = l.funnel_id
    WHERE f.organization_id = ${orgId}
      AND l.master_company_id IS NULL AND l.company <> ''
    ORDER BY lower(trim(l.company)),
             (CASE WHEN l.company_domain IS NOT NULL THEN 1 ELSE 0 END
            + CASE WHEN l.company_linkedin IS NOT NULL THEN 1 ELSE 0 END
            + CASE WHEN l.company_industry IS NOT NULL THEN 1 ELSE 0 END) DESC`)) as unknown as Array<Record<string, unknown>>;
  console.log(`  pass 4 (create missing): ${missing.length} companies${DRY_RUN ? " (dry-run, not created)" : ""}`);
  if (!DRY_RUN) {
    for (const m of missing) {
      const name = String(m.company).trim();
      if (!name) continue;
      const id = await upsertMasterCompany(orgId, {
        name,
        domain: (m.company_domain as string) || null,
        linkedinUrl: (m.company_linkedin as string) || null,
        industry: (m.company_industry as string) || null,
        employeeCount: (m.company_employee_count as number) || null,
      });
      await db.execute(sql`
        UPDATE leads l SET master_company_id = ${id}, updated_at = now()
        FROM funnels f
        WHERE f.id = l.funnel_id AND f.organization_id = ${orgId}
          AND l.master_company_id IS NULL
          AND lower(trim(l.company)) = lower(${name})`);
    }
  }

  const [left] = (await db.execute(sql`
    SELECT count(*) AS n FROM leads l JOIN funnels f ON f.id = l.funnel_id
    WHERE f.organization_id = ${orgId}
      AND l.master_company_id IS NULL AND l.company <> ''`)) as unknown as Array<Record<string, unknown>>;
  console.log(`  still unlinked (named): ${left.n}${DRY_RUN ? " (before any writes)" : " — should be 0"}`);
}

async function validate() {
  const orgs = await db.select({ id: organizations.id, name: organizations.name }).from(organizations);
  for (const org of orgs) {
    const [stats] = (await db.execute(sql`
      SELECT count(*) FILTER (WHERE l.master_company_id IS NOT NULL) AS linked,
             count(*) FILTER (WHERE l.master_company_id IS NULL AND l.company <> '') AS unlinked_named,
             count(*) FILTER (WHERE l.master_company_id IS NULL AND l.company = '') AS unlinked_blank
      FROM leads l JOIN funnels f ON f.id = l.funnel_id
      WHERE f.organization_id = ${org.id}`)) as unknown as Array<Record<string, unknown>>;
    // Hard gate: a lead must never link to another org's company.
    const [cross] = (await db.execute(sql`
      SELECT count(*) AS n
      FROM leads l
      JOIN funnels f ON f.id = l.funnel_id
      JOIN master_companies mc ON mc.id = l.master_company_id
      WHERE f.organization_id = ${org.id} AND mc.organization_id <> f.organization_id`)) as unknown as Array<Record<string, unknown>>;
    console.log(
      `${org.name}: linked=${stats.linked} unlinked-named=${stats.unlinked_named} (should be 0) ` +
      `unlinked-blank=${stats.unlinked_blank} cross-org=${cross.n} (MUST be 0)`,
    );
  }
}

(async () => {
  if (VALIDATE) {
    await validate();
    process.exit(0);
  }
  console.log(DRY_RUN ? "── DRY RUN — no writes ──" : "── APPLYING ──");
  const orgs = await db.select({ id: organizations.id, name: organizations.name }).from(organizations);
  for (const org of orgs) {
    await backfillOrg(org.id, org.name);
  }
  console.log("\ndone");
  process.exit(0);
})().catch((e) => { console.error("FAILED:", e); process.exit(1); });
