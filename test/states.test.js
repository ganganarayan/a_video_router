import test from 'node:test';
import assert from 'node:assert/strict';
import { STATES, RETRYABLE_STATES, canDeleteZoomSource } from '../src/pipeline/states.js';

const uploadedZoomRec = {
  source: 'zoom',
  status: STATES.UPLOADED,
  youtube_video_id: 'AbC123xyz',
  source_deleted: false,
};

test('delete allowed only with a verified YouTube video id', () => {
  assert.equal(canDeleteZoomSource(uploadedZoomRec, 'delete'), true);
  assert.equal(canDeleteZoomSource(uploadedZoomRec, 'trash'), true);
  // THE guard: same row without a video id must never be deletable,
  // regardless of what status claims.
  assert.equal(canDeleteZoomSource({ ...uploadedZoomRec, youtube_video_id: null }, 'delete'), false);
  assert.equal(canDeleteZoomSource({ ...uploadedZoomRec, youtube_video_id: '' }, 'delete'), false);
});

test('delete mode off blocks deletion even after upload', () => {
  assert.equal(canDeleteZoomSource(uploadedZoomRec, 'off'), false);
  assert.equal(canDeleteZoomSource(uploadedZoomRec, undefined), false);
  assert.equal(canDeleteZoomSource(uploadedZoomRec, 'weird'), false);
});

test('fathom recordings are never deletable', () => {
  assert.equal(canDeleteZoomSource({ ...uploadedZoomRec, source: 'fathom' }, 'delete'), false);
});

test('already-deleted sources are not deleted twice', () => {
  assert.equal(canDeleteZoomSource({ ...uploadedZoomRec, source_deleted: true }, 'delete'), false);
});

test('skip states cannot reach delete (no video id by construction)', () => {
  for (const status of [STATES.SKIPPED_NO_ROUTE, STATES.SKIPPED_NO_VIEW]) {
    const rec = { source: 'zoom', status, youtube_video_id: null, source_deleted: false };
    assert.equal(canDeleteZoomSource(rec, 'delete'), false);
  }
});

test('retryable states exclude anything past a verified upload', () => {
  assert.equal(RETRYABLE_STATES.has(STATES.UPLOADED), false);
  assert.equal(RETRYABLE_STATES.has(STATES.LMS_PUSHED), false);
  assert.equal(RETRYABLE_STATES.has(STATES.DELETED), false);
  assert.equal(RETRYABLE_STATES.has(STATES.ERROR), true);
  assert.equal(RETRYABLE_STATES.has(STATES.SKIPPED_NO_ROUTE), true);
  assert.equal(RETRYABLE_STATES.has(STATES.SKIPPED_NO_VIEW), true);
});
