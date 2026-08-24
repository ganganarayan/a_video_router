-- ============================================================
-- 004 — Multi-tenancy + wallet billing (schema for ALL phases)
--
-- Additive & non-breaking: creates the new tables, adds tenant_id to the
-- existing domain tables, and migrates the current single-tenant data under
-- Tenant #1 ("applygita"). The old admin_users table and app_config keys are
-- LEFT INTACT so the current single-tenant code keeps working until the
-- multi-tenant code is layered on in later phases.
--
-- Roles mirror Assess360:
--   super_admin  -> platform owner (tenant_id NULL, sees all); slug "admin"
--   admin        -> tenant owner (has tenant_id); staff_permission NULL
--   staff        -> role 'admin' + tenant_id + staff_permission ('view'|'edit')
-- ============================================================

-- ---------- tenants ----------
CREATE TABLE IF NOT EXISTS tenants (
  id         SERIAL PRIMARY KEY,
  slug       TEXT UNIQUE NOT NULL,                 -- = username; "admin" reserved for super admin
  name       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'active',       -- 'active' | 'suspended'
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT tenants_status_chk CHECK (status IN ('active','suspended')),
  CONSTRAINT tenants_slug_not_admin CHECK (slug <> 'admin')
);

-- Tenant #1 — the user's own workspace; existing data is migrated under it.
INSERT INTO tenants (slug, name) VALUES ('applygita', 'Apply Gita')
ON CONFLICT (slug) DO NOTHING;

