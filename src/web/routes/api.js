import express from 'express';
import cron from 'node-cron';
import cronParser from 'cron-parser';
import { query, getConfigMap, setConfigValue } from '../../db.js';
import { encrypt } from '../../lib/secrets.js';
import { requireApiAuth, updateAccount, setSessionCookie } from '../auth.js';
import { runPipeline, isRunning } from '../../pipeline/run.js';
import { enqueuePush, getJobs } from '../../pipeline/manual.js';
import { reschedule, getSchedule } from '../../scheduler.js';
import * as zoom from '../../providers/zoom.js';
import * as fathom from '../../providers/fathom.js';
import * as lms from '../../providers/lms.js';
import { getChannels } from '../../providers/youtube.js';
import { canDeleteZoomSource } from '../../pipeline/states.js';
import { config } from '../../config.js';
import { log, logError } from '../../lib/logger.js';

export const apiRouter = express.Router();
apiRouter.use(requireApiAuth);

const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// ---------- overview / runs / recordings ----------

apiRouter.get('/overview', wrap(async (_req, res) => {
  const { rows: [lastRun] } = await query('SELECT * FROM run_logs ORDER BY id DESC LIMIT 1');
  const { rows: [totals] } = await query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE youtube_video_id IS NOT NULL)::int AS uploaded,
            count(*) FILTER (WHERE status = 'error')::int AS errors,
            count(*) FILTER (WHERE status LIKE 'skipped%')::int AS skipped
     FROM processed_recordings`,
  );
  const schedule = getSchedule();
  let nextRun = null;
  try {
    if (schedule.expression) {
      nextRun = cronParser.parseExpression(schedule.expression, { tz: schedule.timezone })
        .next().toISOString();
    }
  } catch { /* leave null */ }
  res.json({ lastRun: lastRun || null, nextRun, schedule, totals, running: isRunning() });
}));

apiRouter.get('/runs', wrap(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const { rows } = await query('SELECT * FROM run_logs ORDER BY id DESC LIMIT $1', [limit]);
  res.json(rows);
}));

apiRouter.get('/recordings', wrap(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  const q = String(req.query.q || '').trim();
  const status = String(req.query.status || '').trim();
  const where = [];
  const params = [];
  if (q) {
    params.push(`%${q}%`);
    where.push(`(title ILIKE $${params.length} OR matched_tag ILIKE $${params.length})`);
  }
  if (status) {
    params.push(status);
    where.push(`status = $${params.length}`);
  }
  params.push(limit);
  const { rows } = await query(
    `SELECT p.*, c.label AS channel_label
     FROM processed_recordings p
     LEFT JOIN youtube_channels c ON c.id = p.channel_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY coalesce(p.uploaded_at, p.discovered_at) DESC
     LIMIT $${params.length}`,
    params,
  );
  res.json(rows);
}));

apiRouter.post('/run-now', wrap(async (_req, res) => {
  if (isRunning()) return res.status(409).json({ error: 'A run is already in progress.' });
  runPipeline('manual').catch((err) => logError('manual run crashed:', err));
  res.json({ started: true });
}));

// ---------- source videos (live listing from Zoom/Fathom) ----------

apiRouter.get('/sources', wrap(async (req, res) => {
  // Zoom's list endpoint caps the range at 30 days per request.
  const windowDays = Math.min(Math.max(Number(req.query.days) || 30, 1), 30);
  const [zoomAccount, fathomAccount] = await Promise.all([
    zoom.getZoomAccount(), fathom.getFathomAccount(),
  ]);
  const { rows: dbRows } = await query(
    `SELECT source, source_id, status, youtube_url, youtube_video_id, source_deleted, lms_lesson_url
     FROM processed_recordings`,
  );
  const byKey = new Map(dbRows.map((r) => [`${r.source}:${r.source_id}`, r]));
  const result = { windowDays, zoom: null, fathom: null, errors: {} };

  if (zoomAccount) {
    try {
      const meetings = await zoom.listRecordings(zoomAccount, windowDays);
      result.zoom = meetings.map((m) => {
        const rec = byKey.get(`zoom:${m.uuid}`) || null;
        return {
          source_id: m.uuid,
          title: m.topic,
          recorded_at: m.start_time || null,
          duration_minutes: m.duration ?? null,
          total_bytes: (m.recording_files || []).reduce((s, f) => s + (f.file_size || 0), 0),
          has_target_view: Boolean(zoom.pickRecordingFile(m)),
          status: rec?.status || 'not_processed',
          youtube_url: rec?.youtube_url || null,
          lms_lesson_url: rec?.lms_lesson_url || null,
          source_deleted: rec?.source_deleted || false,
          // delete stays inactive until the YouTube link exists on this exact row
          can_delete: Boolean(rec?.youtube_video_id) && !rec?.source_deleted,
        };
      });
    } catch (err) {
      result.errors.zoom = err.message;
    }
  }

  if (fathomAccount) {
    try {
      const meetings = await fathom.listMeetings(fathomAccount, windowDays);
      result.fathom = meetings.map((m) => {
        const rec = byKey.get(`fathom:${m.recordingId}`) || null;
        return {
          source_id: m.recordingId,
          title: m.title,
          recorded_at: m.recordedAt,
          duration_minutes: m.durationMinutes,
          status: rec?.status || 'not_processed',
          youtube_url: rec?.youtube_url || null,
          lms_lesson_url: rec?.lms_lesson_url || null,
        };
      });
    } catch (err) {
      result.errors.fathom = err.message;
    }
  }

  res.json(result);
}));

// Queue a manual per-video push (upload to a chosen channel and/or push to a
// chosen LMS course). Jobs run sequentially in the background.
apiRouter.post('/push', wrap(async (req, res) => {
  const { source, source_id, title, channel_id, lms_course_id, lms_module_id } = req.body;
  if (!['zoom', 'fathom'].includes(source)) return res.status(400).json({ error: 'source must be zoom or fathom' });
  if (!source_id) return res.status(400).json({ error: 'source_id is required' });
  if (!channel_id && !lms_course_id) {
    return res.status(400).json({ error: 'Pick a YouTube channel and/or an LMS course to push to.' });
  }
  const { job, duplicate } = enqueuePush({
    source,
    source_id: String(source_id),
    title,
    channel_id: channel_id ? Number(channel_id) : null,
    lms_course_id: lms_course_id?.trim() || null,
    lms_module_id: lms_module_id?.trim() || null,
  });
  res.json({ ok: true, jobId: job.id, duplicate });
}));

apiRouter.get('/push-queue', wrap(async (_req, res) => {
  res.json(getJobs());
}));

// Manual Zoom delete — same safety gate as the pipeline: only rows that hold a
// verified YouTube video id can ever be deleted at the source.
apiRouter.post('/sources/zoom/delete', wrap(async (req, res) => {
  const sourceId = String(req.body.source_id || '');
  if (!sourceId) return res.status(400).json({ error: 'source_id is required' });
  const account = await zoom.getZoomAccount();
  if (!account) return res.status(400).json({ error: 'Zoom is not connected.' });

  const { rows: [rec] } = await query(
    `SELECT * FROM processed_recordings WHERE source = 'zoom' AND source_id = $1`, [sourceId],
  );
  const cfg = await getConfigMap();
  const mode = cfg.zoom_delete_mode === 'trash' ? 'trash' : 'delete';
  if (!rec || !canDeleteZoomSource(rec, mode)) {
    return res.status(400).json({
      error: 'Blocked: this recording has no verified YouTube upload yet (or is already deleted). Run the pipeline first.',
    });
  }
  await zoom.deleteMeetingRecordings(account, sourceId, mode);
  await query(
    `UPDATE processed_recordings SET status = 'deleted', source_deleted = true WHERE id = $1`,
    [rec.id],
  );
  log(`manual zoom delete (${mode}): ${rec.title}`);
  res.json({ ok: true, mode });
}));

// ---------- connections ----------

apiRouter.get('/connections', wrap(async (_req, res) => {
  const { rows: [z] } = await query('SELECT id, account_id, client_id, status, updated_at FROM zoom_account ORDER BY id DESC LIMIT 1');
  const { rows: [f] } = await query('SELECT id, status, updated_at FROM fathom_account ORDER BY id DESC LIMIT 1');
  const { rows: [l] } = await query('SELECT id, base_url, status, updated_at FROM lms_account ORDER BY id DESC LIMIT 1');
  const channels = (await getChannels()).map((c) => ({
    id: c.id, label: c.label, channel_id: c.channel_id, channel_handle: c.channel_handle,
    oauth_client_id: c.oauth_client_id, status: c.status, connected: Boolean(c.refresh_token),
  }));
  res.json({
    zoom: z || null,
    fathom: f ? { ...f, has_key: true } : null,
    lms: l || null,
    channels,
    oauthCallbackUrl: `${config.publicUrl}/oauth/youtube/callback`,
  });
}));

apiRouter.post('/connections/zoom', wrap(async (req, res) => {
  const { account_id, client_id, client_secret } = req.body;
  if (!account_id || !client_id || !client_secret) {
    return res.status(400).json({ error: 'account_id, client_id and client_secret are required' });
  }
  await query('DELETE FROM zoom_account');
  await query(
    `INSERT INTO zoom_account (account_id, client_id, client_secret, status) VALUES ($1, $2, $3, 'unverified')`,
    [account_id.trim(), client_id.trim(), encrypt(client_secret.trim())],
  );
  res.json({ ok: true });
}));

apiRouter.post('/connections/zoom/test', wrap(async (_req, res) => {
  const account = await zoom.getZoomAccount();
  if (!account) return res.status(400).json({ error: 'Save Zoom credentials first.' });
  try {
    const result = await zoom.testConnection(account);
    await query(`UPDATE zoom_account SET status = 'connected', updated_at = now() WHERE id = $1`, [account.id]);
    res.json(result);
  } catch (err) {
    await query(`UPDATE zoom_account SET status = 'error', updated_at = now() WHERE id = $1`, [account.id]);
    res.status(400).json({ error: err.message });
  }
}));

apiRouter.post('/connections/fathom', wrap(async (req, res) => {
  const { api_key } = req.body;
  if (!api_key) return res.status(400).json({ error: 'api_key is required' });
  await query('DELETE FROM fathom_account');
  await query(`INSERT INTO fathom_account (api_key, status) VALUES ($1, 'unverified')`, [encrypt(api_key.trim())]);
  res.json({ ok: true });
}));

apiRouter.post('/connections/fathom/test', wrap(async (_req, res) => {
  const account = await fathom.getFathomAccount();
  if (!account) return res.status(400).json({ error: 'Save a Fathom API key first.' });
  try {
    const result = await fathom.testConnection(account);
    await query(`UPDATE fathom_account SET status = 'connected', updated_at = now() WHERE id = $1`, [account.id]);
    res.json(result);
  } catch (err) {
    await query(`UPDATE fathom_account SET status = 'error', updated_at = now() WHERE id = $1`, [account.id]);
    res.status(400).json({ error: err.message });
  }
}));

apiRouter.post('/connections/lms', wrap(async (req, res) => {
  const { base_url, api_key } = req.body;
  if (!base_url || !api_key) return res.status(400).json({ error: 'base_url and api_key are required' });
  await query('DELETE FROM lms_account');
  await query(
    `INSERT INTO lms_account (base_url, api_key, status) VALUES ($1, $2, 'unverified')`,
    [base_url.trim().replace(/\/+$/, ''), encrypt(api_key.trim())],
  );
  res.json({ ok: true });
}));

apiRouter.post('/connections/lms/test', wrap(async (_req, res) => {
  const account = await lms.getLmsAccount();
  if (!account) return res.status(400).json({ error: 'Save LMS settings first.' });
  try {
    const result = await lms.testConnection(account);
    await query(`UPDATE lms_account SET status = 'connected', updated_at = now() WHERE id = $1`, [account.id]);
    res.json(result);
  } catch (err) {
    await query(`UPDATE lms_account SET status = 'error', updated_at = now() WHERE id = $1`, [account.id]);
    res.status(400).json({ error: err.message });
  }
}));

// ---------- YouTube channels ----------

apiRouter.post('/channels', wrap(async (req, res) => {
  const { label, oauth_client_id, oauth_client_secret } = req.body;
  if (!label || !oauth_client_id || !oauth_client_secret) {
    return res.status(400).json({ error: 'label, oauth_client_id and oauth_client_secret are required' });
  }
  const { rows: [row] } = await query(
    `INSERT INTO youtube_channels (label, oauth_client_id, oauth_client_secret)
     VALUES ($1, $2, $3) RETURNING id`,
    [label.trim(), oauth_client_id.trim(), encrypt(oauth_client_secret.trim())],
  );
  res.json({ ok: true, id: row.id, connectUrl: `/oauth/youtube/start/${row.id}` });
}));

apiRouter.put('/channels/:id', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const { label, oauth_client_id, oauth_client_secret } = req.body;
  const sets = [];
  const params = [];
  if (label) { params.push(label.trim()); sets.push(`label = $${params.length}`); }
  if (oauth_client_id) { params.push(oauth_client_id.trim()); sets.push(`oauth_client_id = $${params.length}`); }
  if (oauth_client_secret) { params.push(encrypt(oauth_client_secret.trim())); sets.push(`oauth_client_secret = $${params.length}`); }
  if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
  params.push(id);
  await query(`UPDATE youtube_channels SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
  res.json({ ok: true });
}));

