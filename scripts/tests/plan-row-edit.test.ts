/**
 * LEO-332 — editing a row's text, and meals as rows on today's sheet.
 *
 * Independent, tsx-runnable:  npx tsx scripts/tests/plan-row-edit.test.ts
 *
 * Text: `update` may carry the user's own wording; the snapshot shows it for
 * that day only.
 *
 * Meals: each `user.rhythm.meal_blocks` entry becomes a row on today's sheet,
 * pinned by default to its configured time, and every plan-row event works on
 * it. 往日 and teammates never see these rows.
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
import { recordTodoFeedback, type TodoFeedbackEvent } from '../../src/todo/feedback.js';
import { buildPlanSnapshotForDate, buildTodayPlanSnapshot, isRhythmRow } from '../../src/todo/today-plan.js';
import { addDays, todayInTimezone } from '../../src/utils/date.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ORIGINAL_CWD = process.cwd();

type TestFn = () => void;
const tests: Array<{ name: string; fn: TestFn }> = [];
function test(name: string, fn: TestFn): void {
  tests.push({ name, fn });
}

function freshConfig(): AppConfig {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-os-plan-edit-'));
  process.chdir(dir);
  const parsed = yaml.load(fs.readFileSync(path.join(REPO_ROOT, 'config', 'config.example.yaml'), 'utf8')) as Record<string, any>;
  parsed.memory.repository_path = dir;
  parsed.todo_inbox.ledger_path = path.join(dir, 'todo-inbox.jsonl');
  parsed.todo_inbox.vault_path = path.join(dir, 'todo-inbox.md');
  parsed.user.rhythm.meal_blocks = [{ label: '午餐', start: '12:00', end: '13:00' }];
  return AppConfigSchema.parse(parsed);
}

function planToday(config: AppConfig, ...candidateIds: string[]): void {
  const date = todayInTimezone(config);
  const content = JSON.stringify({
    todos: candidateIds.map((candidateId, index) => ({ rank: index + 1, text: `第 ${index + 1} 件`, candidateId })),
  });
  appendDailyMemory(config, 'daily_plan', date, content);
  writeLatestWorkflowOutput(config, 'daily_plan', date, content);
}

const LUNCH = 'rhythm:meal:午餐';

function feedback(config: AppConfig, event: TodoFeedbackEvent, candidateId: string, extra: Record<string, unknown> = {}): void {
  recordTodoFeedback(config, { date: todayInTimezone(config), event, candidateId, rank: 1, ...extra });
}

const row = (config: AppConfig, id: string) => buildTodayPlanSnapshot(config)?.todos.find((todo) => todo.candidateId === id);

// --- text -----------------------------------------------------------------------

test('an update with text rewrites the row; the latest wins', () => {
  const config = freshConfig();
  planToday(config, 'linear:XX-1');
  feedback(config, 'update', 'linear:XX-1', { text: '先写摘要' });
  feedback(config, 'update', 'linear:XX-1', { text: '  先写摘要和引言  ' });
  assert.equal(row(config, 'linear:XX-1')?.text, '先写摘要和引言');
});

test('an update without text leaves the wording alone', () => {
  const config = freshConfig();
  planToday(config, 'linear:XX-1');
  feedback(config, 'update', 'linear:XX-1', { text: '改过的' });
  feedback(config, 'update', 'linear:XX-1', { minutes: 45 });
  assert.equal(row(config, 'linear:XX-1')?.text, '改过的');
});

test('a text edit made on another day does not touch today', () => {
  const config = freshConfig();
  planToday(config, 'linear:XX-1');
  recordTodoFeedback(config, { date: addDays(todayInTimezone(config), -1), event: 'update', candidateId: 'linear:XX-1', rank: 1, text: '昨天的说法' });
  assert.equal(row(config, 'linear:XX-1')?.text, '第 1 件');
});

// --- meals as rows ------------------------------------------------------------------

test('a meal block is a row after the plan, at its configured time and length', () => {
  const config = freshConfig();
  planToday(config, 'linear:XX-1', 'linear:XX-2');
  const todos = buildTodayPlanSnapshot(config)?.todos ?? [];
  assert.deepEqual(todos.map((todo) => todo.candidateId), ['linear:XX-1', 'linear:XX-2', LUNCH]);
  assert.deepEqual(row(config, LUNCH), { candidateId: LUNCH, text: '午餐', minutes: 60, start: '12:00', rank: 3 });
});

test('a meal row moves, resizes, renames and is deleted like any row', () => {
  const config = freshConfig();
  planToday(config, 'linear:XX-1');
  feedback(config, 'place', LUNCH, { start: '12:30' });
  feedback(config, 'update', LUNCH, { minutes: 30, text: '简单吃点' });
  assert.deepEqual(row(config, LUNCH), { candidateId: LUNCH, text: '简单吃点', minutes: 30, start: '12:30', rank: 2 });
  feedback(config, 'remove', LUNCH);
  assert.equal(row(config, LUNCH), undefined);
});

test('unplace releases a meal row from its configured time too', () => {
  const config = freshConfig();
  planToday(config, 'linear:XX-1');
  feedback(config, 'unplace', LUNCH);
  assert.equal(row(config, LUNCH)?.start, undefined);
});

test('ticking a meal row shows in the day\'s feedback', () => {
  const config = freshConfig();
  planToday(config, 'linear:XX-1');
  feedback(config, 'complete', LUNCH);
  assert.equal(buildTodayPlanSnapshot(config)?.feedback[LUNCH], 'complete');
});

test('no plan rows means no meal rows: lunch alone is not a plan', () => {
  const config = freshConfig();
  const date = todayInTimezone(config);
  writeLatestWorkflowOutput(config, 'daily_plan', date, JSON.stringify({ todos: [] }));
  assert.deepEqual(buildTodayPlanSnapshot(config)?.todos, []);
});

test('往日 replays a day without meal rows', () => {
  const config = freshConfig();
  planToday(config, 'linear:XX-1');
  const past = buildPlanSnapshotForDate(config, todayInTimezone(config));
  assert.deepEqual(past?.todos.map((todo) => todo.candidateId), ['linear:XX-1']);
});

test('meal rows are recognisable, so team sync can leave them out', () => {
  assert.equal(isRhythmRow(LUNCH), true);
  assert.equal(isRhythmRow('linear:XX-1'), false);
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
console.log(`\nplan-row-edit.test: ${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
