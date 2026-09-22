/**
 * runCommand timeout reporting.
 *
 * Independent, tsx-runnable:  npx tsx scripts/tests/command-timeout.test.ts
 *
 * A SIGTERMed child writes nothing on its way out, so a timeout used to resolve
 * with code null and two empty streams — indistinguishable from a silent crash.
 * That is how a killed life-review-os run reached the user as a failure with no
 * stated cause.
 */
import assert from 'node:assert/strict';

import { runCommand } from '../../src/utils/command.js';

type TestFn = () => Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];
function test(name: string, fn: TestFn): void {
  tests.push({ name, fn });
}

test('a timed-out command is flagged and says so in stderr', async () => {
  const result = await runCommand('node', ['-e', 'setTimeout(() => {}, 10000)'], { timeoutMs: 300 });
  assert.equal(result.timedOut, true);
  assert.equal(result.ok, false);
  assert.equal(result.timeoutKind, 'total');
  assert.match(result.stderr, /\[timeout\] killed by total timeout \(SIGTERM\)/);
});

test('a silent command is killed by the idle timeout', async () => {
  // Emits nothing, then sleeps well past the idle window — the hang case.
  const result = await runCommand('node', ['-e', 'setTimeout(() => {}, 10000)'], { idleTimeoutMs: 300 });
  assert.equal(result.timedOut, true);
  assert.equal(result.timeoutKind, 'idle');
  assert.match(result.stderr, /\[timeout\] killed by idle timeout \(SIGTERM\)/);
});

test('a command that keeps streaming is NOT killed by the idle timeout', async () => {
  // A heartbeat every 100ms for ~800ms, total far past the 300ms idle window:
  // each write resets the timer, so a slow-but-working run survives.
  const script =
    'let n=0;const t=setInterval(()=>{process.stdout.write("beat ");if(++n>=8){clearInterval(t);process.exit(0);}},100);';
  const result = await runCommand('node', ['-e', script], { idleTimeoutMs: 300 });
  assert.equal(result.timedOut, false);
  assert.equal(result.ok, true);
  assert.match(result.stdout, /beat/);
});

test('output produced before the kill is kept alongside the timeout note', async () => {
  const script = 'process.stdout.write("partial draft"); setTimeout(() => {}, 10000);';
  const result = await runCommand('node', ['-e', script], { timeoutMs: 400 });
  assert.equal(result.timedOut, true);
  assert.equal(result.stdout, 'partial draft');
  assert.match(result.stderr, /\[timeout\]/);
});

test('a command that exits on its own is untouched', async () => {
  const result = await runCommand('node', ['-e', 'process.stdout.write("done")'], { timeoutMs: 10000 });
  assert.equal(result.ok, true);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, 'done');
  assert.equal(result.stderr, '');
  assert.ok(!result.timedOut);
});

test('a genuine non-zero exit is not mislabelled as a timeout', async () => {
  const result = await runCommand('node', ['-e', 'console.error("boom"); process.exit(3)'], { timeoutMs: 10000 });
  assert.equal(result.ok, false);
  assert.equal(result.code, 3);
  assert.match(result.stderr, /boom/);
  assert.ok(!result.timedOut);
  assert.ok(!/\[timeout\]/.test(result.stderr), 'no timeout note on a real exit code');
});

test('a child that exits 0 only because SIGTERM raced it is still a failure', async () => {
  // Without the `&& !timedOut` guard a child that handles SIGTERM and exits
  // cleanly would be reported as a success with a truncated draft.
  const script = 'process.on("SIGTERM", () => process.exit(0)); setTimeout(() => {}, 10000);';
  const result = await runCommand('node', ['-e', script], { timeoutMs: 300 });
  assert.equal(result.timedOut, true);
  assert.equal(result.ok, false, 'a killed run must never look successful');
});

/**
 * A child that exits before draining stdin makes the `child.stdin.end(input)`
 * write fail with EPIPE. Nothing listened on that stream, so it surfaced as an
 * uncaught exception and killed the calling process — a whole regression suite
 * died this way in CI, printing no assertions at all, only "write EPIPE".
 *
 * The outcome is already covered by the 'error' and 'close' handlers, so the
 * write failing is not interesting. It just must not be fatal.
 */
test('a child that exits without reading stdin does not kill the caller', async () => {
  const result = await runCommand('node', ['-e', 'process.exit(0)'], {
    // Large enough not to fit in the pipe buffer, so the write really does fail
    // rather than being silently absorbed.
    input: 'x'.repeat(2_000_000),
    timeoutMs: 10000,
  });
  assert.equal(result.code, 0, 'the child exited fine; only our write to it failed');
  assert.equal(result.ok, true);
});

test('a child that exits non-zero without reading stdin still reports its code', async () => {
  const result = await runCommand('node', ['-e', 'console.error("nope"); process.exit(3)'], {
    input: 'y'.repeat(2_000_000),
    timeoutMs: 10000,
  });
  assert.equal(result.code, 3);
  assert.equal(result.ok, false);
  assert.match(result.stderr, /nope/, 'stderr collected before the exit must survive');
});

test('a missing binary with stdin input still resolves rather than throwing', async () => {
  const result = await runCommand('definitely-not-a-real-binary-xyz', ['--x'], { input: 'x'.repeat(200000) });
  assert.equal(result.ok, false);
  assert.equal(result.code, null);
  assert.match(result.stderr, /ENOENT/);
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
