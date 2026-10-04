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
import {
  addTodoInboxItemToTodayPlan,
  abandonCaptures,
  carriedCaptureDates,
  handleTodoInboxCommand,
  listTodoInboxItems,
  mergeOpenCapturesIntoPlan,
  staleCaptures,
  STALE_CAPTURE_DAYS,
  syncPlanRowFromTodoInbox,
} from '../../src/todo/inbox.js';
import { addDays, todayInTimezone } from '../../src/utils/date.js';

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

// --- the note left on a row comes back ---------------------------------------

test('a note left with 记一条更新 is readable again', () => {
  const config = freshConfig();
  planToday(config, 'linear:LEO-102');
  recordTodoFeedback(config, {
    date: todayInTimezone(config),
    event: 'update',
    candidateId: 'linear:LEO-102',
    rank: 1,
    note: '汇率按 4.74 重算过了',
  });
  assert.equal(buildTodayPlanSnapshot(config)?.notes['linear:LEO-102'], '汇率按 4.74 重算过了');
});

test('the latest note wins, and an empty one does not erase it', () => {
  const config = freshConfig();
  planToday(config, 'linear:LEO-102');
  const date = todayInTimezone(config);
  recordTodoFeedback(config, { date, event: 'update', candidateId: 'linear:LEO-102', rank: 1, note: '第一版' });
  recordTodoFeedback(config, { date, event: 'update', candidateId: 'linear:LEO-102', rank: 1, note: '第二版' });
  recordTodoFeedback(config, { date, event: 'complete', candidateId: 'linear:LEO-102', rank: 1 });
  assert.equal(buildTodayPlanSnapshot(config)?.notes['linear:LEO-102'], '第二版', 'a later note-less event leaves it alone');
});

test('a note on any event is kept, not just 更新', () => {
  const config = freshConfig();
  planToday(config, 'linear:LEO-102');
  recordTodoFeedback(config, {
    date: todayInTimezone(config),
    event: 'complete',
    candidateId: 'linear:LEO-102',
    rank: 1,
    note: '只做了一半就交了',
  });
  assert.equal(buildTodayPlanSnapshot(config)?.notes['linear:LEO-102'], '只做了一半就交了');
});

test('a row with no note has no entry at all', () => {
  const config = freshConfig();
  planToday(config, 'linear:LEO-102');
  recordTodoFeedback(config, { date: todayInTimezone(config), event: 'complete', candidateId: 'linear:LEO-102', rank: 1 });
  assert.deepEqual(buildTodayPlanSnapshot(config)?.notes, {});
});

// --- a capture lands on today's sheet, and keeps coming back ----------------

test('capturing puts it straight on today\'s sheet', () => {
  const config = freshConfig();
  planToday(config, 'linear:LEO-1');
  capture(config, '订牙医');
  assert.deepEqual(planTexts(config), ['第 1 件', '订牙医'], 'no staging step');
});

test('captured before today\'s plan exists, it is on the plan once generated', () => {
  const config = freshConfig();
  const id = capture(config, '买咖啡豆');   // no plan yet: nothing to append to
  assert.equal(buildTodayPlanSnapshot(config), null);
  // The morning run produces a plan that does not mention it...
  const generated = JSON.stringify({ todos: [{ rank: 1, text: '第 1 件', candidateId: 'linear:LEO-1' }] });
  const merged = mergeOpenCapturesIntoPlan(config, generated, todayInTimezone(config));
  const todos = JSON.parse(merged).todos as Array<{ text: string; candidateId: string; minutes?: number }>;
  assert.deepEqual(todos.map((t) => t.text), ['第 1 件', '买咖啡豆'], '...and it is put back afterwards');
  assert.equal(todos[1].minutes, 30, 'with the default estimate so the clock still adds up');
  assert.equal(todos[1].candidateId, `todo_inbox:${id}`);
});

test('an unfinished capture is carried onto the next day, model or not', () => {
  const config = freshConfig();
  capture(config, '报税材料');
  // Tomorrow's run: the model did not pick it.
  const generated = JSON.stringify({ todos: [{ rank: 1, text: '别的事', candidateId: 'linear:LEO-9' }] });
  const merged = mergeOpenCapturesIntoPlan(config, generated, '2026-10-04');
  assert.deepEqual((JSON.parse(merged).todos as Array<{ text: string }>).map((t) => t.text), ['别的事', '报税材料']);
});

test('a finished or shelved capture is not carried', () => {
  const config = freshConfig();
  capture(config, '交房租');
  handleTodoInboxCommand(config, { type: 'update', action: 'done', target: '交房租' }, { source: 'test', messageId: 'm' });
  const generated = JSON.stringify({ todos: [{ rank: 1, text: '别的事', candidateId: 'linear:LEO-9' }] });
  assert.equal(mergeOpenCapturesIntoPlan(config, generated, '2026-10-04'), generated, 'done is the way out');
});

