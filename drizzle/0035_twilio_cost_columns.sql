ALTER TABLE "call_records" ADD COLUMN "twilio_price" real;--> statement-breakpoint
ALTER TABLE "call_records" ADD COLUMN "twilio_price_unit" text;--> statement-breakpoint
ALTER TABLE "call_records" ADD COLUMN "twilio_price_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sms_messages" ADD COLUMN "twilio_price" real;--> statement-breakpoint
ALTER TABLE "sms_messages" ADD COLUMN "twilio_price_unit" text;