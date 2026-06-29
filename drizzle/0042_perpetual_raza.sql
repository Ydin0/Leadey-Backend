ALTER TABLE "lead_tasks" ALTER COLUMN "funnel_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "lead_tasks" ALTER COLUMN "lead_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "lead_tasks" ADD COLUMN "category" text DEFAULT 'follow_up' NOT NULL;