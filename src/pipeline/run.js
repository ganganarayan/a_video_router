import { query, getConfigMap } from '../db.js';
import { log, logError } from '../lib/logger.js';
import * as zoom from '../providers/zoom.js';
import * as fathom from '../providers/fathom.js';
import * as lms from '../providers/lms.js';
import { getChannelById, uploadVideo, ensurePlaylist, addToPlaylist } from '../providers/youtube.js';
import { matchRule, buildVideoTitle } from './router.js';
import { STATES, RETRYABLE_STATES } from './states.js';
import { tempFilePath, cleanupTemp, downloadFathomVideo } from './download.js';
import { lock, unlock, isLocked, recordingKey } from './locks.js';
import { ProgressTracker } from './progress.js';
import { sendRunSummary } from '../notifier.js';

let running = false;
export const isRunning = () => running;

const UPDATABLE = new Set([
  'title', 'matched_tag', 'channel_id', 'youtube_video_id', 'youtube_url', 'playlist_name',
  'lms_lesson_id', 'lms_lesson_url', 'lms_status', 'status', 'file_size_bytes',
  'source_deleted', 'error_message', 'recorded_at', 'duration_minutes', 'source_meta',
  'source_file_id', 'uploaded_at',
  'download_ms', 'upload_ms', 'download_bps', 'upload_bps',
]);

async function updateRec(id, fields) {
  const keys = Object.keys(fields).filter((k) => UPDATABLE.has(k));
  if (!keys.length) return;
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
  const values = keys.map((k) => (k === 'source_meta' ? JSON.stringify(fields[k]) : fields[k]));
  await query(`UPDATE processed_recordings SET ${sets} WHERE id = $1`, [id, ...values]);
}

async function getRec(id) {
  const { rows } = await query('SELECT * FROM processed_recordings WHERE id = $1', [id]);
  return rows[0];
}

// Dedupe core: unique (source, source_id). Insert-if-absent, then return the row.
async function ensureRow(source, sourceId, fields) {
  const { rows } = await query(
    `INSERT INTO processed_recordings (source, source_id, title, recorded_at, duration_minutes, source_meta)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (source, source_id) DO NOTHING
     RETURNING *`,
    [source, sourceId, fields.title, fields.recorded_at || null,
      fields.duration_minutes ?? null, JSON.stringify(fields.source_meta || {})],
  );
  if (rows[0]) return { rec: rows[0], isNew: true };
  const { rows: existing } = await query(
    'SELECT * FROM processed_recordings WHERE source = $1 AND source_id = $2',
    [source, sourceId],
  );
  return { rec: existing[0], isNew: false };
}

async function getRules() {
  const { rows } = await query('SELECT * FROM routing_rules');
  return rows;
}

function noteSkip(rec, reason, counts, details) {
  counts.skipped++;
  details.skipped.push({ title: rec.title, source: rec.source, reason });
}

// --- post-upload steps (LMS push, Zoom delete) — safe to repeat, never re-upload ---

async function tryLmsPush(ctx, rec, rule, details) {
  if (rec.lms_status === 'pushed') return;
  if (!lms.isConfigured(ctx.lmsAccount)) return; // dormant until connected
  if (!rule?.lms_course_id) {
    details.warnings.push({ title: rec.title, message: 'LMS connected but rule has no lms_course_id; push pending' });
    return;
  }
  try {
    const result = await lms.pushVideo(ctx.lmsAccount, rec, rule);
    const fields = { lms_status: 'pushed', lms_lesson_id: result.lessonId, lms_lesson_url: result.lessonUrl };
    if (rec.status === STATES.UPLOADED) fields.status = STATES.LMS_PUSHED;
    await updateRec(rec.id, fields);
    log(`lms pushed: ${rec.title} -> ${result.lessonUrl}`);
  } catch (err) {
    // Never blocks the Zoom delete — YouTube is the durable copy; retried next run.
    await updateRec(rec.id, { lms_status: 'failed' });
    details.warnings.push({ title: rec.title, message: `LMS push failed: ${err.message}` });
    logError(`lms push failed for rec ${rec.id}:`, err.message);
  }
}

// NOTE: Zoom deletion is intentionally MANUAL only — the pipeline never deletes
// a source. Deletion happens exclusively from the Sources page "Delete from Zoom"
// button (POST /api/sources/zoom/delete), which stays inactive until the
// recording has a verified YouTube link.
async function postUploadSteps(ctx, rec, rule, details) {
  await tryLmsPush(ctx, rec, rule, details);
}

