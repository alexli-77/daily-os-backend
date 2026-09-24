/**
 * cycle_context: the local-md replacement for life-review-os reading the Feishu
 * weekly table. Parses 要务 markdown back into per-OKR rows, and assembles the
 * previous/target cycle context daily-os hands the planner.
 *
 * Run: tsx scripts/tests/cycle-context.test.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import yaml from 'js-yaml';
import { AppConfigSchema, type AppConfig } from '../../src/config/schema.js';
import { buildCycleContext, parsePrioritiesByOkr } from '../../src/cycles/cycle-context.js';
import { writeCycle, buildCycleId } from '../../src/cycles/file.js';
import { addDays, todayInTimezone } from '../../src/utils/date.js';

const CREATED: string[] = [];

const OKR = [
  '---',
  'cycle: 2026Q3',
  '---',
  '',
  '## Objective O1: 工作 · 技术专家',
  '',
  '| KR ID | Description | Target | Current | Progress | Updated |',
  '| --- | --- | --- | --- | --- | --- |',
  '| O1-KR1 | 求职 | 1 | 0 | 0% | |',
  '',
  '## Objective O2: 金钱 · 家庭理财规划师',
  '',
  '| KR ID | Description | Target | Current | Progress | Updated |',
  '| --- | --- | --- | --- | --- | --- |',
  '| O2-KR1 | 家庭财富 | 1 | 0 | 0% | |',
  '',
].join('\n');

function tempConfig(): AppConfig {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-os-cc-'));
  CREATED.push(vault);
  fs.mkdirSync(path.join(vault, '10_OKR'), { recursive: true });
  fs.writeFileSync(path.join(vault, '10_OKR', 'current-okr.md'), OKR, 'utf8');
  const parsed = yaml.load(fs.readFileSync(path.join(process.cwd(), 'config', 'config.example.yaml'), 'utf8')) as Record<string, any>;
  parsed.memory.repository_path = vault;
  parsed.user.timezone = 'UTC';
  return AppConfigSchema.parse(parsed);
}

const LABELS = ['', '工作 · 技术专家', '金钱 · 家庭理财规划师'];

try {
  // 1) parse: bullets per O; the placeholder line is not a task.
  const parsed = parsePrioritiesByOkr(
    ['### 工作 · 技术专家', '- 完成简历 (LEO-93) **MIT**', '- 更新 LinkedIn', '', '### 金钱 · 家庭理财规划师', '本周期无安排'].join('\n'),
    LABELS,
  );
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].row, 1);
  assert.match(parsed[0].tasks, /完成简历 \(LEO-93\) \*\*MIT\*\*/, 'Linear id and MIT kept verbatim');
  assert.match(parsed[0].tasks, /更新 LinkedIn/);
  assert.equal(parsed[1].okr, '金钱 · 家庭理财规划师');
  assert.equal(parsed[1].tasks, '', '本周期无安排 placeholder yields no task');

  // 2) build: today sits inside the target cycle; the one before it is the review.
  const config = tempConfig();
  const today = todayInTimezone(config);
  const targetStart = addDays(today, -3); // 14-day span → contains today
  const reviewStart = addDays(targetStart, -14);
  writeCycle(config, buildCycleId(reviewStart, 'prev'), {
    cycle: 'prev',
    mode: 'biweekly',
    sections: {
      '要务': { content: '### 工作 · 技术专家\n- 上期做的事 (LEO-1)', source: 'planner' },
      retro: { content: '上期复盘：还行', source: 'user' },
    },
  });
  writeCycle(config, buildCycleId(targetStart, 'cur'), {
    cycle: 'cur',
    mode: 'biweekly',
    sections: { '要务': { content: '### 工作 · 技术专家\n- 本期已有要务', source: 'user' } },
  });

  const ctx = buildCycleContext(config);
  assert.ok(ctx, 'context built');
  assert.deepEqual(ctx!.okrRows, [
    { row_index: 1, okr: '工作 · 技术专家' },
    { row_index: 2, okr: '金钱 · 家庭理财规划师' },
  ]);
  assert.equal(ctx!.targetWeek.label, 'cur');
  assert.equal(ctx!.reviewWeek.label, 'prev');
  assert.match(ctx!.reviewRows[0].tasks, /上期做的事 \(LEO-1\)/, 'review 要务 come from the previous cycle file');
  assert.equal(ctx!.reviewRetro, '上期复盘：还行');
  assert.match(ctx!.targetRows[0].tasks, /本期已有要务/, 'target 要务 come from the current cycle file');

  // 3) no local OKR → null (life-review-os falls back to Feishu).
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-os-cc-bare-'));
  CREATED.push(bare);
  const p2 = yaml.load(fs.readFileSync(path.join(process.cwd(), 'config', 'config.example.yaml'), 'utf8')) as Record<string, any>;
  p2.memory.repository_path = bare;
  assert.equal(buildCycleContext(AppConfigSchema.parse(p2)), null, 'no OKR rows → no context');

  console.log('cycle-context.test.ts: all tests passed');
} finally {
  for (const dir of CREATED) fs.rmSync(dir, { recursive: true, force: true });
}
