CREATE TABLE "email_domains" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"client" text DEFAULT '' NOT NULL,
	"registrar" text DEFAULT '' NOT NULL,
	"purchased" boolean DEFAULT false NOT NULL,
	"age_label" text DEFAULT 'new' NOT NULL,
	"health" integer DEFAULT 50 NOT NULL,
	"status" text DEFAULT 'warning' NOT NULL,
	"spf" text DEFAULT 'warn' NOT NULL,
	"dkim" text DEFAULT 'warn' NOT NULL,
	"dmarc" text DEFAULT 'warn' NOT NULL,
	"mx" text DEFAULT 'warn' NOT NULL,
	"tracking" text DEFAULT 'warn' NOT NULL,
	"dns_records" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_mailboxes" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"domain_id" text,
	"smartlead_account_id" text,
	"email" text NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"provider" text DEFAULT 'Google' NOT NULL,
	"warmup" text DEFAULT 'off' NOT NULL,
	"warm_score" integer DEFAULT 0 NOT NULL,
	"sent_today" integer DEFAULT 0 NOT NULL,
	"daily_limit" integer DEFAULT 50 NOT NULL,
	"reputation" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"assigned_to" text,
	"campaign" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "email_mailboxes" ADD CONSTRAINT "email_mailboxes_domain_id_email_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."email_domains"("id") ON DELETE set null ON UPDATE no action;