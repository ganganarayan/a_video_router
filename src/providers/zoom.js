import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { query } from '../db.js';
import { decrypt } from '../lib/secrets.js';
import { log } from '../lib/logger.js';

const ZOOM_API = 'https://api.zoom.us/v2';

// Zoom meeting UUIDs containing '/' (or starting with '//') must be double-URL-encoded
// in path segments, per Zoom API docs.
export function encodeMeetingUUID(uuid) {
  if (uuid.startsWith('//') || uuid.includes('/')) {
    return encodeURIComponent(encodeURIComponent(uuid));
  }
  return encodeURIComponent(uuid);
}

export async function getZoomAccount() {
  const { rows } = await query('SELECT * FROM zoom_account ORDER BY id DESC LIMIT 1');
  return rows[0] || null;
}

let tokenCache = { token: null, expiresAt: 0, clientId: null };

export async function getAccessToken(account) {
  const now = Date.now();
  if (tokenCache.token && tokenCache.clientId === account.client_id && now < tokenCache.expiresAt) {
    return tokenCache.token;
  }
  const secret = decrypt(account.client_secret);
  const basic = Buffer.from(`${account.client_id}:${secret}`).toString('base64');
  const url = `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(account.account_id)}`;
  const res = await fetch(url, { method: 'POST', headers: { Authorization: `Basic ${basic}` } });
  if (!res.ok) {
    throw new Error(`Zoom token request failed (${res.status}): ${await res.text()}`);
  }
  const data = await res.json();
  tokenCache = {
    token: data.access_token,
    clientId: account.client_id,
    expiresAt: now + (data.expires_in - 60) * 1000,
  };
  return data.access_token;
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

export async function downloadRecording(account, downloadUrl, destPath) {
  const token = await getAccessToken(account);
  const res = await fetch(`${downloadUrl}?access_token=${token}`, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: 'follow',
  });
  if (!res.ok || !res.body) {
    throw new Error(`Zoom download failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(destPath));
  return fs.statSync(destPath).size;
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
