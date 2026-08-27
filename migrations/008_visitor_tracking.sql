-- Visitor & Traffic Intelligence (super-admin analytics).
-- Scope: public/marketing traffic only. Logged-in app navigation is NEVER recorded
-- (the capture middleware skips any request carrying a session cookie).

-- Every server-side hit to a public page (humans AND bots/scanners). Powers the
-- Traffic view and — filtered to humans + marketing sections — the Visitors view.
CREATE TABLE IF NOT EXISTS page_hits (
  id           BIGSERIAL PRIMARY KEY,
  ts           TIMESTAMPTZ NOT NULL DEFAULT now(),
  visitor_id   UUID,                    -- anon cookie id; NULL for cookieless bots
  path         TEXT NOT NULL,
  method       TEXT NOT NULL DEFAULT 'GET',
  status       INTEGER,                 -- final response status
  section      TEXT,                    -- 'landing' | 'kb' | 'legal' | 'embed' | 'other'
  is_bot       BOOLEAN NOT NULL DEFAULT false,
  bot_kind     TEXT,                    -- 'crawler' | 'scanner' | 'ua' | NULL
  is_wake      BOOLEAN NOT NULL DEFAULT false,  -- this hit woke the sleeping app
  ip           TEXT,
  ua_raw       TEXT,
  browser      TEXT,
  os           TEXT,
  device_type  TEXT,                    -- 'desktop' | 'mobile' | 'tablet' | 'bot'
  referrer     TEXT,
  country      TEXT,                    -- ISO-2, from edge header or cached lookup
  city         TEXT,
  human_confirmed BOOLEAN NOT NULL DEFAULT false,  -- client beacon proved JS ran (definitely human)
  screen       TEXT,                    -- viewport w×h, from the beacon
  tz           TEXT,                    -- browser timezone, from the beacon
  -- ad attribution captured on the hit
  utm_source   TEXT, utm_medium TEXT, utm_campaign TEXT, utm_term TEXT, utm_content TEXT,
  fbclid       TEXT, gclid TEXT,
  fbc          TEXT, fbp TEXT           -- Meta cookies (populated by the client beacon)
);
CREATE INDEX IF NOT EXISTS page_hits_ts_idx      ON page_hits (ts DESC);
CREATE INDEX IF NOT EXISTS page_hits_path_idx    ON page_hits (path);
CREATE INDEX IF NOT EXISTS page_hits_visitor_idx ON page_hits (visitor_id);

-- One row per unique anonymous visitor (cookie). Holds first-touch attribution
-- (never overwritten) plus rolling last-seen / hit count. Powers "unique humans".
CREATE TABLE IF NOT EXISTS visitors (
  visitor_id    UUID PRIMARY KEY,
  first_seen    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen     TIMESTAMPTZ NOT NULL DEFAULT now(),
  hits          INTEGER NOT NULL DEFAULT 1,
  landing_path  TEXT,
  referrer      TEXT,
  utm_source    TEXT, utm_medium TEXT, utm_campaign TEXT, utm_term TEXT, utm_content TEXT,
  fbclid        TEXT, gclid TEXT, fbc TEXT, fbp TEXT,
  ip            TEXT,
  ua_raw        TEXT,
  browser       TEXT, os TEXT, device_type TEXT,
  country       TEXT, city TEXT,
  human_confirmed BOOLEAN NOT NULL DEFAULT false,
  screen        TEXT, tz TEXT
);

-- Wake log: the first inbound request after the app boots from sleep.
CREATE TABLE IF NOT EXISTS wake_events (
  id            BIGSERIAL PRIMARY KEY,
  ts            TIMESTAMPTZ NOT NULL DEFAULT now(),
  waker_path    TEXT,
  ip            TEXT,
  ua_raw        TEXT,
  is_bot        BOOLEAN NOT NULL DEFAULT false,
  bot_kind      TEXT,
  country       TEXT
);
CREATE INDEX IF NOT EXISTS wake_events_ts_idx ON wake_events (ts DESC);

-- Login recording. last_login_at already exists (migration 004) but was never
-- written; previous_login_at lets a user see their prior login while last_login_at
-- tracks the current one. One row per user, overwritten on every login.
ALTER TABLE users ADD COLUMN IF NOT EXISTS previous_login_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_ip     TEXT;
