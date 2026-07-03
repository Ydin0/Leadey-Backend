CREATE TABLE "funnel_tag_assignments" (
	"funnel_id" text NOT NULL,
	"tag_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "funnel_tag_assignments_funnel_id_tag_id_pk" PRIMARY KEY("funnel_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "funnel_tags" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"color" text DEFAULT 'blue' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "funnel_tags_organization_id_name_unique" UNIQUE("organization_id","name")
);
--> statement-breakpoint
ALTER TABLE "funnel_tag_assignments" ADD CONSTRAINT "funnel_tag_assignments_funnel_id_funnels_id_fk" FOREIGN KEY ("funnel_id") REFERENCES "public"."funnels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funnel_tag_assignments" ADD CONSTRAINT "funnel_tag_assignments_tag_id_funnel_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."funnel_tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funnel_tags" ADD CONSTRAINT "funnel_tags_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "funnel_tag_assignments_tag_idx" ON "funnel_tag_assignments" USING btree ("tag_id");--> statement-breakpoint
CREATE INDEX "funnel_tags_org_idx" ON "funnel_tags" USING btree ("organization_id");