/**
 * `partial` — "I worked on this, it is not finished."
 *
 * Independent, tsx-runnable:  npx tsx scripts/tests/partial-progress.test.ts
 *
 * ## Why this state exists
 *
 * A plan row had two ways out: `complete` or `defer`. Half-finished work — by
 * far the most common outcome of a real day — had to be filed as one of them,
 * and both lose something specific:
 *
 *   - `complete` is **terminal**. `getCompletedCandidateIds` excludes the id
 *     from every future plan, so an unfinished task ticked "done enough" is
 *     never proposed again.
 *   - `defer` says the day's work never happened, and feeds the carry-over
 *     streak that the scorer reads as "you keep putting this off".
 *
 * ## The four places that silently swallowed it
 *
 * Adding a case to the union is the easy part. The event travels through four
 * filters that each enumerate the events they care about, and every one of them
 * would have dropped `partial` on the floor without saying so:
 *
 *   1. the `/api/today/todo-feedback` gate — rejects unknown events by name
 *   2. `readTodayPlan`'s feedback map — what the Mac client reads state back from
 *   3. `run-workflow`'s daily_review evidence filter — the row would reach the
 *      evening review looking untouched
 *   4. `selectCarryOverCandidateIds` — `open`-only, so a partial row could never
 *      be carried to tomorrow
 *
 * Each of those is a silent drop, which is why they are tested by name here
 * rather than through one end-to-end case that would pass with three of the four
 * still broken.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { AppConfig } from '../../src/config/schema.js';
import {
  getCarryOverDaysById,
  getCompletedCandidateIds,
  getAdoptionStats,
  listTodoFeedback,
  recordTodoFeedback,
  recordTodoPresented,
} from '../../src/todo/feedback.js';
import { selectCarryOverCandidateIds, type DailyReviewReconciliation } from '../../src/workflows/summary.js';

type TestFn = () => void;
const tests: Array<{ name: string; fn: TestFn }> = [];
function test(name: string, fn: TestFn): void {
  tests.push({ name, fn });
}

const config = {} as AppConfig;
const DATE = '2026-09-17';

function withTmpWorkdir(fn: () => void): void {
  const cwd = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'partial-progress-'));
  fs.mkdirSync(path.join(dir, 'data', 'runtime'), { recursive: true });
  process.chdir(dir);
  try {
    fn();
  } finally {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// --- the ledger -------------------------------------------------------------

test('a partial row is NOT treated as completed, so it can be planned again tomorrow', () => {
  withTmpWorkdir(() => {
    recordTodoFeedback(config, { date: DATE, event: 'partial', candidateId: 'linear:CUTTO-1', rank: 1 });
    assert.equal(getCompletedCandidateIds(config).has('linear:CUTTO-1'), false);
  });
});

test('THE CORRECTION: complete then partial clears the completion', () => {
  withTmpWorkdir(() => {
    // Ticking a row and then downgrading it is the case that makes `partial`
    // worth having at all — and the one that would quietly strand a task
    // forever if `getCompletedCandidateIds` only cleared on `reopen`. The user
    // believes they have marked it unfinished; the planner has to agree.
    recordTodoFeedback(config, { date: DATE, event: 'complete', candidateId: 'linear:CUTTO-1', rank: 1 });
    assert.equal(getCompletedCandidateIds(config).has('linear:CUTTO-1'), true);

    recordTodoFeedback(config, { date: DATE, event: 'partial', candidateId: 'linear:CUTTO-1', rank: 1 });
    assert.equal(getCompletedCandidateIds(config).has('linear:CUTTO-1'), false);
  });
});

test('partial then complete still ends up complete — order wins, not precedence', () => {
  withTmpWorkdir(() => {
    recordTodoFeedback(config, { date: DATE, event: 'partial', candidateId: 'linear:CUTTO-1', rank: 1 });
    recordTodoFeedback(config, { date: DATE, event: 'complete', candidateId: 'linear:CUTTO-1', rank: 1 });
    assert.equal(getCompletedCandidateIds(config).has('linear:CUTTO-1'), true);
  });
});

test('partial does not create a carry-over streak by itself', () => {
  withTmpWorkdir(() => {
    // `carry_over` is written by the evening review, deliberately. Making
    // `partial` imply it would double-count: the review would then add its own
    // entry for the same day and the scorer would read two days of deferral out
    // of one afternoon's work.
    recordTodoFeedback(config, { date: DATE, event: 'partial', candidateId: 'linear:CUTTO-1', rank: 1 });
    assert.equal(getCarryOverDaysById(config).size, 0);
  });
});

test('partial does not inflate the adoption rate', () => {
  withTmpWorkdir(() => {
    // Adoption measures how often a surfaced todo actually gets *finished*.
    // Counting half-done work would make the scorer look better than it is at
    // exactly the moment it should be learning something.
    recordTodoPresented(config, DATE, [{ candidateId: 'c1', rank: 1 }, { candidateId: 'c2', rank: 2 }]);
    recordTodoFeedback(config, { date: DATE, event: 'complete', candidateId: 'c1', rank: 1 });
    recordTodoFeedback(config, { date: DATE, event: 'partial', candidateId: 'c2', rank: 2 });

    const stats = getAdoptionStats(config);
    assert.equal(stats.top3Presented, 2);
    assert.equal(stats.top3Completed, 1, 'only c1 was finished');
  });
});

test('a partial entry round-trips through the ledger intact', () => {
  withTmpWorkdir(() => {
    recordTodoFeedback(config, {
      date: DATE,
      event: 'partial',
      candidateId: 'linear:CUTTO-1',
      rank: 2,
      source: 'macos-today',
      note: '写完了交互，UI 还没画',
    });
    const [entry] = listTodoFeedback(config);
    assert.equal(entry?.event, 'partial');
    assert.equal(entry?.rank, 2);
    assert.equal(entry?.note, '写完了交互，UI 还没画');
  });
});

// --- carry-over -------------------------------------------------------------

function recon(items: Array<{ id: string; status: string }>, carryOver: string[]): DailyReviewReconciliation {
  return {
    reconciliation: items.map((item) => ({
      candidateId: item.id,
      text: item.id,
      status: item.status as never,
      evidence: '',
    })),
    carryOver,
  } as DailyReviewReconciliation;
}

test('THE DROP: a progressed row can now be carried to tomorrow', () => {
  // Before this change the filter was `open`-only. A row the user marked
  // `partial` is *required* to reconcile as `progressed`, so every single one of
  // them would have been silently removed from the carry-over list — the state
  // would have shipped losing precisely the work it was added to record.
  const ids = selectCarryOverCandidateIds(recon([{ id: 'a', status: 'progressed' }], ['a']));
  assert.deepEqual(ids, ['a']);
});

test('an open row still carries over', () => {
  assert.deepEqual(selectCarryOverCandidateIds(recon([{ id: 'a', status: 'open' }], ['a'])), ['a']);
});

test('a done row still cannot be carried — the guard that matters is intact', () => {
  // This is the whole reason the filter exists: the model must not report
  // something finished and also ask to keep it for tomorrow.
  assert.deepEqual(selectCarryOverCandidateIds(recon([{ id: 'a', status: 'done' }], ['a'])), []);
});

test('an id the model never reconciled is not carried', () => {
  assert.deepEqual(selectCarryOverCandidateIds(recon([{ id: 'a', status: 'open' }], ['ghost'])), []);
});

// --- the prompt contract ----------------------------------------------------

test('the review prompt tells the model what partial means and where it must land', () => {
  // The evidence now carries `partial` entries; a prompt that never mentions
  // them leaves the model to invent a mapping, and the one it invents will not
  // be the one `selectCarryOverCandidateIds` was built around.
  const prompt = fs.readFileSync(path.join(process.cwd(), 'prompts', 'daily_review.md'), 'utf8');
  assert.match(prompt, /`partial`/, 'the event has to be named');
  assert.match(prompt, /`partial` 的 `candidateId`，其 `status` 必须为 `progressed`/);
  assert.match(prompt, /`open` 或 `progressed`/, 'carry-over must no longer say open-only');
});

function run(): void {
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
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run();
