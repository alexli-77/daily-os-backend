/**
 * 双周排期 (cycle schedule).
 *
 * The daily plan re-derived the whole cycle every morning from a flat list of
 * 要务, so it was wrong in the same ways every day. Now the cycle is laid out
 * once — big rocks in concrete slots, the rest on days — and each day's plan
 * is a slice of it. These tests pin the three joints: what a schedule may
 * contain, how generation keeps the past, and how a day's plan is sliced.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

import { AppConfigSchema, type AppConfig } from '../../src/config/schema.js';
import { parseAgenda } from '../../src/calendar/agenda.js';
import { buildCycleId, readCycle, writeCycle } from '../../src/cycles/file.js';
import {
  cycleScheduleItems,
  generateCycleSchedule,
  normalizeSchedule,
  readSchedule,
  scheduledElsewhere,
  scheduledSessionsFor,
  writeSchedule,
} from '../../src/cycles/schedule.js';
import { appendDailyMemory, writeLatestWorkflowOutput } from '../../src/storage/memory.js';
import { recordTodoFeedback } from '../../src/todo/feedback.js';
import { applyCycleSchedule, buildScoredTodos, idFragment, type TodoCandidate } from '../../src/todo/scorer.js';
import { buildTodayPlanSnapshot } from '../../src/todo/today-plan.js';
import { addDays, todayInTimezone } from '../../src/utils/date.js';
import type { Evidence } from '../../src/workflows/types.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ORIGINAL_CWD = process.cwd();

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
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

const PRIORITIES = [
  '### 工作 · 设计师',
  '- 写完方案初稿 **MIT**',
  '- 整理作品集首页',
  '- 已经做完的事 ✅',
  '',
  '### 享乐 · 生活',
  '- 打球 3 次',
].join('\n');

const DRAFT = idFragment('写完方案初稿 **MIT**');
const PORTFOLIO = idFragment('整理作品集首页');
const SPORT = idFragment('打球 3 次');

/** A vault with one 14-day cycle that started three days before `today`. */
function setup(): { config: AppConfig; id: string; today: string; days: string[] } {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-os-sched-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-os-sched-cwd-'));
  process.chdir(work);
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
  return { config, id, today, days: Array.from({ length: 14 }, (_, index) => addDays(start, index)) };
}

await test('the schedulable 要务 are the open bullets, keyed like the plan\'s weekly ids, with role and MIT', () => {
  const { config, id } = setup();
  const items = cycleScheduleItems(JSON.parse(JSON.stringify(readCycle(config, id))));
  assert.deepEqual(items.map((item) => item.key), [DRAFT, PORTFOLIO, SPORT], 'the ✅ one is not schedulable');
  assert.equal(items[0]?.mit, true);
  assert.equal(items[2]?.okr, '享乐 · 生活');
});

await test('a schedule only says things that can be true', () => {
  const { config, id, days } = setup();
  const items = cycleScheduleItems(readCycle(config, id)!);
  const { schedule, dropped } = normalizeSchedule(
    {
      sessions: [
        { itemKey: DRAFT, date: days[5], start: '10:00', minutes: 100, bigRock: true },
        { itemKey: PORTFOLIO, date: days[4], minutes: 60, bigRock: true },
        { itemKey: 'deadbeef', date: days[4], minutes: 60 },
        { itemKey: SPORT, date: addDays(days[13]!, 1), minutes: 60 },
        { itemKey: SPORT, date: days[6], minutes: 999, start: '25:00' },
      ],
      deadlines: [{ itemKey: DRAFT, date: days[6] }, { itemKey: 'deadbeef', date: days[6] }],
    },
    { cycleId: id, items, days, generatedAt: 'now' },
  );
  assert.equal(dropped, 3, 'unknown 要务, a day outside the cycle, an unknown deadline');
  assert.deepEqual(schedule.sessions.map((session) => session.itemKey), [PORTFOLIO, DRAFT, SPORT], 'sorted by day');
  assert.equal(schedule.sessions[0]?.bigRock, undefined, 'a big rock without a time is just a day');
  assert.equal(schedule.sessions[1]?.minutes, 105, 'snapped to 15 minutes');
  assert.equal(schedule.sessions[2]?.minutes, 240, 'capped');
  assert.equal(schedule.sessions[2]?.start, undefined, 'a clock time that is not one is dropped');
  assert.equal(schedule.sessions[1]?.label, '写完方案初稿 **MIT**', 'the label is the 要务 text, not whatever was sent');
});

