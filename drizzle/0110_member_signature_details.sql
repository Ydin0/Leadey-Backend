CREATE TABLE IF NOT EXISTS "member_signature_details" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"title" text,
	"signature_name" text,
	"signature_email" text,
	"signature_phone" text,
	"signature_company" text,
	"signature_fields" jsonb,
	"default_signature_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "member_signature_details" ADD CONSTRAINT "member_signature_details_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "member_signature_details_org_user_uq" ON "member_signature_details" USING btree ("organization_id","user_id");--> statement-breakpoint
-- Backfill: seed each user's EXISTING signature settings into their home org so
-- nothing is lost. Other orgs start blank (fresh per-org details).
INSERT INTO "member_signature_details" ("id", "organization_id", "user_id", "title", "signature_name", "signature_email", "signature_phone", "signature_company", "signature_fields", "default_signature_id")
SELECT 'msig_' || u."id", u."organization_id", u."id", u."title", u."signature_name", u."signature_email", u."signature_phone", u."signature_company", u."signature_fields", u."default_signature_id"
FROM "users" u
WHERE u."organization_id" IS NOT NULL
  AND (u."title" IS NOT NULL OR u."signature_name" IS NOT NULL OR u."signature_email" IS NOT NULL OR u."signature_phone" IS NOT NULL OR u."signature_company" IS NOT NULL OR u."signature_fields" IS NOT NULL OR u."default_signature_id" IS NOT NULL)
ON CONFLICT ("organization_id", "user_id") DO NOTHING;
