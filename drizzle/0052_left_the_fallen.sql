DROP INDEX "master_contacts_org_email_key";--> statement-breakpoint
DROP INDEX "master_contacts_org_linkedin_key";--> statement-breakpoint
CREATE UNIQUE INDEX "master_contacts_org_email_key_unique" ON "master_contacts" USING btree ("organization_id","email_key") WHERE email_key IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "master_contacts_org_linkedin_key_unique" ON "master_contacts" USING btree ("organization_id","linkedin_key") WHERE linkedin_key IS NOT NULL;