/**
 * History migration into cycle files (LEO-280).
 *
 * Independent, tsx-runnable:  npx tsx scripts/tests/cycle-migration.test.ts
 *
 * The migration reads two sources that disagree about almost everything, so the
 * cases below are the ones that actually cost data when they go wrong:
 *
 *   - a cycle was re-planned up to 14 times; only the last run is real;
 *   - the retro column is on the left of its 要务 column in 🐶's table and on
 *     the right in 🐧's, so a fixed offset silently reads the neighbouring
 *     cycle's retro;
 *   - a run's review is about the cycle that just *ended*, not the one it plans;
 *   - the write-back appends that review *inside* the retro cell, so the retro
 *     has to be split back apart;
 *   - re-running must not restamp files, and must never overwrite a section the
 *     user has since edited;
 *   - 🐧's history must never reach this machine's vault.
 *
 * Feishu is a saved block dump (`fixtures/cycle-migration-blocks.json`): same
 * block shapes as the real document, synthetic content, no network.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

import { AppConfigSchema, type AppConfig } from '../../src/config/schema.js';
import { cyclesDir, readCycle, writeSection } from '../../src/cycles/file.js';
import {
  applyCyclePlan,
  findCycleColumns,
  inferMode,
  loadRuns,
  parseFeishuTables,
  planCycles,
  splitRetroAndReview,
  startDateForLabel,
  tableMarker,
  type CyclePlan,
  type FeishuTable,
} from '../../src/cycles/migration.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURE = path.join(REPO_ROOT, 'scripts', 'tests', 'fixtures', 'cycle-migration-blocks.json');

type TestFn = () => void | Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];
function test(name: string, fn: TestFn): void {
  tests.push({ name, fn });
}

const CREATED: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-os-migration-'));
  CREATED.push(dir);
  return dir;
}

function tempConfig(vault: string): AppConfig {
  const parsed = yaml.load(fs.readFileSync(path.join(REPO_ROOT, 'config', 'config.example.yaml'), 'utf8')) as Record<string, any>;
  parsed.memory.repository_path = vault;
  return AppConfigSchema.parse(parsed);
}

function tables(): FeishuTable[] {
  return parseFeishuTables(JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as unknown[]);
}

/** A `.runs` directory whose files have controlled mtimes. */
function runsDir(records: Array<{ name: string; mtime: number; body: unknown }>): string {
  const dir = tempDir();
  for (const record of records) {
    const file = path.join(dir, `${record.name}.json`);
    fs.writeFileSync(file, JSON.stringify(record.body), 'utf8');
    fs.utimesSync(file, record.mtime / 1000, record.mtime / 1000);
  }
  return dir;
}

function run(input: {
  runId: string;
  mode?: string;
  targetWeek: string;
  reviewWeek?: string;
  items?: Array<{ text: string; is_mit?: boolean; target_row?: number; target_row_label?: string }>;
  review?: string;
}): unknown {
  return {
    ok: true,
    run_id: input.runId,
    created_at: '2026-08-25T02:45:27.080Z',
    mode: input.mode || 'biweekly',
    evidence: { review_week: input.reviewWeek || '', target_week: input.targetWeek },
    writeback: {
      doc_year: 2026,
      target_week: input.targetWeek,
      layout: 'retro_before_task',
      items: (input.items || []).map((item) => ({
        text: item.text,
        is_mit: item.is_mit === true,
        target_row: item.target_row ?? 1,
        target_row_label: item.target_row_label ?? '工作线',
      })),
      review: { text: input.review || '', ready: true },
    },
  };
}

/** Three runs for the same cycle, plus the next cycle's run that reviews it. */
function standardRuns(): string {
  return runsDir([
    { name: 'oldest', mtime: 1_000_000, body: run({ runId: 'oldest', targetWeek: '8.24-9.6', reviewWeek: '8.10-8.23', items: [{ text: '第一版要务' }], review: '关于 8.10-8.23 的复盘' }) },
    { name: 'middle', mtime: 2_000_000, body: run({ runId: 'middle', targetWeek: '8.24-9.6', reviewWeek: '8.10-8.23', items: [{ text: '第二版要务' }], review: '第二版：关于 8.10-8.23 的复盘' }) },
    { name: 'newest', mtime: 3_000_000, body: run({ runId: 'newest', targetWeek: '8.24-9.6', reviewWeek: '8.10-8.23', items: [{ text: '最终要务', is_mit: true }, { text: '次要要务' }], review: '最终版：关于 8.10-8.23 的复盘' }) },
  ]);
}

