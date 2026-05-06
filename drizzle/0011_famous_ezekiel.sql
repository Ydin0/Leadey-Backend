CREATE TABLE "bundle_documents" (
	"id" text PRIMARY KEY NOT NULL,
	"bundle_id" text NOT NULL,
	"twilio_document_sid" text,
	"document_type" text NOT NULL,
	"file_name" text NOT NULL,
	"status" text DEFAULT 'uploaded' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "regulatory_bundles" ADD COLUMN "business_registration_number" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "regulatory_bundles" ADD COLUMN "business_type" text DEFAULT 'limited_company' NOT NULL;--> statement-breakpoint
ALTER TABLE "regulatory_bundles" ADD COLUMN "contact_email" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "regulatory_bundles" ADD COLUMN "contact_phone" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "bundle_documents" ADD CONSTRAINT "bundle_documents_bundle_id_regulatory_bundles_id_fk" FOREIGN KEY ("bundle_id") REFERENCES "public"."regulatory_bundles"("id") ON DELETE cascade ON UPDATE no action;