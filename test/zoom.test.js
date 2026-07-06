import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeMeetingUUID, pickRecordingFile } from '../src/providers/zoom.js';

test('plain UUID is single-encoded', () => {
  assert.equal(encodeMeetingUUID('abcDEF123=='), 'abcDEF123%3D%3D');
});

test('UUID containing a slash is double-encoded', () => {
  // '/' -> '%2F' -> '%252F'
  assert.equal(encodeMeetingUUID('ab/cd=='), 'ab%252Fcd%253D%253D');
});

test('UUID starting with // is double-encoded', () => {
  assert.ok(encodeMeetingUUID('//abc123').startsWith('%252F%252F'));
});

test('picks only shared_screen_with_speaker_view MP4', () => {
  const meeting = {
    recording_files: [
      { id: 'a', recording_type: 'gallery_view', file_type: 'MP4' },
      { id: 'b', recording_type: 'shared_screen_with_speaker_view', file_type: 'M4A' },
      { id: 'c', recording_type: 'shared_screen_with_speaker_view', file_type: 'MP4' },
      { id: 'd', recording_type: 'shared_screen', file_type: 'MP4' },
    ],
  };
  assert.equal(pickRecordingFile(meeting)?.id, 'c');
});

test('missing view returns null (skipped_no_matching_view path)', () => {
  assert.equal(pickRecordingFile({ recording_files: [{ recording_type: 'gallery_view', file_type: 'MP4' }] }), null);
  assert.equal(pickRecordingFile({}), null);
});
