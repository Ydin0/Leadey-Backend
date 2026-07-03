CREATE TABLE "telephony_credit_transactions" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text,
	"kind" text NOT NULL,
	"amount_minor" integer NOT NULL,
	"balance_after_minor" integer NOT NULL,
	"invoice_id" text,
	"stripe_session_id" text,
	"period" text,
	"description" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "telephony_credit_balance_minor" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "telephony_buffer_pct" integer DEFAULT 20 NOT NULL;--> statement-breakpoint
ALTER TABLE "telephony_credit_transactions" ADD CONSTRAINT "telephony_credit_transactions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tel_credit_tx_org_created_idx" ON "telephony_credit_transactions" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "tel_credit_tx_org_period_idx" ON "telephony_credit_transactions" USING btree ("organization_id","period","kind");--> statement-breakpoint
CREATE INDEX "tel_credit_tx_invoice_idx" ON "telephony_credit_transactions" USING btree ("invoice_id");