CREATE TABLE "credit_transactions" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text,
	"kind" text NOT NULL,
	"action" text NOT NULL,
	"credits" integer NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"unit_credits" integer DEFAULT 1 NOT NULL,
	"balance_after" integer NOT NULL,
	"amount_usd_cents" integer,
	"stripe_session_id" text,
	"description" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "credit_balance" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "scraper_contacts" ADD COLUMN "credits_billed_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "credit_tx_org_created_idx" ON "credit_transactions" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "credit_tx_stripe_session_idx" ON "credit_transactions" USING btree ("stripe_session_id");--> statement-breakpoint
-- Seed the unified wallet from each org's remaining monthly plan credits so
-- nobody loses value when the credit system goes live.
UPDATE "organizations" SET "credit_balance" = GREATEST("credits_included" - "credits_used", 0);