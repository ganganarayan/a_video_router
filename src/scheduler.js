import cron from 'node-cron';
import { query } from './db.js';
import { runPipeline } from './pipeline/run.js';
import { hasAlwaysOn } from './billing.js';
import { log, logError } from './lib/logger.js';

// id -> node-cron task, for the currently-enabled schedules.
const tasks = new Map();

export async function getSchedules(tenantId) {
  if (tenantId != null) {
    const { rows } = await query('SELECT * FROM schedules WHERE tenant_id = $1 ORDER BY id', [tenantId]);
    return rows;
  }
  const { rows } = await query('SELECT * FROM schedules ORDER BY id');
  return rows;
}

// Stop every running cron task and re-create one per enabled schedule. Called at
// boot and after any schedule create/update/toggle/delete.
export async function reloadSchedules() {
  for (const task of tasks.values()) task.stop();
  tasks.clear();
  // The scheduler is an Always-On feature: only load schedules for tenants that are
  // unlimited (comped) or hold an active subscription. (Belt-and-suspenders: each
  // fire re-checks, so a lapse between reloads is still caught.)
  const { rows } = await query(
    `SELECT s.* FROM schedules s
       JOIN wallets w ON w.tenant_id = s.tenant_id
      WHERE s.enabled = true
        AND (w.unlimited = true OR (w.always_on_until IS NOT NULL AND w.always_on_until > now()))
      ORDER BY s.id`,
  );
  for (const s of rows) {
    if (!cron.validate(s.cron_expression)) {
      logError(`schedule #${s.id} "${s.name}" has invalid cron "${s.cron_expression}" — skipped`);
      continue;
    }
    const task = cron.schedule(
      s.cron_expression,
      () => {
        hasAlwaysOn(s.tenant_id).then((ok) => {
          if (!ok) { log(`schedule "${s.name}" (#${s.id}) skipped — tenant ${s.tenant_id} not Always-On`); return; }
          log(`schedule "${s.name}" (#${s.id}) firing for tenant ${s.tenant_id}`);
          runPipeline(s.tenant_id, 'scheduled').catch((err) => logError('scheduled run crashed:', err));
        }).catch((err) => logError('schedule Always-On check failed:', err));
      },
      { timezone: s.timezone || 'Asia/Kolkata' },
    );
    tasks.set(s.id, task);
  }
  log(`scheduler: ${tasks.size} active schedule(s)`);
  return tasks.size;
}

// Daily retention: prune raw page hits past the window (bot scanners would
// otherwise grow the table unbounded). Aggregates/uniques are unaffected.
const RETENTION_DAYS = 180;
let retentionTask;
function startRetention() {
  if (retentionTask) return;
  retentionTask = cron.schedule('17 3 * * *', async () => {
    try {
      const r = await query(`DELETE FROM page_hits WHERE ts < now() - interval '${RETENTION_DAYS} days'`);
      if (r.rowCount) log(`retention: pruned ${r.rowCount} page_hits older than ${RETENTION_DAYS}d`);
    } catch (err) { logError('retention prune failed:', err); }
    // Re-evaluate schedules daily so a lapsed Always-On subscription stops firing.
    try { await reloadSchedules(); } catch (err) { logError('daily schedule reload failed:', err); }
  }, { timezone: 'Asia/Kolkata' });
}

export async function startScheduler() {
  const n = await reloadSchedules();
  startRetention();
  return n;
}
export const activeCount = () => tasks.size;
