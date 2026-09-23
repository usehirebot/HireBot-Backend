-- Run with: psql $DATABASE_URL -f src/db/migrations/002_billing.sql

-- Dedup table for Stripe webhook delivery retries. Stripe redelivers an
-- event if it doesn't get a fast 200, so the webhook handler must be able
-- to recognize "I already applied this one" — see billing.ts.
CREATE TABLE IF NOT EXISTS stripe_events (
  id           TEXT        PRIMARY KEY,  -- Stripe event.id
  type         TEXT        NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
