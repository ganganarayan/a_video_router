import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { log } from '../lib/logger.js';

export function tempFilePath(recId) {
  const dir = path.join(os.tmpdir(), 'videorouter');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `rec_${recId}.mp4`);
}

export function cleanupTemp(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (err) {
    log(`temp cleanup failed for ${filePath}: ${err.message}`);
  }
}

// Fathom serves a single composited video at <share_url>/video.m3u8.
// -c copy remux (no re-encode); reconnect flags survive Fathom's redirect-to-GCS
// chunk hosts; +faststart makes the mp4 stream-friendly for the YouTube upload.
export function fathomFfmpegArgs(shareUrl, destPath) {
  const m3u8 = `${String(shareUrl).replace(/\/+$/, '')}/video.m3u8`;
  return [
    '-hide_banner', '-loglevel', 'error',
    '-http_persistent', '0',
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
    '-i', m3u8,
    '-c', 'copy',
    '-bsf:a', 'aac_adtstoasc',
    '-movflags', '+faststart',
    '-y', destPath,
  ];
}

export function downloadFathomVideo(shareUrl, destPath) {
  return new Promise((resolve, reject) => {
    const args = fathomFfmpegArgs(shareUrl, destPath);
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('error', (err) => reject(new Error(`ffmpeg spawn failed: ${err.message}`)));
    proc.on('close', (code) => {
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
