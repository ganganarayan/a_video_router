import test from 'node:test';
import assert from 'node:assert/strict';
import { matchRule, buildVideoTitle } from '../src/pipeline/router.js';

const rules = [
  { id: 1, source: 'any', match_type: 'contains', pattern: 'Hindi', channel_id: 1, priority: 100, enabled: true },
  { id: 2, source: 'any', match_type: 'contains', pattern: 'Online - Gita Certification', channel_id: 2, priority: 100, enabled: true },
  { id: 3, source: 'any', match_type: 'contains', pattern: 'Online - 5 Day', channel_id: 2, priority: 100, enabled: true },
  { id: 4, source: 'any', match_type: 'contains', pattern: 'Online - 90 Day', channel_id: 2, priority: 100, enabled: true },
];

test('matches by case-insensitive contains', () => {
  assert.equal(matchRule(rules, 'zoom', 'HINDI satsang session 3')?.id, 1);
  assert.equal(matchRule(rules, 'fathom', 'Online - 90 Day | Session 12')?.id, 4);
});

test('no match returns null (skipped_no_route path)', () => {
  assert.equal(matchRule(rules, 'zoom', 'Random team standup'), null);
});

test('longest pattern wins at equal priority', () => {
  const overlapping = [
    { id: 10, pattern: 'Online', match_type: 'contains', priority: 100, enabled: true },
    { id: 11, pattern: 'Online - 90 Day', match_type: 'contains', priority: 100, enabled: true },
  ];
  assert.equal(matchRule(overlapping, 'zoom', 'Online - 90 Day | S1')?.id, 11);
});

test('lower priority number beats longer pattern', () => {
  const prio = [
    { id: 20, pattern: 'Online - 90 Day', match_type: 'contains', priority: 100, enabled: true },
    { id: 21, pattern: 'Online', match_type: 'contains', priority: 1, enabled: true },
  ];
  assert.equal(matchRule(prio, 'zoom', 'Online - 90 Day')?.id, 21);
});

test('disabled and source-incompatible rules are ignored', () => {
  const r = [
    { id: 30, pattern: 'Hindi', match_type: 'contains', priority: 1, enabled: false },
    { id: 31, pattern: 'Hindi', match_type: 'contains', priority: 5, enabled: true, source: 'fathom' },
    { id: 32, pattern: 'Hindi', match_type: 'contains', priority: 9, enabled: true, source: 'any' },
  ];
  assert.equal(matchRule(r, 'zoom', 'Hindi class')?.id, 32);
  assert.equal(matchRule(r, 'fathom', 'Hindi class')?.id, 31);
});

test('prefix and regex match types', () => {
  const r = [
    { id: 40, pattern: 'Hindi', match_type: 'prefix', priority: 100, enabled: true },
    { id: 41, pattern: '90\\s*Day', match_type: 'regex', priority: 100, enabled: true },
  ];
  assert.equal(matchRule(r, 'zoom', 'Hindi - class 2')?.id, 40);
  assert.equal(matchRule(r, 'zoom', 'Class Hindi'), null); // prefix must start the title
  assert.equal(matchRule(r, 'zoom', 'Online 90Day intro')?.id, 41);
});

test('invalid regex never matches (no crash)', () => {
  const r = [{ id: 50, pattern: '[unclosed', match_type: 'regex', priority: 1, enabled: true }];
  assert.equal(matchRule(r, 'zoom', '[unclosed test'), null);
});

test('buildVideoTitle keeps title when keep_prefix=true', () => {
  assert.equal(buildVideoTitle('Online - 90 Day | Session 12', 'Online - 90 Day', true),
    'Online - 90 Day | Session 12');
});

test('buildVideoTitle strips the tag when keep_prefix=false', () => {
  assert.equal(buildVideoTitle('Online - 90 Day | Session 12', 'Online - 90 Day', false), 'Session 12');
  assert.equal(buildVideoTitle('Hindi - Bhagavad Gita 4.7', 'Hindi', false), 'Bhagavad Gita 4.7');
});

test('buildVideoTitle falls back to full title when stripping empties it', () => {
  assert.equal(buildVideoTitle('Hindi', 'Hindi', false), 'Hindi');
});
