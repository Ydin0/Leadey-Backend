ALTER TABLE "booking_page_members" ADD COLUMN "priority" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "booking_pages" ADD COLUMN "owner_priority" integer DEFAULT 3 NOT NULL;