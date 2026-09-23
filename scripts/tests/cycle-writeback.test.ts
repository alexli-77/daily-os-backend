/**
 * LEO-278 — a finished life-review-os run lands in `20_CYCLES`.
 *
 * Independent, tsx-runnable:  npx tsx scripts/tests/cycle-writeback.test.ts
 *
 * The property this file exists to defend is the one that has already been got
 * wrong twice in this project: a run's 要务 and its review describe two
 * *different* cycles. 要务 plans `writeback.target_week`; the review is about
 * `evidence.review_week`, the cycle that just ended. Filing both under the same
 * label puts a review of August 10-23 next to the priorities for August 24.
 *
 * Everything runs against a temp vault and temp run records; no real config,
 * vault or `.runs` directory is touched, and nothing here talks to Feishu.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

import { AppConfigSchema, type AppConfig } from '../../src/config/schema.js';
import { readCycle, writeSection } from '../../src/cycles/file.js';
import { formatLocalCycleWriteback, writeLocalCyclesFromRun } from '../../src/cycles/writeback.js';
import { RETRO_TEMPLATE, isBlankRetroTemplate } from '../../src/cycles/retro-template.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

type TestFn = () => void | Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];
function test(name: string, fn: TestFn): void {
  tests.push({ name, fn });
}

const CREATED: string[] = [];

const TARGET_ID = '2026-08-24_8.24-9.6';
const REVIEW_ID = '2026-08-10_8.10-8.23';

/** The quarterly OKR file, the source of the 要务 group headings. */
const CURRENT_OKR = [
  '---',
  'cycle: 2026Q3',
  '---',
  '',
  '## Objective O1: 工作 · 技术专家',
  '',
  '| KR ID | Description | Target | Current | Progress | Updated |',
  '| --- | --- | --- | --- | --- | --- |',
  '| O1-KR1 | 求职材料 | 1 | 0 | 0% | |',
  '',
  '## Objective O2: 金钱 · 家庭理财规划师',
  '',
  '| KR ID | Description | Target | Current | Progress | Updated |',
  '| --- | --- | --- | --- | --- | --- |',
  '| O2-KR1 | 家庭财富报告 | 1 | 0 | 0% | |',
  '',
].join('\n');

function tempWorkspace(options: { withOkr?: boolean } = {}): { config: AppConfig; vault: string; runsDir: string } {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-os-wb-vault-'));
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-os-wb-runs-'));
  CREATED.push(vault, runsDir);
  if (options.withOkr !== false) {
    fs.mkdirSync(path.join(vault, '10_OKR'), { recursive: true });
    fs.writeFileSync(path.join(vault, '10_OKR', 'current-okr.md'), CURRENT_OKR, 'utf8');
  }
  const parsed = yaml.load(fs.readFileSync(path.join(REPO_ROOT, 'config', 'config.example.yaml'), 'utf8')) as Record<string, any>;
  parsed.memory.repository_path = vault;
  return { config: AppConfigSchema.parse(parsed), vault, runsDir };
}

/** A life-review-os run record, shaped like the ones in `.runs`. */
function writeRun(
  runsDir: string,
  runId: string,
  overrides: {
    targetWeek?: string | null;
    reviewWeek?: string | null;
    reviewText?: string;
    items?: Array<{ text: string; target_row: number; target_row_label: string; is_mit?: boolean }>;
    docYear?: number;
  } = {},
): string {
  const record: Record<string, unknown> = {
    ok: true,
    run_id: runId,
    created_at: '2026-08-26T12:00:00.000Z',
    mode: 'biweekly',
    evidence: {
      review_week: overrides.reviewWeek === undefined ? '8.10-8.23' : overrides.reviewWeek,
      target_week: overrides.targetWeek === undefined ? '8.24-9.6' : overrides.targetWeek,
    },
    writeback: {
      doc_year: overrides.docYear === undefined ? 2026 : overrides.docYear,
      target_week: overrides.targetWeek === undefined ? '8.24-9.6' : overrides.targetWeek,
      ready: true,
      items:
        overrides.items === undefined
          ? [
              { text: '完成三条路径决策文档收尾', target_row: 1, target_row_label: 'KR1 完成 PhD / AI 工程求职三条路径的yes/no判断', is_mit: true },
              { text: '8.26 完成 Duolingo English Test', target_row: 1, target_row_label: 'KR1 完成 PhD / AI 工程求职三条路径的yes/no判断' },
              { text: '校准家庭财富三个数 (LEO-102)', target_row: 2, target_row_label: 'KR1 完成 2026 Q3 家庭财富报告' },
            ]
          : overrides.items,
      review: { text: overrides.reviewText === undefined ? '本双周行政类任务完成率高，唯一 MIT 仍为 0%。' : overrides.reviewText },
    },
  };
  fs.writeFileSync(path.join(runsDir, `${runId}.json`), JSON.stringify(record), 'utf8');
  return runId;
}

