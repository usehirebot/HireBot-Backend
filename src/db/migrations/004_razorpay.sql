-- Run with: psql $DATABASE_URL -f src/db/migrations/004_razorpay.sql
--
-- Provider swap: Stripe requires a registered company for Indian accounts,
-- which ruled it out. Razorpay's Payment Links don't need a pre-created
-- customer object (unlike Stripe Checkout) — customer details are passed
-- inline per payment link — so stripe_customer_id has no Razorpay
-- equivalent and nothing writes it anymore. stripe_events also goes: it
-- existed purely to dedup Stripe's webhook redelivery, and
-- session_purchases.payment_reference (renamed below) already provides an
-- equivalent, sufficient guard against crediting the same purchase twice.

ALTER TABLE session_credits DROP COLUMN IF EXISTS stripe_customer_id;

ALTER TABLE session_purchases RENAME COLUMN stripe_checkout_session_id TO payment_reference;

DROP TABLE IF EXISTS stripe_events;
