ALTER TABLE "funnels" ADD COLUMN "visibility" text DEFAULT 'private' NOT NULL;--> statement-breakpoint
ALTER TABLE "funnels" ADD COLUMN "config" jsonb DEFAULT '{}'::jsonb NOT NULL;