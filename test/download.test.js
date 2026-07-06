import test from 'node:test';
import assert from 'node:assert/strict';
import { fathomFfmpegArgs } from '../src/pipeline/download.js';

test('fathom ffmpeg command matches the verified remux recipe', () => {
  const args = fathomFfmpegArgs('https://fathom.video/share/xyz', '/tmp/out.mp4');
  assert.deepEqual(args, [
    '-hide_banner', '-loglevel', 'error',
    '-http_persistent', '0',
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
    '-i', 'https://fathom.video/share/xyz/video.m3u8',
    '-c', 'copy',
    '-bsf:a', 'aac_adtstoasc',
    '-movflags', '+faststart',
    '-y', '/tmp/out.mp4',
  ]);
});

test('trailing slash on share_url does not double up', () => {
  const args = fathomFfmpegArgs('https://fathom.video/share/xyz/', 'o.mp4');
  assert.ok(args.includes('https://fathom.video/share/xyz/video.m3u8'));
});