// --- the download → upload core, shared by both sources ---

async function downloadUploadFinish(ctx, rec, rule, downloadFn, counts, details, progress = null) {
  let temp = null;
  try {
    const channel = await getChannelById(rule.channel_id);
    if (!channel) throw new Error('routing rule points to a missing YouTube channel');
    if (!channel.refresh_token) throw new Error(`YouTube channel "${channel.label}" is not connected (no refresh token)`);

    await updateRec(rec.id, {
      status: STATES.DOWNLOADING,
      matched_tag: rule.pattern,
      channel_id: channel.id,
      playlist_name: rule.playlist_name || null,
      error_message: null,
    });
    temp = tempFilePath(rec.id);
    progress?.startPhase('download');
    const dlStart = Date.now();
    const size = await downloadFn(temp, (done, total) => progress?.update(done, total));
    const dlMs = Date.now() - dlStart;
    progress?.finishPhase();

    await updateRec(rec.id, { status: STATES.UPLOADING, file_size_bytes: size });
    // Manual pushes may supply an exact title/description; otherwise derive from the tag.
    const ytTitle = rule.custom_title || buildVideoTitle(rec.title, rule.pattern, rule.keep_prefix);
    progress?.startPhase('upload', size);
    const ulStart = Date.now();
    const { videoId, url, uploadStatus } = await uploadVideo(channel, temp, {
      title: ytTitle,
      description: rule.custom_description || '',
      privacy: rule.privacy || 'unlisted',
      onProgress: (done, total) => progress?.update(done, total),
    });
    const ulMs = Date.now() - ulStart;
    progress?.finishPhase();

    // Verified upload: from here on this row can never re-enter the upload path.
    // Persist transfer metrics (for the Logs page) — captured for scheduled and manual alike.
    await updateRec(rec.id, {
      status: STATES.UPLOADED,
      youtube_video_id: videoId,
      youtube_url: url,
      uploaded_at: new Date(),
      download_ms: dlMs,
      upload_ms: ulMs,
      download_bps: dlMs > 0 ? Math.round(size / (dlMs / 1000)) : 0,
      upload_bps: ulMs > 0 ? Math.round(size / (ulMs / 1000)) : 0,
    });
    counts.uploaded++;
    details.posted.push({ title: ytTitle, source: rec.source, url, uploadStatus });
    log(`uploaded: ${ytTitle} -> ${url}`);
    progress?.finish();

    if (rule.playlist_name) {
      try {
        const playlistId = await ensurePlaylist(channel, rule.playlist_name);
        await addToPlaylist(channel, playlistId, videoId);
      } catch (err) {
        // Video is uploaded — never fail the row over a playlist problem.
        details.warnings.push({ title: ytTitle, message: `playlist add failed: ${err.message}` });
        logError(`playlist add failed for rec ${rec.id}:`, err.message);
      }
    }

    await postUploadSteps(ctx, await getRec(rec.id), rule, details);
  } catch (err) {
    counts.errors++;
    let message = err.message;
    // A dead refresh token: flag the channel so the dashboard shows it needs
    // reconnecting, and surface a plain-English message instead of invalid_grant.
    if (err.tokenInvalid && rule.channel_id) {
      await query("UPDATE youtube_channels SET status = 'reauth_required' WHERE id = $1", [rule.channel_id])
        .catch((e) => logError('could not flag channel reauth:', e.message));
      message = 'YouTube channel needs reconnecting — its authorization expired or was revoked. '
        + 'Go to Connections → YouTube → Reconnect (and publish the OAuth consent screen so tokens stop expiring).';
    }
    details.errors.push({ title: rec.title, source: rec.source, message });
    await updateRec(rec.id, { status: STATES.ERROR, error_message: message });
    logError(`processing failed for rec ${rec.id} (${rec.title}):`, err.message);
  } finally {
    cleanupTemp(temp);
  }
}

// --- per-source processing ---

