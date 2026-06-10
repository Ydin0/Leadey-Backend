CREATE TABLE "lead_hiring_roles" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"funnel_id" text NOT NULL,
	"lead_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"salary_range" text DEFAULT '' NOT NULL,
	"location" text DEFAULT '' NOT NULL,
	"posted_ago" text DEFAULT '' NOT NULL,
	"seniority" text DEFAULT '' NOT NULL,
	"url" text DEFAULT '' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lead_hiring_roles" ADD CONSTRAINT "lead_hiring_roles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_hiring_roles" ADD CONSTRAINT "lead_hiring_roles_funnel_id_funnels_id_fk" FOREIGN KEY ("funnel_id") REFERENCES "public"."funnels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_hiring_roles" ADD CONSTRAINT "lead_hiring_roles_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;