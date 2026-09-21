/**
 * The user's ordering of today's plan, laid back over the model's.
 *
 * Independent, tsx-runnable:  npx tsx scripts/tests/plan-order.test.ts
 *
 * Worth testing as a pure function rather than through the endpoint, because
 * every interesting case is a *disagreement* between two lists that were
 * written at different times — the ledger says where five rows go, and the plan
 * on disk has since gained a sixth, lost one, or been rerun entirely. Those are
 * ordinary days, not edge cases, and none of them are visible in a test that
 * reorders a list and reads it straight back.
 *
 * The property that matters most: `rank` is half the ledger key every client
 * sends back with complete / defer / update. If two rows come out claiming the
 * same rank, two different rows write to the same ledger slot.
 *
 * The second half of the file (LEO-309) is about *which* plan the snapshot is
 * built from, which turned out to be a different question from where its rows
 * sit — and one that only has a wrong answer after 21:30.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { AppConfig } from '../../src/config/schema.js';
import { writeLatestWorkflowOutput, writeWorkflowDetailCache } from '../../src/storage/memory.js';
import { recordTodoFeedback } from '../../src/todo/feedback.js';
import { buildTodayPlanSnapshot } from '../../src/todo/today-plan.js';
import { renderPlatformPage, type PageContext } from '../../src/ui/pages.js';
import { applyUserOrder } from '../../src/ui/server.js';
import { addDays, todayInTimezone } from '../../src/utils/date.js';
import type { DailyPlanTodo } from '../../src/workflows/summary.js';

type TestFn = () => void;
const tests: Array<{ name: string; fn: TestFn }> = [];
function test(name: string, fn: TestFn): void {
  tests.push({ name, fn });
}

/** The shape `extractDailyPlanTodos` produces: ranked 1..n, in model order. */
function plan(...ids: string[]): DailyPlanTodo[] {
  return ids.map((candidateId, index) => ({ rank: index + 1, text: `任务 ${candidateId}`, candidateId }));
}

function order(todos: DailyPlanTodo[]): string[] {
  return todos.map((todo) => todo.candidateId);
}

test('with nothing recorded, the model order is untouched', () => {
  const todos = plan('a', 'b', 'c');
  assert.deepEqual(order(applyUserOrder(todos, new Map())), ['a', 'b', 'c']);
});

test('a recorded order wins over the model order', () => {
  const todos = plan('a', 'b', 'c');
  const userRank = new Map([['c', 1], ['a', 2], ['b', 3]]);
  assert.deepEqual(order(applyUserOrder(todos, userRank)), ['c', 'a', 'b']);
});

test('rank is rewritten to 1..n, so no two rows share a ledger key', () => {
  const todos = plan('a', 'b', 'c');
  const result = applyUserOrder(todos, new Map([['c', 1], ['a', 2], ['b', 3]]));
  assert.deepEqual(result.map((todo) => todo.rank), [1, 2, 3]);
});

// A rerun between the reorder and the read is the common way this happens: the
// ledger knows nothing about the new row. Falling back to its model rank keeps
// it next to the row the model put it next to — here it followed `b`, and it
// still follows `b` — which beats both dropping it and pinning it to the top.
test('a row the ledger has never seen lands beside where the model put it', () => {
  const todos = plan('a', 'b', 'new', 'c');
  // The user moved c to the front, back when the plan was a/b/c.
  const userRank = new Map([['c', 1], ['a', 2], ['b', 3]]);
  assert.deepEqual(order(applyUserOrder(todos, userRank)), ['c', 'a', 'b', 'new']);
});

test('a recorded row that is no longer in the plan is simply absent', () => {
  const todos = plan('a', 'c');
  const userRank = new Map([['c', 1], ['a', 2], ['b', 3]]);
  const result = applyUserOrder(todos, userRank);
  assert.deepEqual(order(result), ['c', 'a']);
  assert.deepEqual(result.map((todo) => todo.rank), [1, 2]);
});

// Two entries can collide when a new row's model rank equals a recorded rank.
// Without a tie-break the sort is free to swap them on every read, and a list
// that reshuffles when nothing happened is worse than one in the wrong order.
test('ties keep arrival order rather than shuffling between reads', () => {
  const todos = plan('a', 'b', 'c');
  const userRank = new Map([['c', 2]]);
  const once = order(applyUserOrder(todos, userRank));
  const twice = order(applyUserOrder(todos, userRank));
  assert.deepEqual(once, twice);
  assert.deepEqual(once, ['a', 'b', 'c']);
});

