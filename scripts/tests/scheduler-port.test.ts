/**
 * LEO-212 SchedulerPort tests — dual-driver + driver selection.
 *
 * Independent, dependency-free runner (run with: `tsx scripts/tests/scheduler-port.test.ts`).
 *
 * Covers, without touching the real repo (each case runs in a throwaway workdir
 * so scheduler-state.json + lock files stay isolated):
 *   - LoopDriver fires a due workflow exactly once and never re-fires (dedupe).
 *   - LoopDriver skips a workflow whose per-run lock is already held.
 *   - LoopDriver.stop() halts the interval (no further ticks).
 *   - resolveSchedulerDriver / isContainer: auto vs darwin vs container vs override.
 *   - createScheduler wires the resolved driver and listJobs reflects config.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { AppConfig, WorkflowName } from '../../src/config/schema.js';
import { acquireSchedulerLock, createSchedulerState, releaseSchedulerLock, runSchedulerTick } from '../../src/service/launchd.js';
import {
  LoopDriver,
  createScheduler,
  isContainer,
  listSchedulerJobs,
  resolveSchedulerDriver,
} from '../../src/service/scheduler-port.js';

type TestFn = () => void | Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];
function test(name: string, fn: TestFn): void {
  tests.push({ name, fn });
}

// Minimal config that only fills the fields the tick + port actually read. The
// three side-effecting sub-features (progress reminder, background suggestions,
// Feishu feedback polling) are disabled so a tick reduces to the workflow loop.
const config = {
  user: { timezone: 'America/Toronto' },
  workflows: {
    daily_plan: { enabled: true, time: '08:00' },
    daily_review: { enabled: false, time: '21:30', skip_on_weekly_review_day: true },
    weekly_review: { enabled: false, time: '20:00', weekday: 'SUN' },
  },
  progress: { enabled: false },
  background_suggestions: { enabled: false },
  feedback: { feishu: { enabled: false } },
  scheduler: { driver: 'auto' },
} as unknown as AppConfig;

const BEFORE_DUE = new Date('2026-07-17T07:00:00-04:00'); // 07:00 Toronto — before 08:00
const AFTER_DUE = new Date('2026-07-17T08:05:00-04:00'); // 08:05 Toronto — daily_plan due
const DAILY_PLAN_KEY = '2026-07-17:daily_plan:08:00';

// --- a plan made the evening before is kept ---------------------------------

test('the morning daily_plan keeps a plan already made for the day (the evening before)', async () => {
  await withTmpWorkdir(async () => {
    const calls: WorkflowName[] = [];
    const runWorkflow = async (_c: AppConfig, workflow: WorkflowName): Promise<string> => {
      calls.push(workflow);
      return 'ok';
    };
    const kept = createSchedulerState();
    await runSchedulerTick(config, kept, { now: () => AFTER_DUE, runWorkflow, hasPlanFor: () => true });
    assert.deepEqual(calls, [], 'a plan exists: not replaced');
    assert.ok(kept.fired.has(DAILY_PLAN_KEY), 'and not retried every minute');
    await runSchedulerTick(config, createSchedulerState(), { now: () => AFTER_DUE, runWorkflow, hasPlanFor: () => false });
    assert.deepEqual(calls, ['daily_plan'], 'no plan yet: the morning run makes one');
  });
});

// --- LoopDriver: fire once, no repeat --------------------------------------

test('LoopDriver fires a due workflow exactly once and dedupes on repeat ticks', async () => {
  await withTmpWorkdir(async () => {
    const calls: WorkflowName[] = [];
    const runWorkflow = async (_c: AppConfig, workflow: WorkflowName): Promise<string> => {
      calls.push(workflow);
      return 'ok';
    };
    let current = BEFORE_DUE;
    const driver = new LoopDriver(config, { now: () => current, runWorkflow, intervalMs: 10_000 });

    await driver.tick();
    assert.equal(calls.length, 0, 'not yet due at 07:00');

    current = AFTER_DUE;
    await driver.tick();
    assert.deepEqual(calls, ['daily_plan'], 'fires once when due');

    await driver.tick();
    assert.deepEqual(calls, ['daily_plan'], 'does not re-fire the same slot');
  });
});

// --- LoopDriver: lock held -> skip -----------------------------------------

test('LoopDriver skips a workflow whose per-run lock is already held', async () => {
  await withTmpWorkdir(async () => {
    const calls: WorkflowName[] = [];
    const runWorkflow = async (_c: AppConfig, workflow: WorkflowName): Promise<string> => {
      calls.push(workflow);
      return 'ok';
    };
    const lock = acquireSchedulerLock(DAILY_PLAN_KEY);
    assert.ok(lock, 'pre-acquired the daily_plan lock');

    const driver = new LoopDriver(config, { now: () => AFTER_DUE, runWorkflow });
    await driver.tick();
    assert.equal(calls.length, 0, 'lock held by another runner -> skipped this tick');

    releaseSchedulerLock(lock as string);
  });
});

// --- LoopDriver: stop halts the loop ---------------------------------------

test('LoopDriver.stop() halts the interval so no further ticks run', async () => {
  await withTmpWorkdir(async () => {
    let ticks = 0;
    const now = (): Date => {
      ticks += 1; // now() is called exactly once per tick, before any await
      return BEFORE_DUE; // before due: no workflow side effects
    };
    const driver = new LoopDriver(config, { now, runWorkflow: async () => 'ok', intervalMs: 15 });

    await driver.start(); // awaits the first tick
    await delay(80);
    const whileRunning = ticks;
    assert.ok(whileRunning >= 2, `interval should keep ticking, saw ${whileRunning}`);

    await driver.stop();
    const atStop = ticks;
    await delay(80);
    assert.equal(ticks, atStop, 'no ticks after stop()');
  });
});

// --- LoopDriver: clock rollback + cross-day boundary -----------------------

test('LoopDriver: a same-day clock rollback never re-fires, but the next day does', async () => {
  await withTmpWorkdir(async () => {
    const calls: Array<{ workflow: WorkflowName; date: Date }> = [];
    let current = AFTER_DUE; // 2026-07-17 08:05 Toronto
    const driver = new LoopDriver(config, {
      now: () => current,
      runWorkflow: async (_c, workflow) => {
        calls.push({ workflow, date: current });
        return 'ok';
      },
      intervalMs: 10_000,
    });

    await driver.tick();
    assert.equal(calls.length, 1, 'fires once when first due at 08:05');

    // System clock jumps backward to 07:00 the same day (NTP correction / DST).
    // The 08:00 slot for 2026-07-17 already fired -> must not re-fire.
    current = new Date('2026-07-17T07:00:00-04:00');
    await driver.tick();
    assert.equal(calls.length, 1, 'clock rollback before the slot does not re-fire it');

    // Clock jumps forward again past the slot on the same day -> still deduped.
    current = new Date('2026-07-17T09:30:00-04:00');
    await driver.tick();
    assert.equal(calls.length, 1, 'same-day re-cross of the slot stays deduped');

    // The next calendar day crosses a fresh slot key -> fires exactly once.
    current = new Date('2026-07-18T08:05:00-04:00');
    await driver.tick();
    assert.equal(calls.length, 2, 'the next day fires a new slot');
    await driver.tick();
    assert.equal(calls.length, 2, 'and dedupes the new day too');
  });
});

test('LoopDriver.stop() is idempotent and leaves no live timer', async () => {
  await withTmpWorkdir(async () => {
    let ticks = 0;
    const driver = new LoopDriver(config, {
      now: () => {
        ticks += 1;
        return BEFORE_DUE;
      },
      runWorkflow: async () => 'ok',
      intervalMs: 15,
    });
    await driver.start();
    await driver.stop();
    await driver.stop(); // double stop must not throw
    const atStop = ticks;
    await delay(60);
    assert.equal(ticks, atStop, 'no ticks after a double stop');
  });
});

// --- driver selection ------------------------------------------------------

test('resolveSchedulerDriver: auto resolves loop off-darwin, launchd on a darwin host', () => {
  assert.equal(resolveSchedulerDriver(config, {}, 'linux'), 'loop');
  assert.equal(resolveSchedulerDriver(config, {}, 'darwin'), 'launchd');
});

test('resolveSchedulerDriver: container forces loop even on darwin, env var overrides both', () => {
  assert.equal(resolveSchedulerDriver(config, { DAILY_OS_IN_CONTAINER: '1' }, 'darwin'), 'loop');
  assert.equal(resolveSchedulerDriver(config, { container: 'podman' }, 'darwin'), 'loop');
  assert.equal(resolveSchedulerDriver(config, { DAILY_OS_SCHEDULER: 'launchd' }, 'linux'), 'launchd');
  assert.equal(resolveSchedulerDriver(config, { DAILY_OS_SCHEDULER: 'loop' }, 'darwin'), 'loop');
});

test('isContainer honors explicit env markers', () => {
  assert.equal(isContainer({ DAILY_OS_IN_CONTAINER: '1' }), true);
  assert.equal(isContainer({ container: 'docker' }), true);
  assert.equal(isContainer({}), false); // sandbox has no /.dockerenv
});

// --- createScheduler + listJobs --------------------------------------------

test('createScheduler wires the resolved driver and honors a forced driver', () => {
  assert.equal(createScheduler(config, { platform: 'linux', env: {} }).driver, 'loop');
  assert.equal(createScheduler(config, { platform: 'darwin', env: {} }).driver, 'launchd');
  assert.equal(createScheduler(config, { driver: 'loop', platform: 'darwin', env: {} }).driver, 'loop');
});

test('listSchedulerJobs mirrors the configured workflow schedule', () => {
  const jobs = listSchedulerJobs(config);
  assert.deepEqual(
    jobs.map((j) => [j.workflow, j.time, j.enabled]),
    [
      ['daily_plan', '08:00', true],
      ['daily_review', '21:30', false],
      ['weekly_review', '20:00', false],
    ],
  );
  assert.equal(jobs[2].weekday, 'SUN');
});

// --- helpers ---------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTmpWorkdir(fn: () => void | Promise<void>): Promise<void> {
  const cwd = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-port-'));
  fs.mkdirSync(path.join(dir, 'data', 'memory'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'data', 'runtime'), { recursive: true });
  process.chdir(dir);
  try {
    await fn();
  } finally {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

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
      console.error(`    ${error instanceof Error ? error.stack || error.message : String(error)}`);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

void run();
