/**
 * Retro review write-back wiring.
 *
 * Independent, tsx-runnable:  npx tsx scripts/tests/retro-review-writeback.test.ts
 *
 * The retro review (engine/04-write.md Step 4.5) shipped in life-review-os #12
 * and had never written a single one to Feishu. Two independent gates: the CLI
 * marked it not-ready, and nothing here ever called `write-review` — a grep for
 * it across src/ returned zero hits. This locks down the second gate.
 */
import assert from 'node:assert/strict';

import { formatRetroReviewOutcome, type LifeReviewOsReviewResult } from '../../src/skills/life-review-os.js';

type TestFn = () => void | Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];
function test(name: string, fn: TestFn): void {
  tests.push({ name, fn });
}

const WRITTEN: LifeReviewOsReviewResult = {
  written: true,
  alreadyWritten: false,
  retroHeader: '8.24-9.6 retro',
  targetRow: 2,
  chars: 286,
};

test('a written review reports where it landed', () => {
  const line = formatRetroReviewOutcome(WRITTEN);
  assert.match(line, /8\.24-9\.6 retro/);
  assert.match(line, /第 2 行/);
  assert.match(line, /286 字/);
});

test('an already-written review is reported as skipped, not as a fresh write', () => {
  const line = formatRetroReviewOutcome({ ...WRITTEN, written: false, alreadyWritten: true });
  assert.match(line, /已存在/);
  assert.ok(!/已写入/.test(line), 'must not claim it wrote something');
});

test('a failed review says so instead of silently vanishing', () => {
  const line = formatRetroReviewOutcome({ ...WRITTEN, written: false, error: 'Could not locate a "retro" column adjacent to "8.24-9.6 要务".' });
  assert.match(line, /未写入/);
  assert.match(line, /adjacent to/);
});

test('an older CLI without write-review produces no line rather than a false claim', () => {
  assert.equal(formatRetroReviewOutcome(undefined), '');
});

test('a review that neither wrote nor errored is still reported', () => {
  // Guards against an outcome that reads as success because the line is empty.
  assert.match(formatRetroReviewOutcome({ ...WRITTEN, written: false }), /未写入/);
});

/**
 * Behaviour, driven through a stub CLI rather than asserted against source.
 *
 * The important property: the priorities are already in the document by the
 * time the review runs, and there is no rollback. A review failure must degrade
 * to a note on an otherwise successful write-back, never throw — throwing would
 * report a success as a failure and invite a duplicate retry.
 */
async function withStubCli(reviewBehaviour: 'ok' | 'fail', fn: () => Promise<void>): Promise<void> {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const yaml = (await import('js-yaml')).default;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retro-review-'));
  const cli = path.join(dir, 'fake-life-review-os.mjs');
  fs.writeFileSync(
    cli,
    [
      'const args = process.argv.slice(2);',
      'if (args[0] === "writeback") {',
      '  console.log(JSON.stringify({ ok: true, task_header: "8.24-9.6 要务", item_count: 13, skipped_count: 0, inserted_columns: true }));',
      '  process.exit(0);',
      '}',
      'if (args[0] === "write-review") {',
      reviewBehaviour === 'ok'
        ? '  console.log(JSON.stringify({ ok: true, written: true, already_written: false, retro_header: "8.24-9.6 retro", target_row: 2, chars: 286 }));\n  process.exit(0);'
        : '  console.log(JSON.stringify({ ok: false, error: "Could not locate a \\"retro\\" column adjacent to \\"8.24-9.6 要务\\"." }));\n  process.exit(1);',
      '}',
      'process.exit(9);',
    ].join('\n'),
  );

  const parsed = yaml.load(fs.readFileSync('config/config.example.yaml', 'utf8')) as Record<string, any>;
  parsed.skills.enabled = true;
  // This suite exercises the Feishu retro-review write-back, which now defaults
  // off (skills.feishu_writeback); opt in so the write path is reached.
  parsed.skills.feishu_writeback = true;
  parsed.skills.registry[0].workdir = dir;
  parsed.skills.registry[0].path = path.join(dir, 'SKILL.md');
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '# stub');

  const { AppConfigSchema } = await import('../../src/config/schema.js');
  const config = AppConfigSchema.parse(parsed);

  const previous = process.env.LIFE_REVIEW_OS_CLI;
  process.env.LIFE_REVIEW_OS_CLI = cli;
  try {
    (globalThis as Record<string, unknown>).__stubConfig = config;
    await fn();
  } finally {
    if (previous === undefined) delete process.env.LIFE_REVIEW_OS_CLI;
    else process.env.LIFE_REVIEW_OS_CLI = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('writing the priorities does NOT also write the review', async () => {
  // They are two writes into two different cells, so they are two decisions.
  // Chaining them meant one confirmation covered both, and the review was never
  // shown before it happened.
  await withStubCli('ok', async () => {
    const { executeLifeReviewOsWriteback } = await import('../../src/skills/life-review-os.js');
    const config = (globalThis as Record<string, any>).__stubConfig;
    const result = await executeLifeReviewOsWriteback(config, 'weekly-review', 'run-1');
    assert.equal(result.itemCount, 13);
    assert.equal(result.review, undefined, 'the review must not ride along');
  });
});

test('the review is written by its own call', async () => {
  await withStubCli('ok', async () => {
    const { executeLifeReviewOsRetroReview } = await import('../../src/skills/life-review-os.js');
    const config = (globalThis as Record<string, any>).__stubConfig;
    const review = await executeLifeReviewOsRetroReview(config, 'weekly-review', 'run-1');
    assert.equal(review.written, true);
    assert.equal(review.retroHeader, '8.24-9.6 retro');
    assert.equal(review.targetRow, 2);
  });
});

test('a failing review reports instead of throwing — the priorities are untouched by it', async () => {
  await withStubCli('fail', async () => {
    const { executeLifeReviewOsRetroReview } = await import('../../src/skills/life-review-os.js');
    const config = (globalThis as Record<string, any>).__stubConfig;
    const review = await executeLifeReviewOsRetroReview(config, 'weekly-review', 'run-1');
    assert.equal(review.written, false);
    assert.match(review.error || '', /adjacent to/);
    assert.match(formatRetroReviewOutcome(review), /未写入/);
  });
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
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

void run();
