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
