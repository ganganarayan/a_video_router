import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { config } from '../config.js';
import { query, getConfigValue } from '../db.js';
import { encrypt, decrypt } from '../lib/secrets.js';
import { log } from '../lib/logger.js';

const ZOOM_API = 'https://api.zoom.us/v2';

// The single platform-owned Zoom OAuth app (set once by the super-admin). Returns
// { clientId, clientSecret } or null when not configured.
export async function platformZoomCreds() {
  const clientId = (await getConfigValue('zoom_client_id')) || '';
  const clientSecret = decrypt((await getConfigValue('zoom_client_secret')) || '') || '';
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

export const zoomRedirectUri = () => `${config.publicUrl}/oauth/zoom/callback`;

// Start the user-level OAuth consent for the platform app. Zoom shows the app's
// configured scopes; the client just picks their account and approves.
export async function getZoomAuthUrl(state) {
  const creds = await platformZoomCreds();
  if (!creds) throw new Error('Zoom is not set up yet — the platform admin must add the Zoom OAuth app.');
  return 'https://zoom.us/oauth/authorize?' + new URLSearchParams({
    response_type: 'code',
    client_id: creds.clientId,
    redirect_uri: zoomRedirectUri(),
    state,
  }).toString();
}

// Exchange the consent code for tokens and store a per-tenant OAuth connection
// (replacing any prior Zoom row for that tenant).
export async function handleZoomOAuthCallback(tenantId, code) {
  const creds = await platformZoomCreds();
  if (!creds) throw new Error('Zoom is not set up yet — the platform admin must add the Zoom OAuth app.');
  const basic = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64');
  const url = `https://zoom.us/oauth/token?grant_type=authorization_code&code=${encodeURIComponent(code)}&redirect_uri=${encodeURIComponent(zoomRedirectUri())}`;
  const res = await fetch(url, { method: 'POST', headers: { Authorization: `Basic ${basic}` } });
  if (!res.ok) throw new Error(`Zoom token exchange failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  if (!data.refresh_token) throw new Error('Zoom did not return a refresh token — try connecting again.');
  const meRes = await fetch(`${ZOOM_API}/users/me`, { headers: { Authorization: `Bearer ${data.access_token}` } });
  const me = meRes.ok ? await meRes.json() : {};
  await query('DELETE FROM zoom_account WHERE tenant_id = $1', [tenantId]);
  await query(
    `INSERT INTO zoom_account (tenant_id, refresh_token, oauth_email, status) VALUES ($1, $2, $3, 'connected')`,
    [tenantId, encrypt(data.refresh_token), me.email || null],
  );
  log(`zoom connected via OAuth: ${me.email || 'unknown'} (tenant ${tenantId})`);
  return { email: me.email || '' };
}

// Zoom meeting UUIDs containing '/' (or starting with '//') must be double-URL-encoded
// in path segments, per Zoom API docs.
export function encodeMeetingUUID(uuid) {
  if (uuid.startsWith('//') || uuid.includes('/')) {
    return encodeURIComponent(encodeURIComponent(uuid));
  }
  return encodeURIComponent(uuid);
}

export async function getZoomAccount(tenantId) {
  const { rows } = await query(
    'SELECT * FROM zoom_account WHERE tenant_id = $1 ORDER BY id DESC LIMIT 1', [tenantId],
  );
  return rows[0] || null;
}

// Access tokens are cached per account row (not per client_id — the platform
// OAuth app shares one client_id across every tenant).
const tokenCache = new Map(); // accountId -> { token, expiresAt }

export async function getAccessToken(account) {
  const now = Date.now();
  const cached = tokenCache.get(account.id);
  if (cached && now < cached.expiresAt) return cached.token;

  let token, expiresIn;
  if (account.refresh_token) {
    // User-level OAuth via the platform app. Zoom ROTATES the refresh token on
    // every refresh, so we persist the new one or the next refresh would fail.
    const creds = await platformZoomCreds();
    if (!creds) throw new Error('Zoom is not set up yet — the platform admin must add the Zoom OAuth app.');
    const current = decrypt(account.refresh_token);
    const basic = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64');
    const url = `https://zoom.us/oauth/token?grant_type=refresh_token&refresh_token=${encodeURIComponent(current)}`;
    const res = await fetch(url, { method: 'POST', headers: { Authorization: `Basic ${basic}` } });
    if (!res.ok) throw new Error(`Zoom token refresh failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    token = data.access_token;
    expiresIn = data.expires_in;
    if (data.refresh_token && data.refresh_token !== current) {
      const enc = encrypt(data.refresh_token);
      await query('UPDATE zoom_account SET refresh_token = $1, updated_at = now() WHERE id = $2', [enc, account.id]);
      account.refresh_token = enc; // keep the in-memory row consistent for this request
    }
  } else {
    // Legacy Server-to-Server OAuth (per-account credentials).
    const secret = decrypt(account.client_secret);
    const basic = Buffer.from(`${account.client_id}:${secret}`).toString('base64');
    const url = `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(account.account_id)}`;
    const res = await fetch(url, { method: 'POST', headers: { Authorization: `Basic ${basic}` } });
    if (!res.ok) throw new Error(`Zoom token request failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    token = data.access_token;
    expiresIn = data.expires_in;
  }
  tokenCache.set(account.id, { token, expiresAt: now + (expiresIn - 60) * 1000 });
  return token;
}

async function zoomGet(token, pathAndQuery) {
  const res = await fetch(`${ZOOM_API}${pathAndQuery}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Zoom GET ${pathAndQuery} failed (${res.status}): ${await res.text()}`);
  return res.json();
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

// Lists all meetings with cloud recordings in the rolling window (paginated).
export async function listRecordings(account, windowDays) {
  const token = await getAccessToken(account);
  const to = new Date();
  const from = new Date(to.getTime() - windowDays * 24 * 3600 * 1000);
  const meetings = [];
  let nextPageToken = '';
  do {
    const qs = new URLSearchParams({ from: isoDate(from), to: isoDate(to), page_size: '300' });
    if (nextPageToken) qs.set('next_page_token', nextPageToken);
    const data = await zoomGet(token, `/users/me/recordings?${qs}`);
    meetings.push(...(data.meetings || []));
    nextPageToken = data.next_page_token || '';
  } while (nextPageToken);
  return meetings;
}

// Lists the most recent `limit` recordings. Zoom caps each query at a one-month
// range, so we walk backward one month at a time and stop as soon as we have
// enough (the common case is a single call). Newest first, de-duped by uuid.
export async function listRecentRecordings(account, limit = 20, maxMonths = 6) {
  const token = await getAccessToken(account);
  const collected = [];
  const seen = new Set();
  let to = new Date();
  for (let month = 0; month < maxMonths && collected.length < limit; month++) {
    const from = new Date(to.getTime() - 30 * 24 * 3600 * 1000);
    let nextPageToken = '';
    do {
      const qs = new URLSearchParams({ from: isoDate(from), to: isoDate(to), page_size: '300' });
      if (nextPageToken) qs.set('next_page_token', nextPageToken);
      const data = await zoomGet(token, `/users/me/recordings?${qs}`);
      for (const m of data.meetings || []) {
        if (!seen.has(m.uuid)) { seen.add(m.uuid); collected.push(m); }
      }
      nextPageToken = data.next_page_token || '';
    } while (nextPageToken);
    // Contiguous windows: the next one ends exactly where this began (uuid de-dup
    // guards the shared boundary day), so no recording falls into a gap.
    to = from;
  }
  return collected
    .sort((a, b) => new Date(b.start_time || 0) - new Date(a.start_time || 0))
    .slice(0, limit);
}

// Re-fetch a single meeting's recordings by UUID (used by the retry sweep after
// the meeting has left the rolling window).
export async function getMeetingRecordings(account, meetingUuid) {
  const token = await getAccessToken(account);
  try {
    return await zoomGet(token, `/meetings/${encodeMeetingUUID(meetingUuid)}/recordings`);
  } catch (err) {
    if (String(err.message).includes('(404)')) return null; // recording gone
    throw err;
  }
}

// The one file the automatic pipeline wants: screen share + speaker view, MP4.
export function pickRecordingFile(meeting) {
  return (meeting.recording_files || []).find(
    (f) => f.recording_type === 'shared_screen_with_speaker_view' && f.file_type === 'MP4',
  ) || null;
}

// All uploadable (MP4) files of a meeting, for the manual per-file picker.
export function listVideoFiles(meeting) {
  return (meeting.recording_files || []).filter((f) => f.file_type === 'MP4');
}

// Resolve a specific file by its Zoom file id; fall back to the auto-pick when
// no id is given (used by manual push).
export function findFile(meeting, fileId) {
  if (!fileId) return pickRecordingFile(meeting);
  return (meeting.recording_files || []).find((f) => f.id === fileId) || null;
}

// Locate a meeting within the account-level listing (the endpoint that works
// with the base recording scope) — avoids the granular per-meeting endpoint.
export async function findMeetingInWindow(account, meetingUuid, windowDays = 30) {
  const meetings = await listRecordings(account, windowDays);
  return meetings.find((m) => m.uuid === meetingUuid) || null;
}

// Locate a meeting by UUID across the same recent-listing window the Sources
// page shows. The Sources listing lists the latest N recordings (which can span
// several months via listRecentRecordings), but a 30-day findMeetingInWindow
// misses anything older than 30 days — that broke Preview/Download for every
// row after the newest one. We walk backward one month at a time (Zoom's
// per-query cap) and stop as soon as we find the UUID.
export async function findRecentMeeting(account, meetingUuid, maxMonths = 6) {
  const token = await getAccessToken(account);
  let to = new Date();
  for (let month = 0; month < maxMonths; month++) {
    const from = new Date(to.getTime() - 30 * 24 * 3600 * 1000);
    let nextPageToken = '';
    do {
      const qs = new URLSearchParams({ from: isoDate(from), to: isoDate(to), page_size: '300' });
      if (nextPageToken) qs.set('next_page_token', nextPageToken);
      const data = await zoomGet(token, `/users/me/recordings?${qs}`);
      const hit = (data.meetings || []).find((m) => m.uuid === meetingUuid);
      if (hit) return hit;
      nextPageToken = data.next_page_token || '';
    } while (nextPageToken);
    to = new Date(from.getTime() - 24 * 3600 * 1000);
  }
  return null;
}

export async function downloadRecording(account, downloadUrl, destPath, onProgress) {
  const token = await getAccessToken(account);
  const res = await fetch(`${downloadUrl}?access_token=${token}`, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: 'follow',
  });
  if (!res.ok || !res.body) {
    throw new Error(`Zoom download failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
  const total = Number(res.headers.get('content-length')) || 0;
  let received = 0;
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      received += chunk.length;
      onProgress?.(received, total);
      cb(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(destPath));
  return fs.statSync(destPath).size;
}

// Open an authenticated read stream for a recording file (for streaming straight to
// the browser — the free "download to local computer" feature, and inline preview).
// Caller pipes res.body. An optional Range header is forwarded so the browser's
// <video> element can seek (Zoom serves 206 Partial Content), which also lets it
// fetch the moov atom when it sits at the end of the file.
export async function openRecordingStream(account, downloadUrl, rangeHeader) {
  const token = await getAccessToken(account);
  const headers = { Authorization: `Bearer ${token}` };
  if (rangeHeader) headers.Range = rangeHeader;
  const res = await fetch(`${downloadUrl}?access_token=${token}`, { headers, redirect: 'follow' });
  if ((!res.ok && res.status !== 206) || !res.body) {
    throw new Error(`Zoom download failed (${res.status})`);
  }
  return res;
}

// Permanent delete or trash of ALL recording files of the meeting. Reclaims Zoom storage.
export async function deleteMeetingRecordings(account, meetingUuid, mode) {
  if (mode !== 'trash' && mode !== 'delete') throw new Error(`invalid zoom delete mode: ${mode}`);
  const token = await getAccessToken(account);
  const url = `${ZOOM_API}/meetings/${encodeMeetingUUID(meetingUuid)}/recordings?action=${mode}`;
  const res = await fetch(url, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 204 || res.status === 200) return true;
  throw new Error(`Zoom delete failed (${res.status}): ${await res.text()}`);
}

export async function testConnection(account) {
  const token = await getAccessToken(account);
  const me = await zoomGet(token, '/users/me');
  log(`zoom test ok: ${me.email}`);
  return { ok: true, detail: `Connected as ${me.email}` };
}
