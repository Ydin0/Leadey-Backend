CREATE TABLE "phone_lookups" (
	"phone_e164" text PRIMARY KEY NOT NULL,
	"line_type" text,
	"carrier" text,
	"sms_capable" boolean DEFAULT true NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "phone_lookups_checked_at_idx" ON "phone_lookups" USING btree ("checked_at");