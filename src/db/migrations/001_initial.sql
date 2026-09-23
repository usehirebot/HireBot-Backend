-- Run with: psql $DATABASE_URL -f src/db/migrations/001_initial.sql

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── Users ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  clerk_user_id     TEXT        UNIQUE NOT NULL,
  email             TEXT        NOT NULL,
  status            TEXT        NOT NULL DEFAULT 'active',   -- active | blocked | suspended
  blocked_reason    TEXT,
  blocked_by        UUID        REFERENCES users(id),
  blocked_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Sessions (refresh tokens, revocable per device) ───────────────────────────
CREATE TABLE IF NOT EXISTS sessions (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token_hash  TEXT        NOT NULL,
  device_label        TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at          TIMESTAMPTZ NOT NULL,
  revoked_at          TIMESTAMPTZ
);

-- ── Billing ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS subscriptions (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stripe_customer_id      TEXT,
  stripe_subscription_id  TEXT,
  status                  TEXT        NOT NULL DEFAULT 'trialing',  -- trialing | active | past_due | canceled
  plan                    TEXT        NOT NULL DEFAULT 'pro_monthly', -- pro_monthly | pro_annual
  trial_ends_at           TIMESTAMPTZ,
  current_period_end      TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Usage ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS usage_events (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type       TEXT        NOT NULL,               -- e.g. 'explanation_requested'
  idempotency_key  TEXT        UNIQUE NOT NULL,
  metadata         JSONB       NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS usage_counters (
  user_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period_start TIMESTAMPTZ NOT NULL,
  period_end   TIMESTAMPTZ NOT NULL,
  count        INT         NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, period_start)
);

-- ── Indexes ───────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_users_clerk_id     ON users(clerk_user_id);
CREATE INDEX IF NOT EXISTS idx_users_email        ON users(email);
CREATE INDEX IF NOT EXISTS idx_sessions_user      ON sessions(user_id, revoked_at);
CREATE INDEX IF NOT EXISTS idx_sessions_hash      ON sessions(refresh_token_hash);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe ON subscriptions(stripe_subscription_id);
CREATE INDEX IF NOT EXISTS idx_usage_events_user  ON usage_events(user_id, created_at);
