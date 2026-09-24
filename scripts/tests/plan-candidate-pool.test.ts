/**
 * #220 — the daily plan came back with one item on a working Thursday.
 *
 * The model was fine; its candidate pool was empty. Two causes are covered here
 * (the scorer-side exclusion rule has its own tests in todo-scorer.test.ts):
 *
 *   - `weekly_priorities` read only the Feishu weekly table. With write-back off
 *     (#211) that table never gets a column for the current cycle, so the
 *     cycle's 要务 — which exist, in the local cycle file — never reached the
 *     plan. The biweekly planner had the same blind spot for last cycle's 要务.
 *   - a plan-row tick on an inbox row only wrote the feedback ledger; the inbox
 *     kept saying `open`. Once the inbox is what decides "done" after the day
 *     of the tick, that tick has to reach the inbox.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

import { AppConfigSchema, type AppConfig } from '../../src/config/schema.js';
import { writeSection } from '../../src/cycles/file.js';
import { recentLocalPriorities, renderLocalPrioritiesBlock } from '../../src/cycles/context.js';
import { buildSkillInputPack } from '../../src/skills/runner.js';
import { handleTodoInboxCommand, listTodoInboxItems, syncTodoInboxFromPlanRow } from '../../src/todo/inbox.js';
import {
  extractWeeklyPrioritiesFromLocalCycle,
  parseCyclePriorities,
  preferLocalPriorities,
} from '../../src/workflows/weekly-priorities.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
/** life-review-os: `fs.readFileSync(dailyOsInputPath).slice(0, 20000)`. */
const PROMPT_CUT = 20000;

type TestFn = () => void | Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];
function test(name: string, fn: TestFn): void {
  tests.push({ name, fn });
}

const CREATED: string[] = [];

function tempConfig(): AppConfig {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-os-pool-'));
  CREATED.push(dir);
  const parsed = yaml.load(fs.readFileSync(path.join(REPO_ROOT, 'config', 'config.example.yaml'), 'utf8')) as Record<string, any>;
  parsed.memory.repository_path = dir;
  parsed.todo_inbox.ledger_path = path.join(dir, 'todo-inbox.jsonl');
  parsed.todo_inbox.vault_path = path.join(dir, 'todo-inbox.md');
  return AppConfigSchema.parse(parsed);
}

const PREVIOUS = [
  '### KR1 Cutto 北美运营 MIT',
  '- 完成两轮海外创作者触达 (CUTTO-1038) **MIT** 🚧',
  '- 补齐内容赛道 Skill 的可评审 Demo (CUTTO-1093) 🚧',
  '- 交付水印 PNG (CUTTO-1139) ✅',
  '',
  '### KR1 🏸穿线 + 教球利润 > 900刀',
  '- 剪出 1 条可发布短视频 ❌',
].join('\n');

const CURRENT = [
  '### 工作-UX designer',
  '- 持续海外触达，每周冷启动私信 10-15 人 (CUTTO-1038) **MIT**',
  '- 敲定邮件模板 A/B 版本 (CUTTO-1024) ✅',
  '',
  '### 金钱-家庭CFO',
  '1. 本双周至少完成 2 次教球或穿线订单',
].join('\n');

function seedCycles(config: AppConfig): void {
  writeSection(config, '2026-09-07_9.7-9.20', '要务', PREVIOUS, 'planner');
  writeSection(config, '2026-09-21_9.21-10.4', '要务', CURRENT, 'planner');
}

// --- ② weekly_priorities from the local cycle ----------------------------------

test('parsing keeps the OKR heading and the item text verbatim, markers included', () => {
  const items = parseCyclePriorities(CURRENT, '9.21-10.4');
  assert.equal(items.length, 3);
  assert.equal(items[0]?.okr, '工作-UX designer');
  assert.equal(items[0]?.item, '持续海外触达，每周冷启动私信 10-15 人 (CUTTO-1038) **MIT**');
  assert.equal(items[1]?.item.endsWith('✅'), true, 'the scorer drops ✅ rows, so the marker has to survive');
  assert.equal(items[2]?.okr, '金钱-家庭CFO', 'numbered items count too');
});

test('the cycle covering the date is the one read, across its whole span', () => {
  const config = tempConfig();
  seedCycles(config);
  for (const date of ['2026-09-21', '2026-09-24', '2026-10-04']) {
    const source = extractWeeklyPrioritiesFromLocalCycle(config, date);
    assert.equal(source.state, 'available', date);
    assert.equal((source.data as { week: string }).week, '9.21-10.4', date);
  }
  const previous = extractWeeklyPrioritiesFromLocalCycle(config, '2026-09-20');
  assert.equal((previous.data as { week: string }).week, '9.7-9.20', 'the last day of the previous cycle is still the previous cycle');
});

test('a date no cycle covers is missing, not the nearest cycle', () => {
  const config = tempConfig();
  seedCycles(config);
  assert.equal(extractWeeklyPrioritiesFromLocalCycle(config, '2026-10-05').state, 'missing');
});

test('a cycle file with no 要务 yet reports empty, so Feishu still gets its chance', () => {
  const config = tempConfig();
  writeSection(config, '2026-09-21_9.21-10.4', 'retro', 'x', 'user');
  const local = extractWeeklyPrioritiesFromLocalCycle(config, '2026-09-24');
  assert.equal(local.state, 'empty');
  const feishu = { state: 'available' as const, data: { week: '9.21-10.4', items: [{ item: 'from feishu' }] } };
  assert.equal(preferLocalPriorities(local, feishu), feishu);
});

test('the local cycle wins over Feishu when it has 要务', () => {
  const config = tempConfig();
  seedCycles(config);
  const local = extractWeeklyPrioritiesFromLocalCycle(config, '2026-09-24');
  const feishu = { state: 'available' as const, data: { week: '8.24-9.6', items: [] } };
  assert.equal(preferLocalPriorities(local, feishu), local);
});

