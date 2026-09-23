-- Run with: psql $DATABASE_URL -f src/db/migrations/003_session_credits.sql
--
-- Product pivot: no free trial, no recurring subscription. Users buy a pack
-- of prepaid sessions (₹100 for 1, ₹300 for 5) and explicitly start one at
-- a time; access is hard-locked once the balance hits zero. The old
-- subscription-period model (status/plan/trial_ends_at/current_period_end)
-- no longer applies — only the users/subscriptions row it was already
-- structured around, no other feature reads these columns yet.
--
-- Written to be replayable: the migration runner (scripts/migrate.ts)
-- applies every file in this directory on every run, so — like 001 and
-- 002 — this one has to tolerate being run again after it already
-- succeeded once.

ALTER TABLE IF EXISTS subscriptions RENAME TO session_credits;

ALTER TABLE session_credits
  DROP COLUMN IF EXISTS status,
  DROP COLUMN IF EXISTS plan,
  DROP COLUMN IF EXISTS trial_ends_at,
  DROP COLUMN IF EXISTS current_period_end,
  DROP COLUMN IF EXISTS stripe_subscription_id,
  ADD COLUMN IF NOT EXISTS balance INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS active_session_started_at TIMESTAMPTZ;

-- The old subscriptions table allowed (in principle) more than one row per
-- user; a credit balance is inherently 1:1 with a user, and auth.ts's
-- upsert-on-signup relies on this being enforced (ON CONFLICT (user_id)).
-- No IF NOT EXISTS form for ADD CONSTRAINT, so guard it explicitly.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'session_credits_user_id_key'
  ) THEN
    ALTER TABLE session_credits ADD CONSTRAINT session_credits_user_id_key UNIQUE (user_id);
  END IF;
END $$;

-- Durable purchase record — support/audit trail, and the idempotency guard
-- against crediting the same Checkout session twice (on top of the
-- stripe_events table, which guards Stripe's own webhook redelivery rather
-- than "did we already apply this specific purchase").
CREATE TABLE IF NOT EXISTS session_purchases (
  id                          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stripe_checkout_session_id  TEXT        NOT NULL UNIQUE,
  pack_size                   INT         NOT NULL,        -- 1 or 5
  amount_paid_minor           INT         NOT NULL,        -- paise (10000 = ₹100)
  currency                    TEXT        NOT NULL DEFAULT 'inr',
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_session_purchases_user ON session_purchases(user_id);

-- Index names kept from the old table (queries filter by user_id and by
-- stripe_customer_id same as before) — rename purely cosmetic.
ALTER INDEX IF EXISTS idx_subscriptions_user RENAME TO idx_session_credits_user;
ALTER INDEX IF EXISTS idx_subscriptions_stripe RENAME TO idx_session_credits_stripe;
