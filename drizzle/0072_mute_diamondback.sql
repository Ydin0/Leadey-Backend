ALTER TABLE "organizations" ADD COLUMN "telephony_monthly_limit_minor" integer;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "telephony_autotopup_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "telephony_autotopup_threshold_minor" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "telephony_autotopup_target_minor" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "telephony_autotopup_last_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "telephony_autotopup_last_error" text;