/**
 * Today → schedule, and today-only changes to the 作息.
 *
 * The schedule is the one source of truth for which 要务 happens on which
 * day; Today is where plans meet the day. Changes made on Today land in the
 * schedule, are reversible, and never touch the 作息 template.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

import { AppConfigSchema, type AppConfig } from '../../src/config/schema.js';
import { buildCycleId, writeCycle } from '../../src/cycles/file.js';
import { readSchedule, scheduledSessionsFor, writeSchedule } from '../../src/cycles/schedule.js';
import { addAdhocSession, deferScheduled, moveAdhocSession, removeAdhocSession, restoreScheduled, skipScheduled, weeklyItemKey } from '../../src/cycles/schedule-writeback.js';
import { applyOverride, changeDayOverride, normalizeRoutines, readRoutines, routineForDate, writeRoutines } from '../../src/user/routine.js';
import { addDays } from '../../src/utils/date.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(`    ${error instanceof Error ? error.message : String(error)}`);
  }
}

const START = '2026-10-05';
const DAYS = Array.from({ length: 14 }, (_, index) => addDays(START, index));
const ID = buildCycleId(START, '10.5-10.18');

function setup(): AppConfig {
  const parsed = yaml.load(fs.readFileSync(path.join(REPO_ROOT, 'config', 'config.example.yaml'), 'utf8')) as Record<string, any>;
  parsed.memory.repository_path = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-os-writeback-'));
  const config = AppConfigSchema.parse(parsed);
  writeCycle(config, ID, { cycle: '10.5-10.18', mode: 'biweekly', sections: { '要务': { content: '### 工作\n- 方案\n- 打球 3 次', source: 'user' } } });
  writeSchedule(config, {
    cycleId: ID,
    generatedAt: 'now',
    sessions: [
      { id: 's1', itemKey: 'aaaaaaaa', label: '方案', date: DAYS[3]!, start: '10:00', minutes: 60, bigRock: true, step: '写初稿' },
      { id: 's2', itemKey: 'bbbbbbbb', label: '打球', date: DAYS[5]!, minutes: 90 },
      { id: 's3', itemKey: 'bbbbbbbb', label: '打球', date: DAYS[10]!, minutes: 90 },
      { id: 's4', itemKey: 'aaaaaaaa', label: '方案', date: DAYS[13]!, minutes: 60 },
    ],
    deadlines: [],
  });
  return config;
}

const session = (config: AppConfig, id: string) => readSchedule(config, ID)!.sessions.find((entry) => entry.id === id);

test('only a cycle 要务 row has a schedule to write back to', () => {
  assert.equal(weeklyItemKey('weekly:3:aaaaaaaa'), 'aaaaaaaa');
  assert.equal(weeklyItemKey('linear:XX-1'), null);
  assert.equal(weeklyItemKey('todo_inbox:todo-1'), null);
});

test('顺到明天 moves today\'s session to tomorrow without its reserved time; 恢复 brings it back', () => {
  const config = setup();
  assert.match(deferScheduled(config, DAYS[3]!, 'aaaaaaaa') ?? '', /移到 10\.9/);
  assert.equal(session(config, 's1')?.date, DAYS[4]);
  assert.equal(session(config, 's1')?.start, undefined, 'tomorrow\'s slot is not today\'s');
  assert.equal(session(config, 's1')?.movedFrom, DAYS[3]);
  assert.ok(restoreScheduled(config, DAYS[3]!, 'aaaaaaaa'));
  assert.equal(session(config, 's1')?.date, DAYS[3]);
});

test('删除 skips today\'s session — kept, out of every slice — and 恢复 brings it back', () => {
  const config = setup();
  assert.ok(skipScheduled(config, DAYS[3]!, 'aaaaaaaa'));
  assert.equal(session(config, 's1')?.skipped, true);
  assert.deepEqual(scheduledSessionsFor(config, DAYS[3]!), [], 'a skipped session is not today\'s work');
  restoreScheduled(config, DAYS[3]!, 'aaaaaaaa');
  assert.deepEqual(scheduledSessionsFor(config, DAYS[3]!).map((entry) => entry.id), ['s1']);
});

test('on the cycle\'s last day there is no tomorrow to push to: it is skipped', () => {
  const config = setup();
  assert.match(deferScheduled(config, DAYS[13]!, 'aaaaaaaa') ?? '', /最后一天/);
  assert.equal(session(config, 's4')?.skipped, true);
});

test('a 临时安排 of a 要务 counts as one of the cycle\'s: the next one is taken, and undo gives it back', () => {
  const config = setup();
  const added = addAdhocSession(config, DAYS[3]!, 'bbbbbbbb', { start: '19:00', minutes: 120, step: '打球' })!;
  assert.equal(added.takenDate, DAYS[5]);
  assert.equal(session(config, 's2')?.skipped, true);
  assert.equal(session(config, 's3')?.skipped, undefined, 'only the nearest one');
  assert.deepEqual(scheduledSessionsFor(config, DAYS[3]!).map((entry) => [entry.step, entry.start, entry.adhoc]), [['写初稿', '10:00', undefined], ['打球', '19:00', true]]);
  assert.ok(removeAdhocSession(config, DAYS[3]!, added.sessionId));
  assert.equal(session(config, 's2')?.skipped, undefined);
  assert.ok(!readSchedule(config, ID)!.sessions.some((entry) => entry.adhoc));
});

test('an ad-hoc session can be given its id, and follows its row when moved or stretched', () => {
  const config = setup();
  addAdhocSession(config, DAYS[3]!, 'bbbbbbbb', { start: '19:00', minutes: 60, step: '打球' }, { id: 'a-row1' });
  assert.ok(moveAdhocSession(config, DAYS[3]!, 'a-row1', { start: '20:00' }));
  assert.ok(moveAdhocSession(config, DAYS[3]!, 'a-row1', { minutes: 120 }));
  assert.deepEqual([session(config, 'a-row1')?.start, session(config, 'a-row1')?.minutes], ['20:00', 120]);
  assert.equal(moveAdhocSession(config, DAYS[3]!, 'nope', { start: '20:00' }), false);
});

test('an extra one takes nothing', () => {
  const config = setup();
  const added = addAdhocSession(config, DAYS[3]!, 'bbbbbbbb', { start: '19:00', minutes: 60, step: '加练' }, { extra: true })!;
  assert.equal(added.takenDate, undefined);
  assert.ok(!readSchedule(config, ID)!.sessions.some((entry) => entry.skipped));
});

test('today-only 作息 changes: hide, edit, and room cleared for something that came up — the template untouched', () => {
  const blocks = [
    { id: 'dinner', start: '18:00', end: '20:00', title: '晚饭', kind: 'fixed' as const },
    { id: 'draw', start: '20:00', end: '21:30', title: '画画', kind: 'slot' as const },
    { id: 'night', start: '22:00', end: '23:00', title: '睡觉', kind: 'fixed' as const },
  ];
  const cleared = applyOverride(blocks, { hidden: [], edits: [], clears: [{ id: 'x', start: '19:00', end: '21:00', label: '打球' }] });
  assert.deepEqual(cleared.map((block) => [block.title, block.start, block.end]), [['晚饭', '18:00', '19:00'], ['画画', '21:00', '21:30'], ['睡觉', '22:00', '23:00']]);
  const split = applyOverride(blocks, { hidden: [], edits: [], clears: [{ id: 'x', start: '18:30', end: '19:00', label: '电话' }] });
  assert.deepEqual(split.slice(0, 2).map((block) => [block.start, block.end]), [['18:00', '18:30'], ['19:00', '20:00']], 'split around it');
  const edited = applyOverride(blocks, { hidden: ['night'], edits: [{ ...blocks[0]!, start: '17:30', end: '19:00' }], clears: [] });
  assert.deepEqual(edited.map((block) => [block.title, block.start]), [['晚饭', '17:30'], ['画画', '20:00']]);

  const config = setup();
  writeRoutines(config, { periods: [{ id: 'p', name: '两周', from: START, to: DAYS[13], categories: [], rules: [], dayTypes: [{ label: '每天', weekdays: ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'], modes: [{ label: '一种', blocks }] }] }] });
  changeDayOverride(config, DAYS[3]!, { type: 'clear', id: 'x', start: '19:00', end: '21:00', label: '打球' });
  assert.equal(routineForDate(config, DAYS[3]!)!.blocks.find((block) => block.title === '晚饭')?.end, '19:00');
  assert.equal(routineForDate(config, DAYS[4]!)!.blocks.find((block) => block.title === '晚饭')?.end, '20:00', 'tomorrow is the template');
  assert.ok(normalizeRoutines(readRoutines(config)).routines.dayOverrides[DAYS[3]!], 'overrides survive a round trip');
  changeDayOverride(config, DAYS[3]!, { type: 'unclear', id: 'x' });
  assert.equal(routineForDate(config, DAYS[3]!)!.blocks.find((block) => block.title === '晚饭')?.end, '20:00');
  assert.equal(readRoutines(config).dayOverrides[DAYS[3]!], undefined, 'nothing left to override, nothing stored');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