apiRouter.delete('/channels/:id', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const { rowCount } = await query('SELECT 1 FROM routing_rules WHERE channel_id = $1 LIMIT 1', [id]);
  if (rowCount) return res.status(409).json({ error: 'Channel is used by routing rules — delete or repoint those first.' });
  await query('UPDATE processed_recordings SET channel_id = NULL WHERE channel_id = $1', [id]);
  await query('DELETE FROM youtube_channels WHERE id = $1', [id]);
  res.json({ ok: true });
}));

// ---------- routing rules ----------

apiRouter.get('/rules', wrap(async (_req, res) => {
  const { rows } = await query(
    `SELECT r.*, c.label AS channel_label, c.channel_handle
     FROM routing_rules r LEFT JOIN youtube_channels c ON c.id = r.channel_id
     ORDER BY r.priority, r.id`,
  );
  res.json(rows);
}));

const RULE_FIELDS = ['source', 'match_type', 'pattern', 'channel_id', 'playlist_name',
  'privacy', 'keep_prefix', 'lms_course_id', 'lms_module_id', 'priority', 'enabled'];

function ruleValues(body) {
  const errors = [];
  if (!body.pattern?.trim()) errors.push('pattern is required');
  if (!body.channel_id) errors.push('channel is required');
  if (body.source && !['any', 'zoom', 'fathom'].includes(body.source)) errors.push('bad source');
  if (body.match_type && !['contains', 'prefix', 'regex'].includes(body.match_type)) errors.push('bad match_type');
  if (body.privacy && !['unlisted', 'private', 'public'].includes(body.privacy)) errors.push('bad privacy');
  return {
    errors,
    values: {
      source: body.source || 'any',
      match_type: body.match_type || 'contains',
      pattern: body.pattern?.trim(),
      channel_id: Number(body.channel_id) || null,
      playlist_name: body.playlist_name?.trim() || null,
      privacy: body.privacy || 'unlisted',
      keep_prefix: body.keep_prefix !== false && body.keep_prefix !== 'false',
      lms_course_id: body.lms_course_id?.trim() || null,
      lms_module_id: body.lms_module_id?.trim() || null,
      priority: Number(body.priority) || 100,
      enabled: body.enabled !== false && body.enabled !== 'false',
    },
  };
}

