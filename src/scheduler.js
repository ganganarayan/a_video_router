import cron from 'node-cron';
import { query } from './db.js';
import { runPipeline } from './pipeline/run.js';
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
  const { rows } = await query('SELECT * FROM schedules WHERE enabled = true ORDER BY id');
  for (const s of rows) {
    if (!cron.validate(s.cron_expression)) {
      logError(`schedule #${s.id} "${s.name}" has invalid cron "${s.cron_expression}" — skipped`);
      continue;
    }
    const task = cron.schedule(
      s.cron_expression,
      () => {
        log(`schedule "${s.name}" (#${s.id}) firing for tenant ${s.tenant_id}`);
        runPipeline(s.tenant_id, 'scheduled').catch((err) => logError('scheduled run crashed:', err));
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
  }, { timezone: 'Asia/Kolkata' });
}

export async function startScheduler() {
  const n = await reloadSchedules();
  startRetention();
  return n;
}
export const activeCount = () => tasks.size;
