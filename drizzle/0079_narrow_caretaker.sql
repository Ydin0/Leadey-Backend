CREATE TABLE "email_thread_state" (
	"organization_id" text NOT NULL,
	"lead_id" text NOT NULL,
	"last_read_at" timestamp with time zone,
	"marked_unread" boolean DEFAULT false NOT NULL,
	"starred" boolean DEFAULT false NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"snoozed_until" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_thread_state_organization_id_lead_id_pk" PRIMARY KEY("organization_id","lead_id")
);
--> statement-breakpoint
ALTER TABLE "email_thread_state" ADD CONSTRAINT "email_thread_state_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
INSERT INTO "email_thread_state" ("organization_id", "lead_id", "last_read_at")
SELECT DISTINCT em."organization_id", em."lead_id", now()
FROM "email_messages" em
WHERE em."lead_id" IS NOT NULL
ON CONFLICT DO NOTHING;
