-- Meta Conversions API event log — records every server-side event the app sends
-- to Meta (Lead, CompleteRegistration, Purchase, PageView test…) so the super-admin
-- conversions panel can show what actually reached Meta. Pixel config itself lives
-- in app_config (meta_pixel_id, meta_capi_token[encrypted], meta_test_event_code).
CREATE TABLE IF NOT EXISTS capi_events (
  id           BIGSERIAL PRIMARY KEY,
  ts           TIMESTAMPTZ NOT NULL DEFAULT now(),
  event_name   TEXT NOT NULL,          -- 'Lead' | 'CompleteRegistration' | 'Purchase' | ...
  event_id     TEXT,                   -- dedup key shared with the browser pixel
  source       TEXT,                   -- 'capi' | 'pixel'
  http_status  INTEGER,                -- Meta HTTP status
  ok           BOOLEAN,                -- accepted?
  visitor_id   UUID,                   -- links to the visitors/page_hits tables
  value_paise  BIGINT,                 -- for Purchase events
  currency     TEXT,
  error        TEXT
);
CREATE INDEX IF NOT EXISTS capi_events_ts_idx ON capi_events (ts DESC);
CREATE INDEX IF NOT EXISTS capi_events_name_idx ON capi_events (event_name, ts DESC);
