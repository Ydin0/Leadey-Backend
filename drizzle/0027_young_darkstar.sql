ALTER TABLE "dialer_sessions" ALTER COLUMN "funnel_step_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "dialer_sessions" ADD COLUMN "funnel_id" text;--> statement-breakpoint
ALTER TABLE "dialer_sessions" ADD CONSTRAINT "dialer_sessions_funnel_id_funnels_id_fk" FOREIGN KEY ("funnel_id") REFERENCES "public"."funnels"("id") ON DELETE cascade ON UPDATE no action;