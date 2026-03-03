CREATE TABLE "settings" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settings_key_unique" UNIQUE("key")
);
--> statement-breakpoint
ALTER TABLE "funnel_steps" ADD COLUMN "subject" text;--> statement-breakpoint
ALTER TABLE "funnel_steps" ADD COLUMN "email_body" text;--> statement-breakpoint
ALTER TABLE "funnels" ADD COLUMN "smartlead_campaign_id" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "smartlead_lead_id" text;