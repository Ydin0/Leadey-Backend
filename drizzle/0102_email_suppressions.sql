CREATE TABLE "email_suppressions" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"email_key" text NOT NULL,
	"reason" text NOT NULL,
	"lead_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "email_suppressions" ADD CONSTRAINT "email_suppressions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "email_suppressions_org_email_uq" ON "email_suppressions" USING btree ("organization_id","email_key");