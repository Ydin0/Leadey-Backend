CREATE TABLE "org_roles" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"permissions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "app_role" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "permission_overrides" jsonb;--> statement-breakpoint
ALTER TABLE "org_roles" ADD CONSTRAINT "org_roles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "org_roles_org_idx" ON "org_roles" USING btree ("organization_id");--> statement-breakpoint
UPDATE "users" SET "app_role" = CASE WHEN "role" = 'org:admin' THEN 'admin' ELSE 'member' END WHERE "app_role" IS NULL;