-- ---------- users (supersedes admin_users; old table kept for now) ----------
CREATE TABLE IF NOT EXISTS users (
  id                   SERIAL PRIMARY KEY,
  tenant_id            INTEGER REFERENCES tenants(id) ON DELETE CASCADE,  -- NULL = super admin
  email                TEXT UNIQUE NOT NULL,
  name                 TEXT NOT NULL DEFAULT '',
  password_hash        TEXT,                        -- NULL until set (first-login/reset)
  role                 TEXT NOT NULL DEFAULT 'admin',   -- 'super_admin' | 'admin'
  staff_permission     TEXT,                        -- NULL = owner/admin; 'view' | 'edit' = staff
  must_change_password BOOLEAN NOT NULL DEFAULT false,
  deleted_at           TIMESTAMPTZ,                 -- soft delete
  created_at           TIMESTAMPTZ DEFAULT now(),
  updated_at           TIMESTAMPTZ DEFAULT now(),
  last_login_at        TIMESTAMPTZ,
  CONSTRAINT users_role_chk CHECK (role IN ('super_admin','admin')),
  CONSTRAINT users_staff_chk CHECK (staff_permission IS NULL OR staff_permission IN ('view','edit')),
  -- super admin is global (no tenant); tenant users must have a tenant
  CONSTRAINT users_scope_chk CHECK (
    (role = 'super_admin' AND tenant_id IS NULL) OR
    (role = 'admin' AND tenant_id IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id);
CREATE INDEX IF NOT EXISTS idx_users_email  ON users(email);

-- Super admin — passwordless first login, forced to set a password on first login.
INSERT INTO users (tenant_id, email, name, role, password_hash, must_change_password)
VALUES (NULL, 'ganganarayan.rns@gmail.com', 'Ganga Narayan Das', 'super_admin', NULL, true)
ON CONFLICT (email) DO NOTHING;

-- Tenant #1 admin. Provisioned by the super admin (or via /reset) — no passwordless login.
INSERT INTO users (tenant_id, email, name, role, password_hash, must_change_password)
SELECT t.id, 'applygita@gmail.com', 'Apply Gita Admin', 'admin', NULL, true
FROM tenants t WHERE t.slug = 'applygita'
ON CONFLICT (email) DO NOTHING;

-- ---------- wallet (one per tenant) ----------
CREATE TABLE IF NOT EXISTS wallets (
  tenant_id        INTEGER PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  balance_paise    BIGINT NOT NULL DEFAULT 0,       -- may go negative (last upload always completes)
  free_upload_used BOOLEAN NOT NULL DEFAULT false,  -- one free upload (<=1 GiB) per tenant
  updated_at       TIMESTAMPTZ DEFAULT now()
);
INSERT INTO wallets (tenant_id)
SELECT id FROM tenants WHERE slug = 'applygita'
ON CONFLICT (tenant_id) DO NOTHING;

-- ---------- wallet ledger (append-only) ----------
CREATE TABLE IF NOT EXISTS wallet_txns (
  id                 SERIAL PRIMARY KEY,
  tenant_id          INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  type               TEXT NOT NULL,                 -- 'topup' | 'deduction' | 'adjustment'
  amount_paise       BIGINT NOT NULL,               -- signed: +topup / -deduction
  balance_after_paise BIGINT NOT NULL,
  units              INTEGER,                        -- for deductions: 1 or 2
  recording_id       INTEGER REFERENCES processed_recordings(id) ON DELETE SET NULL,
  payment_id         INTEGER,                        -- FK added after payments table below
  note               TEXT,
  created_at         TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT wallet_txns_type_chk CHECK (type IN ('topup','deduction','adjustment'))
);
CREATE INDEX IF NOT EXISTS idx_wallet_txns_tenant ON wallet_txns(tenant_id, created_at DESC);

-- ---------- payments (mirrors VidaPulse payments audit; Razorpay top-ups) ----------
CREATE TABLE IF NOT EXISTS payments (
  id                  SERIAL PRIMARY KEY,
  tenant_id           INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  razorpay_order_id   TEXT,
  razorpay_payment_id TEXT UNIQUE,
  base_paise          BIGINT NOT NULL,              -- wallet credit (>= min_topup_paise)
  gst_paise           BIGINT NOT NULL DEFAULT 0,    -- 18% of base
  fee_paise           BIGINT NOT NULL DEFAULT 0,    -- 2.5% gateway on (base+gst)
  total_paise         BIGINT NOT NULL,              -- what the tenant actually pays
  currency            TEXT NOT NULL DEFAULT 'INR',
  status              TEXT NOT NULL DEFAULT 'created', -- 'created' | 'paid' | 'failed'
  notes               JSONB,
  created_at          TIMESTAMPTZ DEFAULT now(),
  updated_at          TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT payments_status_chk CHECK (status IN ('created','paid','failed'))
);
CREATE INDEX IF NOT EXISTS idx_payments_tenant ON payments(tenant_id, created_at DESC);

-- wire the deferred FK from wallet_txns -> payments
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'wallet_txns_payment_fk'
  ) THEN
    ALTER TABLE wallet_txns
      ADD CONSTRAINT wallet_txns_payment_fk
      FOREIGN KEY (payment_id) REFERENCES payments(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ---------- per-tenant settings (overrides; app_config stays global) ----------
CREATE TABLE IF NOT EXISTS tenant_settings (
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key       TEXT NOT NULL,
  value     TEXT,
  PRIMARY KEY (tenant_id, key)
);

-- ---------- add tenant_id to existing domain tables ----------
ALTER TABLE zoom_account          ADD COLUMN IF NOT EXISTS tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE;
ALTER TABLE fathom_account        ADD COLUMN IF NOT EXISTS tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE;
ALTER TABLE youtube_channels      ADD COLUMN IF NOT EXISTS tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE;
ALTER TABLE lms_account           ADD COLUMN IF NOT EXISTS tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE;
ALTER TABLE routing_rules         ADD COLUMN IF NOT EXISTS tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE;
ALTER TABLE processed_recordings  ADD COLUMN IF NOT EXISTS tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE;
ALTER TABLE run_logs              ADD COLUMN IF NOT EXISTS tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE;
ALTER TABLE schedules             ADD COLUMN IF NOT EXISTS tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE;

-- ---------- migrate existing rows under Tenant #1 ----------
UPDATE zoom_account         SET tenant_id = (SELECT id FROM tenants WHERE slug='applygita') WHERE tenant_id IS NULL;
UPDATE fathom_account       SET tenant_id = (SELECT id FROM tenants WHERE slug='applygita') WHERE tenant_id IS NULL;
UPDATE youtube_channels     SET tenant_id = (SELECT id FROM tenants WHERE slug='applygita') WHERE tenant_id IS NULL;
UPDATE lms_account          SET tenant_id = (SELECT id FROM tenants WHERE slug='applygita') WHERE tenant_id IS NULL;
UPDATE routing_rules        SET tenant_id = (SELECT id FROM tenants WHERE slug='applygita') WHERE tenant_id IS NULL;
UPDATE processed_recordings SET tenant_id = (SELECT id FROM tenants WHERE slug='applygita') WHERE tenant_id IS NULL;
UPDATE run_logs             SET tenant_id = (SELECT id FROM tenants WHERE slug='applygita') WHERE tenant_id IS NULL;
UPDATE schedules            SET tenant_id = (SELECT id FROM tenants WHERE slug='applygita') WHERE tenant_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_pr_tenant       ON processed_recordings(tenant_id);
CREATE INDEX IF NOT EXISTS idx_runlogs_tenant  ON run_logs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_rules_tenant    ON routing_rules(tenant_id);
CREATE INDEX IF NOT EXISTS idx_channels_tenant ON youtube_channels(tenant_id);
CREATE INDEX IF NOT EXISTS idx_schedules_tenant ON schedules(tenant_id);

-- Move the current per-tenant-relevant app_config values into Tenant #1's settings.
INSERT INTO tenant_settings (tenant_id, key, value)
SELECT (SELECT id FROM tenants WHERE slug='applygita'), key, value
FROM app_config
WHERE key IN ('zoom_delete_mode','email_to','email_from','gmail_app_password','rolling_window_days')
ON CONFLICT (tenant_id, key) DO NOTHING;

-- ---------- global billing config (platform-level; editable) ----------
INSERT INTO app_config (key, value) VALUES
  ('price_per_unit_paise', '5000'),        -- ₹50 per upload unit
  ('unit_bytes',           '1073741824'),  -- 1 GiB — above this = 2 units
  ('gst_percent',          '18'),
  ('gateway_percent',      '2.5'),
  ('min_topup_paise',      '50000')        -- ₹500 minimum wallet credit
ON CONFLICT (key) DO NOTHING;
