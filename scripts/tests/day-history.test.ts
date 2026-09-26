/**
 * Past days' plans (`/api/day/plan`).
 *
 * The Today page is today or nothing (LEO-309); a previous day could only be
 * read by opening `data/memory/daily/<date>.md`. These tests pin the two things
 * that make the past-days view trustworthy: it shows the plan a day actually
 * ended with (last run, the user's own ticks for *that* date), and it still
 * finds a plan after the detail cache has pruned it.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

import { AppConfigSchema, type AppConfig } from '../../src/config/schema.js';
import { appendDailyMemory } from '../../src/storage/memory.js';
import { recordTodoFeedback } from '../../src/todo/feedback.js';
import { isHistoryDate, listPlanDates, readDailyMemorySections, readDayHistory } from '../../src/todo/day-history.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ORIGINAL_CWD = process.cwd();

type TestFn = () => void;
const tests: Array<{ name: string; fn: TestFn }> = [];
function test(name: string, fn: TestFn): void {
  tests.push({ name, fn });
}

/** Every store here resolves relative paths against cwd, so each test gets its own. */
function freshConfig(): AppConfig {
  const parsed = yaml.load(fs.readFileSync(path.join(REPO_ROOT, 'config', 'config.example.yaml'), 'utf8')) as Record<string, any>;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-os-history-'));
  process.chdir(dir);
  return AppConfigSchema.parse(parsed);
}

const plan = (...texts: string[]): string =>
  JSON.stringify({ todos: texts.map((text, index) => ({ rank: index + 1, text, candidateId: `linear:T-${index + 1}`, minutes: 30 })) });

const review = JSON.stringify({
  reconciliation: [
    { candidateId: 'linear:T-1', text: '第一件', status: 'done', evidence: 'PR 合了' },
    { candidateId: 'linear:T-2', text: '第二件', status: 'open' },
  ],
  carry_over: ['linear:T-2'],
  note: '一半完成',
});

test('the last plan of the day is the one shown — a rerun supersedes the morning plan', () => {
  const config = freshConfig();
  appendDailyMemory(config, 'daily_plan', '2026-09-24', plan('早上的旧计划'));
  appendDailyMemory(config, 'daily_plan', '2026-09-24', plan('第一件', '第二件'));
  const day = readDayHistory(config, '2026-09-24');
  assert.deepEqual(day.todos.map((todo) => todo.text), ['第一件', '第二件']);
  assert.equal(day.plan?.date, '2026-09-24');
});

test('row states are that day\'s, not another day\'s, and a reopen clears a tick', () => {
  const config = freshConfig();
  appendDailyMemory(config, 'daily_plan', '2026-09-24', plan('第一件', '第二件'));
  recordTodoFeedback(config, { date: '2026-09-24', event: 'complete', candidateId: 'linear:T-1', rank: 1 });
  recordTodoFeedback(config, { date: '2026-09-24', event: 'complete', candidateId: 'linear:T-2', rank: 2 });
  recordTodoFeedback(config, { date: '2026-09-24', event: 'reopen', candidateId: 'linear:T-2', rank: 2 });
  recordTodoFeedback(config, { date: '2026-09-25', event: 'defer', candidateId: 'linear:T-1', rank: 1 });
  assert.deepEqual(readDayHistory(config, '2026-09-24').feedback, { 'linear:T-1': 'complete' });
});

test('the evening review comes with it, parsed', () => {
  const config = freshConfig();
  appendDailyMemory(config, 'daily_plan', '2026-09-24', plan('第一件', '第二件'));
  appendDailyMemory(config, 'daily_review', '2026-09-24', review);
  const day = readDayHistory(config, '2026-09-24');
  assert.deepEqual(day.review?.reconciliation.map((item) => item.status), ['done', 'open']);
  assert.equal(day.review?.note, '一半完成');
});

test('a plan from before the JSON format is shipped as text, not as "no plan"', () => {
  const config = freshConfig();
  const legacy = '## 早上\n\n- 回邮件\n- 写周报\n\n## 下午\n\n- 开会';
  appendDailyMemory(config, 'daily_plan', '2026-06-02', legacy);
  const day = readDayHistory(config, '2026-06-02');
  assert.equal(day.todos.length, 0);
  assert.ok(day.plan, 'the day did have a plan');
  assert.equal(day.rawPlan, legacy, 'its own ## headings did not split it');
});

test('only the workflow headings split a day\'s file', () => {
  const config = freshConfig();
  appendDailyMemory(config, 'daily_plan', '2026-06-02', '## 早上\n- a');
  appendDailyMemory(config, 'daily_review', '2026-06-02', '## 复盘\n- b');
  assert.deepEqual(readDailyMemorySections(config, '2026-06-02').map((section) => section.workflow), ['daily_plan', 'daily_review']);
});

test('a day with no file has no plan, and says so rather than throwing', () => {
  const config = freshConfig();
  const day = readDayHistory(config, '2026-01-01');
  assert.equal(day.plan, null);
  assert.deepEqual(day.todos, []);
  assert.equal(day.review, null);
});

test('the day list is newest first and only counts days that had a plan', () => {
  const config = freshConfig();
  appendDailyMemory(config, 'daily_plan', '2026-09-22', plan('a'));
  appendDailyMemory(config, 'daily_plan', '2026-09-24', plan('b'));
  appendDailyMemory(config, 'daily_review', '2026-09-23', review);
  fs.writeFileSync(path.resolve(config.memory.daily_dir, 'notes.md'), 'not a day');
  assert.deepEqual(listPlanDates(config), ['2026-09-24', '2026-09-22']);
});

test('dates are validated before they reach a file path', () => {
  assert.equal(isHistoryDate('2026-09-24'), true);
  for (const bad of ['2026-9-24', '../../etc/passwd', '2026-09-24.md', '', null]) {
    assert.equal(isHistoryDate(bad), false, String(bad));
  }
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
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
