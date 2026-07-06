import test from 'node:test';
import assert from 'node:assert/strict';
import { encryptWithKey, decryptWithKey, isEncrypted, deriveKey } from '../src/lib/crypto.js';

const KEY = 'f'.repeat(64);

test('AES-256-GCM round trip', () => {
  const secret = 'zoom-client-secret-XYZ/123+abc';
  const stored = encryptWithKey(KEY, secret);
  assert.notEqual(stored, secret);
  assert.ok(isEncrypted(stored));
  assert.equal(decryptWithKey(KEY, stored), secret);
});

test('two encryptions of the same value differ (random IV)', () => {
  assert.notEqual(encryptWithKey(KEY, 'same'), encryptWithKey(KEY, 'same'));
});

test('tampered ciphertext fails authentication', () => {
  const stored = encryptWithKey(KEY, 'secret');
  const tampered = stored.slice(0, -4) + (stored.endsWith('AAAA') ? 'BBBB' : 'AAAA');
  assert.throws(() => decryptWithKey(KEY, tampered));
});

test('plaintext (legacy) values pass through decrypt unchanged', () => {
  assert.equal(decryptWithKey(KEY, 'not-encrypted'), 'not-encrypted');
  assert.equal(decryptWithKey(KEY, ''), '');
  assert.equal(decryptWithKey(KEY, null), null);
});

test('non-hex key material is derived to 32 bytes', () => {
  assert.equal(deriveKey('some passphrase').length, 32);
  assert.equal(deriveKey(KEY).length, 32);
});
