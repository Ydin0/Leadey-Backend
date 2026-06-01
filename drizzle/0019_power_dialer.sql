CREATE TABLE "call_dispositions" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"slug" text NOT NULL,
	"label" text NOT NULL,
	"outcome_bucket" text NOT NULL,
	"funnel_action" text DEFAULT 'none' NOT NULL,
	"retry_after_days" integer,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"hotkey" text,
	"color" text,
	"is_system" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "call_dispositions_organization_id_slug_unique" UNIQUE("organization_id","slug")
);
--> statement-breakpoint
CREATE TABLE "dialer_queue_items" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"lead_id" text NOT NULL,
	"master_contact_id" text,
	"lead_phone" text NOT NULL,
	"position" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"disposition_id" text,
	"call_record_id" text,
	"notes" text,
	"called_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "dialer_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"funnel_step_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"total_leads" integer DEFAULT 0 NOT NULL,
	"completed_leads" integer DEFAULT 0 NOT NULL,
	"current_lead_index" integer DEFAULT 0 NOT NULL,
	"dispositions_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"filters_json" jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "funnel_disposition_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"funnel_step_id" text NOT NULL,
	"disposition_id" text NOT NULL,
	"funnel_action" text NOT NULL,
	"retry_after_days" integer,
	CONSTRAINT "funnel_disposition_rules_funnel_step_id_disposition_id_unique" UNIQUE("funnel_step_id","disposition_id")
);
--> statement-breakpoint
CREATE TABLE "voicemail_drops" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text,
	"name" text NOT NULL,
	"recording_url" text NOT NULL,
	"twilio_asset_sid" text,
	"duration_seconds" integer DEFAULT 0 NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "master_contacts" ADD COLUMN "do_not_call" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "master_contacts" ADD COLUMN "timezone" text;--> statement-breakpoint
ALTER TABLE "master_contacts" ADD COLUMN "last_called_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "master_contacts" ADD COLUMN "call_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "master_contacts" ADD COLUMN "best_time_start" text;--> statement-breakpoint
ALTER TABLE "master_contacts" ADD COLUMN "best_time_end" text;--> statement-breakpoint
ALTER TABLE "call_dispositions" ADD CONSTRAINT "call_dispositions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dialer_queue_items" ADD CONSTRAINT "dialer_queue_items_session_id_dialer_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."dialer_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dialer_queue_items" ADD CONSTRAINT "dialer_queue_items_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dialer_queue_items" ADD CONSTRAINT "dialer_queue_items_master_contact_id_master_contacts_id_fk" FOREIGN KEY ("master_contact_id") REFERENCES "public"."master_contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dialer_queue_items" ADD CONSTRAINT "dialer_queue_items_disposition_id_call_dispositions_id_fk" FOREIGN KEY ("disposition_id") REFERENCES "public"."call_dispositions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dialer_queue_items" ADD CONSTRAINT "dialer_queue_items_call_record_id_call_records_id_fk" FOREIGN KEY ("call_record_id") REFERENCES "public"."call_records"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dialer_sessions" ADD CONSTRAINT "dialer_sessions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dialer_sessions" ADD CONSTRAINT "dialer_sessions_funnel_step_id_funnel_steps_id_fk" FOREIGN KEY ("funnel_step_id") REFERENCES "public"."funnel_steps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funnel_disposition_rules" ADD CONSTRAINT "funnel_disposition_rules_funnel_step_id_funnel_steps_id_fk" FOREIGN KEY ("funnel_step_id") REFERENCES "public"."funnel_steps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funnel_disposition_rules" ADD CONSTRAINT "funnel_disposition_rules_disposition_id_call_dispositions_id_fk" FOREIGN KEY ("disposition_id") REFERENCES "public"."call_dispositions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voicemail_drops" ADD CONSTRAINT "voicemail_drops_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dialer_queue_items_session_position" ON "dialer_queue_items" USING btree ("session_id","position");--> statement-breakpoint
CREATE INDEX "dialer_queue_items_session_status" ON "dialer_queue_items" USING btree ("session_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "dialer_sessions_one_active_per_user" ON "dialer_sessions" USING btree ("user_id") WHERE status = 'active';