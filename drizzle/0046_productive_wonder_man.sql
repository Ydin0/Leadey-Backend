CREATE TABLE "workflow_enrollments" (
	"id" text PRIMARY KEY NOT NULL,
	"workflow_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"lead_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"current_node_id" text,
	"next_run_at" timestamp with time zone,
	"waiting_for" text,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_error" text,
	"entered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "workflow_step_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"enrollment_id" text NOT NULL,
	"workflow_id" text NOT NULL,
	"lead_id" text NOT NULL,
	"node_id" text NOT NULL,
	"type" text NOT NULL,
	"status" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ran_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflows" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"funnel_id" text NOT NULL,
	"name" text DEFAULT 'Untitled workflow' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"graph" jsonb DEFAULT '{"nodes":[],"edges":[]}'::jsonb NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "tags" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "owner_id" text;--> statement-breakpoint
ALTER TABLE "workflow_enrollments" ADD CONSTRAINT "workflow_enrollments_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_enrollments" ADD CONSTRAINT "workflow_enrollments_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_step_runs" ADD CONSTRAINT "workflow_step_runs_enrollment_id_workflow_enrollments_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."workflow_enrollments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_funnel_id_funnels_id_fk" FOREIGN KEY ("funnel_id") REFERENCES "public"."funnels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workflow_enrollments_status_next" ON "workflow_enrollments" USING btree ("status","next_run_at");--> statement-breakpoint
CREATE INDEX "workflow_enrollments_workflow_lead" ON "workflow_enrollments" USING btree ("workflow_id","lead_id");--> statement-breakpoint
CREATE INDEX "workflow_enrollments_lead" ON "workflow_enrollments" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "workflow_step_runs_enrollment" ON "workflow_step_runs" USING btree ("enrollment_id");--> statement-breakpoint
CREATE INDEX "workflows_org_funnel" ON "workflows" USING btree ("organization_id","funnel_id");