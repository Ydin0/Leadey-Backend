ALTER TABLE "organizations" ADD COLUMN "stripe_customer_id" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "stripe_subscription_id" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "stripe_price_id" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "plan" text DEFAULT 'trial' NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "plan_status" text DEFAULT 'trialing' NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "trial_ends_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "current_period_end" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "seats_included" integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "credits_included" integer DEFAULT 10000 NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "credits_used" integer DEFAULT 0 NOT NULL;