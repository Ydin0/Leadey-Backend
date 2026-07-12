CREATE TABLE "linkedin_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"unipile_account_id" text NOT NULL,
	"name" text,
	"public_identifier" text,
	"profile_url" text,
	"status" text DEFAULT 'connected' NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "linkedin_accounts" ADD CONSTRAINT "linkedin_accounts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "linkedin_accounts_org_idx" ON "linkedin_accounts" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "linkedin_accounts_org_user_idx" ON "linkedin_accounts" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "linkedin_accounts_unipile_uq" ON "linkedin_accounts" USING btree ("unipile_account_id");