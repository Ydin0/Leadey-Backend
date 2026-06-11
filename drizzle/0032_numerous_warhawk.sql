CREATE TABLE "email_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"email" text NOT NULL,
	"from_name" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"encrypted_tokens" text,
	"smtp_host" text,
	"smtp_port" integer,
	"smtp_secure" boolean DEFAULT true NOT NULL,
	"username" text,
	"encrypted_password" text,
	"imap_host" text,
	"imap_port" integer,
	"imap_secure" boolean DEFAULT true NOT NULL,
	"gmail_history_id" text,
	"graph_delta_link" text,
	"imap_uid" integer,
	"last_synced_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"account_id" text,
	"lead_id" text,
	"funnel_id" text,
	"user_id" text,
	"direction" text NOT NULL,
	"from_email" text NOT NULL,
	"from_name" text DEFAULT '' NOT NULL,
	"to_email" text DEFAULT '' NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"body_html" text DEFAULT '' NOT NULL,
	"body_text" text DEFAULT '' NOT NULL,
	"provider_message_id" text,
	"provider_thread_id" text,
	"message_id_header" text,
	"in_reply_to" text,
	"status" text DEFAULT 'sent' NOT NULL,
	"opened_at" timestamp with time zone,
	"open_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "email_accounts" ADD CONSTRAINT "email_accounts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "email_accounts_org_user_idx" ON "email_accounts" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE INDEX "email_messages_lead_idx" ON "email_messages" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "email_messages_thread_idx" ON "email_messages" USING btree ("provider_thread_id");--> statement-breakpoint
CREATE INDEX "email_messages_org_idx" ON "email_messages" USING btree ("organization_id");