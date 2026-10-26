/**
 * 回收 — closing out a day whose evening review never ran.
 *
 * Independent, tsx-runnable:  npx tsx scripts/tests/wrapup.test.ts
 *
 * The scheduler only catches a missed review up on the same day, so a Mac
 * that slept through 21:30 left the day unclosed for good (2026-10-19). These
 * tests pin what counts as pending, that 回收 / 跳过 each close it for good,
 * and that 挪到今天 really puts the row on today's sheet — now, or when the
 * morning plan is generated if it has not been yet.
 *
 * Nothing here runs a review: `done` is only exercised on a day that already
 * has one, because the late review calls the model.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

import { AppConfigSchema, type AppConfig } from '../../src/config/schema.js';
import { appendDailyMemory, writeLatestWorkflowOutput } from '../../src/storage/memory.js';
import { listTodoFeedback } from '../../src/todo/feedback.js';
import { readDayHistory } from '../../src/todo/day-history.js';
import { buildTodayPlanSnapshot } from '../../src/todo/today-plan.js';
import { mergeMovedRowsIntoPlan, moveRowToDay, openRowsOf, pendingWrapups, recordWrapup, rowNeedsCleanup } from '../../src/todo/wrapup.js';
import { addDays, todayInTimezone } from '../../src/utils/date.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ORIGINAL_CWD = process.cwd();
let failures = 0;

async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`  ✗ ${name}\n    ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  }
}

function freshConfig(): { config: AppConfig; dir: string; parsed: Record<string, any> } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-os-wrapup-'));
  process.chdir(dir);
  const parsed = yaml.load(fs.readFileSync(path.join(REPO_ROOT, 'config', 'config.example.yaml'), 'utf8')) as Record<string, any>;
  parsed.memory.repository_path = path.join(dir, 'vault');
  parsed.todo_inbox.ledger_path = path.join(dir, 'todo-inbox.jsonl');
  parsed.todo_inbox.vault_path = path.join(dir, 'todo-inbox.md');
  parsed.user.rhythm.meal_blocks = [];
  fs.mkdirSync(parsed.memory.repository_path, { recursive: true });
  return { config: AppConfigSchema.parse(parsed), dir, parsed };
}

const plan = (...ids: string[]): string =>
  JSON.stringify({ todos: ids.map((candidateId, index) => ({ rank: index + 1, text: `第 ${index + 1} 件`, candidateId, minutes: 30 })) });

function planDay(config: AppConfig, date: string, ...ids: string[]): void {
  appendDailyMemory(config, 'daily_plan', date, plan(...ids));
}

function planToday(config: AppConfig, ...ids: string[]): void {
  const today = todayInTimezone(config);
  appendDailyMemory(config, 'daily_plan', today, plan(...ids));
  writeLatestWorkflowOutput(config, 'daily_plan', today, plan(...ids));
}

async function testPending(): Promise<void> {
  console.log('\n--- what is pending ---');
  await check('a day with a plan and no review is pending, oldest first', () => {
    const { config } = freshConfig();
    const today = todayInTimezone(config);
    planDay(config, addDays(today, -1), 'linear:A-1');
    planDay(config, addDays(today, -3), 'linear:A-2', 'linear:A-3');
    assert.deepEqual(pendingWrapups(config, today).map((day) => day.date), [addDays(today, -3), addDays(today, -1)]);
    assert.deepEqual(pendingWrapups(config, today)[0]!.todos.map((row) => row.candidateId), ['linear:A-2', 'linear:A-3']);
  });
  await check('a reviewed day with a row nobody decided on is still pending', () => {
    const { config } = freshConfig();
    const today = todayInTimezone(config);
    planDay(config, addDays(today, -1), 'linear:A-1');
    appendDailyMemory(config, 'daily_review', addDays(today, -1), '{"reconciliation":[]}');
    planDay(config, addDays(today, -2), 'linear:A-1');
    appendDailyMemory(config, 'weekly_review', addDays(today, -2), '周复盘');
    assert.deepEqual(pendingWrapups(config, today).map((day) => day.date), [addDays(today, -2), addDays(today, -1)]);
  });
  await check('a day whose rows all have a state is clean, reviewed or not', () => {
    const { config } = freshConfig();
    const today = todayInTimezone(config);
    const yesterday = addDays(today, -1);
    planDay(config, yesterday, 'linear:A-1', 'linear:A-2', 'linear:A-3', 'linear:A-4');
    fs.mkdirSync('data/runtime', { recursive: true });
    const events = [['complete', 'linear:A-1'], ['partial', 'linear:A-2'], ['missed', 'linear:A-3'], ['defer', 'linear:A-4']];
    fs.writeFileSync(
      'data/runtime/todo-feedback.jsonl',
      events.map(([event, candidateId], index) => JSON.stringify({ ts: 'x', date: yesterday, event, candidateId, rank: index + 1 })).join('\n') + '\n',
    );
    assert.deepEqual(pendingWrapups(config, today), []);
    assert.deepEqual(openRowsOf(config, yesterday), []);
  });
  await check('an edit alone is not a decision, and 固定日程 never need one', () => {
    assert.equal(rowNeedsCleanup('linear:A-1', undefined), true);
    assert.equal(rowNeedsCleanup('linear:A-1', 'update'), true);
    assert.equal(rowNeedsCleanup('linear:A-1', 'missed'), false);
    assert.equal(rowNeedsCleanup('rhythm:block:b1', undefined), false);
  });
  await check('a day with no plan is not asked about', () => {
    const { config } = freshConfig();
    const today = todayInTimezone(config);
    assert.deepEqual(pendingWrapups(config, today), []);
  });
  await check('today is never pending, and a day beyond the lookback is not asked about', () => {
    const { config } = freshConfig();
    const today = todayInTimezone(config);
    planDay(config, today, 'linear:A-1');
    planDay(config, addDays(today, -8), 'linear:A-1');
    assert.deepEqual(pendingWrapups(config, today), []);
  });
  await check('回收 or 跳过 closes the day for good', () => {
    const { config } = freshConfig();
    const today = todayInTimezone(config);
    planDay(config, addDays(today, -1), 'linear:A-1');
    planDay(config, addDays(today, -2), 'linear:A-1');
    recordWrapup(addDays(today, -1), 'done');
    recordWrapup(addDays(today, -2), 'skipped');
    assert.deepEqual(pendingWrapups(config, today), []);
  });
  await check('rows carry how they were left', () => {
    const { config } = freshConfig();
    const today = todayInTimezone(config);
    planDay(config, addDays(today, -1), 'linear:A-1', 'linear:A-2');
    fs.mkdirSync('data/runtime', { recursive: true });
    fs.writeFileSync('data/runtime/todo-feedback.jsonl', `${JSON.stringify({ ts: 'x', date: addDays(today, -1), event: 'complete', candidateId: 'linear:A-1', rank: 1 })}\n`);
    assert.deepEqual(pendingWrapups(config, today)[0]!.todos.map((row) => row.state ?? 'open'), ['complete', 'open']);
  });
}

async function testMove(): Promise<void> {
  console.log('\n--- 挪到今天 ---');
  await check('onto today\'s plan when it exists, and the past day reads as carried', () => {
    const { config } = freshConfig();
    const today = todayInTimezone(config);
    const yesterday = addDays(today, -1);
    planDay(config, yesterday, 'linear:A-1', 'linear:A-2');
    planToday(config, 'linear:B-1');
    const result = moveRowToDay(config, yesterday, today, 'linear:A-2', 2);
    assert.equal(result.ok && result.placed, 'appended');
    assert.deepEqual(buildTodayPlanSnapshot(config)?.todos.map((todo) => todo.candidateId), ['linear:B-1', 'linear:A-2']);
    const past = readDayHistory(config, yesterday);
    assert.equal(past.feedback['linear:A-2'], 'defer');
    assert.match(past.notes['linear:A-2'] ?? '', /挪到了/);
    assert.equal(listTodoFeedback(config).some((entry) => entry.date === today), false, 'today gets no ledger entry, only the row');
  });
  await check('a row already on today\'s plan is not added twice', () => {
    const { config } = freshConfig();
    const today = todayInTimezone(config);
    planDay(config, addDays(today, -1), 'linear:A-1');
    planToday(config, 'linear:A-1');
    const result = moveRowToDay(config, addDays(today, -1), today, 'linear:A-1', 1);
    assert.equal(result.ok && result.placed, 'already');
    assert.equal(buildTodayPlanSnapshot(config)?.todos.length, 1);
  });
  await check('before today\'s plan exists, it waits and joins the plan when it is generated', () => {
    const { config } = freshConfig();
    const today = todayInTimezone(config);
    planDay(config, addDays(today, -1), 'linear:A-1');
    const result = moveRowToDay(config, addDays(today, -1), today, 'linear:A-1', 1);
    assert.equal(result.ok && result.placed, 'pending');
    const merged = JSON.parse(mergeMovedRowsIntoPlan(plan('linear:C-1'), today)) as { todos: Array<{ candidateId: string; rank: number }> };
    assert.deepEqual(merged.todos.map((todo) => [todo.candidateId, todo.rank]), [['linear:C-1', 1], ['linear:A-1', 2]]);
    assert.equal(mergeMovedRowsIntoPlan(plan('linear:C-1'), today), plan('linear:C-1'), 'merged once, then cleared');
  });
  await check('a 固定日程 row is not moved — today has its own', () => {
    const { config } = freshConfig();
    const today = todayInTimezone(config);
    const result = moveRowToDay(config, addDays(today, -1), today, 'rhythm:block:b1', 1);
    assert.equal(result.ok, false);
  });
}

async function testEndpoints(): Promise<void> {
  console.log('\n--- endpoints ---');
  const { config, dir, parsed } = freshConfig();
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config', 'config.yaml'), yaml.dump(parsed), 'utf8');
  fs.writeFileSync(path.join(dir, '.env'), '');
  const originalRuntimePath = process.env.DAILY_OS_UI_RUNTIME_PATH;
  process.env.DAILY_OS_UI_RUNTIME_PATH = path.join(dir, 'data', 'runtime', 'ui.json');
  const today = todayInTimezone(config);
  const yesterday = addDays(today, -1);
  const twoAgo = addDays(today, -2);
  planDay(config, twoAgo, 'linear:A-1');
  planDay(config, yesterday, 'linear:A-1', 'linear:A-2');
  appendDailyMemory(config, 'daily_review', yesterday, '{"reconciliation":[]}');
  planToday(config, 'linear:B-1');

  const { startUiServer } = await import('../../src/ui/server.js');
  const controls = await startUiServer({ configPath: 'config/config.yaml', envPath: '.env', host: '127.0.0.1', port: 0, open: false });
  const headers = { Authorization: `Bearer ${controls.token}`, 'content-type': 'application/json' };
  const get = async (p: string): Promise<any> => (await fetch(`${controls.url}${p}`, { headers })).json();
  const post = async (p: string, body: Record<string, unknown>): Promise<any> =>
    (await fetch(`${controls.url}${p}`, { method: 'POST', headers, body: JSON.stringify(body) })).json();
  try {
    await check('GET /api/day/wrapups lists every day with an open row, oldest first — reviewed or not', async () => {
      const state = await get('/api/day/wrapups');
      assert.equal(state.today, today);
      assert.deepEqual(state.pending.map((day: any) => day.date), [twoAgo, yesterday]);
    });
    await check('move-to-today puts the row on today\'s sheet', async () => {
      const result = await post('/api/day/move-to-today', { date: twoAgo, candidateId: 'linear:A-1', rank: 1 });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.placed, 'appended');
      assert.ok(buildTodayPlanSnapshot(config)?.todos.some((todo) => todo.candidateId === 'linear:A-1'));
    });
    await check('a moved row is a decision: the day it left is clean', async () => {
      assert.deepEqual((await get('/api/day/wrapups')).pending.map((day: any) => day.date), [yesterday]);
    });
    await check('这天不清了 closes the day', async () => {
      const result = await post('/api/day/wrapup', { date: twoAgo, action: 'skip' });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.deepEqual((await get('/api/day/wrapups')).pending.map((day: any) => day.date), [yesterday]);
    });
    await check('清理完成 is refused while a row is still open, and says which', async () => {
      const result = await post('/api/day/wrapup', { date: yesterday, action: 'done' });
      assert.equal(result.ok, false);
      assert.equal(result.open, 2);
      assert.match(result.error, /还有 2 条没处理/);
    });
    await check('清理完成 on a settled, already-reviewed day closes it without running another review', async () => {
      assert.equal((await post('/api/today/todo-feedback', { date: yesterday, event: 'complete', candidateId: 'linear:A-1', rank: 1 })).ok, true);
      assert.equal((await post('/api/today/todo-feedback', { date: yesterday, event: 'missed', candidateId: 'linear:A-2', rank: 2 })).ok, true);
      const result = await post('/api/day/wrapup', { date: yesterday, action: 'done' });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.reviewStarted, false);
      assert.deepEqual((await get('/api/day/wrapups')).pending, []);
    });
    await check('today and later cannot be closed out or moved from', async () => {
      assert.equal((await post('/api/day/wrapup', { date: today, action: 'skip' })).ok, false);
      assert.equal((await post('/api/day/move-to-today', { date: today, candidateId: 'linear:B-1', rank: 1 })).ok, false);
      assert.equal((await post('/api/day/wrapup', { date: twoAgo, action: 'maybe' })).ok, false);
    });
  } finally {
    await controls.stop();
    if (originalRuntimePath === undefined) delete process.env.DAILY_OS_UI_RUNTIME_PATH;
    else process.env.DAILY_OS_UI_RUNTIME_PATH = originalRuntimePath;
  }
}

try {
  await testPending();
  await testMove();
  await testEndpoints();
} finally {
  process.chdir(ORIGINAL_CWD);
}
if (failures > 0) {
  console.error(`\n${failures} failed`);
  process.exit(1);
}
console.log('\nwrapup: all passed');