// --- the split that matters ---------------------------------------------------

test('要务 goes to the planned cycle and review goes to the reviewed cycle', () => {
  const { config, runsDir } = tempWorkspace();
  writeRun(runsDir, 'run-1');
  const result = writeLocalCyclesFromRun(config, runsDir, 'run-1');

  assert.equal(result.error, undefined, 'a well-formed run must not error');
  const priorities = result.writes.find((write) => write.section === '要务');
  const review = result.writes.find((write) => write.section === 'review');
  assert.equal(priorities?.cycleId, TARGET_ID, '要务 belongs to writeback.target_week');
  assert.equal(review?.cycleId, REVIEW_ID, 'review belongs to evidence.review_week, not the planned cycle');
  assert.notEqual(priorities?.cycleId, review?.cycleId, 'the two writes must not land in the same file');
});

test('both cycle files exist on disk afterwards, each with only its own section', () => {
  const { config, runsDir } = tempWorkspace();
  writeRun(runsDir, 'run-2');
  writeLocalCyclesFromRun(config, runsDir, 'run-2');

  const target = readCycle(config, TARGET_ID);
  const review = readCycle(config, REVIEW_ID);
  assert.ok(target, 'the planned cycle file was created');
  assert.ok(review, 'the reviewed cycle file was created');
  assert.ok(target!.sections['要务']?.content, 'planned cycle has 要务');
  assert.equal(target!.sections.review, undefined, 'the planned cycle must not carry the review');
  assert.ok(review!.sections.review?.content, 'reviewed cycle has the review');
  assert.equal(review!.sections['要务'], undefined, 'the reviewed cycle must not get these priorities');
});

test('sections are written with the right owner', () => {
  const { config, runsDir } = tempWorkspace();
  writeRun(runsDir, 'run-3');
  writeLocalCyclesFromRun(config, runsDir, 'run-3');
  assert.equal(readCycle(config, TARGET_ID)!.sections['要务']!.source, 'planner');
  assert.equal(readCycle(config, REVIEW_ID)!.sections.review!.source, 'ai');
});

test('the run id is recorded on the cycle it planned', () => {
  const { config, runsDir } = tempWorkspace();
  writeRun(runsDir, 'run-4');
  writeLocalCyclesFromRun(config, runsDir, 'run-4');
  assert.equal(readCycle(config, TARGET_ID)!.runId, 'run-4');
  assert.equal(readCycle(config, TARGET_ID)!.mode, 'biweekly');
});

// --- headings -----------------------------------------------------------------

