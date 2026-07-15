CREATE TABLE "meeting_dispositions" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"meeting_key" text NOT NULL,
	"disposition" text NOT NULL,
	"marked_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "meeting_dispositions" ADD CONSTRAINT "meeting_dispositions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_dispositions_org_key_uq" ON "meeting_dispositions" USING btree ("organization_id","meeting_key");