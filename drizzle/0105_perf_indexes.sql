CREATE INDEX IF NOT EXISTS "call_records_org_to_last10_idx" ON "call_records" USING btree ("organization_id",right(regexp_replace("to_number", '[^0-9]', '', 'g'), 10));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "call_records_org_from_last10_idx" ON "call_records" USING btree ("organization_id",right(regexp_replace("from_number", '[^0-9]', '', 'g'), 10));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lead_tasks_lead_id_idx" ON "lead_tasks" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lead_tasks_org_assignee_done_idx" ON "lead_tasks" USING btree ("organization_id","assignee_id","done");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scraper_signals_org_idx" ON "scraper_signals" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scraper_signals_assignment_idx" ON "scraper_signals" USING btree ("assignment_id");