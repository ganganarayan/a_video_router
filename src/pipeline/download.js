import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Transform, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// Cache dir for downloaded source files. Defaults to a temp path; set CACHE_DIR
// to a mounted Railway volume to make the cache survive container restarts.
function cacheDir() {
  const dir = process.env.CACHE_DIR || path.join(os.tmpdir(), 'videorouter');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// The finished, verified download for a recording (only ever holds a complete file).
export function cacheFilePath(recId) {
  return path.join(cacheDir(), `rec_${recId}.mp4`);
}

// The in-progress download target; renamed onto cacheFilePath only on success.
export function partialFilePath(recId) {
  return path.join(cacheDir(), `rec_${recId}.partial.mp4`);
}

// Landing path for a browser/local upload (feature: upload local files). Lives in
// the cache dir so it can be renamed onto the pipeline's partial path (same device).
export function ingestTempPath(token) {
  return path.join(cacheDir(), `upload_${String(token).replace(/[^\w-]/g, '')}.mp4`);
}

// A cached download is reusable only if the file exists and its size matches the
// size recorded on the row from the prior successful download.
export function isCachedComplete(recId, expectedBytes) {
  try {
    const p = cacheFilePath(recId);
    if (!fs.existsSync(p)) return false;
    const size = fs.statSync(p).size;
    if (!size) return false;
    return expectedBytes ? size === Number(expectedBytes) : true;
  } catch {
    return false;
  }
}

export function cleanupTemp(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    /* best effort */
  }
}

// If a transfer sends no bytes for this long, treat it as stalled: abort the
// fetch (closing the connection to the source so we stop holding it open / hitting
// the source) and fail loudly, so the row goes to 'error' instead of hanging.
const STALL_TIMEOUT_MS = 60_000;

// Stream a URL straight to a file with byte-progress and a stall watchdog.
// Memory-light: the body is piped to disk, never buffered. `totalHint` supplies a
// known size when the response has no Content-Length (so the UI still shows %).
// Returns the final file size. Used for the fast Fathom download (a signed MP4
// URL from Fathom's official download API) — same streaming shape as Zoom.
export async function streamToFile(url, destPath, onProgress, opts = {}) {
  const { totalHint = 0, stallMs = STALL_TIMEOUT_MS } = opts;
  const controller = new AbortController();
  let stallTimer = null;
  let stalled = false;
  const armStall = () => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => { stalled = true; controller.abort(); }, stallMs);
  };

  const res = await fetch(url, { redirect: 'follow', signal: controller.signal });
  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => '');
    throw new Error(`download failed (${res.status}): ${body.slice(0, 300)}`);
  }

  const total = Number(res.headers.get('content-length')) || totalHint || 0;
  let received = 0;
  armStall();
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      received += chunk.length;
      armStall();
      onProgress?.(received, total);
      cb(null, chunk);
    },
  });

  try {
    await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(destPath));
  } catch (err) {
    if (stalled || controller.signal.aborted) {
      throw new Error(`transfer stalled — no data for ${Math.round(stallMs / 1000)}s; aborted the connection`);
    }
    throw err;
  } finally {
    if (stallTimer) clearTimeout(stallTimer);
  }
  return fs.statSync(destPath).size;
}
