import bcrypt from 'bcryptjs';
import { config } from './config.js';
import { runMigrations, query } from './db.js';
import { log, logError } from './lib/logger.js';
import { createServer } from './web/server.js';
import { startScheduler } from './scheduler.js';

async function bootstrapAdmin() {
  const { rowCount } = await query('SELECT 1 FROM admin_users LIMIT 1');
  if (rowCount) return;
  const hash = await bcrypt.hash(config.adminPassword, 10);
  await query('INSERT INTO admin_users (email, password_hash) VALUES ($1, $2)', [
    config.adminEmail.toLowerCase(),
    hash,
  ]);
  log(`admin user bootstrapped: ${config.adminEmail}`);
}

async function main() {
  await runMigrations();
  await bootstrapAdmin();

  const app = createServer();
  app.listen(config.port, () => log(`VideoRouter listening on :${config.port}`));

  await startScheduler();
}

main().catch((err) => {
  logError('fatal boot error:', err);
  process.exit(1);
});
