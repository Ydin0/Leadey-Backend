CREATE TABLE "template_attachments" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"template_id" text,
	"file_name" text NOT NULL,
	"stored_name" text NOT NULL,
	"mime_type" text DEFAULT 'application/octet-stream' NOT NULL,
	"size" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "templates" ADD COLUMN "body_html" text;--> statement-breakpoint
ALTER TABLE "template_attachments" ADD CONSTRAINT "template_attachments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_attachments" ADD CONSTRAINT "template_attachments_template_id_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "template_attachments_org_idx" ON "template_attachments" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "template_attachments_template_idx" ON "template_attachments" USING btree ("template_id");