async function processZoomRecording(ctx, rec, meeting, counts, details) {
  if (isLocked(recordingKey('zoom', rec.source_id))) return; // manual push in flight
  if (rec.youtube_video_id) {
    // already uploaded — only the safe post-steps remain
    const rule = matchRule(ctx.rules, 'zoom', rec.title);
    return postUploadSteps(ctx, rec, rule, details);
  }
  if (!RETRYABLE_STATES.has(rec.status)) return;

  const rule = matchRule(ctx.rules, 'zoom', rec.title);
  if (!rule) {
    await updateRec(rec.id, { status: STATES.SKIPPED_NO_ROUTE, error_message: null });
    return noteSkip(rec, 'no routing rule matched', counts, details);
  }
  const file = zoom.pickRecordingFile(meeting);
  if (!file) {
    // No shared_screen_with_speaker_view MP4 — do not guess, do not delete.
    await updateRec(rec.id, { status: STATES.SKIPPED_NO_VIEW, error_message: null });
    return noteSkip(rec, 'no shared_screen_with_speaker_view MP4 in this meeting', counts, details);
  }
  await updateRec(rec.id, { source_file_id: file.id || null });
  await downloadUploadFinish(
    ctx, rec, rule,
    (dest, onProgress) => zoom.downloadRecording(ctx.zoomAccount, file.download_url, dest, onProgress),
    counts, details,
  );
}

async function processFathomRecording(ctx, rec, shareUrl, counts, details) {
  if (isLocked(recordingKey('fathom', rec.source_id))) return; // manual push in flight
  if (rec.youtube_video_id) {
    const rule = matchRule(ctx.rules, 'fathom', rec.title);
    return postUploadSteps(ctx, rec, rule, details); // no delete for fathom (read-only API)
  }
  if (!RETRYABLE_STATES.has(rec.status)) return;

  const rule = matchRule(ctx.rules, 'fathom', rec.title);
  if (!rule) {
    await updateRec(rec.id, { status: STATES.SKIPPED_NO_ROUTE, error_message: null });
    return noteSkip(rec, 'no routing rule matched', counts, details);
  }
  if (!shareUrl) {
    counts.errors++;
    details.errors.push({ title: rec.title, source: 'fathom', message: 'no share_url available' });
    return updateRec(rec.id, { status: STATES.ERROR, error_message: 'no share_url available' });
  }
  await downloadUploadFinish(
    ctx, rec, rule,
    (dest, onProgress) => downloadFathomVideo(shareUrl, dest, onProgress),
    counts, details,
  );
}

async function processZoomPhase(ctx, seen, counts, details) {
  if (!ctx.zoomAccount) return log('zoom: no account connected, skipping');
  const meetings = await zoom.listRecordings(ctx.zoomAccount, ctx.windowDays);
  log(`zoom: ${meetings.length} meeting(s) in the last ${ctx.windowDays} day(s)`);
  for (const meeting of meetings) {
    try {
      const { rec, isNew } = await ensureRow('zoom', meeting.uuid, {
        title: meeting.topic,
        recorded_at: meeting.start_time || null,
        duration_minutes: meeting.duration ?? null,
      });
      if (isNew) counts.found++;
      seen.add(`zoom:${meeting.uuid}`);
      await processZoomRecording(ctx, rec, meeting, counts, details);
    } catch (err) {
      counts.errors++;
      details.errors.push({ title: meeting.topic, source: 'zoom', message: err.message });
      logError('zoom meeting processing failed:', err.message);
    }
  }
}

async function processFathomPhase(ctx, seen, counts, details) {
  const account = await fathom.getFathomAccount();
  if (!account) return log('fathom: no account connected, skipping');
  const meetings = await fathom.listMeetings(account, ctx.windowDays);
  log(`fathom: ${meetings.length} meeting(s) in the last ${ctx.windowDays} day(s)`);
  for (const m of meetings) {
    try {
      const { rec, isNew } = await ensureRow('fathom', m.recordingId, {
        title: m.title,
        recorded_at: m.recordedAt,
        duration_minutes: m.durationMinutes,
        source_meta: { share_url: m.shareUrl },
      });
      if (isNew) counts.found++;
      seen.add(`fathom:${m.recordingId}`);
      await processFathomRecording(ctx, rec, m.shareUrl || rec.source_meta?.share_url, counts, details);
    } catch (err) {
      counts.errors++;
      details.errors.push({ title: m.title, source: 'fathom', message: err.message });
      logError('fathom meeting processing failed:', err.message);
    }
  }
}