test('estimates and text survive the reorder', () => {
  const todos: DailyPlanTodo[] = [
    { rank: 1, text: '写 PR', candidateId: 'a', minutes: 45 },
    { rank: 2, text: '看论文', candidateId: 'b' },
  ];
  const result = applyUserOrder(todos, new Map([['b', 1], ['a', 2]]));
  assert.deepEqual(result, [
    { rank: 1, text: '看论文', candidateId: 'b' },
    { rank: 2, text: '写 PR', candidateId: 'a', minutes: 45 },
  ]);
});

// --- LEO-309: which plan the snapshot is built from --------------------------
//
// `_latest-workflow.json` keeps only the last workflow to finish. The evening
// daily_review overwrote the morning's plan, and the snapshot — which had asked
// that file "are you a daily_plan?" — went null: the Today page claimed there
// was no plan, and team sync pushed no `daily_plans` row for the whole evening,
// which is exactly when a teammate opens it.
//
// Driven against real files rather than a stubbed reader, because the defect
// lives in the *layout* of what is on disk (one overwritten pointer, one
// append-only cache of every run) and a stub would just re-assert my reading
// of it.

/** America/Toronto: the user's zone, and one where UTC is already tomorrow at 21:30. */
const TIMEZONE = 'America/Toronto';

function planContent(...ids: string[]): string {
  return JSON.stringify({ todos: ids.map((candidateId, index) => ({ rank: index + 1, text: `任务 ${candidateId}`, candidateId })) });
}

/**
 * Two outputs written inside the same millisecond carry the same `generated_at`,
 * which is the only ordering the detail cache has. Spin past the boundary so a
 * rerun is genuinely newer than the plan it replaces.
 */
function nextMillisecond(): void {
  const start = Date.now();
  while (Date.now() === start) {
    /* spin */
  }
}

/** Record a finished run exactly the way `runWorkflow` does: pointer, then cache. */
function runWorkflowOutput(config: AppConfig, workflow: 'daily_plan' | 'daily_review', date: string, content: string): void {
  writeLatestWorkflowOutput(config, workflow, date, content);
  writeWorkflowDetailCache(config, workflow, date, content);
}

