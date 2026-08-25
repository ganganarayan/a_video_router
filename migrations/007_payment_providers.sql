-- Multi-gateway schema (Razorpay live now; Easebuzz + PhonePe adapters added when
-- those accounts activate). Additive & back-compatible: the existing Razorpay
-- columns stay and are mirrored into provider-neutral columns so all three share
-- the same wallet-credit machinery.

ALTER TABLE payments ADD COLUMN IF NOT EXISTS provider            TEXT NOT NULL DEFAULT 'razorpay';
ALTER TABLE payments ADD COLUMN IF NOT EXISTS merchant_txn_id     TEXT;  -- our own id (txnid / merchantOrderId)
ALTER TABLE payments ADD COLUMN IF NOT EXISTS provider_order_id   TEXT;  -- gateway order / access id
ALTER TABLE payments ADD COLUMN IF NOT EXISTS provider_payment_id TEXT;  -- gateway payment id

-- Backfill the generic columns from existing Razorpay rows.
UPDATE payments SET provider_order_id   = razorpay_order_id   WHERE provider_order_id   IS NULL AND razorpay_order_id   IS NOT NULL;
UPDATE payments SET provider_payment_id = razorpay_payment_id WHERE provider_payment_id IS NULL AND razorpay_payment_id IS NOT NULL;
UPDATE payments SET merchant_txn_id     = razorpay_order_id   WHERE merchant_txn_id     IS NULL AND razorpay_order_id   IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_merchant_txn ON payments(merchant_txn_id) WHERE merchant_txn_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payments_provider_order ON payments(provider_order_id);

-- Active gateway (razorpay | easebuzz | phonepe). Credentials for every provider
-- live in app_config, set/rotated by the super admin from /admin (stored encrypted):
--   razorpay_key_id / razorpay_key_secret / razorpay_webhook_secret          (live)
--   easebuzz_key / easebuzz_salt / easebuzz_env                              (pending activation)
--   phonepe_client_id / phonepe_client_secret / phonepe_client_version /
--   phonepe_env / phonepe_webhook_username / phonepe_webhook_password        (pending activation)
INSERT INTO app_config (key, value) VALUES ('payment_provider', 'razorpay')
ON CONFLICT (key) DO NOTHING;
