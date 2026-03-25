CREATE TABLE "scraper_assignments" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"scraper_id" text NOT NULL,
	"scraper_name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"frequency" text DEFAULT 'daily' NOT NULL,
	"status" text DEFAULT 'idle' NOT NULL,
	"keywords" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"excluded_keywords" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"keyword_match_mode" text DEFAULT 'any' NOT NULL,
	"countries" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"languages" jsonb DEFAULT '["English"]'::jsonb NOT NULL,
	"source_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_signal_limits" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"lookback_days" integer DEFAULT 7 NOT NULL,
	"max_signals_per_run" integer DEFAULT 100 NOT NULL,
	"min_signal_score" integer DEFAULT 50 NOT NULL,
	"only_decision_makers" boolean DEFAULT false NOT NULL,
	"dedupe_companies" boolean DEFAULT true NOT NULL,
	"include_remote_roles" boolean DEFAULT true NOT NULL,
	"notify_on_high_intent" boolean DEFAULT false NOT NULL,
	"signals_found" integer DEFAULT 0 NOT NULL,
	"companies_found" integer DEFAULT 0 NOT NULL,
	"credits_per_run" real DEFAULT 0 NOT NULL,
	"last_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scraper_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"assignment_id" text NOT NULL,
	"source_id" text NOT NULL,
	"apify_actor_id" text NOT NULL,
	"apify_run_id" text,
	"apify_dataset_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"input_payload" jsonb,
	"items_scraped" integer DEFAULT 0 NOT NULL,
	"signals_created" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "scraper_signals" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"assignment_id" text NOT NULL,
	"run_id" text NOT NULL,
	"source_id" text NOT NULL,
	"job_title" text NOT NULL,
	"company" text NOT NULL,
	"company_domain" text,
	"location" text,
	"job_url" text,
	"description" text,
	"salary" text,
	"posted_at" timestamp with time zone,
	"job_type" text,
	"is_remote" boolean DEFAULT false NOT NULL,
	"score" integer DEFAULT 50 NOT NULL,
	"signal_type" text DEFAULT 'hiring' NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"raw_data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "scraper_runs" ADD CONSTRAINT "scraper_runs_assignment_id_scraper_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."scraper_assignments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scraper_signals" ADD CONSTRAINT "scraper_signals_assignment_id_scraper_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."scraper_assignments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scraper_signals" ADD CONSTRAINT "scraper_signals_run_id_scraper_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."scraper_runs"("id") ON DELETE cascade ON UPDATE no action;