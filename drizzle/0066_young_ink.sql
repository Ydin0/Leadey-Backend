CREATE TABLE "pipeline_members" (
	"id" text PRIMARY KEY NOT NULL,
	"pipeline_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'contributor' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pipeline_members_pipeline_id_user_id_unique" UNIQUE("pipeline_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "pipeline_members" ADD CONSTRAINT "pipeline_members_pipeline_id_pipelines_id_fk" FOREIGN KEY ("pipeline_id") REFERENCES "public"."pipelines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pipeline_members_user_idx" ON "pipeline_members" USING btree ("user_id");