ALTER TABLE "settings" DROP CONSTRAINT "settings_key_unique";--> statement-breakpoint
ALTER TABLE "funnels" ADD COLUMN "organization_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "organization_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_org_key" UNIQUE("organization_id","key");