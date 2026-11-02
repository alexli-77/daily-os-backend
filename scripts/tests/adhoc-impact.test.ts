/**
 * A 临时安排 that crowds out today's 要务 says so (2026-11-02).
 *
 * Run: tsx scripts/tests/adhoc-impact.test.ts
 */
import assert from 'node:assert/strict';

import { measureImpact, workMinutesFrom, type WorkBlock } from '../../src/cycles/adhoc-impact.js';

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  ✗ ${name}\n    ${error instanceof Error ? error.message : String(error)}`);
  }
}

const day: WorkBlock[] = [
  { id: 'english', start: '07:00', end: '08:00', kind: 'slot', habit: true },
  { id: 'pf', start: '13:00', end: '15:00', kind: 'slot' },
  { id: 'cutto', start: '15:00', end: '18:00', kind: 'slot' },
  { id: 'dinner', start: '18:00', end: '19:00', kind: 'fixed' },
  { id: 'cal-ag1', start: '19:00', end: '20:00', kind: 'slot', category: 'ag1' },
];
// 打球 14:00–17:00: the work slots give way.
const withBall: WorkBlock[] = [
  { id: 'english', start: '07:00', end: '08:00', kind: 'slot', habit: true },
  { id: 'pf-a', start: '13:00', end: '14:00', kind: 'slot' },
  { id: 'cutto-b', start: '17:00', end: '18:00', kind: 'slot' },
  { id: 'dinner', start: '18:00', end: '19:00', kind: 'fixed' },
  { id: 'cal-ag1', start: '19:00', end: '20:00', kind: 'slot', category: 'ag1' },
];
const sessions = [
  { itemKey: 'aaaaaaaa', label: '作品集个站', minutes: 120, bigRock: true, start: '13:00' },
  { itemKey: 'bbbbbbbb', label: 'iOS store 宣传图', minutes: 90 },
  { itemKey: 'cccccccc', label: 'X 触达 10 人', minutes: 30 },
];

test('only work slots count: not habits, meals or calendar events; and only from now on', () => {
  assert.equal(workMinutesFrom(day, '09:00'), 300);
  assert.equal(workMinutesFrom(day, '14:00'), 240);
});

test('three hours of 打球 over the afternoon: the 要务 that no longer fit are named, the big rock last', () => {
  const impact = measureImpact({ before: day, after: withBall, sessions, window: { start: '14:00', end: '17:00' }, now: '10:00' });
  assert.ok(impact);
  assert.equal(impact!.taken, 180);
  assert.equal(impact!.shortfall, 240 - 120);
  assert.deepEqual(impact!.squeezed.map((entry) => entry.itemKey), ['bbbbbbbb', 'cccccccc'], 'the big rock stays');
  assert.match(impact!.text, /占了 3h 的工作时间/);
});

test('nothing said when it took no work time, or the 要务 still fit', () => {
  assert.equal(measureImpact({ before: day, after: day, sessions, window: { start: '18:00', end: '19:00' }, now: '10:00' }), null, 'over dinner');
  assert.equal(measureImpact({ before: day, after: withBall, sessions: sessions.slice(2), window: { start: '14:00', end: '17:00' }, now: '10:00' }), null, '30 minutes still fit');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
