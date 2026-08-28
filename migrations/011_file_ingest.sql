-- Schema for the file-ingest features:
--   (1) upload local files to YouTube / LMS
--   (2) download Zoom files to the local computer (free; audit only)
--   (3) upload files from cloud storage to YouTube / LMS
--
-- Local and cloud uploads reuse processed_recordings (source = 'local' | 'cloud')
-- so routing, billing, run logs and the dashboard all apply unchanged. source_id
-- for these is a generated UUID (the UNIQUE(tenant_id, source, source_id) from
-- migration 005 still holds). New origin columns describe where the file came from.

ALTER TABLE processed_recordings ADD COLUMN IF NOT EXISTS origin_provider   TEXT;  -- 'browser' (local) | 'gdrive' | 'dropbox' | 'onedrive' | 's3'
ALTER TABLE processed_recordings ADD COLUMN IF NOT EXISTS original_filename TEXT;  -- the picked/uploaded file name
ALTER TABLE processed_recordings ADD COLUMN IF NOT EXISTS origin_file_ref   TEXT;  -- cloud file id / path (null for local)

-- (3) Cloud storage connections — one row per connected account per tenant.
-- OAuth providers use access/refresh tokens; S3-style providers use access/secret
-- keys. All secret material is stored ENCRYPTED (lib/secrets), never in the clear.
CREATE TABLE IF NOT EXISTS cloud_connections (
  id               SERIAL PRIMARY KEY,
  tenant_id        INTEGER NOT NULL REFERENCES tenants(id),
  provider         TEXT NOT NULL,            -- 'gdrive' | 'dropbox' | 'onedrive' | 's3'
  account_label    TEXT,                     -- email / bucket shown in the UI
  access_token     TEXT,                     -- encrypted (OAuth)
  refresh_token    TEXT,                     -- encrypted (OAuth)
  token_expires_at TIMESTAMPTZ,
  s3_bucket        TEXT,
  s3_region        TEXT,
  s3_access_key    TEXT,                     -- encrypted (S3-style direct login)
  s3_secret_key    TEXT,                     -- encrypted
  status           TEXT NOT NULL DEFAULT 'connected',  -- 'connected' | 'expired' | 'revoked'
  created_at       TIMESTAMPTZ DEFAULT now(),
  updated_at       TIMESTAMPTZ DEFAULT now(),
  UNIQUE (tenant_id, provider, account_label)
);
CREATE INDEX IF NOT EXISTS cloud_connections_tenant_idx ON cloud_connections (tenant_id);

-- (2) Download audit log — downloading a Zoom recording to the local computer is
-- FREE (no metering); this only records who pulled what, for the owner's audit.
CREATE TABLE IF NOT EXISTS download_events (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     INTEGER NOT NULL REFERENCES tenants(id),
  recording_id  INTEGER REFERENCES processed_recordings(id),
  source        TEXT,                        -- 'zoom' (room for more later)
  user_email    TEXT,
  bytes         BIGINT,
  created_at    TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS download_events_tenant_idx ON download_events (tenant_id, created_at DESC);
