-- Trigram (pg_trgm) GIN indexes: make global search's ILIKE '%term%' scans
-- index-backed with zero query changes. Guarded so environments without the
-- pg_trgm extension skip gracefully instead of failing the boot migration.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_trgm') THEN
    RAISE NOTICE 'pg_trgm unavailable - skipping trigram search indexes';
    RETURN;
  END IF;
  EXECUTE 'CREATE EXTENSION IF NOT EXISTS pg_trgm';
  EXECUTE 'CREATE INDEX IF NOT EXISTS leads_name_trgm_idx ON leads USING gin (name gin_trgm_ops)';
  EXECUTE 'CREATE INDEX IF NOT EXISTS leads_company_trgm_idx ON leads USING gin (company gin_trgm_ops)';
  EXECUTE 'CREATE INDEX IF NOT EXISTS leads_email_trgm_idx ON leads USING gin (email gin_trgm_ops)';
  EXECUTE 'CREATE INDEX IF NOT EXISTS master_companies_name_trgm_idx ON master_companies USING gin (name gin_trgm_ops)';
  EXECUTE 'CREATE INDEX IF NOT EXISTS scraper_contacts_full_name_trgm_idx ON scraper_contacts USING gin (full_name gin_trgm_ops)';
END $$;
