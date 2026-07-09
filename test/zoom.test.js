import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeMeetingUUID, pickRecordingFile, listVideoFiles, findFile } from '../src/providers/zoom.js';

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

const multiFileMeeting = {
  recording_files: [
    { id: 'f1', recording_type: 'shared_screen_with_speaker_view', file_type: 'MP4' },
    { id: 'f2', recording_type: 'gallery_view', file_type: 'MP4' },
    { id: 'f3', recording_type: 'audio_only', file_type: 'M4A' },
    { id: 'f4', recording_type: 'shared_screen', file_type: 'MP4' },
  ],
};

test('listVideoFiles returns only MP4 files', () => {
  assert.deepEqual(listVideoFiles(multiFileMeeting).map((f) => f.id), ['f1', 'f2', 'f4']);
  assert.deepEqual(listVideoFiles({}), []);
});

test('findFile selects the exact chosen file by id', () => {
  assert.equal(findFile(multiFileMeeting, 'f4')?.recording_type, 'shared_screen');
  assert.equal(findFile(multiFileMeeting, 'f2')?.recording_type, 'gallery_view');
});

test('findFile with no id falls back to the speaker-view auto-pick', () => {
  assert.equal(findFile(multiFileMeeting, null)?.id, 'f1');
});

test('findFile returns null for an unknown id', () => {
  assert.equal(findFile(multiFileMeeting, 'nope'), null);
});
