ALTER TABLE "dialer_queue_items" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "call_records_org_called_at" ON "call_records" USING btree ("organization_id","called_at");--> statement-breakpoint
CREATE INDEX "call_records_lead_id" ON "call_records" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "dialer_queue_items_lead_status" ON "dialer_queue_items" USING btree ("lead_id","status");