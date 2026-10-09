/**
 * 固定日程: each slot of today's 作息 is one to-do, holding the 要务 assigned to it.
 *
 * Before this, a slot was drawn as an empty band and the 要务 meant for it as a
 * separate row beside it — the same work on screen twice, and two 要务 that are
 * one daily action (read an AI article, post on X) as two rows. These pin the
 * assignment, the rows, and that the covered 要务 leave the plan.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

import { AppConfigSchema, type AppConfig } from '../../src/config/schema.js';
import { buildCycleId, readCycle, writeCycle } from '../../src/cycles/file.js';
import { fixedCoverage, fixedScheduleFor } from '../../src/cycles/fixed-schedule.js';
import { cycleScheduleItems, fixedTitleKey, normalizeSchedule, writeSchedule } from '../../src/cycles/schedule.js';
import { appendDailyMemory, writeLatestWorkflowOutput } from '../../src/storage/memory.js';
import { recordTodoFeedback } from '../../src/todo/feedback.js';
import { applyCycleSchedule, idFragment, type TodoCandidate } from '../../src/todo/scorer.js';
import { buildTodayPlanSnapshot } from '../../src/todo/today-plan.js';
import { writeRoutines } from '../../src/user/routine.js';
import { addDays, todayInTimezone } from '../../src/utils/date.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ORIGINAL_CWD = process.cwd();

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
  } finally {
    process.chdir(ORIGINAL_CWD);
  }
}

const PRIORITIES = [
  '### 工作 · 设计师',
  '- 落地页：1.首页框架 2.Banner **MIT**',
  '- 给老客户发回访邮件',
  '',
  '### 名利 · 写作',
  '- 每天读一篇英文文章并发到 X',
  '- X 日更 1 篇',
].join('\n');

const SITE = idFragment('落地页：1.首页框架 2.Banner **MIT**');
const MAIL = idFragment('给老客户发回访邮件');
const READ = idFragment('每天读一篇英文文章并发到 X');
const POST = idFragment('X 日更 1 篇');

/** A cycle around today, a 作息 every day, and a schedule with 固定日程 assigned. */
function setup(): { config: AppConfig; id: string; today: string } {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-os-fixed-'));
  process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'daily-os-fixed-cwd-')));
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
  writeRoutines(config, { periods: [{
    name: '这段时间', from: start, to: end,
    categories: [{ key: 'habit', label: '习惯', color: 'blue', habit: true }, { key: 'site', label: '落地页', color: 'green' }, { key: 'team', label: '团队', color: 'red' }],
    dayTypes: [{ label: '每天', weekdays: ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'], modes: [{ label: '一种', blocks: [
      { id: 'bip', start: '08:00', end: '09:00', title: 'Build in public', category: 'habit', kind: 'slot' },
      { id: 'standup', start: '11:00', end: '11:30', title: '日会', category: 'team', kind: 'slot' },
      { id: 'site-floor', start: '13:00', end: '14:30', title: '落地页 redesign', category: 'site', kind: 'slot', floor: true },
      { id: 'site-more', start: '14:30', end: '18:00', title: '落地页 redesign', category: 'site', kind: 'slot' },
      { id: 'dinner', start: '18:00', end: '19:00', title: '晚饭' },
    ] }] }],
  }] });
  const items = cycleScheduleItems(readCycle(config, id)!);
  const { schedule } = normalizeSchedule({
    sessions: [
      { itemKey: SITE, date: today, minutes: 90, step: '写首页框架' },
      { itemKey: SITE, date: addDays(today, 1), minutes: 90, step: '做 Banner' },
      { itemKey: READ, date: today, minutes: 30, step: '读一篇 AI 英文文章' },
      { itemKey: POST, date: today, minutes: 30, step: '发 1 条 X' },
      { itemKey: MAIL, date: today, start: '15:00', minutes: 60, bigRock: true, step: '发第一批回访邮件' },
    ],
    fixed: [
      { title: '落地页 Redesign', itemKeys: [SITE] },
      { title: 'Build in public', itemKeys: [READ, POST, SITE] },
    ],
  }, { cycleId: id, items, days: Array.from({ length: 14 }, (_, index) => addDays(start, index)), generatedAt: new Date().toISOString() });
  writeSchedule(config, schedule);
  return { config, id, today };
}

