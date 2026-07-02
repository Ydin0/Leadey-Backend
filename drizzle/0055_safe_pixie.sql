CREATE INDEX "funnels_organization_id_idx" ON "funnels" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "lead_events_timestamp_idx" ON "lead_events" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX "leads_email_lower_idx" ON "leads" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "leads_phone_digits_idx" ON "leads" USING btree (regexp_replace("phone", '[^0-9]', '', 'g'));--> statement-breakpoint
CREATE INDEX "leads_company_lower_idx" ON "leads" USING btree (lower("company"));