-- Zoom via a single platform-owned USER-LEVEL OAuth app (clients click "Connect
-- Zoom" and consent — no per-client Server-to-Server app). Legacy S2S rows keep
-- working: they have account_id/client_id/client_secret and no refresh_token, so
-- the provider uses the account_credentials grant for them and the refresh_token
-- grant (platform app) for OAuth rows.
ALTER TABLE zoom_account ALTER COLUMN account_id    DROP NOT NULL;
ALTER TABLE zoom_account ALTER COLUMN client_id     DROP NOT NULL;
ALTER TABLE zoom_account ALTER COLUMN client_secret DROP NOT NULL;
ALTER TABLE zoom_account ADD COLUMN IF NOT EXISTS refresh_token TEXT; -- encrypted (user OAuth; Zoom rotates it each refresh)
ALTER TABLE zoom_account ADD COLUMN IF NOT EXISTS oauth_email   TEXT; -- the Zoom user who granted consent
