import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { config } from './config.js';
import { log, logError } from './lib/logger.js';

const LOCAL_HOSTS = /localhost|127\.0\.0\.1|railway\.internal/;

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  ssl: LOCAL_HOSTS.test(config.databaseUrl) ? false : { rejectUnauthorized: false },
  max: 5,
});

// A Pool emits 'error' when an IDLE pooled connection dies on its own — the
// managed Postgres restarting, sleeping/waking, or a network drop (Postgres sends
// FATAL 57P01 "terminating connection due to administrator command"). With NO
// listener, Node treats it as an unhandled 'error' event and crashes the whole
// process — which is exactly what was killing the app (and wiping the in-memory
// push queue, orphaning the in-flight recording) every time the DB bounced. Log
// it and move on: the pool discards the dead client and opens a fresh one on the
// next query. An in-flight query still rejects and its caller handles that.
pool.on('error', (err) => {
  logError(`pg pool idle-client error (recovered): ${err.code || ''} ${err.message}`.trim());
});

export function query(text, params) {
  return pool.query(text, params);
}

// Wait for Postgres to accept connections before migrating. Serverless/managed
// databases can be a few seconds behind the app on a cold start — retry instead
// of crash-looping the boot.
export async function waitForDb(maxMs = 45000) {
  const start = Date.now();
  let attempt = 0;
  let lastErr;
  while (Date.now() - start < maxMs) {
    try {
      await pool.query('SELECT 1');
      if (attempt > 0) log(`database ready after ${attempt} retr${attempt === 1 ? 'y' : 'ies'}`);
      return;
    } catch (err) {
      lastErr = err;
      attempt += 1;
      log(`database not ready yet (attempt ${attempt}): ${err.code || err.message} — retrying in 2s`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw new Error(`database not reachable after ${maxMs}ms: ${lastErr?.message}`);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

export async function runMigrations() {
  await waitForDb();
  await query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ DEFAULT now()
  )`);
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const { rowCount } = await query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
    if (rowCount) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      log(`migration applied: ${file}`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`migration ${file} failed: ${err.message}`);
    } finally {
      client.release();
    }
  }
}

// --- app_config helpers ---

export async function getConfigValue(key) {
  const { rows } = await query('SELECT value FROM app_config WHERE key = $1', [key]);
  return rows[0]?.value ?? null;
}

export async function getConfigMap() {
  const { rows } = await query('SELECT key, value FROM app_config');
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export async function setConfigValue(key, value) {
  await query(
    `INSERT INTO app_config (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value],
  );
}

// --- tenants ---

export async function getTenants() {
  const { rows } = await query('SELECT * FROM tenants ORDER BY id');
  return rows;
}

export async function getTenantById(id) {
  const { rows } = await query('SELECT * FROM tenants WHERE id = $1', [id]);
  return rows[0] || null;
}

// --- per-tenant settings (tenant_settings) ---

export async function getTenantSettings(tenantId) {
  const { rows } = await query('SELECT key, value FROM tenant_settings WHERE tenant_id = $1', [tenantId]);
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export async function setTenantSetting(tenantId, key, value) {
  await query(
    `INSERT INTO tenant_settings (tenant_id, key, value) VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value`,
    [tenantId, key, value],
  );
}