function withSnapshotWorkdir(fn: (config: AppConfig, today: string) => void): void {
  const cwd = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'today-plan-'));
  // The todo-feedback ledger resolves against the working directory, not config.
  fs.mkdirSync(path.join(dir, 'data', 'runtime'), { recursive: true });
  process.chdir(dir);
  const config = {
    user: { timezone: TIMEZONE },
    memory: { daily_dir: path.join(dir, 'data', 'memory', 'daily') },
    // Only reached by the Today page renderer, to build Linear issue links.
    sources: { linear: { workspace: '' } },
  } as unknown as AppConfig;
  try {
    fn(config, todayInTimezone(config));
  } finally {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('THE REGRESSION: the evening review does not take today’s plan with it', () => {
  withSnapshotWorkdir((config, today) => {
    runWorkflowOutput(config, 'daily_plan', today, planContent('a', 'b'));
    runWorkflowOutput(config, 'daily_review', today, '今天完成了 a，b 顺延。');

    const snapshot = buildTodayPlanSnapshot(config);
    assert.ok(snapshot, 'the plan must survive a later workflow overwriting the latest-output pointer');
    assert.equal(snapshot.date, today);
    assert.deepEqual(order(snapshot.todos), ['a', 'b']);
  });
});

test('feedback ticked after the review still reaches the snapshot', () => {
  withSnapshotWorkdir((config, today) => {
    runWorkflowOutput(config, 'daily_plan', today, planContent('a', 'b'));
    runWorkflowOutput(config, 'daily_review', today, '今天完成了 a，b 顺延。');
    recordTodoFeedback(config, { date: today, event: 'complete', candidateId: 'a', rank: 1 });
    recordTodoFeedback(config, { date: today, event: 'defer', candidateId: 'b', rank: 2 });

    const snapshot = buildTodayPlanSnapshot(config);
    assert.ok(snapshot);
    assert.deepEqual(snapshot.feedback, { a: 'complete', b: 'defer' });
  });
});

test('a day that never ran a plan has no snapshot, review or not', () => {
  withSnapshotWorkdir((config, today) => {
    runWorkflowOutput(config, 'daily_review', today, '今天没有计划，随手做了点杂事。');
    assert.equal(buildTodayPlanSnapshot(config), null);
  });
});

// The fallback looks up a *date*, so the hazard it introduces is reaching one
// day too far back — which is worse than the bug it fixes, because yesterday's
// plan shown as today's is how someone works a day behind without noticing.
test('yesterday’s plan is not today’s, even when today ran nothing else', () => {
  withSnapshotWorkdir((config, today) => {
    runWorkflowOutput(config, 'daily_plan', addDays(today, -1), planContent('old'));
    assert.equal(buildTodayPlanSnapshot(config), null);
  });
});

test('yesterday’s plan is not today’s, with today’s review on top of it', () => {
  withSnapshotWorkdir((config, today) => {
    runWorkflowOutput(config, 'daily_plan', addDays(today, -1), planContent('old'));
    runWorkflowOutput(config, 'daily_review', today, '今天没跑 plan。');
    assert.equal(buildTodayPlanSnapshot(config), null);
  });
});

// Two plans in one day is an ordinary rerun ("this list is wrong, run it again").
// Once the review has overwritten the pointer, `generated_at` is the only thing
// left that says which of the two the user is looking at.
test('a rerun supersedes the earlier plan, still true after the review', () => {
  withSnapshotWorkdir((config, today) => {
    runWorkflowOutput(config, 'daily_plan', today, planContent('a', 'b'));
    nextMillisecond();
    runWorkflowOutput(config, 'daily_plan', today, planContent('c'));
    runWorkflowOutput(config, 'daily_review', today, '今天完成了 c。');

    const snapshot = buildTodayPlanSnapshot(config);
    assert.ok(snapshot);
    assert.deepEqual(order(snapshot.todos), ['c']);
  });
});

// The reorder overlay and the fallback lookup are independent, and the ledger
// has to survive the trip through the cache copy rather than only the pointer.
test('the user’s own order survives the review overwrite too', () => {
  withSnapshotWorkdir((config, today) => {
    runWorkflowOutput(config, 'daily_plan', today, planContent('a', 'b', 'c'));
    for (const [rank, candidateId] of ['c', 'a', 'b'].entries()) {
      recordTodoFeedback(config, { date: today, event: 'reorder', candidateId, rank: rank + 1 });
    }
    runWorkflowOutput(config, 'daily_review', today, '今天完成了 c。');

    const snapshot = buildTodayPlanSnapshot(config);
    assert.ok(snapshot);
    assert.deepEqual(order(snapshot.todos), ['c', 'a', 'b']);
  });
});

// --- LEO-309, the symptom the issue actually opened with ---------------------
//
// The sentence quoted in 「现象」 is printed by `renderPlanColumn`, which made its
// own read of `_latest-workflow.json` — so fixing the snapshot fixed the Mac app
// and the teammate view and left the web console still saying there was no plan
// all evening. Asserted on rendered HTML, because "the snapshot is right" and
// "the page shows it" turned out to be two different facts.

function pageContext(config: AppConfig): PageContext {
  return { config, role: 'admin', username: 'leon', email: '', avatarSeed: '', url: new URL('http://localhost/today') };
}

/** The rows as the page prints them, in render order. */
function renderedOrder(html: string): string[] {
  return [...html.matchAll(/任务 (\w+)</g)].map((match) => match[1]);
}

test('THE REGRESSION on the page: Today still renders the plan after the review', () => {
  withSnapshotWorkdir((config, today) => {
    runWorkflowOutput(config, 'daily_plan', today, planContent('a', 'b'));
    runWorkflowOutput(config, 'daily_review', today, '今天完成了 a，b 顺延。');

    const html = renderPlatformPage('/today', pageContext(config));
    assert.ok(!html.includes('还没有今日 plan'), 'the Today page must not claim the plan was never generated');
    assert.deepEqual(renderedOrder(html), ['a', 'b']);
  });
});

test('and the page shows the same order the API and the teammate see', () => {
  withSnapshotWorkdir((config, today) => {
    runWorkflowOutput(config, 'daily_plan', today, planContent('a', 'b', 'c'));
    for (const [rank, candidateId] of ['c', 'a', 'b'].entries()) {
      recordTodoFeedback(config, { date: today, event: 'reorder', candidateId, rank: rank + 1 });
    }
    runWorkflowOutput(config, 'daily_review', today, '今天完成了 c。');

    assert.deepEqual(renderedOrder(renderPlatformPage('/today', pageContext(config))), ['c', 'a', 'b']);
  });
});

export function testPlanOrder(): void {
  for (const { name, fn } of tests) {
    fn();
    console.log(`  PASS  ${name}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  testPlanOrder();
  console.log(`\n${tests.length} passed.`);
}