apiRouter.post('/rules', wrap(async (req, res) => {
  const { errors, values } = ruleValues(req.body);
  if (errors.length) return res.status(400).json({ error: errors.join('; ') });
  const cols = RULE_FIELDS.join(', ');
  const placeholders = RULE_FIELDS.map((_, i) => `$${i + 1}`).join(', ');
  const { rows: [row] } = await query(
    `INSERT INTO routing_rules (${cols}) VALUES (${placeholders}) RETURNING id`,
    RULE_FIELDS.map((f) => values[f]),
  );
  res.json({ ok: true, id: row.id });
}));

apiRouter.put('/rules/:id', wrap(async (req, res) => {
  const { errors, values } = ruleValues(req.body);
  if (errors.length) return res.status(400).json({ error: errors.join('; ') });
  const sets = RULE_FIELDS.map((f, i) => `${f} = $${i + 1}`).join(', ');
  await query(
    `UPDATE routing_rules SET ${sets} WHERE id = $${RULE_FIELDS.length + 1}`,
    [...RULE_FIELDS.map((f) => values[f]), Number(req.params.id)],
  );
  res.json({ ok: true });
}));

apiRouter.delete('/rules/:id', wrap(async (req, res) => {
  await query('DELETE FROM routing_rules WHERE id = $1', [Number(req.params.id)]);
  res.json({ ok: true });
}));

