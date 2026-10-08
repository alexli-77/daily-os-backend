/**
 * 作息 (routines): periods → day types → modes → blocks.
 *
 * The frame a period of the user's life runs on, so a day's to-dos can be held
 * to it. These pin what may be stored, and which blocks a date resolves to.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

import { AppConfigSchema, type AppConfig } from '../../src/config/schema.js';
import { nowLine } from '../../src/agent/openai-agent.js';
import { appendDailyMemory, writeLatestWorkflowOutput } from '../../src/storage/memory.js';
import { recordTodoFeedback } from '../../src/todo/feedback.js';
import { buildTodayPlanSnapshot } from '../../src/todo/today-plan.js';
import { renderRhythmPromptSection, resolveDayShape } from '../../src/user/rhythm.js';
import { addDays, todayInTimezone } from '../../src/utils/date.js';
import { normalizeRoutines, readRoutines, resolveRoutine, routineForDate, routinesPath, setDayMode, writeRoutines } from '../../src/user/routine.js';

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

function config(): AppConfig {
  const parsed = yaml.load(fs.readFileSync(path.join(REPO_ROOT, 'config', 'config.example.yaml'), 'utf8')) as Record<string, any>;
  parsed.memory.repository_path = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-os-routine-'));
  return AppConfigSchema.parse(parsed);
}

const PERIOD = {
  id: 'trip',
  name: '出差两周',
  from: '2026-10-05',
  to: '2026-10-18',
  wake: '06:30',
  sleep: '23:00',
  categories: [
    { key: 'habit', label: '习惯', color: 'blue' },
    { key: 'work', label: '工作', color: 'green' },
    { key: 'odd', label: '怪色', color: 'neon' },
  ],
  dayTypes: [
    {
      id: 'workday',
      label: '工作日',
      weekdays: ['MON', 'TUE', 'WED', 'THU', 'FRI'],
      defaultMode: 'deep',
      modes: [
        {
          id: 'deep',
          label: '专注日',
          blocks: [
            { start: '13:00', end: '18:00', title: '专注', category: 'work', kind: 'slot' },
            { start: '07:00', end: '08:00', title: '口语', category: 'habit', kind: 'slot', floor: true },
            { start: '12:00', end: '11:00', title: '倒着的' },
            { start: '12:00', end: '13:00', title: '午饭', category: 'nope', floor: true },
          ],
        },
        { id: 'meet', label: '会议日', blocks: [{ start: '13:00', end: '18:00', title: '开会', kind: 'fixed' }] },
      ],
    },
    { label: '周末', weekdays: ['SAT', 'SUN'], modes: [{ label: '半天', blocks: [{ start: '09:30', end: '12:00', title: '上午做事', category: 'work', kind: 'slot' }] }] },
    { label: '没星期', weekdays: [], modes: [] },
  ],
  rules: ['上午定模式', '  '],
};

test('only what can be true is stored, and what was dropped is said', () => {
  const { routines, problems } = normalizeRoutines({ periods: [PERIOD, { name: '没日期' }], dayModes: { '2026-10-08': 'meet', bad: 'x' } });
  const period = routines.periods[0]!;
  assert.equal(routines.periods.length, 1);
  assert.equal(period.categories.find((category) => category.key === 'odd')?.color, 'gray', 'an unknown colour falls back to gray');
  const deep = period.dayTypes[0]!.modes[0]!;
  assert.deepEqual(deep.blocks.map((block) => block.title), ['口语', '午饭', '专注'], 'sorted by time; the backwards block dropped');
  assert.equal(deep.blocks[0]!.floor, true);
  assert.equal(deep.blocks[1]!.floor, undefined, 'a floor is only meaningful on a slot');
  assert.equal(deep.blocks[1]!.category, undefined, 'an unknown category is dropped');
  assert.equal(deep.blocks[1]!.kind, 'fixed', 'blocks are fixed unless said otherwise');
  assert.equal(period.dayTypes.length, 2, 'a day type with no weekdays is dropped');
  assert.equal(period.dayTypes[1]!.defaultMode, period.dayTypes[1]!.modes[0]!.id, 'the first mode is the default when none is named');
  assert.deepEqual(period.rules, ['上午定模式']);
  assert.deepEqual(routines.dayModes, { '2026-10-08': 'meet' });
  assert.equal(problems.length, 3, `${problems.join(' / ')}`);
});

test('a date resolves to its period, day type and mode — the default until one is picked', () => {
  const { routines } = normalizeRoutines({ periods: [PERIOD] });
  const thursday = resolveRoutine(routines, '2026-10-08')!;
  assert.equal(thursday.dayType.label, '工作日');
  assert.equal(thursday.mode.id, 'deep');
  assert.deepEqual(thursday.modes.map((mode) => mode.id), ['deep', 'meet']);
  assert.equal(thursday.blocks.find((block) => block.title === '专注')?.categoryLabel, '工作');
  assert.equal(thursday.blocks.find((block) => block.title === '专注')?.color, 'green');
  assert.equal(resolveRoutine(routines, '2026-10-10')!.dayType.label, '周末');
  assert.equal(resolveRoutine(routines, '2026-10-19'), null, 'outside every period');
  const picked = resolveRoutine({ ...routines, dayModes: { '2026-10-08': 'meet' } }, '2026-10-08')!;
  assert.equal(picked.mode.label, '会议日');
});

test('a later period wins where two overlap', () => {
  const { routines } = normalizeRoutines({ periods: [PERIOD, { ...PERIOD, id: 'later', name: '第二周特别', from: '2026-10-12' }] });
  assert.equal(resolveRoutine(routines, '2026-10-08')!.period.name, '出差两周');
  assert.equal(resolveRoutine(routines, '2026-10-13')!.period.name, '第二周特别');
});

test('picking a mode is stored per date and survives in the vault file', () => {
  const cfg = config();
  writeRoutines(cfg, { periods: [PERIOD] });
  assert.ok(fs.existsSync(routinesPath(cfg)));
  assert.match(routinesPath(cfg), /00_System[/\\]routines\.json$/);
  setDayMode(cfg, '2026-10-08', 'meet');
  assert.equal(routineForDate(cfg, '2026-10-08')!.mode.id, 'meet');
  assert.equal(routineForDate(cfg, '2026-10-09')!.mode.id, 'deep', 'other days keep their default');
  assert.throws(() => setDayMode(cfg, '2026-10-08', 'nope'), /没有/);
  assert.throws(() => setDayMode(cfg, '2026-11-01', 'deep'), /不在任何作息时期/);
  assert.equal(readRoutines(cfg).periods.length, 1);
});

test('no file means no routine, not an error', () => {
  assert.deepEqual(readRoutines(config()), { periods: [], dayModes: {}, dayOverrides: {} });
});

test('under a 作息 the day shape is the routine: its fixed blocks, no separate meals, slots for the to-dos', () => {
  const cfg = config();
  cfg.user.rhythm.fixed_blocks = [{ label: '周会', start: '16:00', end: '17:00', kind: 'meeting', days: ['THU'] } as any];
  writeRoutines(cfg, {
    periods: [{ ...PERIOD, dayTypes: [{ label: '工作日', weekdays: ['THU'], modes: [{ label: '专注日', blocks: [
      { start: '06:30', end: '07:00', title: '起床' },
      { start: '07:00', end: '08:00', title: '口语', category: 'habit', kind: 'slot', floor: true },
      { start: '12:00', end: '13:00', title: '午饭' },
      { start: '13:00', end: '18:00', title: '专注', category: 'work', kind: 'slot' },
    ] }] }] }],
  });
  const shape = resolveDayShape(cfg, '2026-10-08');
  assert.deepEqual(shape.mealBlocks, [], 'the routine has its own lunch');
  assert.deepEqual(shape.fixedBlocks.map((block) => block.label), ['起床', '午饭', '周会'], 'routine fixed blocks, plus meetings from the settings');
  assert.deepEqual(shape.workingHours, { start: '07:00', end: '18:00' }, 'work runs from the first slot to the last');
  assert.equal(shape.routine?.mode.label, '专注日');
  assert.deepEqual(shape.routine?.slots.map((slot) => [slot.start, slot.category, slot.floor ?? false]), [['07:00', '习惯', true], ['13:00', '工作', false]]);
  const prompt = renderRhythmPromptSection(cfg, '2026-10-08');
  assert.match(prompt, /07:00–08:00 口语〔习惯·保底〕/);
  assert.match(prompt, /上午定模式/, 'the period\'s rules reach the plan');
  assert.equal(resolveDayShape(cfg, '2026-10-20').routine, undefined, 'outside the period: the plain rhythm');
});

test('a hand-built config with no vault still gets a day shape', () => {
  assert.doesNotThrow(() => resolveDayShape({} as never, '2026-10-08'));
});

test('a plan row keeps the slot start the model gave it, and a meal row is not added twice', () => {
  const cfg = config();
  const today = todayInTimezone(cfg);
  writeRoutines(cfg, { periods: [{ ...PERIOD, from: addDays(today, -1), to: addDays(today, 1), dayTypes: [{ label: '每天', weekdays: ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'], modes: [{ label: '一种', blocks: [
    { start: '12:00', end: '13:00', title: '午饭' },
    { start: '13:00', end: '18:00', title: '专注', category: 'work', kind: 'slot' },
  ] }] }] }] });
  const content = JSON.stringify({ todos: [{ rank: 1, text: '做方案', candidateId: 'weekly:0:aaaaaaaa', minutes: 90, start: '13:00' }, { rank: 2, text: '写邮件', candidateId: 'linear:XX-1', start: '25:00' }] });
  const process_ = process.cwd();
  process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'daily-os-routine-cwd-')));
  try {
    appendDailyMemory(cfg, 'daily_plan', today, content);
    writeLatestWorkflowOutput(cfg, 'daily_plan', today, content);
    const todos = buildTodayPlanSnapshot(cfg)?.todos ?? [];
    assert.equal(todos.find((todo) => todo.candidateId === 'weekly:0:aaaaaaaa')?.start, '13:00');
    assert.equal(todos.find((todo) => todo.candidateId === 'linear:XX-1')?.start, undefined, 'a time that is not one is dropped');
    assert.ok(!todos.some((todo) => todo.candidateId.startsWith('rhythm:meal:')), 'lunch is the routine\'s fixed block, not a second row');
  } finally {
    process.chdir(process_);
  }
});

test('habit slots are to-dos on today\'s sheet: a row each, unless the plan already put one there', () => {
  const cfg = config();
  const today = todayInTimezone(cfg);
  writeRoutines(cfg, { periods: [{ ...PERIOD, from: addDays(today, -1), to: addDays(today, 1),
    categories: [{ key: 'habit', label: '习惯', color: 'blue', habit: true }, { key: 'work', label: '工作', color: 'green' }],
    dayTypes: [{ label: '每天', weekdays: ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'], modes: [{ label: '一种', blocks: [
      { id: 'english', start: '07:00', end: '08:00', title: '英语口语', note: '出声说', category: 'habit', kind: 'slot' },
      { id: 'read', start: '09:30', end: '10:00', title: '看书', category: 'habit', kind: 'slot' },
      { id: 'deep', start: '13:00', end: '18:00', title: '专注', category: 'work', kind: 'slot' },
    ] }] }] }] });
  const content = JSON.stringify({ todos: [
    { rank: 1, text: '读完第三章', candidateId: 'weekly:1:bbbbbbbb', minutes: 30, start: '09:30' },
    { rank: 2, text: '做方案', candidateId: 'weekly:0:aaaaaaaa', minutes: 90, start: '13:00' },
  ] });
  const process_ = process.cwd();
  process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'daily-os-routine-cwd-')));
  try {
    appendDailyMemory(cfg, 'daily_plan', today, content);
    writeLatestWorkflowOutput(cfg, 'daily_plan', today, content);
    const todos = buildTodayPlanSnapshot(cfg)?.todos ?? [];
    const english = todos.find((todo) => todo.candidateId === 'rhythm:habit:english');
    assert.deepEqual([english?.text, english?.start, english?.minutes, english?.habit], ['英语口语：出声说', '07:00', 60, true]);
    assert.ok(!todos.some((todo) => todo.candidateId === 'rhythm:habit:read'), 'the plan already put a row in 看书');
    assert.equal(todos.find((todo) => todo.candidateId === 'weekly:1:bbbbbbbb')?.habit, true, 'and that row is a habit');
    assert.equal(todos.find((todo) => todo.candidateId === 'weekly:0:aaaaaaaa')?.habit, undefined, 'a work slot is not');
    recordTodoFeedback(cfg, { date: today, event: 'complete', candidateId: 'rhythm:habit:english', rank: 3 });
    assert.equal(buildTodayPlanSnapshot(cfg)?.feedback['rhythm:habit:english'], 'complete', 'ticked like any row');
    recordTodoFeedback(cfg, { date: today, event: 'remove', candidateId: 'rhythm:habit:english', rank: 3 });
    assert.ok(!buildTodayPlanSnapshot(cfg)?.todos.some((todo) => todo.candidateId === 'rhythm:habit:english'), 'and let go on a day it cannot happen');
  } finally {
    process.chdir(process_);
  }
});

test('a plan run for today is told what time it is; another day\'s is not', () => {
  const cfg = config();
  cfg.user.timezone = 'Asia/Tokyo';
  const today = todayInTimezone(cfg);
  const line = nowLine({ config: cfg, date: today }, new Date('2026-10-08T08:22:00Z'));
  assert.match(line, /现在 17:22/);
  assert.equal(nowLine({ config: cfg, date: addDays(today, 1) }), '');
  const prompt = fs.readFileSync(path.join(REPO_ROOT, 'prompts', 'daily_plan.md'), 'utf8');
  assert.match(prompt, /不能早于 Date 里写的「现在」/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
