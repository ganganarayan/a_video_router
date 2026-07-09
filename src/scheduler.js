import cron from 'node-cron';
import { query } from './db.js';
import { runPipeline } from './pipeline/run.js';
import { log, logError } from './lib/logger.js';

// id -> node-cron task, for the currently-enabled schedules.
const tasks = new Map();

export async function getSchedules() {
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
        log(`schedule "${s.name}" (#${s.id}) firing`);
        runPipeline('scheduled').catch((err) => logError('scheduled run crashed:', err));
      },
      { timezone: s.timezone || 'Asia/Kolkata' },
    );
    tasks.set(s.id, task);
  }
  log(`scheduler: ${tasks.size} active schedule(s)`);
  return tasks.size;
}

export const startScheduler = reloadSchedules;
export const activeCount = () => tasks.size;
