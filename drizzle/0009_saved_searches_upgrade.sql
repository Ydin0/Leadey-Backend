-- Saved Searches Upgrade: Add filters JSONB + rich signal data columns
-- Non-destructive migration — all columns use ADD COLUMN IF NOT EXISTS with defaults

-- ─── scraper_assignments: Saved Search fields ────────────────────────
ALTER TABLE "scraper_assignments" ADD COLUMN IF NOT EXISTS "filters" jsonb NOT NULL DEFAULT '{}';
ALTER TABLE "scraper_assignments" ADD COLUMN IF NOT EXISTS "search_name" text NOT NULL DEFAULT 'Untitled Search';
ALTER TABLE "scraper_assignments" ADD COLUMN IF NOT EXISTS "total_results" integer NOT NULL DEFAULT 0;
ALTER TABLE "scraper_assignments" ADD COLUMN IF NOT EXISTS "last_run_result_count" integer NOT NULL DEFAULT 0;

-- ─── scraper_signals: Company enrichment data ────────────────────────
ALTER TABLE "scraper_signals" ADD COLUMN IF NOT EXISTS "company_logo" text;
ALTER TABLE "scraper_signals" ADD COLUMN IF NOT EXISTS "company_industry" text;
ALTER TABLE "scraper_signals" ADD COLUMN IF NOT EXISTS "company_employee_count" integer;
ALTER TABLE "scraper_signals" ADD COLUMN IF NOT EXISTS "company_revenue" integer;
ALTER TABLE "scraper_signals" ADD COLUMN IF NOT EXISTS "company_funding" integer;
ALTER TABLE "scraper_signals" ADD COLUMN IF NOT EXISTS "company_funding_stage" text;
ALTER TABLE "scraper_signals" ADD COLUMN IF NOT EXISTS "company_country" text;
ALTER TABLE "scraper_signals" ADD COLUMN IF NOT EXISTS "company_city" text;
ALTER TABLE "scraper_signals" ADD COLUMN IF NOT EXISTS "company_linkedin_url" text;
ALTER TABLE "scraper_signals" ADD COLUMN IF NOT EXISTS "hiring_team" jsonb NOT NULL DEFAULT '[]';
ALTER TABLE "scraper_signals" ADD COLUMN IF NOT EXISTS "seniority" text;
ALTER TABLE "scraper_signals" ADD COLUMN IF NOT EXISTS "technology_slugs" jsonb NOT NULL DEFAULT '[]';
ALTER TABLE "scraper_signals" ADD COLUMN IF NOT EXISTS "min_salary_usd" integer;
ALTER TABLE "scraper_signals" ADD COLUMN IF NOT EXISTS "max_salary_usd" integer;
ALTER TABLE "scraper_signals" ADD COLUMN IF NOT EXISTS "employment_status" text;
ALTER TABLE "scraper_signals" ADD COLUMN IF NOT EXISTS "discovered_at" timestamp with time zone;
ALTER TABLE "scraper_signals" ADD COLUMN IF NOT EXISTS "enrichment_status" text NOT NULL DEFAULT 'none';
