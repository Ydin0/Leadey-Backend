-- Migration: Switch from Apify to TheirStack
-- Make Apify-specific columns nullable and add TheirStack columns

ALTER TABLE "scraper_runs" ALTER COLUMN "apify_actor_id" DROP NOT NULL;
ALTER TABLE "scraper_runs" ALTER COLUMN "source_id" SET DEFAULT 'theirstack';

ALTER TABLE "scraper_assignments" ADD COLUMN IF NOT EXISTS "job_seniority" jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE "scraper_assignments" ADD COLUMN IF NOT EXISTS "remote_filter" text NOT NULL DEFAULT 'include';
