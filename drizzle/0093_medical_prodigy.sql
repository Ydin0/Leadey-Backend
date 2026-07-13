CREATE TABLE "meeting_transcripts" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"lead_id" text,
	"meeting_id" text,
	"fetched_by_user_id" text,
	"title" text DEFAULT '' NOT NULL,
	"held_at" timestamp with time zone,
	"duration_sec" integer,
	"summary" jsonb,
	"transcript" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"recording_url" text,
	"embed_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "meeting_transcripts" ADD CONSTRAINT "meeting_transcripts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_transcripts_provider_ext_uq" ON "meeting_transcripts" USING btree ("organization_id","provider","external_id");--> statement-breakpoint
CREATE INDEX "meeting_transcripts_lead_idx" ON "meeting_transcripts" USING btree ("lead_id");