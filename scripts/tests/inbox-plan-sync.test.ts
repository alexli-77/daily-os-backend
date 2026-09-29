/**
 * Ticking a capture in 我的待办 has to reach the call-sheet row.
 *
 * The two halves keep state in different places: the inbox ledger has a
 * `status`, the plan row reads the feedback ledger. `syncTodoInboxFromPlanRow`
 * already carried a plan-row tick back to the inbox (#220); nothing carried the
 * other way. So ticking in the inbox left the row looking untouched, and the
 * next plan dropped the item entirely — the row vanished instead of being
 * struck through, which is what the user actually reported.
 *
 * Runs inside a throwaway workdir (process.chdir): the feedback ledger resolves
 * against cwd, so without this the tests would write the real one.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

import { AppConfigSchema, type AppConfig } from '../../src/config/schema.js';
import { appendDailyMemory, writeLatestWorkflowOutput } from '../../src/storage/memory.js';
import { listTodoFeedback, recordTodoFeedback } from '../../src/todo/feedback.js';
import { buildTodayPlanSnapshot } from '../../src/todo/today-plan.js';
import { addTodoInboxItemToTodayPlan, handleTodoInboxCommand, syncPlanRowFromTodoInbox } from '../../src/todo/inbox.js';
import { todayInTimezone } from '../../src/utils/date.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ORIGINAL_CWD = process.cwd();

type TestFn = () => void;
const tests: Array<{ name: string; fn: TestFn }> = [];
function test(name: string, fn: TestFn): void {
  tests.push({ name, fn });
}

/** Fresh cwd per test: the feedback ledger is a cwd-relative path. */
function freshConfig(): AppConfig {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-os-inbox-sync-'));
  process.chdir(dir);
  const parsed = yaml.load(fs.readFileSync(path.join(REPO_ROOT, 'config', 'config.example.yaml'), 'utf8')) as Record<string, any>;
  parsed.memory.repository_path = dir;
  parsed.todo_inbox.ledger_path = path.join(dir, 'todo-inbox.jsonl');
  parsed.todo_inbox.vault_path = path.join(dir, 'todo-inbox.md');
  return AppConfigSchema.parse(parsed);
}

/** Capture a todo the way the console's quick-capture does; returns its id. */
function capture(config: AppConfig, text: string): string {
  const result = handleTodoInboxCommand(config, { type: 'capture', text }, { source: 'test', messageId: 'm1' });
  const id = result.items?.[0]?.id;
  assert.ok(id, 'capture returned an item');
  return id!;
}

/**
 * Put a plan on today containing these candidate ids, the way a real run does:
 * `buildTodayPlanSnapshot` reads the latest-workflow file, not the daily memory,
 * so seeding only the latter would leave it with no plan at all.
 */
function planToday(config: AppConfig, ...candidateIds: string[]): void {
  const date = todayInTimezone(config);
  const content = JSON.stringify({
    todos: candidateIds.map((candidateId, index) => ({ rank: index + 1, text: `第 ${index + 1} 件`, candidateId })),
  });
  appendDailyMemory(config, 'daily_plan', date, content);
  writeLatestWorkflowOutput(config, 'daily_plan', date, content);
}

const eventsFor = (config: AppConfig, candidateId: string): string[] =>
  listTodoFeedback(config).filter((entry) => entry.candidateId === candidateId).map((entry) => entry.event);

// --- the reported bug -------------------------------------------------------

test('ticking a capture that is on today\'s plan writes the plan row done', () => {
  const config = freshConfig();
  const id = capture(config, '转运商品');
  planToday(config, `todo_inbox:${id}`, 'linear:LEO-1');
  assert.equal(syncPlanRowFromTodoInbox(config, id, 'done'), true);
  assert.deepEqual(eventsFor(config, `todo_inbox:${id}`), ['complete'], 'the call-sheet row is now done, not gone');
});

test('the row keeps its rank, so the review reconciles it in place', () => {
  const config = freshConfig();
  const id = capture(config, '魁北克住宿预订');
  planToday(config, 'linear:LEO-1', 'linear:LEO-2', `todo_inbox:${id}`);
  syncPlanRowFromTodoInbox(config, id, 'done');
  const entry = listTodoFeedback(config).find((row) => row.candidateId === `todo_inbox:${id}`);
  assert.equal(entry?.rank, 3, 'third row on the sheet');
});

// --- what it deliberately does not do ---------------------------------------

test('a capture that was never planned writes nothing', () => {
  const config = freshConfig();
  const id = capture(config, '学校保险能不能挂家属');
  planToday(config, 'linear:LEO-1');
  assert.equal(syncPlanRowFromTodoInbox(config, id, 'done'), false);
  assert.deepEqual(eventsFor(config, `todo_inbox:${id}`), [], 'no ledger entry without a reader');
});

