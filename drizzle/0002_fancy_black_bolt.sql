CREATE TABLE "linkedin_rate_limits" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"date" text NOT NULL,
	"invitations_sent" integer DEFAULT 0 NOT NULL,
	"messages_sent" integer DEFAULT 0 NOT NULL,
	"profiles_viewed" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "funnel_steps" ADD COLUMN "action" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "unipile_provider_id" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "notes" jsonb;