function planFor(dir: string): CyclePlan[] {
  return planCycles({ runs: loadRuns(dir), tables: tables(), selfMarker: '🐶', partnerMarker: '🐧', year: 2026 });
}

function find(plans: CyclePlan[], owner: 'self' | 'partner', label: string): CyclePlan {
  const plan = plans.find((candidate) => candidate.owner === owner && candidate.label === label);
  assert.ok(plan, `no ${owner} plan for ${label}`);
  return plan;
}

// --- sources -----------------------------------------------------------------

test('the last run for a cycle wins, by mtime and not by file order', () => {
  const plan = find(planFor(standardRuns()), 'self', '8.24-9.6');
  assert.equal(plan.runId, 'newest');
  assert.match(plan.sections['要务'] || '', /最终要务 \*\*MIT\*\*/);
  assert.doesNotMatch(plan.sections['要务'] || '', /第一版|第二版/, 'superseded runs must not leak in');
});

test('both table layouts resolve the retro column that belongs to the cycle', () => {
  const all = tables();
  const self = all.find((table) => tableMarker(table) === '🐶')!;
  const partner = all.find((table) => tableMarker(table) === '🐧')!;
  assert.equal(self.layout, 'retro_before_task');
  assert.equal(partner.layout, 'task_before_retro');

  // 🐶: the retro sits one column to the left of its 要务 column.
  assert.deepEqual(findCycleColumns(self, '8.10-8.23'), { taskColumn: 4, retroColumn: 3 });
  // Reading the other side here would hand 8.24-9.6 the 8.10-8.23 retro.
  assert.deepEqual(findCycleColumns(self, '8.24-9.6'), { taskColumn: 2, retroColumn: 1 });

  // 🐧: same document, opposite side.
  assert.deepEqual(findCycleColumns(partner, '8.24-9.6'), { taskColumn: 1, retroColumn: 2 });
  assert.deepEqual(findCycleColumns(partner, '8.10-8.23'), { taskColumn: 3, retroColumn: 4 });
});

test('each cycle gets its own retro, not its neighbour\'s', () => {
  const plans = planFor(standardRuns());
  assert.match(find(plans, 'self', '8.10-8.23').sections.retro || '', /做得好：坚持了两周/);
  assert.equal(find(plans, 'self', '8.24-9.6').sections.retro, undefined, '8.24-9.6 has an empty retro cell');
  assert.match(find(plans, 'partner', '8.24-9.6').sections.retro || '', /伙伴的 8\.24-9\.6 retro/);
  assert.match(find(plans, 'partner', '8.10-8.23').sections.retro || '', /伙伴的 8\.10-8\.23 retro/);
});

test('the 🕙review block is lifted out of the retro cell', () => {
  const split = splitRetroAndReview('状态：还行\n做得好：X\n🕙review\nAI 写的复盘。');
  assert.equal(split.retro, '状态：还行\n做得好：X');
  assert.equal(split.review, 'AI 写的复盘。');
  assert.deepEqual(splitRetroAndReview('只有 retro'), { retro: '只有 retro', review: '' });

  const plans = planFor(standardRuns());
  const retro = find(plans, 'self', '8.10-8.23').sections.retro || '';
  assert.doesNotMatch(retro, /🕙|AI 写的/, 'the review must not be duplicated inside the retro');
});

test('a review is filed under the cycle it reviews, not the cycle it plans', () => {
  const plans = planFor(standardRuns());
  assert.match(find(plans, 'self', '8.10-8.23').sections.review || '', /最终版：关于 8\.10-8\.23 的复盘/);
  assert.equal(find(plans, 'self', '8.24-9.6').sections.review, undefined);
});

test('doc mentions inside a cell keep their words', () => {
  const self = tables().find((table) => tableMarker(table) === '🐶')!;
  assert.equal(self.cells[2][0], '金钱-家庭 CFO。以家庭理财计划为核心。');
});

test('labels become dates and modes, including the year-end wrap', () => {
  assert.equal(startDateForLabel('8.24-9.6', 2026), '2026-08-24');
  assert.equal(startDateForLabel('12.29-1.4', 2026), '2025-12-29', 'a wrapping label starts the year before');
  assert.equal(startDateForLabel('13.1-1.4', 2026), '', 'a nonsense month is not a cycle');
  assert.equal(inferMode('8.24-9.6'), 'biweekly');
  assert.equal(inferMode('6.22-6.28'), 'weekly');
  assert.equal(inferMode('12.29-1.4'), 'weekly', 'the wrap must not be measured as a year');
});

// --- writing -----------------------------------------------------------------

