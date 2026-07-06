import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIngestPayload, isConfigured } from '../src/providers/lms.js';

const rec = {
  id: 10432,
  source: 'zoom',
  title: 'Online - 90 Day | Session 12',
  matched_tag: 'Online - 90 Day',
  youtube_url: 'https://youtu.be/AbC123xyz',
  recorded_at: '2026-07-06T05:30:00.000Z',
  duration_minutes: 88,
};
const rule = { lms_course_id: 'COURSE_1', lms_module_id: 'MOD_2' };

test('ingest payload matches the myappz.ai spec', () => {
  const p = buildIngestPayload(rec, rule);
  assert.equal(p.external_id, 'vr_10432'); // idempotency key
  assert.equal(p.video_url, 'https://youtu.be/AbC123xyz');
  assert.equal(p.source_file_url, null); // embed model, no file transfer
  assert.equal(p.title, 'Online - 90 Day | Session 12');
  assert.equal(p.source, 'zoom');
  assert.equal(p.program, 'Online - 90 Day');
  assert.equal(p.course_id, 'COURSE_1');
  assert.equal(p.module_id, 'MOD_2');
  assert.equal(p.recorded_at, '2026-07-06T05:30:00.000Z');
  assert.equal(p.duration_minutes, 88);
});

test('missing optional fields become nulls, not crashes', () => {
  const p = buildIngestPayload({ id: 1, source: 'fathom', title: 't', youtube_url: 'u' }, null);
  assert.equal(p.course_id, null);
  assert.equal(p.module_id, null);
  assert.equal(p.recorded_at, null);
  assert.equal(p.duration_minutes, null);
});

test('LMS stays dormant until an account is configured', () => {
  assert.equal(isConfigured(null), false);
  assert.equal(isConfigured({ base_url: '', api_key: 'k' }), false);
  assert.equal(isConfigured({ base_url: 'https://x', api_key: 'k' }), true);
});
