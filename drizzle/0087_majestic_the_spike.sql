CREATE TABLE "scheduled_meetings" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"lead_id" text,
	"funnel_id" text,
	"host_user_id" text,
	"host_account_id" text,
	"host_email" text,
	"provider" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"description" text,
	"start_time" timestamp with time zone,
	"end_time" timestamp with time zone,
	"join_url" text,
	"location" text,
	"attendees" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'confirmed' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "scheduled_meetings" ADD CONSTRAINT "scheduled_meetings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scheduled_meetings_org_lead_idx" ON "scheduled_meetings" USING btree ("organization_id","lead_id");--> statement-breakpoint
CREATE INDEX "scheduled_meetings_org_start_idx" ON "scheduled_meetings" USING btree ("organization_id","start_time");--> statement-breakpoint
CREATE UNIQUE INDEX "scheduled_meetings_event_uq" ON "scheduled_meetings" USING btree ("provider_event_id");