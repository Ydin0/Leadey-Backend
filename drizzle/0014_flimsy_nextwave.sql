CREATE TABLE "master_companies" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"domain" text,
	"linkedin_url" text,
	"industry" text,
	"employee_count" integer,
	"revenue" bigint,
	"funding" bigint,
	"funding_stage" text,
	"country" text,
	"city" text,
	"logo" text,
	"description" text,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "master_companies_organization_id_domain_unique" UNIQUE("organization_id","domain")
);
--> statement-breakpoint
CREATE TABLE "master_contacts" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"linkedin_url" text,
	"first_name" text,
	"last_name" text,
	"full_name" text,
	"headline" text,
	"profile_image_url" text,
	"current_title" text,
	"current_company" text,
	"master_company_id" text,
	"location" text,
	"email" text,
	"email_status" text,
	"phone" text,
	"phone_status" text,
	"enrichment_status" text DEFAULT 'none' NOT NULL,
	"last_discovered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "master_contacts_organization_id_linkedin_url_unique" UNIQUE("organization_id","linkedin_url")
);
--> statement-breakpoint
ALTER TABLE "master_companies" ADD CONSTRAINT "master_companies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "master_contacts" ADD CONSTRAINT "master_contacts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "master_contacts" ADD CONSTRAINT "master_contacts_master_company_id_master_companies_id_fk" FOREIGN KEY ("master_company_id") REFERENCES "public"."master_companies"("id") ON DELETE set null ON UPDATE no action;