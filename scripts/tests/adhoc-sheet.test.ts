/**
 * A capture added during the day is on today's sheet at once, and stays there.
 *
 * Two ways it was lost:
 * - a plan with no rows (every 要务 in 固定日程) parsed as "no plan", so there
 *   was nothing to append to and the row waited for 重新生成;
 * - the append went to the latest-output pointer only, so once another
 *   workflow took the pointer (the evening review) the sheet fell back to the
 *   cached morning plan and the row vanished.
 *
 * Run: tsx scripts/tests/adhoc-sheet.test.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

import { AppConfigSchema } from '../../src/config/schema.js';
import { writeLatestWorkflowOutput, writeWorkflowDetailCache } from '../../src/storage/memory.js';
import { captureTodoItems } from '../../src/todo/inbox.js';
import { buildTodayPlanSnapshot } from '../../src/todo/today-plan.js';
import { todayInTimezone } from '../../src/utils/date.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ORIGINAL_CWD = process.cwd();

try {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-os-adhoc-'));
  process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'daily-os-adhoc-cwd-')));
  const parsed = yaml.load(fs.readFileSync(path.join(REPO_ROOT, 'config', 'config.example.yaml'), 'utf8')) as Record<string, any>;
  parsed.memory.repository_path = vault;
  parsed.user.timezone = 'UTC';
  const config = AppConfigSchema.parse(parsed);
  const today = todayInTimezone(config);
  const onSheet = (id: string) => Boolean(buildTodayPlanSnapshot(config)?.todos.some((todo) => todo.candidateId === `todo_inbox:${id}`));

  // No plan yet: the capture is kept, and no plan is invented around it.
  const early = captureTodoItems(config, '先记一条', { source: 'console-adhoc' }).items![0]!;
  assert.equal(buildTodayPlanSnapshot(config), null);
  assert.ok(!onSheet(early.id));

  // A plan with no rows, as a run writes it: pointer and cache.
  const empty = JSON.stringify({ todos: [], note: '今天的事都在固定日程里。' });
  writeLatestWorkflowOutput(config, 'daily_plan', today, empty);
  writeWorkflowDetailCache(config, 'daily_plan', today, empty);

  const item = captureTodoItems(config, '给设计师回邮件', { source: 'console-adhoc' }).items![0]!;
  assert.ok(onSheet(item.id), 'added to an empty plan, without regenerating');

  // The evening review takes the pointer; the row is still there.
  writeLatestWorkflowOutput(config, 'daily_review', today, '{"reconciliation":[]}');
  assert.ok(onSheet(item.id), 'still on the sheet after another workflow wrote the pointer');
  // Read here, from the cache: a run stamps the pointer and the cache a
  // millisecond or so apart, so comparing across the switch is noise.
  const generatedAt = buildTodayPlanSnapshot(config)!.generated_at;

  // And one added after that lands in the cache the sheet now reads.
  const late = captureTodoItems(config, '晚上补一条', { source: 'console-adhoc' }).items![0]!;
  assert.ok(onSheet(late.id) && onSheet(item.id));
  assert.equal(buildTodayPlanSnapshot(config)!.generated_at, generatedAt, 'appending does not change when the plan was generated');

  console.log('adhoc-sheet tests passed');
} finally {
  process.chdir(ORIGINAL_CWD);
}