await test('generation plans from today on, keeps what was behind it, and saves beside the cycle', async () => {
  const { config, id, today, days } = setup();
  writeSchedule(config, {
    cycleId: id,
    generatedAt: 'before',
    sessions: [{ id: 's-old', itemKey: SPORT, label: '打球 3 次', date: days[1]!, minutes: 90 }],
    deadlines: [],
  });
  let seen: any = null;
  const { schedule } = await generateCycleSchedule(config, id, {
    today,
    nowClock: '14:20',
    now: 'now',
    events: [{ date: today, start: '11:30', end: '12:00', title: '日会' }, { date: addDays(today, 1), title: '团建' }],
    run: async (input) => {
      seen = input.evidence.sources.cycle_schedule_input?.data;
      return JSON.stringify({
        sessions: [
          { itemKey: DRAFT, date: today, start: '09:30', minutes: 120, bigRock: true },
          { itemKey: SPORT, date: days[1], minutes: 60 },
        ],
        deadlines: [{ itemKey: DRAFT, date: addDays(today, 2) }],
        note: '先保住方案',
      });
    },
  });
  assert.equal(seen.days[0].date, today, 'the model only gets the days still ahead');
  assert.equal(seen.nowClock, '14:20', 'and knows how much of today is left');
  assert.deepEqual(seen.days[0].events, ['11:30-12:00 日会'], 'and what the calendar already holds');
  assert.deepEqual(seen.days[1].events, ['全天 团建']);
  assert.deepEqual(seen.pastSessions.map((session: any) => session.id), ['s-old']);
  assert.deepEqual(schedule.sessions.map((session) => session.id === 's-old' || session.date === today), [true, true], 'the past is kept; the model cannot rewrite it');
  assert.equal(readSchedule(config, id)?.note, '先保住方案');
  assert.ok(fs.existsSync(path.join(config.memory.repository_path, '20_CYCLES', `${id}.schedule.json`)));
});

await test('a reply that is not a schedule fails loudly and leaves the old one alone', async () => {
  const { config, id, today } = setup();
  writeSchedule(config, { cycleId: id, generatedAt: 'before', sessions: [], deadlines: [] });
  await assert.rejects(generateCycleSchedule(config, id, { today, events: [], run: async () => '好的，我来排一下……' }), /JSON/);
  assert.equal(readSchedule(config, id)?.generatedAt, 'before');
});

const weekly = (text: string, index: number): TodoCandidate => ({ id: `weekly:${index}:${idFragment(text)}`, title: text, source: 'weekly_priorities' });

await test('slicing: today\'s sessions lead with their slot, other days\' 要务 wait for their day, the rest is untouched', () => {
  const candidates: TodoCandidate[] = [
    weekly('写完方案初稿 **MIT**', 0),
    weekly('整理作品集首页', 1),
    weekly('打球 3 次', 2),
    weekly('没排进排期的事', 3),
    { id: 'linear:XX-1', title: 'issue', source: 'linear' },
  ];
  const { scheduled, rest } = applyCycleSchedule(candidates, {
    today: [
      { itemKey: SPORT, minutes: 60 },
      { itemKey: DRAFT, minutes: 60, start: '14:00', bigRock: true },
      { itemKey: DRAFT, minutes: 60, start: '10:00' },
    ],
    elsewhere: new Set([PORTFOLIO]),
  });
  assert.deepEqual(scheduled.map((candidate) => candidate.title), ['写完方案初稿 **MIT**', '打球 3 次'], 'big rock first');
  assert.deepEqual(scheduled[0]?.scheduled, { minutes: 120, start: '10:00', bigRock: true }, 'two sessions of one 要务 are one row');
  assert.deepEqual(rest.map((candidate) => candidate.id), ['weekly:3:' + idFragment('没排进排期的事'), 'linear:XX-1']);
  assert.deepEqual(applyCycleSchedule(candidates, undefined).rest, candidates, 'no schedule, no change');
});