// ---------- settings ----------

const SETTING_KEYS = ['cron_expression', 'timezone', 'rolling_window_days',
  'zoom_delete_mode', 'email_to', 'email_from'];

apiRouter.get('/settings', wrap(async (_req, res) => {
  const cfg = await getConfigMap();
  res.json({
    ...Object.fromEntries(SETTING_KEYS.map((k) => [k, cfg[k] ?? ''])),
    gmail_app_password_set: Boolean(cfg.gmail_app_password),
  });
}));

apiRouter.post('/settings', wrap(async (req, res) => {
  const body = req.body;
  if (body.cron_expression && !cron.validate(body.cron_expression)) {
    return res.status(400).json({ error: 'Invalid cron expression.' });
  }
  if (body.zoom_delete_mode && !['off', 'trash', 'delete'].includes(body.zoom_delete_mode)) {
    return res.status(400).json({ error: 'zoom_delete_mode must be off, trash or delete.' });
  }
  if (body.rolling_window_days && !(Number(body.rolling_window_days) >= 1)) {
    return res.status(400).json({ error: 'rolling_window_days must be >= 1.' });
  }
  for (const key of SETTING_KEYS) {
    if (body[key] !== undefined) await setConfigValue(key, String(body[key]).trim());
  }
  if (body.gmail_app_password) {
    await setConfigValue('gmail_app_password', encrypt(String(body.gmail_app_password).trim()));
  }
  await reschedule();
  res.json({ ok: true });
}));

apiRouter.post('/settings/account', wrap(async (req, res) => {
  const result = await updateAccount(req.user, req.body.current_password, {
    newEmail: req.body.new_email?.trim() || null,
    newPassword: req.body.new_password || null,
  });
  if (!result.ok) return res.status(400).json({ error: result.error });
  setSessionCookie(res, result.email); // keep the session valid under the new email
  res.json({ ok: true, email: result.email });
}));
