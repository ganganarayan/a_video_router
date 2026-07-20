import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { isInvalidGrant } from '../src/providers/youtube.js';

test('detects invalid_grant in a thrown googleapis error', () => {
  assert.equal(isInvalidGrant({ message: 'invalid_grant' }), true);
  assert.equal(isInvalidGrant({ response: { data: { error: 'invalid_grant', error_description: 'Token expired' } } }), true);
  assert.equal(isInvalidGrant({ response: { data: 'oauth error: invalid_grant' } }), true);
});

test('detects invalid_grant in a response body string', () => {
  assert.equal(isInvalidGrant('{"error":"invalid_grant"}'), true);
});

test('does not false-positive on unrelated errors', () => {
  assert.equal(isInvalidGrant({ message: 'quotaExceeded' }), false);
  assert.equal(isInvalidGrant('network timeout'), false);
  assert.equal(isInvalidGrant(null), false);
  assert.equal(isInvalidGrant(undefined), false);
});
