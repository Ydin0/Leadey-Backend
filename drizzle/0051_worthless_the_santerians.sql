ALTER TABLE "leads" ADD COLUMN "master_contact_id" text;--> statement-breakpoint
ALTER TABLE "master_contacts" ADD COLUMN "email_key" text;--> statement-breakpoint
ALTER TABLE "master_contacts" ADD COLUMN "phone_key" text;--> statement-breakpoint
ALTER TABLE "master_contacts" ADD COLUMN "linkedin_key" text;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_master_contact_id_master_contacts_id_fk" FOREIGN KEY ("master_contact_id") REFERENCES "public"."master_contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "leads_master_contact_id_idx" ON "leads" USING btree ("master_contact_id");--> statement-breakpoint
CREATE INDEX "leads_funnel_id_idx" ON "leads" USING btree ("funnel_id");--> statement-breakpoint
CREATE INDEX "master_contacts_org_email_key" ON "master_contacts" USING btree ("organization_id","email_key");--> statement-breakpoint
CREATE INDEX "master_contacts_org_phone_key" ON "master_contacts" USING btree ("organization_id","phone_key");--> statement-breakpoint
CREATE INDEX "master_contacts_org_linkedin_key" ON "master_contacts" USING btree ("organization_id","linkedin_key");