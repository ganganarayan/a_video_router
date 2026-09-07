-- ============================================================
-- 018 — Signup attribution
--
-- Snapshot each workspace's acquisition data onto the tenant AT SIGNUP, by
-- linking the anonymous visitor cookie (vr_vid) to the new account. The
-- visitors table already captures first-touch UTM / referrer / user-agent /
-- geo for public traffic; the signup flow now copies that snapshot here so it
-- survives (visitor rows can be pruned) and is joinable to the account.
--
-- Additive only. Existing tenants keep NULLs (they signed up before capture);
-- new signups from here on are stamped. tenants.created_at already exists.
-- ============================================================
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS signup_visitor_id TEXT,
  ADD COLUMN IF NOT EXISTS signup_utm_source TEXT,
  ADD COLUMN IF NOT EXISTS signup_utm_medium TEXT,
  ADD COLUMN IF NOT EXISTS signup_utm_campaign TEXT,
  ADD COLUMN IF NOT EXISTS signup_referrer TEXT,
  ADD COLUMN IF NOT EXISTS signup_landing_path TEXT,
  ADD COLUMN IF NOT EXISTS signup_ua TEXT,
  ADD COLUMN IF NOT EXISTS signup_ip TEXT,
  ADD COLUMN IF NOT EXISTS signup_browser TEXT,
  ADD COLUMN IF NOT EXISTS signup_os TEXT,
  ADD COLUMN IF NOT EXISTS signup_device TEXT,
  ADD COLUMN IF NOT EXISTS signup_country TEXT,
  ADD COLUMN IF NOT EXISTS signup_city TEXT;
