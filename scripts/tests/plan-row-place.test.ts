/**
 * LEO-331 — pinning a row to a time on today's timeline.
 *
 * Independent, tsx-runnable:  npx tsx scripts/tests/plan-row-place.test.ts
 *
 * `place` carries the start the user dropped the row at; the plan snapshot
 * overlays it as `start`. Like every plan-row edit it belongs to its day: a
 * rerun that day keeps the row where it was put, the next day starts clean.
 * `unplace` hands the row back to automatic layout.
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
import { recordTodoFeedback } from '../../src/todo/feedback.js';
import { buildTodayPlanSnapshot } from '../../src/todo/today-plan.js';
import { addDays, todayInTimezone } from '../../src/utils/date.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ORIGINAL_CWD = process.cwd();

type TestFn = () => void;
const tests: Array<{ name: string; fn: TestFn }> = [];
function test(name: string, fn: TestFn): void {
  tests.push({ name, fn });
}

function freshConfig(): AppConfig {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-os-plan-place-'));
  process.chdir(dir);
  const parsed = yaml.load(fs.readFileSync(path.join(REPO_ROOT, 'config', 'config.example.yaml'), 'utf8')) as Record<string, any>;
  parsed.memory.repository_path = dir;
  parsed.todo_inbox.ledger_path = path.join(dir, 'todo-inbox.jsonl');
  parsed.todo_inbox.vault_path = path.join(dir, 'todo-inbox.md');
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

function place(config: AppConfig, candidateId: string, start: string, date = todayInTimezone(config)): void {
  recordTodoFeedback(config, { date, event: 'place', candidateId, rank: 1, start });
}

const starts = (config: AppConfig): Record<string, string | undefined> =>
  Object.fromEntries((buildTodayPlanSnapshot(config)?.todos ?? []).map((todo) => [todo.candidateId, todo.start]));

test('a placed row carries its start; the others carry none', () => {
  const config = freshConfig();
  planToday(config, 'linear:XX-1', 'weekly:0:aaaaaaaa');
  place(config, 'weekly:0:aaaaaaaa', '14:30');
  assert.deepEqual(starts(config), { 'linear:XX-1': undefined, 'weekly:0:aaaaaaaa': '14:30' });
});

test('the latest place wins', () => {
  const config = freshConfig();
  planToday(config, 'linear:XX-1');
  place(config, 'linear:XX-1', '09:00');
  place(config, 'linear:XX-1', '16:00');
  assert.equal(starts(config)['linear:XX-1'], '16:00');
});

test('unplace hands the row back to automatic layout', () => {
  const config = freshConfig();
  planToday(config, 'linear:XX-1');
  place(config, 'linear:XX-1', '09:00');
  recordTodoFeedback(config, { date: todayInTimezone(config), event: 'unplace', candidateId: 'linear:XX-1', rank: 1 });
  assert.equal(starts(config)['linear:XX-1'], undefined);
});

test('a rerun the same day keeps the row where it was put', () => {
  const config = freshConfig();
  planToday(config, 'linear:XX-1', 'linear:XX-2');
  place(config, 'linear:XX-2', '13:00');
  planToday(config, 'linear:XX-2', 'weekly:0:bbbbbbbb');
  assert.deepEqual(starts(config), { 'linear:XX-2': '13:00', 'weekly:0:bbbbbbbb': undefined });
});

test('a place made on another day does not pin today\'s row', () => {
  const config = freshConfig();
  planToday(config, 'linear:XX-1');
  place(config, 'linear:XX-1', '10:00', addDays(todayInTimezone(config), -1));
  assert.equal(starts(config)['linear:XX-1'], undefined);
});

test('placing a row keeps its edited estimate', () => {
  const config = freshConfig();
  planToday(config, 'linear:XX-1');
  recordTodoFeedback(config, { date: todayInTimezone(config), event: 'update', candidateId: 'linear:XX-1', rank: 1, minutes: 90 });
  place(config, 'linear:XX-1', '15:00');
  const row = buildTodayPlanSnapshot(config)?.todos[0];
  assert.equal(row?.minutes, 90);
  assert.equal(row?.start, '15:00');
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
console.log(`\nplan-row-place.test: ${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
