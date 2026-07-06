import cron from 'node-cron';
import { getConfigMap } from './db.js';
import { runPipeline } from './pipeline/run.js';
import { log, logError } from './lib/logger.js';

let task = null;
let current = { expression: null, timezone: null };

export function getSchedule() {
  return { ...current };
}

// Reads cron_expression + timezone from app_config and (re)schedules the pull job.
// Called at boot and again whenever Settings are saved.
export async function startScheduler() {
  const cfg = await getConfigMap();
  const expression = cfg.cron_expression || '0 23 * * *';
  const timezone = cfg.timezone || 'Asia/Kolkata';

  if (!cron.validate(expression)) {
    logError(`invalid cron expression "${expression}" — scheduler NOT started`);
    return false;
  }
  if (task) task.stop();
  task = cron.schedule(expression, () => {
    runPipeline('scheduled').catch((err) => logError('scheduled run crashed:', err));
  }, { timezone });
  current = { expression, timezone };
  log(`scheduler active: "${expression}" (${timezone})`);
  return true;
}

export const reschedule = startScheduler;
