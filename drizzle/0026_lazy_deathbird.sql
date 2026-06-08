CREATE TABLE "lead_field_definitions" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"field_type" text DEFAULT 'text' NOT NULL,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_required" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lead_field_definitions_organization_id_key_unique" UNIQUE("organization_id","key")
);
--> statement-breakpoint
CREATE TABLE "lead_field_values" (
	"id" text PRIMARY KEY NOT NULL,
	"lead_id" text NOT NULL,
	"field_definition_id" text NOT NULL,
	"value" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lead_field_values_lead_id_field_definition_id_unique" UNIQUE("lead_id","field_definition_id")
);
--> statement-breakpoint
ALTER TABLE "funnels" ADD COLUMN "webhook_token" text;--> statement-breakpoint
ALTER TABLE "funnels" ADD COLUMN "webhook_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "funnels" ADD COLUMN "webhook_field_map" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "lead_field_values" ADD CONSTRAINT "lead_field_values_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_field_values" ADD CONSTRAINT "lead_field_values_field_definition_id_lead_field_definitions_id_fk" FOREIGN KEY ("field_definition_id") REFERENCES "public"."lead_field_definitions"("id") ON DELETE cascade ON UPDATE no action;