// Retry rows that fell out of the rolling window (error / skipped / interrupted),
// so adding a routing rule later still auto-processes old skips.
async function retrySweep(ctx, seen, counts, details) {
  const { rows } = await query(
    `SELECT * FROM processed_recordings
     WHERE status = ANY($1) AND youtube_video_id IS NULL
     ORDER BY id`,
    [[...RETRYABLE_STATES]],
  );
  for (const rec of rows) {
    if (seen.has(`${rec.source}:${rec.source_id}`)) continue;
    try {
      if (rec.source === 'zoom') {
        if (!ctx.zoomAccount) continue;
        const meeting = await zoom.getMeetingRecordings(ctx.zoomAccount, rec.source_id);
        if (!meeting) {
          await updateRec(rec.id, { error_message: 'recording no longer exists on Zoom' });
          continue;
        }
        await processZoomRecording(ctx, rec, meeting, counts, details);
      } else {
        await processFathomRecording(ctx, rec, rec.source_meta?.share_url, counts, details);
      }
    } catch (err) {
      counts.errors++;
      details.errors.push({ title: rec.title, source: rec.source, message: err.message });
      logError(`retry sweep failed for rec ${rec.id}:`, err.message);
    }
  }
}

// Push uploaded-but-not-yet-in-LMS rows (lms_status pending/failed). Runs once the
// LMS account is connected — this is what makes the dormant-LMS mode self-healing.
async function lmsSweep(ctx, details) {
  if (!lms.isConfigured(ctx.lmsAccount)) return;
  const { rows } = await query(
    `SELECT * FROM processed_recordings
     WHERE youtube_video_id IS NOT NULL AND lms_status = ANY($1)
     ORDER BY id`,
    [['pending', 'failed']],
  );
  for (const rec of rows) {
    const rule = matchRule(ctx.rules, rec.source, rec.title);
    await tryLmsPush(ctx, rec, rule, details);
  }
}

// --- manual per-video push (used by the Sources page queue) ---
// Uploads to an explicitly chosen channel and/or pushes to an explicitly chosen
// LMS course, bypassing routing rules for this one recording. Throws on failure
// so the queue can surface the message.

export async function manualPush(job) {
  const key = recordingKey(job.source, job.source_id);
  if (!lock(key)) throw new Error('This recording is already being processed.');
  // Live progress snapshot is written straight onto the job so the queue poll sees it.
  const tracker = new ProgressTracker((snap) => { job.progress = snap; });
  try {
    const cfg = await getConfigMap();
    const ctx = {
      cfg,
      windowDays: 30,
      zoomDeleteMode: cfg.zoom_delete_mode || 'off',
      zoomAccount: await zoom.getZoomAccount(),
      lmsAccount: await lms.getLmsAccount(),
      rules: await getRules(),
    };

    let rec;
    let meeting = null;
    let shareUrl = null;
    if (job.source === 'zoom') {
      if (!ctx.zoomAccount) throw new Error('Zoom is not connected.');
      // Use the account-level listing (works with the base recording scope)
      // instead of the granular per-meeting endpoint.
      meeting = await zoom.findMeetingInWindow(ctx.zoomAccount, job.source_id, 30);
      if (!meeting) throw new Error('Recording not found on Zoom (deleted or outside the 30-day window).');
      ({ rec } = await ensureRow('zoom', job.source_id, {
        title: meeting.topic,
        recorded_at: meeting.start_time || null,
        duration_minutes: meeting.duration ?? null,
      }));
    } else {
      const account = await fathom.getFathomAccount();
      if (!account) throw new Error('Fathom is not connected.');
      const meetings = await fathom.listMeetings(account, 30);
      const m = meetings.find((x) => x.recordingId === String(job.source_id));
      ({ rec } = await ensureRow('fathom', job.source_id, {
        title: m?.title || `Fathom recording ${job.source_id}`,
        recorded_at: m?.recordedAt || null,
        duration_minutes: m?.durationMinutes ?? null,
        source_meta: m?.shareUrl ? { share_url: m.shareUrl } : {},
      }));
      shareUrl = m?.shareUrl || rec.source_meta?.share_url || null;
    }

    rec = await getRec(rec.id);
    const rule = {
      pattern: rec.matched_tag || 'manual push',
      channel_id: job.channel_id || rec.channel_id || null,
      playlist_name: job.playlist_name || null,
      privacy: 'unlisted',
      keep_prefix: true,
      custom_title: job.video_title || null,       // explicit YouTube title override
      custom_description: job.description || null,  // explicit YouTube description
      lms_course_id: job.lms_course_id || null,
      lms_module_id: job.lms_module_id || null,
    };
    const counts = { found: 0, uploaded: 0, skipped: 0, errors: 0 };
    const details = { posted: [], skipped: [], errors: [], warnings: [] };

    if (!rec.youtube_video_id) {
      if (!rule.channel_id) {
        throw new Error('Pick a YouTube channel — this video has not been uploaded yet.');
      }
      if (job.source === 'zoom') {
        const file = zoom.findFile(meeting, job.file_id);
        if (!file) {
          throw new Error(job.file_id
            ? 'The selected Zoom file no longer exists — refresh the listing.'
            : 'No shared_screen_with_speaker_view MP4 on this Zoom meeting — pick a specific file to push.');
        }
        await updateRec(rec.id, { source_file_id: file.id || null });
        await downloadUploadFinish(
          ctx, rec, rule,
          (dest, onProgress) => zoom.downloadRecording(ctx.zoomAccount, file.download_url, dest, onProgress),
          counts, details, tracker,
        );
      } else {
        if (!shareUrl) throw new Error('No Fathom share URL available for this recording.');
        await downloadUploadFinish(
          ctx, rec, rule,
          (dest, onProgress) => downloadFathomVideo(shareUrl, dest, onProgress),
          counts, details, tracker,
        );
      }
      rec = await getRec(rec.id);
      if (!rec.youtube_video_id) {
        throw new Error(rec.error_message || details.errors[0]?.message || 'Upload failed.');
      }
    } else if (rule.lms_course_id) {
      await tryLmsPush(ctx, rec, rule, details);
      rec = await getRec(rec.id);
      if (rec.lms_status !== 'pushed') {
        throw new Error(details.warnings.at(-1)?.message || 'LMS push failed.');
      }
    } else {
      return {
        message: 'Already on YouTube — pick an LMS course to push it into the LMS.',
        youtube_url: rec.youtube_url,
        lms_lesson_url: rec.lms_lesson_url,
      };
    }

    rec = await getRec(rec.id);
    const warn = details.warnings.length ? ` (${details.warnings.map((w) => w.message).join('; ')})` : '';
    return {
      message: `done${warn}`,
      youtube_url: rec.youtube_url,
      lms_lesson_url: rec.lms_lesson_url,
      youtube_status: details.posted[0]?.uploadStatus || null,
      status: rec.status,
      transfer: tracker.transferSummary(),
    };
  } finally {
    unlock(key);
  }
}