test('a 要务 belongs to one 固定日程 at most, and titles match however they are cased', () => {
  const { config, today } = setup();
  const rows = fixedScheduleFor(config, today);
  assert.deepEqual(rows.map((row) => row.candidateId), ['rhythm:habit:bip', 'rhythm:block:standup', 'rhythm:block:site-floor'], 'the second 落地页 slot is the flexible pool, not a row');
  const site = rows.find((row) => row.blockId === 'site-floor')!;
  assert.deepEqual([site.text, site.floor, site.minutes], ['落地页 redesign：写首页框架', true, 90]);
  const bip = rows.find((row) => row.blockId === 'bip')!;
  assert.equal(bip.text, 'Build in public：读一篇 AI 英文文章；发 1 条 X', 'two 要务 that are one daily action: one line');
  assert.deepEqual(bip.itemKeys.sort(), [READ, POST].sort(), 'the 落地页 key was already claimed');
  assert.equal(rows.find((row) => row.blockId === 'standup')!.text, '日会');
  assert.deepEqual([...fixedCoverage(rows)].sort(), [SITE, READ, POST].sort());
  assert.equal(fixedTitleKey('画画（补今天的，多画半小时）'), fixedTitleKey('画画'), 'a note for the day in brackets is still the same 固定日程');
  assert.notEqual(fixedTitleKey('Cutto 会议 + 会议纪要'), fixedTitleKey('Cutto'));
});

test('the 要务 inside a 固定日程 leave the plan: no row of their own, not a candidate', () => {
  const { config, today } = setup();
  const content = JSON.stringify({ todos: [
    { rank: 1, text: '写首页框架', candidateId: `weekly:0:${SITE}`, minutes: 90, start: '13:00' },
    { rank: 2, text: '发第一批回访邮件', candidateId: `weekly:1:${MAIL}`, minutes: 60, start: '15:00' },
  ] });
  appendDailyMemory(config, 'daily_plan', today, content);
  writeLatestWorkflowOutput(config, 'daily_plan', today, content);
  const snapshot = buildTodayPlanSnapshot(config)!;
  const ids = snapshot.todos.map((todo) => todo.candidateId);
  assert.ok(!ids.includes(`weekly:0:${SITE}`), 'the 落地页 row is inside its 固定日程');
  assert.ok(ids.includes(`weekly:1:${MAIL}`), 'a 要务 with no 固定日程 is its own row');
  const site = snapshot.todos.find((todo) => todo.candidateId === 'rhythm:block:site-floor')!;
  assert.deepEqual([site.start, site.fixed, site.floor, site.category, site.color], ['13:00', true, true, '落地页', 'green']);

  const candidate = (key: string): TodoCandidate => ({ id: `weekly:0:${key}`, source: 'weekly_priorities', text: key } as TodoCandidate);
  const { scheduled, rest } = applyCycleSchedule([candidate(SITE), candidate(MAIL)], {
    today: [{ itemKey: SITE, minutes: 90 }, { itemKey: MAIL, minutes: 60 }],
    elsewhere: new Set(),
    covered: new Set([SITE]),
  });
  assert.deepEqual([...scheduled, ...rest].map((entry) => entry.id), [`weekly:0:${MAIL}`]);

  recordTodoFeedback(config, { date: today, event: 'complete', candidateId: `weekly:0:${SITE}`, rank: 1 });
  assert.equal(buildTodayPlanSnapshot(config)!.feedback['rhythm:block:site-floor'], 'complete', 'ticked through its 要务 counts');
  recordTodoFeedback(config, { date: today, event: 'missed', candidateId: 'rhythm:habit:bip', rank: 9 });
  assert.equal(buildTodayPlanSnapshot(config)!.feedback['rhythm:habit:bip'], 'missed');
});

test('a day whose 要务 all sit in 固定日程 still has its sheet', () => {
  const { config, today } = setup();
  const content = JSON.stringify({ todos: [], note: '今天的事都在固定日程里。' });
  appendDailyMemory(config, 'daily_plan', today, content);
  writeLatestWorkflowOutput(config, 'daily_plan', today, content);
  const ids = buildTodayPlanSnapshot(config)!.todos.map((todo) => todo.candidateId);
  assert.deepEqual(ids.sort(), ['rhythm:block:site-floor', 'rhythm:block:standup', 'rhythm:habit:bip']);
});

test('the prompts say 固定日程 are written by the system and how 要务 are assigned', () => {
  const plan = fs.readFileSync(path.join(REPO_ROOT, 'prompts', 'daily_plan.md'), 'utf8');
  assert.match(plan, /不要为固定日程写条目/);
  const schedule = fs.readFileSync(path.join(REPO_ROOT, 'prompts', 'cycle_schedule.md'), 'utf8');
  assert.match(schedule, /一条要务最多归一个固定日程/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
