ALTER TABLE "leads" ADD COLUMN "master_company_id" text;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_master_company_id_master_companies_id_fk" FOREIGN KEY ("master_company_id") REFERENCES "public"."master_companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "call_records_org_to_digits_idx" ON "call_records" USING btree ("organization_id",regexp_replace("to_number", '[^0-9]', '', 'g'));--> statement-breakpoint
CREATE INDEX "call_records_org_from_digits_idx" ON "call_records" USING btree ("organization_id",regexp_replace("from_number", '[^0-9]', '', 'g'));--> statement-breakpoint
CREATE INDEX "email_messages_lead_created_idx" ON "email_messages" USING btree ("lead_id","created_at");--> statement-breakpoint
CREATE INDEX "lead_events_lead_id_ts_idx" ON "lead_events" USING btree ("lead_id","timestamp");--> statement-breakpoint
CREATE INDEX "leads_master_company_id_idx" ON "leads" USING btree ("master_company_id");--> statement-breakpoint
CREATE INDEX "master_companies_org_name_lower_idx" ON "master_companies" USING btree ("organization_id",lower("name"));--> statement-breakpoint
CREATE INDEX "sms_messages_lead_created_idx" ON "sms_messages" USING btree ("lead_id","created_at");