// --- the run ---

export async function runPipeline(runType = 'manual') {
  if (running) return { alreadyRunning: true };
  running = true;
  const counts = { found: 0, uploaded: 0, skipped: 0, errors: 0 };
  const details = { posted: [], skipped: [], errors: [], warnings: [] };
  const { rows: [runRow] } = await query(
    'INSERT INTO run_logs (run_type) VALUES ($1) RETURNING id', [runType],
  );
  log(`run #${runRow.id} started (${runType})`);
  try {
    const cfg = await getConfigMap();
    const ctx = {
      cfg,
      windowDays: Math.max(1, Number(cfg.rolling_window_days) || 3),
      zoomDeleteMode: cfg.zoom_delete_mode || 'off',
      zoomAccount: await zoom.getZoomAccount(),
      lmsAccount: await lms.getLmsAccount(),
      rules: await getRules(),
    };
    const seen = new Set();
    await processZoomPhase(ctx, seen, counts, details);
    await processFathomPhase(ctx, seen, counts, details);
    await retrySweep(ctx, seen, counts, details);
    await lmsSweep(ctx, details);
    // Zoom deletion is manual only — no automatic delete sweep here.
  } catch (err) {
    counts.errors++;
    details.errors.push({ title: '(run)', message: err.message });
    logError('run failed:', err);
  } finally {
    await query(
      `UPDATE run_logs SET finished_at = now(), found = $1, uploaded = $2, skipped = $3,
       errors = $4, summary = $5 WHERE id = $6`,
      [counts.found, counts.uploaded, counts.skipped, counts.errors,
        JSON.stringify(details), runRow.id],
    ).catch((e) => logError('run_logs update failed:', e.message));
    running = false;
  }
  log(`run #${runRow.id} finished:`, JSON.stringify(counts));
  try {
    await sendRunSummary(runType, counts, details);
  } catch (err) {
    logError('summary email failed:', err.message);
  }
  return { runId: runRow.id, counts };
}