// --- ② the biweekly planner sees last cycle's 要务 -----------------------------

test('recent priorities come newest first and skip cycles that have not started', () => {
  const config = tempConfig();
  seedCycles(config);
  writeSection(config, '2026-10-05_10.5-10.18', '要务', '### future\n- not yet', 'planner');
  const labels = recentLocalPriorities(config, '2026-09-24').map((entry) => entry.label);
  assert.deepEqual(labels, ['9.21-10.4', '9.7-9.20']);
});

async function testPackPlacement(): Promise<void> {
  const config = tempConfig();
  seedCycles(config);
  // Worst case for the budget: a full retro block ahead of this one.
  const longRetro = '复盘内容。'.repeat(400);
  writeSection(config, '2026-09-07_9.7-9.20', 'retro', longRetro, 'user');
  writeSection(config, '2026-08-24_8.24-9.6', 'retro', longRetro, 'user');
  const pack = await buildSkillInputPack(config, { skillId: 'weekly-review', mode: 'biweekly', userText: '', source: 'test', messageId: 'm' });
  const block = pack.indexOf('## Local Cycle Priorities');

  test('the priorities block is in the pack, inside the 20,000 characters life-review-os reads', () => {
    assert.ok(block >= 0, 'no Local Cycle Priorities block');
    assert.ok(block < PROMPT_CUT, `block starts at ${block}`);
  });

  test("last cycle's unfinished items are in this block, and the block is inside the cut", () => {
    // Searched inside the block, not the whole pack: other blocks can echo a
    // cycle file too (this fixture has no OKR dir, so the OKR chain reads it),
    // and in a real pack the first verbatim copy sat at offset ~46,900.
    const end = pack.indexOf('## Latest Workflow');
    const body = pack.indexOf('补齐内容赛道 Skill 的可评审 Demo (CUTTO-1093) 🚧', block);
    assert.ok(body > block && body < end, `CUTTO-1093 at ${body}, block ${block}..${end}`);
    assert.ok(end < PROMPT_CUT, `the whole block ends at ${end}`);
  });

  test('the block does not push the OKR chain or the Linear blocks down', () => {
    for (const heading of ['## Local OKR Chain', '## Linear Issue Snapshot', '## Local Cycle Retro']) {
      const offset = pack.indexOf(heading);
      assert.ok(offset >= 0 && offset < block, `${heading} at ${offset} must precede the priorities block at ${block}`);
    }
  });

  test('the block tells the planner it is the authority and that 🚧 items cannot silently vanish', () => {
    const text = pack.slice(block, pack.indexOf('## Latest Workflow'));
    assert.match(text, /权威来源/);
    assert.match(text, /本期不做/);
  });

  const bare = await buildSkillInputPack(tempConfig(), { skillId: 'weekly-review', mode: 'biweekly', userText: '', source: 'test', messageId: 'm' });
  test('with no local 要务 the block degrades to an explicit placeholder', () => {
    const offset = bare.indexOf('## Local Cycle Priorities');
    assert.ok(offset >= 0);
    assert.match(bare.slice(offset, bare.indexOf('## Latest Workflow')), /no local cycle priorities yet/);
  });
}

test('rendering an empty list is an empty string, not a bare heading', () => {
  assert.equal(renderLocalPrioritiesBlock([]), '');
});

// --- ① a plan-row tick reaches the inbox -----------------------------------------

function captured(config: AppConfig, text: string): string {
  const result = handleTodoInboxCommand(config, { type: 'capture', text }, { source: 'test' });
  const id = result.items?.[0]?.id;
  assert.ok(id, 'capture returned an item');
  return id!;
}

const statusOf = (config: AppConfig, id: string): string | undefined => listTodoInboxItems(config).find((item) => item.id === id)?.status;

test('complete on an inbox plan row marks the inbox item done', () => {
  const config = tempConfig();
  const id = captured(config, '干发帽、泡沫洗手液器');
  assert.equal(syncTodoInboxFromPlanRow(config, `todo_inbox:${id}`, 'complete'), true);
  assert.equal(statusOf(config, id), 'done');
});

test('reopen and partial put it back to open', () => {
  const config = tempConfig();
  const id = captured(config, 'X 发 3 篇');
  syncTodoInboxFromPlanRow(config, `todo_inbox:${id}`, 'complete');
  syncTodoInboxFromPlanRow(config, `todo_inbox:${id}`, 'reopen');
  assert.equal(statusOf(config, id), 'open');
  syncTodoInboxFromPlanRow(config, `todo_inbox:${id}`, 'complete');
  syncTodoInboxFromPlanRow(config, `todo_inbox:${id}`, 'partial');
  assert.equal(statusOf(config, id), 'open', 'half done is still open work');
});

test('defer on the plan is "tomorrow", not the inbox\'s shelved state', () => {
  const config = tempConfig();
  const id = captured(config, '整理房间');
  assert.equal(syncTodoInboxFromPlanRow(config, `todo_inbox:${id}`, 'defer'), false);
  assert.equal(statusOf(config, id), 'open');
});

test('non-inbox rows and unknown ids are no-ops', () => {
  const config = tempConfig();
  assert.equal(syncTodoInboxFromPlanRow(config, 'linear:CUTTO-1038', 'complete'), false);
  assert.equal(syncTodoInboxFromPlanRow(config, 'todo_inbox:does-not-exist', 'complete'), false);
});

async function run(): Promise<void> {
  await testPackPlacement();
  let passed = 0;
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed += 1;
      console.log(`  ✓ ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`  ✗ ${name}`);
      console.error(`    ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const dir of CREATED) fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

void run();