await test('scheduled rows survive ranking even with the lowest scores, within the same top-N', () => {
  const { config } = setup();
  const evidence = {
    generated_at: '',
    date: '2026-10-08',
    sources: {
      linear: { state: 'available', data: { issues: { nodes: Array.from({ length: 12 }, (_, index) => ({ identifier: `XX-${index}`, title: ['登录', '支付', '导出', '搜索', '通知', '设置', '分享', '上传', '评论', '订阅', '标签', '归档'][index % 12] + '模块重构', priority: 1, dueDate: '2026-10-01', state: { name: 'In Progress', type: 'started' } })) } } },
      weekly_priorities: { state: 'available', data: { items: [{ item: '打球 3 次', okr: '' }] } },
    },
  } as unknown as Evidence;
  const result = buildScoredTodos(config, evidence, '2026-10-08', {
    topN: 5,
    completedCandidateIds: new Set(),
    removedCandidateIds: new Set(),
    carryOverDaysById: new Map(),
    schedule: { today: [{ itemKey: SPORT, minutes: 90 }], elsewhere: new Set() },
  });
  assert.equal(result.top.length, 5);
  assert.equal(result.top[0]?.title, '打球 3 次');
  assert.deepEqual(result.top[0]?.scheduled, { minutes: 90, bigRock: false });
});

await test('each session can say what it does; the plan gets today\'s step, two steps on one day joined', () => {
  const { config, id, days } = setup();
  const items = cycleScheduleItems(readCycle(config, id)!);
  const { schedule } = normalizeSchedule(
    { sessions: [
      { itemKey: DRAFT, date: days[5], minutes: 60, step: '  整理表格，分析用户  ' },
      { itemKey: DRAFT, date: days[6], minutes: 60, step: 'x'.repeat(200) },
      { itemKey: SPORT, date: days[6], minutes: 60 },
    ] },
    { cycleId: id, items, days, generatedAt: 'now' },
  );
  assert.equal(schedule.sessions[0]?.step, '整理表格，分析用户');
  assert.equal(schedule.sessions[1]?.step?.length, 80, 'one line on a calendar block');
  assert.equal(schedule.sessions[2]?.step, undefined);
  const { scheduled } = applyCycleSchedule([weekly('写完方案初稿 **MIT**', 0)], {
    today: [{ itemKey: DRAFT, minutes: 60, step: '整理表格' }, { itemKey: DRAFT, minutes: 30, step: '发第一批邮件' }],
    elsewhere: new Set(),
  });
  assert.equal(scheduled[0]?.scheduled?.step, '整理表格；发第一批邮件');
});

await test('a 要务 ticked on an earlier day is still planned on a day the schedule gives it', () => {
  const { config, today } = setup();
  const yesterday = addDays(today, -1);
  const id = `weekly:0:${DRAFT}`;
  recordTodoFeedback(config, { date: yesterday, event: 'complete', candidateId: id, rank: 1 });
  const evidence = {
    generated_at: '', date: today,
    sources: { weekly_priorities: { state: 'available', data: { items: [{ item: '写完方案初稿 **MIT**', okr: '' }, { item: '整理作品集首页', okr: '' }] } } },
  } as unknown as Evidence;
  const ids = (schedule: any) => buildScoredTodos(config, evidence, today, { carryOverDaysById: new Map(), schedule }).top.map((candidate) => candidate.id);
  assert.ok(ids({ today: [{ itemKey: DRAFT, minutes: 60 }], elsewhere: new Set() }).includes(id), 'today\'s session is new work');
  assert.ok(!ids(undefined).includes(id), 'with no schedule a ticked 要务 stays done, as before');
  recordTodoFeedback(config, { date: today, event: 'complete', candidateId: id, rank: 1 });
  assert.ok(!ids({ today: [{ itemKey: DRAFT, minutes: 60 }], elsewhere: new Set() }).includes(id), 'ticked today: today\'s session is done');
});