test('group headings come from the quarterly OKR objectives, not the KR paragraph', () => {
  const { config, runsDir } = tempWorkspace();
  writeRun(runsDir, 'run-5');
  writeLocalCyclesFromRun(config, runsDir, 'run-5');
  const body = readCycle(config, TARGET_ID)!.sections['要务']!.content;
  assert.match(body, /^### 工作 · 技术专家$/m, 'row 1 is grouped under Objective O1');
  assert.match(body, /^### 金钱 · 家庭理财规划师$/m, 'row 2 is grouped under Objective O2');
  assert.doesNotMatch(body, /### KR1 完成 PhD/, 'the raw KR paragraph must not become a heading');
});

test('an objective with nothing planned still shows, with the placeholder', () => {
  const { config, runsDir } = tempWorkspace();
  // Plan only O1 (row 1); O2 (row 2) is left unplanned this cycle. It must still
  // appear, with 本周期无安排 — not silently dropped.
  writeRun(runsDir, 'run-partial', {
    items: [{ text: '只排了工作这一项', target_row: 1, target_row_label: 'KR1' }],
  });
  writeLocalCyclesFromRun(config, runsDir, 'run-partial');
  const body = readCycle(config, TARGET_ID)!.sections['要务']!.content;
  assert.match(body, /^### 工作 · 技术专家$/m, 'the planned objective shows');
  assert.match(body, /### 金钱 · 家庭理财规划师\n本周期无安排/m, 'the unplanned objective shows the placeholder');
});

test('the MIT marker and Linear ids survive into the markdown', () => {
  const { config, runsDir } = tempWorkspace();
  writeRun(runsDir, 'run-6');
  writeLocalCyclesFromRun(config, runsDir, 'run-6');
  const body = readCycle(config, TARGET_ID)!.sections['要务']!.content;
  assert.match(body, /- 完成三条路径决策文档收尾 \*\*MIT\*\*/, 'MIT emphasis is kept');
  assert.match(body, /\(LEO-102\)/, 'a Linear id in the item text is kept verbatim');
});

test('without a readable OKR file the headings fall back to the KR paragraph', () => {
  const { config, runsDir } = tempWorkspace({ withOkr: false });
  writeRun(runsDir, 'run-7');
  writeLocalCyclesFromRun(config, runsDir, 'run-7');
  const body = readCycle(config, TARGET_ID)!.sections['要务']!.content;
  assert.match(body, /^### KR1 完成 PhD/m, 'falls back rather than dropping the grouping');
  assert.match(body, /完成三条路径决策文档收尾/, 'and the items themselves are unaffected');
});

// --- re-running ---------------------------------------------------------------

test('re-running the same run changes nothing', () => {
  const { config, runsDir } = tempWorkspace();
  writeRun(runsDir, 'run-8');
  writeLocalCyclesFromRun(config, runsDir, 'run-8');
  const before = readCycle(config, TARGET_ID)!.sections['要务']!.updatedAt;

  const second = writeLocalCyclesFromRun(config, runsDir, 'run-8');
  assert.equal(second.writes.find((write) => write.section === '要务')?.status, 'unchanged');
  assert.equal(readCycle(config, TARGET_ID)!.sections['要务']!.updatedAt, before, 'no timestamp bump on a no-op');
});

test('a retro the user wrote is never touched by a run', () => {
  const { config, runsDir } = tempWorkspace();
  writeSection(config, REVIEW_ID, 'retro', '我手写的复盘，不许覆盖', 'user');
  writeRun(runsDir, 'run-9');
  writeLocalCyclesFromRun(config, runsDir, 'run-9');

  const doc = readCycle(config, REVIEW_ID)!;
  assert.equal(doc.sections.retro!.content, '我手写的复盘，不许覆盖', 'the hand-written retro survives');
  assert.equal(doc.sections.retro!.source, 'user');
  assert.ok(doc.sections.review!.content, 'and the review still landed alongside it');
});

test('a 要务 section the user edited is not overwritten by a re-plan', () => {
  const { config, runsDir } = tempWorkspace();
  writeSection(config, TARGET_ID, '要务', '- 我自己改过的要务', 'user');
  writeRun(runsDir, 'run-10');
  const result = writeLocalCyclesFromRun(config, runsDir, 'run-10');

  assert.equal(readCycle(config, TARGET_ID)!.sections['要务']!.content, '- 我自己改过的要务');
  const write = result.writes.find((entry) => entry.section === '要务');
  assert.equal(write?.status, 'unchanged');
  assert.equal(write?.reason, 'user-edited', 'and it says why it stood back');
});

// --- degrading rather than throwing -------------------------------------------

test('a run with no review skips the review and still writes 要务', () => {
  const { config, runsDir } = tempWorkspace();
  writeRun(runsDir, 'run-11', { reviewText: '' });
  const result = writeLocalCyclesFromRun(config, runsDir, 'run-11');

  const review = result.writes.find((write) => write.section === 'review');
  assert.equal(review?.status, 'skipped');
  assert.match(review?.reason || '', /no review/);
  assert.ok(readCycle(config, TARGET_ID)!.sections['要务'], '要务 is unaffected by a missing review');
  assert.equal(readCycle(config, REVIEW_ID), null, 'and no empty file is created for the reviewed cycle');
});

test('a review whose cycle label cannot be dated is reported, not silently dropped', () => {
  const { config, runsDir } = tempWorkspace();
  writeRun(runsDir, 'run-12', { reviewWeek: 'not-a-label' });
  const result = writeLocalCyclesFromRun(config, runsDir, 'run-12');

  const review = result.writes.find((write) => write.section === 'review');
  assert.equal(review?.status, 'skipped');
  assert.match(review?.reason || '', /cannot date/);
  assert.ok(review!.chars > 0, 'the size of what was dropped is reported');
});

test('a run with no items skips 要务', () => {
  const { config, runsDir } = tempWorkspace();
  writeRun(runsDir, 'run-13', { items: [] });
  const result = writeLocalCyclesFromRun(config, runsDir, 'run-13');
  assert.equal(result.writes.find((write) => write.section === '要务')?.status, 'skipped');
  assert.ok(readCycle(config, REVIEW_ID)!.sections.review, 'the review still lands');
});

test('a run record with no target_week is refused as a whole, without throwing', () => {
  const { config, runsDir } = tempWorkspace();
  writeRun(runsDir, 'run-14', { targetWeek: null });
  const result = writeLocalCyclesFromRun(config, runsDir, 'run-14');
  assert.ok(result.error, 'reported as an error');
  assert.equal(result.writes.length, 0);
});

test('a missing run file is an error, not a crash', () => {
  const { config, runsDir } = tempWorkspace();
  const result = writeLocalCyclesFromRun(config, runsDir, 'nope');
  assert.ok(result.error);
  assert.match(result.error!, /no usable run record/);
});

test('an unparseable run file is an error, not a crash', () => {
  const { config, runsDir } = tempWorkspace();
  fs.writeFileSync(path.join(runsDir, 'broken.json'), '{not json', 'utf8');
  const result = writeLocalCyclesFromRun(config, runsDir, 'broken');
  assert.ok(result.error);
});

test('a cycle file with broken frontmatter fails that write and reports it', () => {
  const { config, vault, runsDir } = tempWorkspace();
  fs.mkdirSync(path.join(vault, '20_CYCLES'), { recursive: true });
  fs.writeFileSync(path.join(vault, '20_CYCLES', `${TARGET_ID}.md`), '---\ncycle: [unclosed\n---\n\n## 要务\n旧的\n', 'utf8');
  writeRun(runsDir, 'run-15');
  const result = writeLocalCyclesFromRun(config, runsDir, 'run-15');

  assert.equal(result.writes.find((write) => write.section === '要务')?.status, 'failed', 'refuses to clobber unparseable frontmatter');
  assert.ok(readCycle(config, REVIEW_ID)!.sections.review, 'and the other cycle is still written');
});

test('dryRun reports the same plan but writes nothing', () => {
  const { config, runsDir } = tempWorkspace();
  writeRun(runsDir, 'run-16');
  const result = writeLocalCyclesFromRun(config, runsDir, 'run-16', { dryRun: true });
  assert.equal(result.writes.find((write) => write.section === '要务')?.status, 'created');
  assert.equal(readCycle(config, TARGET_ID), null, 'nothing on disk');
});

// --- the line the user reads --------------------------------------------------

test('the summary names both cycles and both sections', () => {
  const { config, runsDir } = tempWorkspace();
  writeRun(runsDir, 'run-17');
  const note = formatLocalCycleWriteback(writeLocalCyclesFromRun(config, runsDir, 'run-17'));
  assert.match(note, /要务 → 2026-08-24_8\.24-9\.6/);
  assert.match(note, /review → 2026-08-10_8\.10-8\.23/);
});

test('a skipped write says so instead of reading like a success', () => {
  const { config, runsDir } = tempWorkspace();
  writeRun(runsDir, 'run-18', { reviewText: '' });
  const note = formatLocalCycleWriteback(writeLocalCyclesFromRun(config, runsDir, 'run-18'));
  assert.match(note, /跳过/);
});

// --- retro template -----------------------------------------------------------

test('the retro template carries the three Feishu sections in order', () => {
  const status = RETRO_TEMPLATE.indexOf('状态');
  const good = RETRO_TEMPLATE.indexOf('做的好');
  const improve = RETRO_TEMPLATE.indexOf('待改进');
  assert.ok(status >= 0 && good > status && improve > good, 'order is 状态 -> 做的好 -> 待改进');
  assert.match(RETRO_TEMPLATE, /情绪：/);
  assert.match(RETRO_TEMPLATE, /精力：/);
  assert.match(RETRO_TEMPLATE, /外部压力：/);
  assert.match(RETRO_TEMPLATE, /计划外吃掉时间的事：/);
});

test('the template matches the headings life-review-os parses back out', () => {
  // Mirrors bin/life-review-os.mjs, which splits a retro cell on these three.
  assert.match(RETRO_TEMPLATE, /(?:😄\s*)?状态\s*[：:]?/);
  assert.match(RETRO_TEMPLATE, /(?:👍🏻?\s*)?做[得的]好\s*[：:]?/);
  assert.match(RETRO_TEMPLATE, /(?:💪🏻?\s*)?待改进\s*[：:]?/);
});

test('an untouched template is recognised as blank', () => {
  assert.equal(isBlankRetroTemplate(RETRO_TEMPLATE), true);
  assert.equal(isBlankRetroTemplate(`${RETRO_TEMPLATE}\n\n`), true, 'trailing whitespace does not count as content');
  assert.equal(isBlankRetroTemplate(RETRO_TEMPLATE.replace('情绪：', '情绪：正常')), false, 'one filled field is content');
  assert.equal(isBlankRetroTemplate(''), false, 'an empty string is not the template');
});

async function run(): Promise<void> {
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
