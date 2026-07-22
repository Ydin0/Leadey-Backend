ALTER TABLE "scheduled_meetings" ADD COLUMN IF NOT EXISTS "booked_by_user_id" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scheduled_meetings_org_booked_idx" ON "scheduled_meetings" USING btree ("organization_id","booked_by_user_id");--> statement-breakpoint
UPDATE "scheduled_meetings" SET "booked_by_user_id" = COALESCE("created_by", "host_user_id") WHERE "booked_by_user_id" IS NULL;
