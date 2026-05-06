CREATE TABLE "funnel_members" (
	"id" text PRIMARY KEY NOT NULL,
	"funnel_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'contributor' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "funnel_members_funnel_id_user_id_unique" UNIQUE("funnel_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "funnel_members" ADD CONSTRAINT "funnel_members_funnel_id_funnels_id_fk" FOREIGN KEY ("funnel_id") REFERENCES "public"."funnels"("id") ON DELETE cascade ON UPDATE no action;