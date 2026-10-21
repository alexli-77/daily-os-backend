/**
 * 结束本期: the run looks back on the named cycle, never replaces a 总结, and
 * the chat only says what it wrote.
 *
 * Run: tsx scripts/tests/close-cycle.test.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

import { AppConfigSchema, type AppConfig } from '../../src/config/schema.js';
import { pickReviewAndTarget } from '../../src/cycles/cycle-context.js';
import { buildCycleId, readCycle, writeCycle } from '../../src/cycles/file.js';
import { applyCyclePlan } from '../../src/cycles/migration.js';
import { autoPrefixCommand, condenseCycleReviewReply } from '../../src/ui/chat.js';
import { addDays, todayInTimezone } from '../../src/utils/date.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ORIGINAL_CWD = process.cwd();

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void): void {
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

function label(start: string, end: string): string {
  return `${Number(start.slice(5, 7))}.${Number(start.slice(8))}-${Number(end.slice(5, 7))}.${Number(end.slice(8))}`;
}

/** Three back-to-back two-week cycles; today is the last day of the middle one. */
function setup(): { config: AppConfig; ids: string[] } {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-os-close-'));
  process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'daily-os-close-cwd-')));
  const parsed = yaml.load(fs.readFileSync(path.join(REPO_ROOT, 'config', 'config.example.yaml'), 'utf8')) as Record<string, any>;
  parsed.memory.repository_path = vault;
  parsed.user.timezone = 'UTC';
  const config = AppConfigSchema.parse(parsed);
  const today = todayInTimezone(config);
  const ids = [-27, -13, 1].map((offset) => {
    const start = addDays(today, offset);
    const name = label(start, addDays(start, 13));
    const id = buildCycleId(start, name);
    writeCycle(config, id, { cycle: name, mode: 'biweekly' });
    return id;
  });
  return { config, ids };
}

test('结束本期 reviews the named cycle and plans the one after it', () => {
  const { config, ids } = setup();
  const [before, closing, after] = ids;
  const picked = pickReviewAndTarget(config, closing)!;
  assert.equal(picked.review?.id, closing);
  assert.equal(picked.target.id, after);
  // Without a name it is the new cycle's run: on the closing cycle's last day
  // that would look back on the cycle before it — the reason the name exists.
  const byDate = pickReviewAndTarget(config)!;
  assert.equal(byDate.target.id, closing);
  assert.equal(byDate.review?.id, before);
  assert.equal(pickReviewAndTarget(config, after), null, 'no cycle after it yet');
});

test('a 总结 already there is never replaced: the new one is a draft', () => {
  const { config, ids } = setup();
  const id = ids[1]!;
  const doc = readCycle(config, id)!;
  const plan = { owner: 'self' as const, id, label: doc.cycle, mode: 'biweekly', startDate: doc.startDate, runId: 'r1', sections: { review: '第一版总结' }, notes: [] };
  assert.deepEqual(applyCyclePlan(config, plan, readCycle(config, id), { dryRun: false }).written, ['review'], 'empty: written');
  const second = applyCyclePlan(config, { ...plan, runId: 'r2', sections: { review: '第二版总结' } }, readCycle(config, id), { dryRun: false });
  assert.deepEqual(second.drafted, ['review']);
  const after = readCycle(config, id)!.sections.review!;
  assert.equal(after.content.trim(), '第一版总结');
  assert.equal(after.pendingDraft?.content.trim(), '第二版总结');
});

test('the chat says what the 双周复盘 wrote, not the whole draft', () => {
  const full = ['### 自我-自我成长（O3）', '1. 读一篇英文', '', '```json', '{"kr_progress":[]}', '```', '', '---', '📁 本地周期（Cycles 页）', '要务 → 2026-10-19_10.19-11.1：已写入 780 字', 'review → 2026-10-05_10.5-10.18：已写入 276 字'].join('\n');
  const short = condenseCycleReviewReply(full);
  assert.ok(!short.includes('kr_progress') && !short.includes('###'));
  assert.ok(short.includes('要务 → 2026-10-19_10.19-11.1：已写入 780 字'));
  assert.ok(short.includes('去那里看和改'));
  assert.equal(condenseCycleReviewReply('正在跑双周复盘…'), '正在跑双周复盘…', 'progress passes through');
});

test('「今日复盘」 is the evening review of today', () => {
  assert.equal(autoPrefixCommand('今日复盘', 'daily-os'), 'daily-os review');
  assert.equal(autoPrefixCommand('双周复盘', 'daily-os'), 'daily-os skills run weekly-review biweekly');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
