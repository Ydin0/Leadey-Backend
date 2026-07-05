CREATE TABLE "whatsapp_senders" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"line_id" text,
	"number" text NOT NULL,
	"sender_sid" text NOT NULL,
	"waba_id" text NOT NULL,
	"status" text DEFAULT 'creating' NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sms_messages" ADD COLUMN "channel" text DEFAULT 'sms' NOT NULL;--> statement-breakpoint
ALTER TABLE "whatsapp_senders" ADD CONSTRAINT "whatsapp_senders_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_senders" ADD CONSTRAINT "whatsapp_senders_line_id_phone_lines_id_fk" FOREIGN KEY ("line_id") REFERENCES "public"."phone_lines"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "whatsapp_senders_org_idx" ON "whatsapp_senders" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "whatsapp_senders_number_uq" ON "whatsapp_senders" USING btree ("number");