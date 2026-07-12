CREATE TABLE "booking_page_members" (
	"id" text PRIMARY KEY NOT NULL,
	"booking_page_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "booking_page_members_uq" UNIQUE("booking_page_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "booking_pages" ADD COLUMN "is_public" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "booking_pages" ADD COLUMN "public_slug" text;--> statement-breakpoint
ALTER TABLE "booking_page_members" ADD CONSTRAINT "booking_page_members_booking_page_id_booking_pages_id_fk" FOREIGN KEY ("booking_page_id") REFERENCES "public"."booking_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "booking_page_members_page_idx" ON "booking_page_members" USING btree ("booking_page_id");--> statement-breakpoint
CREATE UNIQUE INDEX "booking_pages_slug_uq" ON "booking_pages" USING btree ("public_slug");