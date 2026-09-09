import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { log } from '../lib/logger.js';

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
  } catch (err) {
    log(`temp cleanup failed for ${filePath}: ${err.message}`);
  }
}

// Fathom serves a single composited video at <share_url>/video.m3u8.
// -c copy remux (no re-encode); +faststart makes the mp4 stream-friendly for the
// YouTube upload. Connection tuning (shared with spawnFathomStream, see below):
//   -http_persistent 1 + -multiple_requests 1 keep ONE connection alive across
//   all HLS segments instead of a fresh TCP+TLS handshake per chunk (that per-
//   chunk handshake was crushing throughput to KB/s on long recordings).
//   -reconnect* let a brief Fathom/GCS stall recover instead of killing the job;
//   delay_max 30 tolerates a longer hiccup before giving up.
export function fathomFfmpegArgs(shareUrl, destPath) {
  const m3u8 = `${String(shareUrl).replace(/\/+$/, '')}/video.m3u8`;
  return [
    '-hide_banner', '-loglevel', 'error',
    '-http_persistent', '1',
    '-multiple_requests', '1',
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_on_network_error', '1',
    '-reconnect_delay_max', '30',
    '-i', m3u8,
    '-c', 'copy',
    '-bsf:a', 'aac_adtstoasc',
    '-movflags', '+faststart',
    '-y', destPath,
  ];
}

// Stream a Fathom recording as MP4 straight to a consumer (e.g. the browser
// Download), without a temp file. Uses fragmented MP4 (frag_keyframe+empty_moov)
// so the moov atom isn't deferred to the end — ffmpeg can pipe bytes as they are
// remuxed. Returns the child process; caller pipes proc.stdout and must kill it
// on client disconnect. Memory-light: nothing is buffered here.
export function spawnFathomStream(shareUrl) {
  const m3u8 = `${String(shareUrl).replace(/\/+$/, '')}/video.m3u8`;
  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-http_persistent', '1',
    '-multiple_requests', '1',
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_on_network_error', '1',
    '-reconnect_delay_max', '30',
    '-i', m3u8,
    '-c', 'copy',
    '-bsf:a', 'aac_adtstoasc',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-f', 'mp4',
    'pipe:1',
  ];
  return spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
}

export function downloadFathomVideo(shareUrl, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const args = fathomFfmpegArgs(shareUrl, destPath);
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d; });
    // HLS has no known total up front, so report bytes-written as the output
    // file grows (total 0 => the UI shows an indeterminate bar).
    let poll = null;
    if (onProgress) {
      poll = setInterval(() => {
        try { onProgress(fs.statSync(destPath).size, 0); } catch { /* not created yet */ }
      }, 1000);
    }
    const stopPoll = () => { if (poll) clearInterval(poll); };
    proc.on('error', (err) => { stopPoll(); reject(new Error(`ffmpeg spawn failed: ${err.message}`)); });
    proc.on('close', (code) => {
      stopPoll();
      if (code === 0) {
        try {
          resolve(fs.statSync(destPath).size);
        } catch (err) {
          reject(new Error(`ffmpeg finished but output missing: ${err.message}`));
        }
      } else {
        reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`));
      }
    });
  });
}