test('a capture the model did pick is not duplicated', () => {
  const config = freshConfig();
  const id = capture(config, '写周报');
  const generated = JSON.stringify({ todos: [{ rank: 1, text: '写周报', candidateId: `todo_inbox:${id}` }] });
  assert.equal(mergeOpenCapturesIntoPlan(config, generated, '2026-10-04'), generated);
});

test('a carried row says which day it came from; today\'s does not', () => {
  const config = freshConfig();
  const id = capture(config, '订牙医');
  assert.deepEqual(carriedCaptureDates(config, todayInTimezone(config)), {}, 'captured today, nothing to say');
  const later = '2026-12-31';
  assert.equal(carriedCaptureDates(config, later)[`todo_inbox:${id}`], todayInTimezone(config));
});

// --- the way out of carrying forever ----------------------------------------

/** Rewrite a capture's created_at so it looks like it was captured N days ago. */
function age(config: AppConfig, id: string, days: number): void {
  const ledger = path.resolve(config.todo_inbox.ledger_path);
  // Counted back from the user's today, not UTC's. Using Date.now() here made
  // these pass locally and fail on a UTC runner for a few hours every evening.
  // Noon keeps the instant inside the target day in any timezone.
  const base = Date.parse(`${todayInTimezone(config)}T12:00:00Z`);
  const when = new Date(base - days * 24 * 60 * 60 * 1000).toISOString();
  const lines = fs.readFileSync(ledger, 'utf8').trim().split('\n').map((line) => {
    const item = JSON.parse(line);
    return item.id === id ? JSON.stringify({ ...item, created_at: when }) : line;
  });
  fs.writeFileSync(ledger, `${lines.join('\n')}\n`, 'utf8');
}

test('a capture carried past the threshold is surfaced, a fresh one is not', () => {
  const config = freshConfig();
  const old = capture(config, '报税材料');
  capture(config, '今天刚记的');
  age(config, old, STALE_CAPTURE_DAYS + 2);
  const stale = staleCaptures(config, todayInTimezone(config));
  assert.deepEqual(stale.map((item) => item.text), ['报税材料'], 'only the one that has been sitting');
  assert.equal(stale[0].days, STALE_CAPTURE_DAYS + 2);
});

test('the oldest comes first — that is the one to decide about', () => {
  const config = freshConfig();
  const a = capture(config, '先记的');
  const b = capture(config, '后记的');
  age(config, a, 30);
  age(config, b, 10);
  assert.deepEqual(staleCaptures(config, todayInTimezone(config)).map((item) => item.text), ['先记的', '后记的']);
});

test('abandoning shelves rather than deletes, so it can be found again', () => {
  const config = freshConfig();
  const id = capture(config, '放弃这条');
  assert.deepEqual(abandonCaptures(config, [id]), [id]);
  const item = listTodoInboxItems(config).find((row) => row.id === id);
  assert.equal(item?.status, 'deferred', 'shelved, not a tombstone');
});

test('an abandoned capture stops being carried onto the plan', () => {
  const config = freshConfig();
  const id = capture(config, '不做了');
  const generated = JSON.stringify({ todos: [{ rank: 1, text: '别的事', candidateId: 'linear:LEO-9' }] });
  assert.notEqual(mergeOpenCapturesIntoPlan(config, generated, '2026-12-01'), generated, 'carried while open');
  abandonCaptures(config, [id]);
  assert.equal(mergeOpenCapturesIntoPlan(config, generated, '2026-12-01'), generated, 'and not after');
});

test('abandoning in bulk skips what is already closed instead of failing', () => {
  const config = freshConfig();
  const a = capture(config, '第一条');
  const b = capture(config, '第二条');
  abandonCaptures(config, [a]);
  assert.deepEqual(abandonCaptures(config, [a, b, 'does-not-exist']), [b], 'only the one still open');
});

test('day boundaries follow the user\'s timezone, not UTC\'s', () => {
  const config = freshConfig();
  const id = capture(config, '晚上八点记的');
  // Stamp it late on the user's evening, which is already tomorrow in UTC:
  // 03:30Z on the following day is 22:30 or 23:30 the same day in Toronto,
  // either side of the DST change. Slicing the ISO string would read this as
  // captured tomorrow, and the row would go a day longer without its marker.
  const ledger = path.resolve(config.todo_inbox.ledger_path);
  const today = todayInTimezone(config);
  const lateTonight = `${addDays(today, 1)}T03:30:00.000Z`;
  const lines = fs.readFileSync(ledger, 'utf8').trim().split('\n').map((line) => {
    const item = JSON.parse(line);
    return item.id === id ? JSON.stringify({ ...item, created_at: lateTonight }) : line;
  });
  fs.writeFileSync(ledger, `${lines.join('\n')}\n`, 'utf8');
  assert.deepEqual(carriedCaptureDates(config, today), {}, 'still today where the user lives');
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
