import { query } from '../db.js';
import { decrypt } from '../lib/secrets.js';

const FATHOM_API = 'https://api.fathom.ai/external/v1';
const RATE_DELAY_MS = 1100; // stay under 60 req/min

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function getFathomAccount(tenantId) {
  const { rows } = await query(
    'SELECT * FROM fathom_account WHERE tenant_id = $1 ORDER BY id DESC LIMIT 1', [tenantId],
  );
  return rows[0] || null;
}

async function fathomGet(apiKey, pathAndQuery) {
  const res = await fetch(`${FATHOM_API}${pathAndQuery}`, {
    headers: { 'X-Api-Key': apiKey, Accept: 'application/json' },
  });
  if (res.status === 429) {
    await sleep(5000);
    return fathomGet(apiKey, pathAndQuery);
  }
  if (!res.ok) throw new Error(`Fathom GET ${pathAndQuery} failed (${res.status}): ${await res.text()}`);
  return res.json();
}

async function fathomPost(apiKey, pathAndQuery, body) {
  const res = await fetch(`${FATHOM_API}${pathAndQuery}`, {
    method: 'POST',
    headers: { 'X-Api-Key': apiKey, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  if (res.status === 429) {
    await sleep(5000);
    return fathomPost(apiKey, pathAndQuery, body);
  }
  if (!res.ok) throw new Error(`Fathom POST ${pathAndQuery} failed (${res.status}): ${await res.text()}`);
  return res.json();
}

// --- Official download API (fast, single-file MP4 — no HLS remux) ---
// Fathom generates a real MP4 server-side and hands back a short-lived signed CDN
// URL, which downloads at full speed (like Zoom) and exposes the exact byte size.
// See https://developers.fathom.ai/api-reference/recordings/request-a-download

// Kick off async generation of the downloadable MP4; returns { download_id, status, video? }.
export async function requestDownload(account, recordingId) {
  const apiKey = decrypt(account.api_key);
  return fathomPost(apiKey, `/recordings/${recordingId}/download`, {});
}

// Poll the status of a download started with requestDownload.
export async function getDownloadStatus(account, recordingId, downloadId) {
  const apiKey = decrypt(account.api_key);
  return fathomGet(apiKey, `/recordings/${recordingId}/downloads/${downloadId}`);
}

// Request generation then poll until Fathom reports the MP4 ready, returning a
// ready-to-fetch { url, sizeBytes, contentType }. Throws a clear message on
// failure / expiry / timeout. This is the fast path that replaces the slow HLS
// remux: one CDN file, real byte size, resumable.
export async function resolveDownloadUrl(account, recordingId, opts = {}) {
  // Poll fairly tightly (1.5s ≈ 40 req/min, under the 60/min limit): Fathom renders
  // the MP4 on demand and the whole wait is counted inside the pipeline's download
  // timer, so slack polling directly inflates Fathom transfer time vs Zoom's
  // instant direct download. Faster polling detects "ready" sooner.
  const { timeoutMs = 8 * 60 * 1000, pollMs = 1500, onStatus } = opts;
  const pick = (d) => {
    if (!d) return null;
    if (d.status === 'failed') throw new Error(`Fathom could not generate the MP4 (${d.failure_reason || 'generation failed'}).`);
    if (d.status === 'expired') throw new Error('Fathom download expired before it could be fetched.');
    if (d.video && d.video.url) {
      return {
        url: d.video.url,
        sizeBytes: Number(d.video.file_size_bytes) || 0,
        contentType: d.video.content_type || 'video/mp4',
      };
    }
    return null;
  };
  const started = await requestDownload(account, recordingId);
  const immediate = pick(started);
  if (immediate) return immediate;
  const downloadId = started.download_id;
  if (!downloadId) throw new Error('Fathom download request returned no download_id.');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    onStatus?.('generating');
    const ready = pick(await getDownloadStatus(account, recordingId, downloadId));
    if (ready) return ready;
  }
  throw new Error('Fathom took too long to generate the MP4 (timed out).');
}

// Normalizes one Fathom meeting item to the fields the pipeline needs.
export function normalizeMeeting(m) {
  const recording = m.recording || {};
  return {
    recordingId: String(m.recording_id ?? recording.id ?? m.id ?? ''),
    title: m.title ?? m.meeting_title ?? 'Untitled Fathom recording',
    shareUrl: m.share_url ?? recording.share_url ?? m.url ?? null,
    recordedAt: m.recording_start_time ?? m.created_at ?? m.scheduled_start_time ?? null,
    durationMinutes: m.recording_duration_in_minutes != null
      ? Math.round(m.recording_duration_in_minutes)
      : (m.duration_in_minutes != null ? Math.round(m.duration_in_minutes) : null),
  };
}

// Lists meetings created in the rolling window (cursor pagination, rate-limited).
export async function listMeetings(account, windowDays) {
  const apiKey = decrypt(account.api_key);
  const createdAfter = new Date(Date.now() - windowDays * 24 * 3600 * 1000).toISOString();
  const items = [];
  let cursor = null;
  do {
    const qs = new URLSearchParams({ created_after: createdAfter });
    if (cursor) qs.set('cursor', cursor);
    const data = await fathomGet(apiKey, `/meetings?${qs}`);
    items.push(...(data.items || data.meetings || []));
    cursor = data.next_cursor || null;
    if (cursor) await sleep(RATE_DELAY_MS);
  } while (cursor);
  return items.map(normalizeMeeting).filter((m) => m.recordingId);
}

export async function testConnection(account) {
  const apiKey = decrypt(account.api_key);
  const data = await fathomGet(apiKey, '/meetings?created_after=' +
    encodeURIComponent(new Date(Date.now() - 24 * 3600 * 1000).toISOString()));
  const count = (data.items || data.meetings || []).length;
  return { ok: true, detail: `API key valid (${count} meeting(s) in the last 24h page)` };
}
