CREATE TABLE "dismissed_potential_contacts" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"handle_key" text NOT NULL,
	"dismissed_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dismissed_potential_contacts_organization_id_handle_key_unique" UNIQUE("organization_id","handle_key")
);
--> statement-breakpoint
ALTER TABLE "dismissed_potential_contacts" ADD CONSTRAINT "dismissed_potential_contacts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;