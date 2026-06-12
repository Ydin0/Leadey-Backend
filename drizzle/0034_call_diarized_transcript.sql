ALTER TABLE "call_records" ADD COLUMN "transcript_segments" jsonb;--> statement-breakpoint
ALTER TABLE "call_records" ADD COLUMN "speakers" jsonb;--> statement-breakpoint
ALTER TABLE "call_records" ADD COLUMN "summary_structured" jsonb;