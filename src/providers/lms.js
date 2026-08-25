import { query } from '../db.js';
import { decrypt } from '../lib/secrets.js';

// myappz.ai LMS Video Ingest API (see MyAppz_LMS_Video_Ingest_API_Spec.md)
const INGEST_PATH = '/api/lms/video-ingest';
const SUCCESS_STATUSES = new Set(['created', 'updated', 'duplicate']);

export async function getLmsAccount(tenantId) {
  const { rows } = await query(
    'SELECT * FROM lms_account WHERE tenant_id = $1 ORDER BY id DESC LIMIT 1', [tenantId],
  );
  return rows[0] || null;
}

// The LMS is optional/dormant: pipeline only pushes when an account is saved.
export function isConfigured(account) {
  return Boolean(account && account.base_url && account.api_key);
}

// Pure payload builder (unit-tested). rec = processed_recordings row, rule = routing rule.
export function buildIngestPayload(rec, rule) {
  return {
    external_id: `vr_${rec.id}`,
    video_url: rec.youtube_url,
    source_file_url: null,
    title: rec.title,
    source: rec.source,
    program: rec.matched_tag || null,
    course_id: rule?.lms_course_id || null,
    module_id: rule?.lms_module_id || null,
    recorded_at: rec.recorded_at ? new Date(rec.recorded_at).toISOString() : null,
    duration_minutes: rec.duration_minutes ?? null,
    description: `Uploaded automatically by VideoRouter from ${rec.source}.`,
  };
}

export async function pushVideo(account, rec, rule) {
  const payload = buildIngestPayload(rec, rule);
  const res = await fetch(`${account.base_url.replace(/\/+$/, '')}${INGEST_PATH}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${decrypt(account.api_key)}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': payload.external_id,
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let data = {};
  try { data = JSON.parse(text); } catch { /* non-JSON error body */ }
  if (!res.ok || !SUCCESS_STATUSES.has(data.status)) {
    throw new Error(`LMS ingest failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return { lessonId: data.lms_lesson_id, lessonUrl: data.lms_lesson_url, status: data.status };
}

// Optional reconciliation endpoint.
export async function checkStatus(account, externalId) {
  const res = await fetch(
    `${account.base_url.replace(/\/+$/, '')}${INGEST_PATH}/${encodeURIComponent(externalId)}`,
    { headers: { Authorization: `Bearer ${decrypt(account.api_key)}` } },
  );
  if (!res.ok) throw new Error(`LMS status check failed (${res.status}): ${await res.text()}`);
  return res.json();
}

export async function testConnection(account) {
  // No dedicated ping endpoint in the spec — probe the status endpoint with a
  // sentinel id; any authenticated response (including 404) proves reachability + auth.
  const res = await fetch(
    `${account.base_url.replace(/\/+$/, '')}${INGEST_PATH}/vr_connection_test`,
    { headers: { Authorization: `Bearer ${decrypt(account.api_key)}` } },
  );
  if (res.status === 401 || res.status === 403) {
    throw new Error(`LMS rejected the API key (${res.status})`);
  }
  return { ok: true, detail: `LMS reachable (HTTP ${res.status})` };
}
