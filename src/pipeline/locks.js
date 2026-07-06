// In-process row locks so a manual push and a scheduled run never work the
// same recording at the same time (single-process service, so a Set suffices).
const active = new Set();

export const recordingKey = (source, sourceId) => `${source}:${sourceId}`;

export function lock(key) {
  if (active.has(key)) return false;
  active.add(key);
  return true;
}

export function unlock(key) {
  active.delete(key);
}

export function isLocked(key) {
  return active.has(key);
}
