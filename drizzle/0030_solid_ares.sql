ALTER TABLE "imports" ADD COLUMN "rolled_back_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "import_id" text;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_import_id_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."imports"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "leads_import_id_idx" ON "leads" ("import_id");--> statement-breakpoint
-- Backfill: link existing leads to the import that created them, read from the
-- "imported" lead_event metadata where importId was already recorded.
UPDATE "leads" SET "import_id" = sub.import_id
FROM (
  SELECT le."lead_id" AS lead_id, le."meta"->>'importId' AS import_id
  FROM "lead_events" le
  WHERE le."type" = 'imported' AND le."meta"->>'importId' IS NOT NULL
) AS sub
WHERE "leads"."id" = sub.lead_id
  AND "leads"."import_id" IS NULL
  AND sub.import_id IN (SELECT "id" FROM "imports");