await test('the schedule\'s slice for a date, and what waits for another day', () => {
  const { config, id, today, days } = setup();
  writeSchedule(config, {
    cycleId: id,
    generatedAt: 'now',
    sessions: [
      { id: 'a', itemKey: DRAFT, label: 'x', date: today, start: '10:00', minutes: 60, bigRock: true },
      { id: 'b', itemKey: PORTFOLIO, label: 'y', date: days[10]!, minutes: 60 },
      { id: 'c', itemKey: DRAFT, label: 'x', date: days[11]!, minutes: 60 },
    ],
    deadlines: [],
  });
  assert.deepEqual(scheduledSessionsFor(config, today).map((session) => session.id), ['a']);
  assert.deepEqual([...scheduledElsewhere(config, today)], [PORTFOLIO], 'a 要务 on today and later days is today\'s');
});

await test('a big rock sits at its reserved time on today\'s sheet until the user moves it', () => {
  const { config, id, today } = setup();
  writeSchedule(config, {
    cycleId: id,
    generatedAt: 'now',
    sessions: [{ id: 'a', itemKey: DRAFT, label: 'x', date: today, start: '10:00', minutes: 60, bigRock: true }],
    deadlines: [],
  });
  const candidateId = `weekly:0:${DRAFT}`;
  const content = JSON.stringify({ todos: [{ rank: 1, text: '写方案', candidateId, minutes: 60 }, { rank: 2, text: '别的', candidateId: 'linear:XX-1' }] });
  appendDailyMemory(config, 'daily_plan', today, content);
  writeLatestWorkflowOutput(config, 'daily_plan', today, content);
  const row = () => buildTodayPlanSnapshot(config)?.todos.find((todo) => todo.candidateId === candidateId);
  assert.equal(row()?.start, '10:00');
  assert.equal(buildTodayPlanSnapshot(config)?.todos.find((todo) => todo.candidateId === 'linear:XX-1')?.start, undefined);
  recordTodoFeedback(config, { date: today, event: 'place', candidateId, rank: 1, start: '15:00' });
  assert.equal(row()?.start, '15:00', 'the user\'s move wins');
});

await test('a Feishu agenda is read in the user\'s timezone, declined events left out, midnight-crossers cut at 24:00', () => {
  const events = parseAgenda(
    {
      data: [
        { summary: '日会', start_time: { datetime: '2026-10-08T10:30:00+08:00' }, end_time: { datetime: '2026-10-08T11:00:00+08:00' }, self_rsvp_status: 'accept' },
        { summary: '不去', start_time: { datetime: '2026-10-08T15:00:00+09:00' }, end_time: { datetime: '2026-10-08T16:00:00+09:00' }, self_rsvp_status: 'decline' },
        { summary: '夜里', start_time: { datetime: '2026-10-14T23:30:00+09:00' }, end_time: { datetime: '2026-10-15T00:00:00+09:00' } },
        { summary: '假期', start_time: { date: '2026-10-12' }, end_time: { date: '2026-10-13' } },
      ],
    },
    'Asia/Tokyo',
  );
  assert.deepEqual(events, [
    { date: '2026-10-08', start: '11:30', end: '12:00', title: '日会' },
    { date: '2026-10-14', start: '23:30', end: '24:00', title: '夜里' },
    { date: '2026-10-12', title: '假期' },
  ]);
});

await test('the prompts carry the contract', () => {
  const schedule = fs.readFileSync(path.join(REPO_ROOT, 'prompts', 'cycle_schedule.md'), 'utf8');
  assert.match(schedule, /itemKey.*原样回填/);
  assert.match(schedule, /给优先级排日程/);
  assert.match(schedule, /`nowClock`/);
  assert.match(schedule, /`events` 占用的时段不能排任何东西/);
  assert.match(schedule, /每个格子写 `step`/);
  const plan = fs.readFileSync(path.join(REPO_ROOT, 'prompts', 'daily_plan.md'), 'utf8');
  assert.match(plan, /关于 `scheduled`（双周排期）/);
  assert.match(plan, /有 `scheduled.step` 的，`text` 就按这一步写/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
