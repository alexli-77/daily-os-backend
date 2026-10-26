/**
 * 每日清理结果 — what each day's To-do came to, as the weekly review reads it.
 *
 * Independent, tsx-runnable:  npx tsx scripts/tests/day-outcomes.test.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

import { AppConfigSchema, type AppConfig } from '../../src/config/schema.js';
import { appendDailyMemory } from '../../src/storage/memory.js';
import { dayOutcomes, renderDayOutcomes } from '../../src/todo/day-outcomes.js';
import { recordWrapup } from '../../src/todo/wrapup.js';
import { addDays, todayInTimezone } from '../../src/utils/date.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ORIGINAL_CWD = process.cwd();
let failures = 0;

function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`  ✗ ${name}\n    ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  }
}

function freshConfig(): AppConfig {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-os-outcomes-'));
  process.chdir(dir);
  const parsed = yaml.load(fs.readFileSync(path.join(REPO_ROOT, 'config', 'config.example.yaml'), 'utf8')) as Record<string, any>;
  parsed.memory.repository_path = path.join(dir, 'vault');
  parsed.todo_inbox.ledger_path = path.join(dir, 'todo-inbox.jsonl');
  parsed.todo_inbox.vault_path = path.join(dir, 'todo-inbox.md');
  parsed.user.rhythm.meal_blocks = [];
  fs.mkdirSync(parsed.memory.repository_path, { recursive: true });
  return AppConfigSchema.parse(parsed);
}

const plan = (...ids: string[]): string =>
  JSON.stringify({ todos: ids.map((candidateId, index) => ({ rank: index + 1, text: `第 ${index + 1} 件`, candidateId })) });

function ledger(entries: Array<[string, string, string]>): void {
  fs.mkdirSync('data/runtime', { recursive: true });
  fs.writeFileSync(
    'data/runtime/todo-feedback.jsonl',
    entries.map(([date, event, candidateId], index) => JSON.stringify({ ts: 'x', date, event, candidateId, rank: index + 1 })).join('\n') + '\n',
  );
}

try {
  console.log('\n--- 每日清理结果 ---');
  check('each day is counted by state, and a day with open rows says which', () => {
    const config = freshConfig();
    const today = todayInTimezone(config);
    const d1 = addDays(today, -2);
    const d2 = addDays(today, -1);
    appendDailyMemory(config, 'daily_plan', d1, plan('linear:A-1', 'linear:A-2', 'linear:A-3', 'linear:A-4'));
    appendDailyMemory(config, 'daily_plan', d2, plan('linear:B-1', 'linear:B-2'));
    ledger([
      [d1, 'complete', 'linear:A-1'],
      [d1, 'partial', 'linear:A-2'],
      [d1, 'missed', 'linear:A-3'],
      [d1, 'defer', 'linear:A-4'],
      [d2, 'complete', 'linear:B-1'],
    ]);
    const rows = dayOutcomes(config, [d2, d1, addDays(today, -3)], today);
    assert.deepEqual(rows.map((row) => [row.date, row.done, row.partial, row.missed, row.deferred, row.open, row.state]), [
      [d1, 1, 1, 1, 1, 0, 'clean'],
      [d2, 1, 0, 0, 0, 1, 'open'],
    ]);
    const text = renderDayOutcomes(rows);
    assert.match(text, /4 条：完成 1 · 部分 1 · 未做 1 · 推走 1｜已清理/);
    assert.match(text, /没清理 1 条：「第 2 件」/);
  });
  check('a day put down on purpose says so, and today is not called uncleaned', () => {
    const config = freshConfig();
    const today = todayInTimezone(config);
    const yesterday = addDays(today, -1);
    appendDailyMemory(config, 'daily_plan', yesterday, plan('linear:A-1'));
    appendDailyMemory(config, 'daily_plan', today, plan('linear:B-1'));
    recordWrapup(yesterday, 'skipped');
    const rows = dayOutcomes(config, [yesterday, today], today);
    assert.deepEqual(rows.map((row) => row.state), ['skipped', 'today']);
    assert.match(renderDayOutcomes(rows), /没清理就放下了/);
  });
} finally {
  process.chdir(ORIGINAL_CWD);
}
if (failures > 0) {
  console.error(`\n${failures} failed`);
  process.exit(1);
}
console.log('\nday-outcomes: all passed');
