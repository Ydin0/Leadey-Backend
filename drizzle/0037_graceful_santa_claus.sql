ALTER TABLE "scraper_contacts" ADD COLUMN "searched_company_url" text;--> statement-breakpoint
-- Backfill the searched company URL for existing discovered contacts from the
-- discovery query stored in each Apify result's _meta. Matches the contact's
-- current-company name to the best searched-company slug within its own batch,
-- so contacts reliably map back to the companies they were searched under.
UPDATE "scraper_contacts" sc
SET "searched_company_url" = best.url
FROM (
  WITH c AS (
    SELECT id, lower(regexp_replace(coalesce(company_name,''),'[^a-zA-Z0-9]','','g')) AS name_norm, raw_data
    FROM "scraper_contacts"
    WHERE raw_data ? '_meta' AND raw_data->'_meta'->'query' ? 'currentCompanies'
  ),
  scored AS (
    SELECT c.id, cc.url,
      CASE
        WHEN cc.slug_norm = c.name_norm THEN 1000
        WHEN length(c.name_norm) >= 2 AND cc.slug_norm LIKE '%'||c.name_norm||'%' THEN length(c.name_norm)
        WHEN length(cc.slug_norm) >= 2 AND c.name_norm LIKE '%'||cc.slug_norm||'%' THEN length(cc.slug_norm)
        ELSE 0
      END AS score
    FROM c
    CROSS JOIN LATERAL (
      SELECT url, lower(regexp_replace(regexp_replace(url,'^.*/company/([^/?#]+).*$','\1'),'[^a-zA-Z0-9]','','g')) AS slug_norm
      FROM jsonb_array_elements_text(c.raw_data->'_meta'->'query'->'currentCompanies') AS url
    ) cc
  )
  SELECT DISTINCT ON (id) id, url FROM scored WHERE score > 0 ORDER BY id, score DESC
) best
WHERE sc.id = best.id;