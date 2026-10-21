/**
 * 计划外: what a cycle's days went to outside its 要务, and 加进要务.
 *
 * Run: tsx scripts/tests/unplanned.test.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

import { AppConfigSchema, type AppConfig } from '../../src/config/schema.js';
import { buildCycleId, readCycle, writeCycle } from '../../src/cycles/file.js';
import { cycleScheduleItems, writeSchedule } from '../../src/cycles/schedule.js';
import {
  PROMOTED_HEADING,
  adhocSessionId,
  refilePromoted,
  formatUnplanned,
  markSuggested,
  promoteToPriorities,
  shouldSuggestPromote,
  unplannedForCycle,
  unplannedKey,
} from '../../src/cycles/unplanned.js';
import { recordTodoFeedback } from '../../src/todo/feedback.js';
import { captureTodoItems, updateTodoInboxItemById } from '../../src/todo/inbox.js';
import { writeRoutines } from '../../src/user/routine.js';
import { addDays, todayInTimezone } from '../../src/utils/date.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ORIGINAL_CWD = process.cwd();

let passed = 0;
let failed = 0;
const tests: Array<[string, () => void | Promise<void>]> = [];
function test(name: string, fn: () => void | Promise<void>): void {
  tests.push([name, fn]);
}
async function run(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(`    ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    process.chdir(ORIGINAL_CWD);
  }
}

const PRIORITIES = ['### 工作 · 设计师', '1. 作品集首页上线 **MIT**', '2. 给老客户发回访邮件', '', '### 名利 · 写作', '- X 日更 1 篇'].join('\n');

function setup(): { config: AppConfig; id: string; today: string; yesterday: string } {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-os-unplanned-'));
  process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'daily-os-unplanned-cwd-')));
  const parsed = yaml.load(fs.readFileSync(path.join(REPO_ROOT, 'config', 'config.example.yaml'), 'utf8')) as Record<string, any>;
  parsed.memory.repository_path = vault;
  parsed.user.timezone = 'UTC';
  const config = AppConfigSchema.parse(parsed);
  const today = todayInTimezone(config);
  const start = addDays(today, -3);
  const end = addDays(start, 13);
  const label = `${Number(start.slice(5, 7))}.${Number(start.slice(8))}-${Number(end.slice(5, 7))}.${Number(end.slice(8))}`;
  const id = buildCycleId(start, label);
  writeCycle(config, id, { cycle: label, mode: 'biweekly', sections: { '要务': { content: PRIORITIES, source: 'user' } } });
  return { config, id, today, yesterday: addDays(today, -1) };
}

function capture(config: AppConfig, text: string): string {
  return captureTodoItems(config, text, { source: 'console-adhoc' }).items![0]!.id;
}

function touch(config: AppConfig, id: string, date: string, event: 'update' | 'complete' | 'remove' | 'place', minutes?: number): void {
  recordTodoFeedback(config, { date, event, candidateId: `todo_inbox:${id}`, rank: 0, source: 'test', ...(minutes ? { minutes } : {}), ...(event === 'place' ? { start: '15:00' } : {}) });
}

test('captures outside the 要务 are grouped by wording, with their days and time', () => {
  const { config, id, today, yesterday } = setup();
  const first = capture(config, '见朋友');
  touch(config, first, yesterday, 'update', 120);
  const second = capture(config, '见 朋友！');
  touch(config, second, today, 'update', 60);
  touch(config, second, today, 'complete');
  const once = capture(config, '逛街买鞋');
  touch(config, once, today, 'update', 240);

  const items = unplannedForCycle(config, readCycle(config, id)!, today);
  assert.deepEqual(items.map((item) => item.text), ['逛街买鞋', '见 朋友！']);
  const friend = items[1]!;
  assert.deepEqual(friend.days, [yesterday, today]);
  assert.equal(friend.minutes, 180);
  assert.equal(friend.done, true);
  assert.deepEqual(friend.captureIds.sort(), [first, second].sort());
  assert.equal(formatUnplanned(items), '逛街买鞋（1 天，4h）、见 朋友！（2 天，3h）');
});

test('a capture tied to a 要务 is not 计划外', () => {
  const { config, id, today } = setup();
  touch(config, capture(config, '作品集首页上线'), today, 'update', 60);
  touch(config, capture(config, 'X 日更 1 篇'), today, 'update', 30);
  const picked = capture(config, '写首页 hero 区');
  touch(config, picked, today, 'update', 90);
  const items = cycleScheduleItems(readCycle(config, id)!);
  writeSchedule(config, {
    cycleId: id,
    generatedAt: new Date().toISOString(),
    sessions: [{ id: adhocSessionId(picked), itemKey: items[0]!.key, label: items[0]!.text, date: today, minutes: 90, adhoc: true }],
  } as never);
  assert.deepEqual(unplannedForCycle(config, readCycle(config, id)!, today), []);
});

test('deleted on its day, or deleted outright, it does not count', () => {
  const { config, id, today } = setup();
  const removed = capture(config, '买菜');
  touch(config, removed, today, 'remove');
  const gone = capture(config, '修自行车');
  updateTodoInboxItemById(config, gone, { status: 'deleted' });
  assert.deepEqual(unplannedForCycle(config, readCycle(config, id)!, today), []);
});

test('days after `until` and outside the cycle are not counted', () => {
  const { config, id, today } = setup();
  const later = capture(config, '看展');
  touch(config, later, addDays(today, 2), 'update', 60);
  touch(config, later, addDays(today, 40), 'update', 60);
  const items = unplannedForCycle(config, readCycle(config, id)!, today);
  assert.deepEqual(items[0]!.days, [today], 'only its capture day counts');
});

test('asked about on the second day or past two hours, once', () => {
  const day = (days: number, minutes: number | null) => ({ key: 'k', text: 't', days: Array.from({ length: days }, (_, index) => `2026-10-0${index + 1}`), minutes, done: false, captureIds: [] });
  assert.equal(shouldSuggestPromote(day(1, 60)), false);
  assert.equal(shouldSuggestPromote(day(2, null)), true);
  assert.equal(shouldSuggestPromote(day(1, 120)), true);
  setup();
  assert.equal(markSuggested('c1', 'k'), true);
  assert.equal(markSuggested('c1', 'k'), false);
  assert.equal(markSuggested('c2', 'k'), true, 'a new cycle asks again');
});

test('加进要务 with no OKR picked files it under 计划外新增 and it leaves the 计划外 list', async () => {
  const { config, id, today } = setup();
  touch(config, capture(config, '迭代 Daily OS'), today, 'update', 120);
  assert.equal((await promoteToPriorities(config, id, '迭代 Daily OS')).added, true);
  assert.equal((await promoteToPriorities(config, id, '整理照片')).heading, PROMOTED_HEADING);
  assert.equal((await promoteToPriorities(config, id, '迭代  daily os')).added, false, 'already there');

  const content = readCycle(config, id)!.sections['要务']!.content;
  assert.equal(content.split('\n').filter((line) => line.trim() === PROMOTED_HEADING).length, 1);
  assert.ok(content.includes(`${PROMOTED_HEADING}\n- 迭代 Daily OS\n- 整理照片`));
  assert.ok(content.startsWith(PRIORITIES), 'the 要务 above are untouched');
  assert.ok(cycleScheduleItems(readCycle(config, id)!).some((item) => unplannedKey(item.text) === unplannedKey('迭代 Daily OS')), 'a 要务 the schedule can use');
  assert.deepEqual(unplannedForCycle(config, readCycle(config, id)!, today), []);
});

test('加进要务 goes under the OKR the model picks, and keeps a pending draft', async () => {
  const { config, id } = setup();
  writeCycle(config, id, { sections: { '要务': { pendingDraft: { content: '结束本期的草稿', source: 'planner' } } } });
  let asked = '';
  const ask = async (prompt: string) => { asked = prompt; return '1:2'; };
  const result = await promoteToPriorities(config, id, '整理写作素材库', ask);
  assert.equal(result.heading, '### 名利 · 写作');
  assert.ok(asked.includes('1. 工作 · 设计师') && asked.includes('2. 名利 · 写作') && asked.includes('1. 整理写作素材库'));
  const section = readCycle(config, id)!.sections['要务']!;
  assert.ok(section.content.includes('- X 日更 1 篇\n- 整理写作素材库'), 'at the end of its group');
  assert.ok(!section.content.includes(PROMOTED_HEADING));
  assert.equal(section.pendingDraft?.content.trim(), '结束本期的草稿', 'the draft survives');
  // A model that answers nonsense or fails leaves it in the pen.
  assert.equal((await promoteToPriorities(config, id, '别的事', async () => '不知道')).heading, PROMOTED_HEADING);
  assert.equal((await promoteToPriorities(config, id, '再一件', async () => { throw new Error('down'); })).heading, PROMOTED_HEADING);
});

test('what sits in 计划外新增 is refiled to its OKR groups, and the pen goes when empty', async () => {
  const { config, id } = setup();
  await promoteToPriorities(config, id, '用户访谈');
  await promoteToPriorities(config, id, '调优 daily OS 工具');
  const moved = await refilePromoted(config, id, async () => '1:1\n2:2');
  assert.deepEqual(moved.map((entry) => entry.text), ['用户访谈', '调优 daily OS 工具']);
  const content = readCycle(config, id)!.sections['要务']!.content;
  assert.ok(!content.includes(PROMOTED_HEADING));
  assert.ok(content.includes('2. 给老客户发回访邮件\n- 用户访谈'));
  assert.ok(content.includes('- X 日更 1 篇\n- 调优 daily OS 工具'));
});

test('written down twice on one day is one stretch of time', () => {
  const { config, id, today } = setup();
  touch(config, capture(config, 'skill透出'), today, 'update', 180);
  touch(config, capture(config, 'skill透出'), today, 'update', 120);
  const [item] = unplannedForCycle(config, readCycle(config, id)!, today);
  assert.deepEqual([item!.days.length, item!.minutes, item!.captureIds.length], [1, 180, 2]);
});

test('a block of the 作息 written down as a to-do is not 计划外', () => {
  const { config, id, today } = setup();
  writeRoutines(config, { periods: [{
    name: '这段时间', from: addDays(today, -30), to: addDays(today, 30),
    dayTypes: [{ label: '每天', weekdays: ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'], modes: [{ label: '一种', blocks: [
      { id: 'english', start: '07:00', end: '08:00', title: '英语口语', kind: 'slot' },
    ] }] }],
  }] } as never);
  touch(config, capture(config, '英语口语'), today, 'update', 60);
  touch(config, capture(config, '见朋友'), today, 'update', 60);
  assert.deepEqual(unplannedForCycle(config, readCycle(config, id)!, today).map((item) => item.text), ['见朋友']);
});

for (const [name, fn] of tests) await run(name, fn);
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
