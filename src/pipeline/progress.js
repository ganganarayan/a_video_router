// Tracks download/upload byte progress for a manual push job and exposes a
// live snapshot (current speed, elapsed, ETA, %) plus per-phase averages used
// for the completion log. The snapshot object is stable per phase and mutated
// in place, so whoever holds a reference (the queue job) always sees fresh data.
export class ProgressTracker {
  constructor(onUpdate) {
    this.onUpdate = onUpdate;
    this.startedAt = Date.now();
    this.phase = null; // 'generating' | 'download' | 'upload' | 'done'
    this.total = 0;
    this.done = 0;
    this.phaseStartedAt = null;
    this.phases = {}; // { download: {bytes, ms}, upload: {bytes, ms} }
    this.snapshot = { phase: null, total: 0, done: 0, speedBps: 0, elapsedMs: 0, etaMs: null, pct: null };
  }

  startPhase(phase, total = 0) {
    this.phase = phase;
    this.total = total || 0;
    this.done = 0;
    this.phaseStartedAt = Date.now();
    this.snapshot = { phase, total: this.total, done: 0, speedBps: 0, elapsedMs: 0, etaMs: null, pct: null };
    this._refresh();
  }

  update(done, total) {
    this.done = done;
    if (total) this.total = total;
    this._refresh();
  }

  finishPhase() {
    if (!this.phase || !this.phaseStartedAt) return;
    this.phases[this.phase] = { bytes: this.done, ms: Date.now() - this.phaseStartedAt };
  }

  finish() {
    this.phase = 'done';
    this._refresh();
  }

  _refresh() {
    const now = Date.now();
    const phaseMs = now - (this.phaseStartedAt || now);
    const speedBps = phaseMs > 0 ? this.done / (phaseMs / 1000) : 0;
    const remaining = this.total > this.done ? this.total - this.done : 0;
    const s = this.snapshot;
    s.phase = this.phase;
    s.total = this.total;
    s.done = this.done;
    s.speedBps = Math.round(speedBps);
    s.elapsedMs = now - this.startedAt;
    s.etaMs = this.total && speedBps > 0 ? Math.round((remaining / speedBps) * 1000) : null;
    s.pct = this.total > 0 ? Math.min(100, Math.round((this.done / this.total) * 100)) : null;
    this.onUpdate?.(s);
  }

  // Summary for the completion log.
  transferSummary() {
    const dl = this.phases.download || { bytes: 0, ms: 0 };
    const up = this.phases.upload || { bytes: 0, ms: 0 };
    if (!dl.bytes && !up.bytes) return null;
    return {
      fileSizeBytes: up.bytes || dl.bytes,
      downloadMs: dl.ms,
      uploadMs: up.ms,
      durationMs: dl.ms + up.ms,
      avgDownloadBps: dl.ms > 0 ? Math.round(dl.bytes / (dl.ms / 1000)) : 0,
      avgUploadBps: up.ms > 0 ? Math.round(up.bytes / (up.ms / 1000)) : 0,
      finishedAt: new Date().toISOString(),
    };
  }
}
