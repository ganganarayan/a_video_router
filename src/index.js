import dns from 'node:dns';
// Prefer IPv4 for all DNS lookups. Node 18+ defaults to 'verbatim' (DNS order),
// which can hand back an IPv6 (AAAA) address first; container hosts (Railway)
// often have no working IPv6 egress, so an SMTP connect to e.g. smtp.zoho.in
// then hangs until ETIMEDOUT even though the host is reachable over IPv4.
dns.setDefaultResultOrder('ipv4first');

import { config } from './config.js';
import { runMigrations, query } from './db.js';
import { log, logError } from './lib/logger.js';
import { createServer } from './web/server.js';
import { startScheduler } from './scheduler.js';

// Migration 004 seeds the super admin; this is a belt-and-suspenders ensure for
// any DB where a super_admin row is missing. Passwordless first login + forced
// change (password_hash NULL + must_change_password).
async function ensureSuperAdmin() {
  const { rowCount } = await query("SELECT 1 FROM users WHERE role = 'super_admin' LIMIT 1");
  if (rowCount) return;
  await query(
    `INSERT INTO users (tenant_id, email, name, role, password_hash, must_change_password)
     VALUES (NULL, $1, 'Super Admin', 'super_admin', NULL, true)
     ON CONFLICT (email) DO NOTHING`,
    [config.adminEmail.toLowerCase()],
  );
  log(`super admin ensured: ${config.adminEmail}`);
}

async function main() {
  await runMigrations();
  await ensureSuperAdmin();

  const app = createServer();
  app.listen(config.port, () => log(`VideoRouter listening on :${config.port}`));

  await startScheduler();
}

main().catch((err) => {
  logError('fatal boot error:', err);
  process.exit(1);
});
