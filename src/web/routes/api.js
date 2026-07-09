import express from 'express';
import cron from 'node-cron';
import cronParser from 'cron-parser';
import { query, getConfigMap, setConfigValue } from '../../db.js';
import { encrypt } from '../../lib/secrets.js';
import { requireApiAuth, updateAccount, setSessionCookie } from '../auth.js';
import { runPipeline, isRunning } from '../../pipeline/run.js';
import { enqueuePush, getJobs } from '../../pipeline/manual.js';
import { reloadSchedules, getSchedules } from '../../scheduler.js';
import * as zoom from '../../providers/zoom.js';
import * as fathom from '../../providers/fathom.js';
import * as lms from '../../providers/lms.js';
import { getChannels, getChannelById, getVideoSnippet, updateVideoSnippet } from '../../providers/youtube.js';
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
  const schedules = await getSchedules();
  const enabled = schedules.filter((s) => s.enabled);
  let nextRun = null;
  for (const s of enabled) {
    try {
      const n = cronParser.parseExpression(s.cron_expression, { tz: s.timezone }).next().toISOString();
      if (!nextRun || n < nextRun) nextRun = n;
    } catch { /* skip invalid */ }
  }
  res.json({
    lastRun: lastRun || null,
    nextRun,
    activeSchedules: enabled.length,
    totalSchedules: schedules.length,
    totals,
    running: isRunning(),
  });
}));

// ---------- schedules (recurring runs) ----------

function nextRunOf(s) {
  if (!s.enabled) return null;
  try {
    return cronParser.parseExpression(s.cron_expression, { tz: s.timezone }).next().toISOString();
  } catch {
    return null;
  }
}

apiRouter.get('/schedules', wrap(async (_req, res) => {
  const rows = await getSchedules();
  res.json(rows.map((s) => ({ ...s, nextRun: nextRunOf(s) })));
}));

apiRouter.post('/schedules', wrap(async (req, res) => {
  const { name, cron_expression, timezone, enabled } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
  if (!cron.validate(cron_expression || '')) return res.status(400).json({ error: 'invalid cron expression' });
  await query(
    'INSERT INTO schedules (name, cron_expression, timezone, enabled) VALUES ($1, $2, $3, $4)',
    [name.trim(), cron_expression.trim(), (timezone || 'Asia/Kolkata').trim(), enabled !== false],
  );
  await reloadSchedules();
  res.json({ ok: true });
}));

apiRouter.put('/schedules/:id', wrap(async (req, res) => {
  const { name, cron_expression, timezone, enabled } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
  if (!cron.validate(cron_expression || '')) return res.status(400).json({ error: 'invalid cron expression' });
  await query(
    'UPDATE schedules SET name = $1, cron_expression = $2, timezone = $3, enabled = $4 WHERE id = $5',
    [name.trim(), cron_expression.trim(), (timezone || 'Asia/Kolkata').trim(), enabled !== false, Number(req.params.id)],
  );
  await reloadSchedules();
  res.json({ ok: true });
}));

// Stop / resume a schedule.
apiRouter.post('/schedules/:id/toggle', wrap(async (req, res) => {
  await query('UPDATE schedules SET enabled = $1 WHERE id = $2',
    [req.body.enabled !== false, Number(req.params.id)]);
  await reloadSchedules();
  res.json({ ok: true });
}));

apiRouter.delete('/schedules/:id', wrap(async (req, res) => {
  await query('DELETE FROM schedules WHERE id = $1', [Number(req.params.id)]);
  await reloadSchedules();
  res.json({ ok: true });
}));

// ---------- edit an uploaded video's YouTube title/description ----------

async function channelForRecording(id) {
  const { rows: [rec] } = await query('SELECT * FROM processed_recordings WHERE id = $1', [id]);
  if (!rec) throw Object.assign(new Error('recording not found'), { status: 404 });
  if (!rec.youtube_video_id) throw Object.assign(new Error('this recording has no YouTube video yet'), { status: 400 });
  const channel = await getChannelById(rec.channel_id);
  if (!channel?.refresh_token) throw Object.assign(new Error('the recording\'s YouTube channel is not connected'), { status: 400 });
  return { rec, channel };
}

apiRouter.get('/recordings/:id/youtube', wrap(async (req, res) => {
  const { rec, channel } = await channelForRecording(Number(req.params.id));
  const snippet = await getVideoSnippet(channel, rec.youtube_video_id);
  res.json({ title: snippet.title, description: snippet.description, url: rec.youtube_url });
}));

apiRouter.post('/recordings/:id/youtube', wrap(async (req, res) => {
  const { rec, channel } = await channelForRecording(Number(req.params.id));
  const title = String(req.body.title || '').trim();
  if (!title) return res.status(400).json({ error: 'title cannot be empty' });
  await updateVideoSnippet(channel, rec.youtube_video_id, { title, description: req.body.description || '' });
  // keep the link-log title in step with the YouTube title
  await query('UPDATE processed_recordings SET title = $1 WHERE id = $2', [title, rec.id]);
  res.json({ ok: true });
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
    `SELECT source, source_id, status, youtube_url, youtube_video_id, source_deleted,
            lms_lesson_url, file_size_bytes
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
          // uploadable MP4 files, so the row can offer an exact-file picker
          files: zoom.listVideoFiles(m).map((f) => ({
            id: f.id,
            recording_type: f.recording_type,
            file_size: f.file_size || 0,
            is_default: f.recording_type === 'shared_screen_with_speaker_view',
          })),
          status: rec?.status || 'not_processed',
          // Zoom download status = has the pipeline pulled this recording's bytes?
          // True once file_size_bytes is recorded (download completed) or it's on YouTube.
          downloaded: Boolean(rec?.file_size_bytes) || Boolean(rec?.youtube_video_id),
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
  const { source, source_id, file_id, title, video_title, description,
    channel_id, lms_course_id, lms_module_id } = req.body;
  if (!['zoom', 'fathom'].includes(source)) return res.status(400).json({ error: 'source must be zoom or fathom' });
  if (!source_id) return res.status(400).json({ error: 'source_id is required' });
  if (!channel_id && !lms_course_id) {
    return res.status(400).json({ error: 'Pick a YouTube channel and/or an LMS course to push to.' });
  }
  const { job, duplicate } = enqueuePush({
    source,
    source_id: String(source_id),
    file_id: file_id ? String(file_id) : null,
    title,
    video_title: video_title?.trim() || null,
    description: description?.trim() || null,
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

// Cron/timezone moved to the Schedules page; these are the remaining settings.
const SETTING_KEYS = ['rolling_window_days', 'zoom_delete_mode', 'email_to', 'email_from'];

apiRouter.get('/settings', wrap(async (_req, res) => {
  const cfg = await getConfigMap();
  res.json({
    ...Object.fromEntries(SETTING_KEYS.map((k) => [k, cfg[k] ?? ''])),
    gmail_app_password_set: Boolean(cfg.gmail_app_password),
  });
}));

apiRouter.post('/settings', wrap(async (req, res) => {
  const body = req.body;
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
