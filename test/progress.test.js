import test from 'node:test';
import assert from 'node:assert/strict';
import { ProgressTracker } from '../src/pipeline/progress.js';

test('snapshot reports percent and calls onUpdate', () => {
  const seen = [];
  const t = new ProgressTracker((snap) => seen.push(snap.pct));
  t.startPhase('download', 1000);
  t.update(500, 1000);
  assert.equal(t.snapshot.phase, 'download');
  assert.equal(t.snapshot.pct, 50);
  assert.ok(seen.includes(50));
});

test('percent is null when total is unknown (fathom HLS)', () => {
  const t = new ProgressTracker();
  t.startPhase('download', 0);
  t.update(1234, 0);
  assert.equal(t.snapshot.pct, null);
  assert.equal(t.snapshot.done, 1234);
});

test('transferSummary sums per-phase bytes and durations', () => {
  const t = new ProgressTracker();
  t.startPhase('download', 2000);
  t.update(2000, 2000);
  t.finishPhase();
  t.startPhase('upload', 2000);
  t.update(2000, 2000);
  t.finishPhase();
  const s = t.transferSummary();
  assert.equal(s.fileSizeBytes, 2000);
  assert.ok(s.durationMs >= 0);
  assert.ok(s.finishedAt);
  assert.equal(typeof s.avgUploadBps, 'number');
});

test('transferSummary is null when nothing transferred (LMS-only push)', () => {
  assert.equal(new ProgressTracker().transferSummary(), null);
});
