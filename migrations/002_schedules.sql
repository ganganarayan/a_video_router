-- Multiple named recurring schedules (replaces the single app_config cron).
CREATE TABLE IF NOT EXISTS schedules (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  cron_expression TEXT NOT NULL,
  timezone        TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  enabled         BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ DEFAULT now()
);

-- Migrate the existing single cron into one schedule, seeded DISABLED so no
-- automatic runs fire until the user resumes it from the Schedules page.
INSERT INTO schedules (name, cron_expression, timezone, enabled)
SELECT 'Daily pull',
       COALESCE((SELECT value FROM app_config WHERE key = 'cron_expression'), '0 23 * * *'),
       COALESCE((SELECT value FROM app_config WHERE key = 'timezone'), 'Asia/Kolkata'),
       false
WHERE NOT EXISTS (SELECT 1 FROM schedules);
