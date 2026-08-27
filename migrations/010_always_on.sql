-- Always-On subscription (₹999/mo, features-only: daily scheduler + unlimited staff).
-- Premium access = wallet.unlimited OR always_on_until > now(). Razorpay Subscriptions
-- drive always_on_until via the checkout confirm + subscription.* webhooks. Transfers
-- are still metered on top; this gates FEATURES only, for every tenant (no grandfathering).
ALTER TABLE wallets ADD COLUMN IF NOT EXISTS always_on_until      TIMESTAMPTZ;
ALTER TABLE wallets ADD COLUMN IF NOT EXISTS rzp_subscription_id  TEXT;
ALTER TABLE wallets ADD COLUMN IF NOT EXISTS rzp_customer_id      TEXT;
ALTER TABLE wallets ADD COLUMN IF NOT EXISTS subscription_status  TEXT;
