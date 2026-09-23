-- Run with: psql $DATABASE_URL -f src/db/migrations/005_session_credits_unique_fix.sql
--
-- 003_session_credits.sql was supposed to add this constraint (auth.ts's
-- signup upsert relies on ON CONFLICT (user_id)) but it never actually
-- took effect on the live database, even though 003 is recorded as
-- applied in schema_migrations — every other change in that file landed,
-- just not this one. Re-adding it here rather than digging into why,
-- since the guard makes this safe to run regardless of the current state.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'session_credits_user_id_key'
  ) THEN
    ALTER TABLE session_credits ADD CONSTRAINT session_credits_user_id_key UNIQUE (user_id);
  END IF;
END $$;
