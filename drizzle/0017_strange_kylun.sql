ALTER TABLE "regulatory_bundles" ADD COLUMN "business_registration_authority" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "regulatory_bundles" ADD COLUMN "business_website" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "regulatory_bundles" ADD COLUMN "business_classification" text DEFAULT 'INDEPENDENT_SOFTWARE_VENDOR' NOT NULL;--> statement-breakpoint
ALTER TABLE "regulatory_bundles" ADD COLUMN "address_street1" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "regulatory_bundles" ADD COLUMN "address_street2" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "regulatory_bundles" ADD COLUMN "address_city" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "regulatory_bundles" ADD COLUMN "address_subdivision" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "regulatory_bundles" ADD COLUMN "address_postal_code" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "regulatory_bundles" ADD COLUMN "representative_first_name" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "regulatory_bundles" ADD COLUMN "representative_last_name" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "regulatory_bundles" ADD COLUMN "representative_email" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "regulatory_bundles" ADD COLUMN "representative_phone" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "regulatory_bundles" ADD COLUMN "twilio_address_sid" text;--> statement-breakpoint
ALTER TABLE "regulatory_bundles" ADD COLUMN "twilio_individual_end_user_sid" text;