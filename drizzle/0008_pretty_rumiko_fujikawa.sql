CREATE TABLE "discovery_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"assignment_id" text NOT NULL,
	"apify_run_id" text,
	"apify_dataset_id" text,
	"target_roles" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"seniority_levels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"max_per_company" integer DEFAULT 5 NOT NULL,
	"max_total" integer DEFAULT 100 NOT NULL,
	"company_linkedin_urls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"companies_queried" integer DEFAULT 0 NOT NULL,
	"contacts_found" integer DEFAULT 0 NOT NULL,
	"estimated_cost" real DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scraper_contacts" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"assignment_id" text NOT NULL,
	"discovery_run_id" text NOT NULL,
	"first_name" text,
	"last_name" text,
	"full_name" text,
	"headline" text,
	"linkedin_url" text,
	"location" text,
	"profile_image_url" text,
	"current_title" text,
	"current_company" text,
	"current_company_linkedin_url" text,
	"company_name" text,
	"company_domain" text,
	"company_linkedin_url" text,
	"email" text,
	"email_status" text,
	"phone" text,
	"phone_status" text,
	"enrichment_status" text DEFAULT 'none' NOT NULL,
	"bettercontact_request_id" text,
	"enriched_at" timestamp with time zone,
	"status" text DEFAULT 'discovered' NOT NULL,
	"raw_data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "scraper_runs" ALTER COLUMN "source_id" SET DEFAULT 'theirstack';--> statement-breakpoint
ALTER TABLE "scraper_runs" ALTER COLUMN "apify_actor_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "call_records" ADD COLUMN "recording_url" text;--> statement-breakpoint
ALTER TABLE "call_records" ADD COLUMN "recording_sid" text;--> statement-breakpoint
ALTER TABLE "call_records" ADD COLUMN "recording_duration" integer;--> statement-breakpoint
ALTER TABLE "call_records" ADD COLUMN "transcript" text;--> statement-breakpoint
ALTER TABLE "call_records" ADD COLUMN "summary" text;--> statement-breakpoint
ALTER TABLE "call_records" ADD COLUMN "user_id" text;--> statement-breakpoint
ALTER TABLE "call_records" ADD COLUMN "user_name" text;--> statement-breakpoint
ALTER TABLE "scraper_assignments" ADD COLUMN "job_seniority" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "scraper_assignments" ADD COLUMN "remote_filter" text DEFAULT 'include' NOT NULL;--> statement-breakpoint
ALTER TABLE "scraper_assignments" ADD COLUMN "filters" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "scraper_assignments" ADD COLUMN "search_name" text DEFAULT 'Untitled Search' NOT NULL;--> statement-breakpoint
ALTER TABLE "scraper_assignments" ADD COLUMN "total_results" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "scraper_assignments" ADD COLUMN "last_run_result_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "scraper_signals" ADD COLUMN "company_logo" text;--> statement-breakpoint
ALTER TABLE "scraper_signals" ADD COLUMN "company_industry" text;--> statement-breakpoint
ALTER TABLE "scraper_signals" ADD COLUMN "company_employee_count" integer;--> statement-breakpoint
ALTER TABLE "scraper_signals" ADD COLUMN "company_revenue" bigint;--> statement-breakpoint
ALTER TABLE "scraper_signals" ADD COLUMN "company_funding" bigint;--> statement-breakpoint
ALTER TABLE "scraper_signals" ADD COLUMN "company_funding_stage" text;--> statement-breakpoint
ALTER TABLE "scraper_signals" ADD COLUMN "company_country" text;--> statement-breakpoint
ALTER TABLE "scraper_signals" ADD COLUMN "company_city" text;--> statement-breakpoint
ALTER TABLE "scraper_signals" ADD COLUMN "company_linkedin_url" text;--> statement-breakpoint
ALTER TABLE "scraper_signals" ADD COLUMN "hiring_team" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "scraper_signals" ADD COLUMN "seniority" text;--> statement-breakpoint
ALTER TABLE "scraper_signals" ADD COLUMN "technology_slugs" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "scraper_signals" ADD COLUMN "min_salary_usd" integer;--> statement-breakpoint
ALTER TABLE "scraper_signals" ADD COLUMN "max_salary_usd" integer;--> statement-breakpoint
ALTER TABLE "scraper_signals" ADD COLUMN "employment_status" text;--> statement-breakpoint
ALTER TABLE "scraper_signals" ADD COLUMN "discovered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "scraper_signals" ADD COLUMN "enrichment_status" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "discovery_runs" ADD CONSTRAINT "discovery_runs_assignment_id_scraper_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."scraper_assignments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scraper_contacts" ADD CONSTRAINT "scraper_contacts_assignment_id_scraper_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."scraper_assignments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scraper_contacts" ADD CONSTRAINT "scraper_contacts_discovery_run_id_discovery_runs_id_fk" FOREIGN KEY ("discovery_run_id") REFERENCES "public"."discovery_runs"("id") ON DELETE cascade ON UPDATE no action;