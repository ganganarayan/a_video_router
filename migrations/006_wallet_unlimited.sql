-- Per-tenant "unlimited" flag: exempts a tenant from metering (owner's own
-- workspace, or comped tenants). Super admin toggles it.
ALTER TABLE wallets ADD COLUMN IF NOT EXISTS unlimited BOOLEAN NOT NULL DEFAULT false;

-- The platform owner's own tenant is unmetered by default during rollout.
UPDATE wallets SET unlimited = true
WHERE tenant_id = (SELECT id FROM tenants WHERE slug = 'applygita');
