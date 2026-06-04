ALTER TABLE "call_dispositions" ADD COLUMN "lead_status" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "do_not_call" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Backfill system dispositions with their campaign-status mapping + new actions/hotkeys
UPDATE "call_dispositions" SET "lead_status" = 'contacted', "funnel_action" = 'advance', "hotkey" = '1', "sort_order" = 1 WHERE "slug" = 'connected' AND "is_system" = true;--> statement-breakpoint
UPDATE "call_dispositions" SET "lead_status" = 'callback', "funnel_action" = 'retry', "hotkey" = '4', "sort_order" = 4 WHERE "slug" = 'callback-requested' AND "is_system" = true;--> statement-breakpoint
UPDATE "call_dispositions" SET "lead_status" = 'no_answer', "funnel_action" = 'retry', "hotkey" = '5', "sort_order" = 5 WHERE "slug" = 'voicemail' AND "is_system" = true;--> statement-breakpoint
UPDATE "call_dispositions" SET "lead_status" = 'no_answer', "funnel_action" = 'retry', "hotkey" = '6', "sort_order" = 6 WHERE "slug" = 'no-answer' AND "is_system" = true;--> statement-breakpoint
UPDATE "call_dispositions" SET "lead_status" = 'no_answer', "funnel_action" = 'retry', "hotkey" = '7', "sort_order" = 7 WHERE "slug" = 'gatekeeper' AND "is_system" = true;--> statement-breakpoint
UPDATE "call_dispositions" SET "lead_status" = 'not_interested', "funnel_action" = 'none', "hotkey" = '8', "sort_order" = 8 WHERE "slug" = 'not-interested' AND "is_system" = true;--> statement-breakpoint
UPDATE "call_dispositions" SET "lead_status" = 'bounced', "funnel_action" = 'none', "hotkey" = '9', "sort_order" = 9 WHERE "slug" = 'wrong-number' AND "is_system" = true;--> statement-breakpoint
UPDATE "call_dispositions" SET "lead_status" = 'bounced', "funnel_action" = 'none', "hotkey" = '0', "sort_order" = 10 WHERE "slug" = 'bad-number' AND "is_system" = true;--> statement-breakpoint
UPDATE "call_dispositions" SET "lead_status" = NULL, "funnel_action" = 'dnc', "hotkey" = NULL, "sort_order" = 11 WHERE "slug" = 'do-not-call' AND "is_system" = true;--> statement-breakpoint
-- Add the two new positive dispositions for every org that already has system dispositions
INSERT INTO "call_dispositions" ("id","organization_id","slug","label","outcome_bucket","funnel_action","lead_status","retry_after_days","sort_order","hotkey","color","is_system")
SELECT 'disp_' || replace(gen_random_uuid()::text,'-',''), o."organization_id", 'interested', 'Interested', 'contacted', 'advance', 'interested', NULL, 2, '2', NULL, true
FROM (SELECT DISTINCT "organization_id" FROM "call_dispositions" WHERE "is_system" = true) o
WHERE NOT EXISTS (SELECT 1 FROM "call_dispositions" c WHERE c."organization_id" = o."organization_id" AND c."slug" = 'interested');--> statement-breakpoint
INSERT INTO "call_dispositions" ("id","organization_id","slug","label","outcome_bucket","funnel_action","lead_status","retry_after_days","sort_order","hotkey","color","is_system")
SELECT 'disp_' || replace(gen_random_uuid()::text,'-',''), o."organization_id", 'booked-meeting', 'Booked Meeting', 'contacted', 'advance', 'qualified', NULL, 3, '3', NULL, true
FROM (SELECT DISTINCT "organization_id" FROM "call_dispositions" WHERE "is_system" = true) o
WHERE NOT EXISTS (SELECT 1 FROM "call_dispositions" c WHERE c."organization_id" = o."organization_id" AND c."slug" = 'booked-meeting');