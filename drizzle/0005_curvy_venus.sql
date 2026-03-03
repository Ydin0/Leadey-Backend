CREATE TABLE "call_records" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"line_id" text,
	"twilio_call_sid" text,
	"direction" text NOT NULL,
	"from_number" text NOT NULL,
	"to_number" text NOT NULL,
	"contact_name" text,
	"company_name" text,
	"duration" integer DEFAULT 0 NOT NULL,
	"disposition" text DEFAULT 'completed' NOT NULL,
	"called_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "phone_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"twilio_sid" text NOT NULL,
	"number" text NOT NULL,
	"friendly_name" text NOT NULL,
	"country" text NOT NULL,
	"country_code" text NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"assigned_to" text,
	"assigned_to_name" text,
	"monthly_cost" real DEFAULT 1.15 NOT NULL,
	"voicemail_greeting" text DEFAULT '' NOT NULL,
	"call_forwarding_number" text DEFAULT '' NOT NULL,
	"call_recording_enabled" boolean DEFAULT false NOT NULL,
	"bundle_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "regulatory_bundles" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"country" text NOT NULL,
	"country_code" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"business_name" text NOT NULL,
	"business_address" text DEFAULT '' NOT NULL,
	"identity_document_name" text DEFAULT '' NOT NULL,
	"twilio_bundle_sid" text,
	"twilio_end_user_sid" text,
	"twilio_document_sid" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "call_records" ADD CONSTRAINT "call_records_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_records" ADD CONSTRAINT "call_records_line_id_phone_lines_id_fk" FOREIGN KEY ("line_id") REFERENCES "public"."phone_lines"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_lines" ADD CONSTRAINT "phone_lines_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regulatory_bundles" ADD CONSTRAINT "regulatory_bundles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;