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
import { recoverInterruptedDownloads } from './pipeline/run.js';

// Capture the reason a crash restarts the container instead of it dying silently.
// (An OS-level OOM kill still won't reach these — that shows only in Railway's
// metrics — but a JS uncaught error / unhandled rejection now leaves a log line.)
process.on('unhandledRejection', (reason) => {
  logError('unhandledRejection:', reason instanceof Error ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  logError('uncaughtException:', err?.stack || err);
  process.exit(1); // let the platform restart us — but now with a logged reason
});

// Memory heartbeat: if the container is being OOM-killed during a big transfer,
// RSS will be seen climbing toward the limit right before the restart in the logs.
setInterval(() => {
  const m = process.memoryUsage();
  log(`mem rss=${Math.round(m.rss / 1048576)}MB heap=${Math.round(m.heapUsed / 1048576)}MB`);
}, 30000).unref();

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
  await recoverInterruptedDownloads().catch((err) => logError('orphan recovery failed:', err.message));

  const app = createServer();
  app.listen(config.port, () => log(`VideoRouter listening on :${config.port}`));

  await startScheduler();
}

main().catch((err) => {
  logError('fatal boot error:', err);
  process.exit(1);
});
