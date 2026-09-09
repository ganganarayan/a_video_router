import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  cacheFilePath, partialFilePath, isCachedComplete,
} from '../src/pipeline/download.js';

test('cache and partial paths are distinct and stable per recording', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vrcache-'));
  process.env.CACHE_DIR = dir;
  try {
    assert.notEqual(cacheFilePath(42), partialFilePath(42));
    assert.equal(cacheFilePath(42), cacheFilePath(42));
    assert.ok(cacheFilePath(42).startsWith(dir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.CACHE_DIR;
  }
});

test('isCachedComplete only reuses a complete file of the expected size', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vrcache-'));
  process.env.CACHE_DIR = dir;
  try {
    const id = 777;
    assert.equal(isCachedComplete(id, 100), false);        // no file yet
    fs.writeFileSync(cacheFilePath(id), Buffer.alloc(100));
    assert.equal(isCachedComplete(id, 100), true);         // exact size → reuse
    assert.equal(isCachedComplete(id, 250), false);        // size mismatch (partial/corrupt) → re-download
    assert.equal(isCachedComplete(id, null), true);        // unknown expected size → accept any non-empty
    fs.writeFileSync(cacheFilePath(id), Buffer.alloc(0));
    assert.equal(isCachedComplete(id, null), false);       // empty file → not reusable
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.CACHE_DIR;
  }
});
