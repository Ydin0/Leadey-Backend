ALTER TABLE "call_records" ADD COLUMN "outcome" text;--> statement-breakpoint
ALTER TABLE "call_records" ADD COLUMN "outcome_manual" boolean DEFAULT false NOT NULL;