function applyAll(config: AppConfig, plans: CyclePlan[], dryRun: boolean) {
  return plans.map((plan) => applyCyclePlan(config, plan, readCycle(config, plan.id), { dryRun }));
}

test('--dry-run writes nothing at all', () => {
  const vault = tempDir();
  const config = tempConfig(vault);
  const plans = planFor(standardRuns()).filter((plan) => plan.owner === 'self');
  const results = applyAll(config, plans, true);

  assert.ok(results.every((result) => result.status === 'created'));
  assert.ok(results.some((result) => result.written.length > 0), 'dry run still reports the sections it would write');
  assert.equal(fs.existsSync(path.join(vault, '20_CYCLES')), false, 'no file may appear');
});

test('running twice leaves every file byte-identical', () => {
  const vault = tempDir();
  const config = tempConfig(vault);
  const plans = planFor(standardRuns()).filter((plan) => plan.owner === 'self');

  applyAll(config, plans, false);
  const dir = cyclesDir(config);
  const first = fs.readdirSync(dir).sort().map((name) => [name, fs.readFileSync(path.join(dir, name), 'utf8')]);
  assert.ok(first.length >= 2);

  const second = applyAll(config, plans, false);
  assert.ok(second.every((result) => result.status === 'unchanged'), 'a second pass must be a no-op');
  const after = fs.readdirSync(dir).sort().map((name) => [name, fs.readFileSync(path.join(dir, name), 'utf8')]);
  assert.deepEqual(after, first, 'not even updated_at may move');
});

test('a section the user has edited is staged as a draft, not overwritten', () => {
  const vault = tempDir();
  const config = tempConfig(vault);
  const plans = planFor(standardRuns()).filter((plan) => plan.owner === 'self');
  applyAll(config, plans, false);

  const plan = find(plans, 'self', '8.10-8.23');
  writeSection(config, plan.id, 'retro', '我后来手写重排过的 retro', 'user');
  // The review is AI-owned, so it stays migratable; only the retro is frozen.
  writeSection(config, plan.id, 'review', '旧的 review', 'ai');

  const result = applyCyclePlan(config, plan, readCycle(config, plan.id), { dryRun: false });
  // The hand-edited retro is now staged as a pending draft rather than skipped;
  // the AI review is still overwritten.
  assert.deepEqual(result.drafted, ['retro']);
  assert.deepEqual(result.written, ['review']);
  assert.deepEqual(result.skipped, []);
  const doc = readCycle(config, plan.id)!;
  // Body preserved, draft staged with the plan's new content.
  assert.equal(doc.sections.retro?.content, '我后来手写重排过的 retro');
  assert.ok(doc.sections.retro?.pendingDraft, 'retro carries a pending draft');
  assert.notEqual(doc.sections.retro?.pendingDraft?.content, '我后来手写重排过的 retro');
  assert.equal(doc.sections.retro?.pendingDraft?.source, 'user');
  assert.match(doc.sections.review?.content || '', /最终版/);

  // Re-running does not restage the identical draft.
  const rerun = applyCyclePlan(config, plan, readCycle(config, plan.id), { dryRun: false });
  assert.ok(
    rerun.skipped.some((entry) => entry.section === 'retro' && entry.reason === 'draft-unchanged'),
    're-running does not restage the same draft',
  );
  assert.deepEqual(rerun.drafted, [], 'no new draft on a re-run with the same content');
});

test('🐧 cycles never land in this machine\'s vault', () => {
  const vault = tempDir();
  const exportRoot = tempDir();
  const config = tempConfig(vault);
  const partnerConfig: AppConfig = { ...config, memory: { ...config.memory, repository_path: exportRoot } };

  const plans = planFor(standardRuns());
  for (const plan of plans) {
    const target = plan.owner === 'self' ? config : partnerConfig;
    applyCyclePlan(target, plan, readCycle(target, plan.id), { dryRun: false });
  }

  const selfFiles = fs.readdirSync(cyclesDir(config));
  const partnerFiles = fs.readdirSync(cyclesDir(partnerConfig));
  assert.ok(partnerFiles.length > 0, 'the export must actually receive the partner history');
  for (const name of selfFiles) {
    const body = fs.readFileSync(path.join(cyclesDir(config), name), 'utf8');
    assert.doesNotMatch(body, /伙伴/, `${name} contains partner content`);
  }
  // Same labels on both sides: the two directories are what keeps them apart.
  assert.ok(selfFiles.includes('2026-08-24_8.24-9.6.md'));
  assert.ok(partnerFiles.includes('2026-08-24_8.24-9.6.md'));
});

async function main(): Promise<void> {
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

void main();
