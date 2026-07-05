ALTER TABLE "leads" ADD COLUMN "extra_emails" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "extra_phones" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "master_contacts" ADD COLUMN "extra_emails" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "master_contacts" ADD COLUMN "extra_phones" jsonb DEFAULT '[]'::jsonb NOT NULL;