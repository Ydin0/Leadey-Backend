CREATE TABLE "calendly_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"email" text DEFAULT '' NOT NULL,
	"scheduling_url" text,
	"calendly_user_uri" text,
	"calendly_org_uri" text,
	"encrypted_tokens" text,
	"webhook_subscription_uri" text,
	"webhook_signing_key" text,
	"status" text DEFAULT 'active' NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendly_accounts_org_user_uq" UNIQUE("organization_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "calendly_meetings" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text,
	"calendly_event_uri" text NOT NULL,
	"invitee_email" text DEFAULT '' NOT NULL,
	"invitee_name" text DEFAULT '' NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"start_time" timestamp with time zone,
	"end_time" timestamp with time zone,
	"join_url" text,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"lead_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendly_meetings_event_uq" UNIQUE("calendly_event_uri")
);
--> statement-breakpoint
ALTER TABLE "calendly_accounts" ADD CONSTRAINT "calendly_accounts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendly_meetings" ADD CONSTRAINT "calendly_meetings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "calendly_accounts_org_user_idx" ON "calendly_accounts" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE INDEX "calendly_meetings_org_idx" ON "calendly_meetings" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "calendly_meetings_lead_idx" ON "calendly_meetings" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "calendly_meetings_email_idx" ON "calendly_meetings" USING btree ("invitee_email");