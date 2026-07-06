-- VideoRouter initial schema (design doc §5).
-- Additions beyond the design doc, needed at runtime:
--   processed_recordings.recorded_at      — sent to the LMS ingest payload
--   processed_recordings.duration_minutes — sent to the LMS ingest payload
--   processed_recordings.source_meta      — JSONB (e.g. Fathom share_url) so retries
--                                           work even after the rolling window has passed

-- Provider credentials (secrets stored encrypted at the app layer, AES-256-GCM)
CREATE TABLE IF NOT EXISTS zoom_account (
  id            SERIAL PRIMARY KEY,
  account_id    TEXT NOT NULL,
  client_id     TEXT NOT NULL,
  client_secret TEXT NOT NULL,          -- encrypted
  status        TEXT DEFAULT 'unverified',
  updated_at    TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fathom_account (
  id         SERIAL PRIMARY KEY,
  api_key    TEXT NOT NULL,             -- encrypted
  status     TEXT DEFAULT 'unverified',
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS youtube_channels (
  id             SERIAL PRIMARY KEY,
  label          TEXT NOT NULL,         -- "Gita main", "Hindi"
  channel_id     TEXT,                  -- UC... (filled after OAuth)
  channel_handle TEXT,                  -- @GangaNarayanDas1
  google_email   TEXT,
  oauth_client_id     TEXT NOT NULL,    -- per-channel Google project (quota isolation)
  oauth_client_secret TEXT NOT NULL,    -- encrypted
  refresh_token  TEXT,                  -- encrypted, set by the OAuth connect flow
  status         TEXT DEFAULT 'disconnected',
  created_at     TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS lms_account (
  id         SERIAL PRIMARY KEY,
  base_url   TEXT NOT NULL,             -- myappz.ai LMS API base URL
  api_key    TEXT NOT NULL,             -- encrypted; bearer token issued by myappz.ai
  status     TEXT DEFAULT 'unverified',
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS routing_rules (
  id            SERIAL PRIMARY KEY,
  source        TEXT NOT NULL DEFAULT 'any',      -- 'zoom' | 'fathom' | 'any'
  match_type    TEXT NOT NULL DEFAULT 'contains', -- 'contains' | 'prefix' | 'regex'
  pattern       TEXT NOT NULL,
  channel_id    INTEGER REFERENCES youtube_channels(id),
  playlist_name TEXT,
  privacy       TEXT NOT NULL DEFAULT 'unlisted',
  keep_prefix   BOOLEAN NOT NULL DEFAULT true,    -- keep tag in the YouTube title
  lms_course_id TEXT,                             -- target LMS course for this tag
  lms_module_id TEXT,                             -- optional target module/section
  priority      INTEGER NOT NULL DEFAULT 100,
  enabled       BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS processed_recordings (
  id             SERIAL PRIMARY KEY,
  source         TEXT NOT NULL,          -- 'zoom' | 'fathom'
  source_id      TEXT NOT NULL,          -- Zoom meeting UUID / Fathom recording_id
  source_file_id TEXT,                   -- Zoom recording file id (the mp4 we took)
  title          TEXT,
  matched_tag    TEXT,
  channel_id     INTEGER REFERENCES youtube_channels(id),
  youtube_video_id  TEXT,
  youtube_url    TEXT,                   -- final unlisted YouTube link
  playlist_name  TEXT,
  lms_lesson_id  TEXT,                   -- returned by the myappz.ai LMS ingest endpoint
  lms_lesson_url TEXT,                   -- viewable lesson link inside the LMS
  lms_status     TEXT DEFAULT 'pending', -- 'pending' | 'pushed' | 'failed'
  status         TEXT NOT NULL DEFAULT 'discovered',
  file_size_bytes BIGINT,
  source_deleted BOOLEAN NOT NULL DEFAULT false,
  error_message  TEXT,
  recorded_at    TIMESTAMPTZ,
  duration_minutes INTEGER,
  source_meta    JSONB,
  discovered_at  TIMESTAMPTZ DEFAULT now(),
  uploaded_at    TIMESTAMPTZ,            -- timestamp shown in the dashboard log
  UNIQUE (source, source_id)
);

CREATE TABLE IF NOT EXISTS run_logs (
  id           SERIAL PRIMARY KEY,
  run_type     TEXT NOT NULL,            -- 'scheduled' | 'manual'
  started_at   TIMESTAMPTZ DEFAULT now(),
  finished_at  TIMESTAMPTZ,
  found        INTEGER DEFAULT 0,
  uploaded     INTEGER DEFAULT 0,
  skipped      INTEGER DEFAULT 0,
  errors       INTEGER DEFAULT 0,
  summary      JSONB
);

CREATE TABLE IF NOT EXISTS app_config (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS admin_users (
  id            SERIAL PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL
);

-- Seed defaults (no-op if already present)
INSERT INTO app_config (key, value) VALUES
  ('cron_expression',     '0 23 * * *'),
  ('timezone',            'Asia/Kolkata'),
  ('rolling_window_days', '3'),
  ('zoom_delete_mode',    'delete'),
  ('email_to',            ''),
  ('email_from',          ''),
  ('gmail_app_password',  '')
ON CONFLICT (key) DO NOTHING;
