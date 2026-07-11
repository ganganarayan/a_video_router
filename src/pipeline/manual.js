// FIFO queue for manual per-video pushes from the Sources page. One worker,
// sequential jobs; it yields while a scheduled/manual pipeline run is active
// (row locks in run.js protect against any remaining overlap).
import { manualPush, isRunning } from './run.js';
import { log, logError } from '../lib/logger.js';

const MAX_JOBS_KEPT = 100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let seq = 0;
let working = false;
const jobs = [];

export function enqueuePush(payload) {
  const duplicate = jobs.find(
    (j) => (j.status === 'queued' || j.status === 'processing') &&
      j.source === payload.source && j.source_id === payload.source_id,
  );
  if (duplicate) return { job: duplicate, duplicate: true };

  const job = {
    id: ++seq,
    source: payload.source,
    source_id: payload.source_id,
    file_id: payload.file_id || null,
    title: payload.title || payload.source_id,
    video_title: payload.video_title || null,
    description: payload.description || null,
    channel_id: payload.channel_id || null,
    lms_course_id: payload.lms_course_id || null,
    lms_module_id: payload.lms_module_id || null,
    status: 'queued',
    message: '',
    youtube_url: null,
    lms_lesson_url: null,
    queued_at: new Date().toISOString(),
    finished_at: null,
  };
  jobs.push(job);
  if (jobs.length > MAX_JOBS_KEPT) jobs.splice(0, jobs.length - MAX_JOBS_KEPT);
  void work();
  return { job, duplicate: false };
}

export function getJobs() {
  return [...jobs].reverse();
}

export function hasActiveJobs() {
  return jobs.some((j) => j.status === 'queued' || j.status === 'processing');
}

async function work() {
  if (working) return;
  working = true;
  try {
    let job;
    // eslint-disable-next-line no-cond-assign
    while ((job = jobs.find((j) => j.status === 'queued'))) {
      while (isRunning()) await sleep(5000); // let a pipeline run finish first
      job.status = 'processing';
      log(`push queue: job #${job.id} started (${job.source}: ${job.title})`);
      try {
        const result = await manualPush(job);
        job.status = 'done';
        job.message = result.message;
        job.youtube_url = result.youtube_url || null;
        job.lms_lesson_url = result.lms_lesson_url || null;
        job.youtube_status = result.youtube_status || null;
        job.transfer = result.transfer || null;
      } catch (err) {
        job.status = 'failed';
        job.message = err.message;
        logError(`push queue: job #${job.id} failed:`, err.message);
      }
      job.finished_at = new Date().toISOString();
    }
  } finally {
    working = false;
  }
}
