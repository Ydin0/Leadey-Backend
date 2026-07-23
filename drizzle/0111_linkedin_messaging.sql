CREATE TABLE IF NOT EXISTS "linkedin_invitations" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"account_id" text,
	"unipile_account_id" text NOT NULL,
	"user_id" text,
	"lead_id" text,
	"provider_id" text NOT NULL,
	"public_identifier" text,
	"name" text,
	"message" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted_at" timestamp with time zone,
	"last_checked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "linkedin_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"account_id" text,
	"unipile_account_id" text,
	"lead_id" text,
	"provider_id" text NOT NULL,
	"chat_id" text,
	"unipile_message_id" text,
	"direction" text NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"sender_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "linkedin_invitations" ADD CONSTRAINT "linkedin_invitations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "linkedin_messages" ADD CONSTRAINT "linkedin_messages_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "linkedin_invitations_org_status_idx" ON "linkedin_invitations" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "linkedin_invitations_org_lead_idx" ON "linkedin_invitations" USING btree ("organization_id","lead_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "linkedin_invitations_acct_provider_uq" ON "linkedin_invitations" USING btree ("unipile_account_id","provider_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "linkedin_messages_org_lead_idx" ON "linkedin_messages" USING btree ("organization_id","lead_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "linkedin_messages_org_provider_idx" ON "linkedin_messages" USING btree ("organization_id","provider_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "linkedin_messages_org_created_idx" ON "linkedin_messages" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "linkedin_messages_unipile_msg_uq" ON "linkedin_messages" USING btree ("unipile_message_id");