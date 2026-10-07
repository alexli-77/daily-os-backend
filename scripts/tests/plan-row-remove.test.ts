/**
 * LEO-329 — deleting a row from today's call sheet.
 *
 * Independent, tsx-runnable:  npx tsx scripts/tests/plan-row-remove.test.ts
 *
 * `remove` is a day-scoped decision: the row leaves today's sheet, a rerun
 * today does not bring it back, and tomorrow the scorer may propose it again.
 * The one source it reaches is the inbox — deleting a capture's row deletes the
 * capture. `reopen` undoes all of it.
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
import { getRemovedCandidateIds, recordTodoFeedback } from '../../src/todo/feedback.js';
import { handleTodoInboxCommand, listTodoInboxItems, syncTodoInboxFromPlanRow } from '../../src/todo/inbox.js';
import { buildScoredTodos } from '../../src/todo/scorer.js';
import { buildTodayPlanSnapshot } from '../../src/todo/today-plan.js';
import { addDays, todayInTimezone } from '../../src/utils/date.js';
import type { Evidence } from '../../src/workflows/types.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ORIGINAL_CWD = process.cwd();

type TestFn = () => void;
const tests: Array<{ name: string; fn: TestFn }> = [];
function test(name: string, fn: TestFn): void {
  tests.push({ name, fn });
}

function freshConfig(): AppConfig {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-os-plan-remove-'));
  process.chdir(dir);
  const parsed = yaml.load(fs.readFileSync(path.join(REPO_ROOT, 'config', 'config.example.yaml'), 'utf8')) as Record<string, any>;
  parsed.memory.repository_path = dir;
  parsed.todo_inbox.ledger_path = path.join(dir, 'todo-inbox.jsonl');
  parsed.todo_inbox.vault_path = path.join(dir, 'todo-inbox.md');
  // No meal rows (LEO-332): these tests compare whole row lists.
  parsed.user.rhythm.meal_blocks = [];
  return AppConfigSchema.parse(parsed);
}

function capture(config: AppConfig, text: string): string {
  const result = handleTodoInboxCommand(config, { type: 'capture', text }, { source: 'test', messageId: 'm1' });
  const id = result.items?.[0]?.id;
  assert.ok(id, 'capture returned an item');
  return id!;
}

function planToday(config: AppConfig, ...candidateIds: string[]): void {
  const date = todayInTimezone(config);
  const content = JSON.stringify({
    todos: candidateIds.map((candidateId, index) => ({ rank: index + 1, text: `第 ${index + 1} 件`, candidateId })),
  });
  appendDailyMemory(config, 'daily_plan', date, content);
  writeLatestWorkflowOutput(config, 'daily_plan', date, content);
}

function feedback(config: AppConfig, event: 'remove' | 'reopen' | 'complete', candidateId: string, date = todayInTimezone(config)): void {
  recordTodoFeedback(config, { date, event, candidateId, rank: 1 });
}

const rows = (config: AppConfig): string[] => buildTodayPlanSnapshot(config)?.todos.map((todo) => todo.candidateId) ?? [];

/** Evidence with two Linear issues, both named in the current cycle so `anchorToCycle` keeps them. */
function linearEvidence(date: string): Evidence {
  return {
    date,
    sources: {
      linear: {
        state: 'available',
        data: {
          items: [
            { identifier: 'XX-1', title: '第一件', priority: 2, state: { name: 'In Progress', type: 'started' } },
            { identifier: 'XX-2', title: '第二件', priority: 2, state: { name: 'In Progress', type: 'started' } },
          ],
        },
      },
    },
  } as unknown as Evidence;
}

// --- the sheet ----------------------------------------------------------------

test('a removed row is gone from today\'s sheet, and the rest keep their order', () => {
  const config = freshConfig();
  planToday(config, 'linear:XX-1', 'weekly:0:aaaaaaaa', 'linear:XX-2');
  feedback(config, 'remove', 'weekly:0:aaaaaaaa');
  assert.deepEqual(rows(config), ['linear:XX-1', 'linear:XX-2']);
});

test('reopen brings a removed row back', () => {
  const config = freshConfig();
  planToday(config, 'linear:XX-1', 'linear:XX-2');
  feedback(config, 'remove', 'linear:XX-2');
  feedback(config, 'reopen', 'linear:XX-2');
  assert.deepEqual(rows(config), ['linear:XX-1', 'linear:XX-2']);
});

test('a removal made on another day does not touch today\'s sheet', () => {
  const config = freshConfig();
  planToday(config, 'linear:XX-1', 'linear:XX-2');
  feedback(config, 'remove', 'linear:XX-2', addDays(todayInTimezone(config), -1));
  assert.deepEqual(rows(config), ['linear:XX-1', 'linear:XX-2']);
});

// --- the scorer -----------------------------------------------------------------

test('getRemovedCandidateIds is scoped to its day and undone by reopen', () => {
  const config = freshConfig();
  const today = todayInTimezone(config);
  feedback(config, 'remove', 'linear:XX-1');
  feedback(config, 'remove', 'linear:XX-2');
  feedback(config, 'reopen', 'linear:XX-2');
  assert.deepEqual([...getRemovedCandidateIds(config, today)], ['linear:XX-1']);
  assert.equal(getRemovedCandidateIds(config, addDays(today, 1)).size, 0, 'tomorrow it is a candidate again');
});

test('a rerun today does not re-propose a removed row; tomorrow it may', () => {
  const config = freshConfig();
  const today = todayInTimezone(config);
  const ids = (date: string): string[] =>
    buildScoredTodos(config, linearEvidence(date), date, { completedCandidateIds: new Set() }).top.map((todo) => todo.id);
  feedback(config, 'remove', 'linear:XX-1');
  assert.ok(!ids(today).includes('linear:XX-1'), 'excluded today');
  assert.ok(ids(today).includes('linear:XX-2'));
  assert.ok(ids(addDays(today, 1)).includes('linear:XX-1'), 'back tomorrow');
});

// --- the inbox ------------------------------------------------------------------

test('removing a capture\'s row deletes the capture; reopen restores it', () => {
  const config = freshConfig();
  const id = capture(config, '买牙膏');
  const status = (): string | undefined => listTodoInboxItems(config).find((item) => item.id === id)?.status;
  assert.equal(syncTodoInboxFromPlanRow(config, `todo_inbox:${id}`, 'remove'), true);
  assert.equal(status(), 'deleted');
  assert.equal(syncTodoInboxFromPlanRow(config, `todo_inbox:${id}`, 'reopen'), true);
  assert.equal(status(), 'open');
});

test('removing a non-inbox row leaves the inbox alone', () => {
  const config = freshConfig();
  const id = capture(config, '买牙膏');
  assert.equal(syncTodoInboxFromPlanRow(config, 'linear:XX-1', 'remove'), false);
  assert.equal(listTodoInboxItems(config).find((item) => item.id === id)?.status, 'open');
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
console.log(`\nplan-row-remove.test: ${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
