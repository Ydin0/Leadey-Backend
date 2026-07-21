CREATE TABLE IF NOT EXISTS "inbox_read_state" (
	"user_id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"calls_seen_at" timestamp with time zone,
	"messages_seen_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "inbox_read_state" ADD CONSTRAINT "inbox_read_state_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;