test('with no plan at all it is a no-op rather than an error', () => {
  const config = freshConfig();
  const id = capture(config, '美签修改');
  assert.equal(syncPlanRowFromTodoInbox(config, id, 'done'), false);
});

test('shelving a capture is not the plan\'s 顺延到明天', () => {
  const config = freshConfig();
  const id = capture(config, '整理房间');
  planToday(config, `todo_inbox:${id}`);
  assert.equal(syncPlanRowFromTodoInbox(config, id, 'deferred'), false);
  assert.deepEqual(eventsFor(config, `todo_inbox:${id}`), []);
});

test('ticking twice does not duplicate the event', () => {
  const config = freshConfig();
  const id = capture(config, '本月的记账');
  planToday(config, `todo_inbox:${id}`);
  assert.equal(syncPlanRowFromTodoInbox(config, id, 'done'), true);
  assert.equal(syncPlanRowFromTodoInbox(config, id, 'done'), false, 'already done');
  assert.deepEqual(eventsFor(config, `todo_inbox:${id}`), ['complete']);
});

test('a row reopened on the plan can be ticked again from the inbox', () => {
  const config = freshConfig();
  const id = capture(config, '需要填申请表');
  planToday(config, `todo_inbox:${id}`);
  syncPlanRowFromTodoInbox(config, id, 'done');
  recordTodoFeedback(config, { date: todayInTimezone(config), event: 'reopen', candidateId: `todo_inbox:${id}`, rank: 1 });
  assert.equal(syncPlanRowFromTodoInbox(config, id, 'done'), true, 'reopen cleared the done state');
  assert.deepEqual(eventsFor(config, `todo_inbox:${id}`), ['complete', 'reopen', 'complete']);
});

// --- putting a capture on today's sheet -------------------------------------

const planTexts = (config: AppConfig): string[] => buildTodayPlanSnapshot(config)?.todos.map((todo) => todo.text) ?? [];

test('a capture can be added to the end of today\'s plan, with its estimate', () => {
  const config = freshConfig();
  const id = capture(config, '订魁北克住宿');
  planToday(config, 'linear:LEO-1');
  const added = addTodoInboxItemToTodayPlan(config, id, 45, todayInTimezone(config));
  assert.equal(added?.rank, 2);
  assert.deepEqual(planTexts(config), ['第 1 件', '订魁北克住宿']);
  const row = buildTodayPlanSnapshot(config)?.todos.find((todo) => todo.candidateId === `todo_inbox:${id}`);
  assert.equal(row?.minutes, 45, 'the estimate rides along so the slots below stay honest');
});

test('adding it twice is refused rather than duplicating the row', () => {
  const config = freshConfig();
  const id = capture(config, '换汇');
  planToday(config, 'linear:LEO-1');
  assert.ok(addTodoInboxItemToTodayPlan(config, id, 30, todayInTimezone(config)));
  assert.equal(addTodoInboxItemToTodayPlan(config, id, 30, todayInTimezone(config)), null);
  assert.equal(planTexts(config).length, 2);
});

test('no plan today, unknown id, and an already-done capture are all refused', () => {
  const config = freshConfig();
  const id = capture(config, '本月记账');
  assert.equal(addTodoInboxItemToTodayPlan(config, id, 30, todayInTimezone(config)), null, 'no plan yet');
  planToday(config, 'linear:LEO-1');
  assert.equal(addTodoInboxItemToTodayPlan(config, 'nope', 30, todayInTimezone(config)), null, 'unknown id');
  syncPlanRowFromTodoInbox(config, id, 'done');
  handleTodoInboxCommand(config, { type: 'update', action: 'done', target: '本月记账' }, { source: 'test', messageId: 'm' });
  assert.equal(addTodoInboxItemToTodayPlan(config, id, 30, todayInTimezone(config)), null, 'already done');
});

test('an added row can then be ticked from the inbox, closing the loop', () => {
  const config = freshConfig();
  const id = capture(config, '转运商品');
  planToday(config, 'linear:LEO-1');
  addTodoInboxItemToTodayPlan(config, id, 30, todayInTimezone(config));
  assert.equal(syncPlanRowFromTodoInbox(config, id, 'done'), true);
  assert.deepEqual(eventsFor(config, `todo_inbox:${id}`), ['complete']);
});

let passed = 0;
let failed = 0;
for (const { name, fn } of tests) {
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
console.log(`\ninbox-plan-sync.test: ${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
