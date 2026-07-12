-- Persist per-recording transfer metrics for the Logs page.
ALTER TABLE processed_recordings ADD COLUMN IF NOT EXISTS download_ms  INTEGER;
ALTER TABLE processed_recordings ADD COLUMN IF NOT EXISTS upload_ms    INTEGER;
ALTER TABLE processed_recordings ADD COLUMN IF NOT EXISTS download_bps BIGINT;
ALTER TABLE processed_recordings ADD COLUMN IF NOT EXISTS upload_bps   BIGINT;
