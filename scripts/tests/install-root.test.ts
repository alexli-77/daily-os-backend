/**
 * Shipped assets must be findable from a working directory that is not the
 * checkout.
 *
 * Independent, tsx-runnable:  npx tsx scripts/tests/install-root.test.ts
 *
 * Since the service started shipping inside the Mac app, the code is read-only
 * in `Daily OS.app/Contents/Resources/service` and the working directory is
 * `~/Library/Application Support/DailyOS`. Every `path.resolve('prompts/…')`
 * and `path.resolve('.env.example')` written before that split silently means
 * "somewhere in the user's data directory", where no template has ever lived.
 *
 * The failure mode is what makes this worth a test rather than a code review:
 * it is invisible from the checkout, because there the two directories are the
 * same one. It is also invisible on an *installed* machine as long as some
 * earlier call already created the file — which is exactly how the second copy
 * of this logic survived the first fix and crashed `daily-os ui` on a fresh
 * directory months later.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { bundledAsset, installRoot } from '../../src/utils/install-root.js';

type TestFn = () => void;
const tests: Array<{ name: string; fn: TestFn }> = [];
function test(name: string, fn: TestFn): void {
  tests.push({ name, fn });
}

/** Every template the service copies, or reads, on a first run. */
const SHIPPED = [
  ['.env.example'],
  ['config', 'config.example.yaml'],
  ['prompts', 'biweekly_strategy.md'],
  ['prompts', 'skills', 'daily-plan', 'SKILL.md'],
];

test('every shipped template resolves from a foreign working directory', () => {
  const original = process.cwd();
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-os-install-root-'));
  try {
    process.chdir(elsewhere);
    for (const segments of SHIPPED) {
      const resolved = bundledAsset(...segments);
      assert.ok(
        fs.existsSync(resolved),
        `${segments.join('/')} not found from a foreign cwd — resolved to ${resolved}`,
      );
      assert.ok(
        resolved.startsWith(installRoot()),
        `${segments.join('/')} resolved outside the install root: ${resolved}`,
      );
    }
  } finally {
    process.chdir(original);
    fs.rmSync(elsewhere, { recursive: true, force: true });
  }
});

// The override is the reason this is `bundledAsset` and not just a path join:
// prompts are edited by hand, and an edit the next app update silently reverted
// would be worse than not allowing one.
test('a copy in the working directory wins over the shipped one', () => {
  const original = process.cwd();
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-os-install-root-'));
  try {
    process.chdir(elsewhere);
    fs.mkdirSync(path.join(elsewhere, 'prompts'), { recursive: true });
    const override = path.join(elsewhere, 'prompts', 'biweekly_strategy.md');
    fs.writeFileSync(override, '# mine\n', 'utf8');
    assert.equal(fs.realpathSync(bundledAsset('prompts', 'biweekly_strategy.md')), fs.realpathSync(override));
  } finally {
    process.chdir(original);
    fs.rmSync(elsewhere, { recursive: true, force: true });
  }
});

test('a name that ships nowhere still returns an install-root path, not a cwd one', () => {
  const original = process.cwd();
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-os-install-root-'));
  try {
    process.chdir(elsewhere);
    const resolved = bundledAsset('prompts', 'does-not-exist.md');
    assert.ok(resolved.startsWith(installRoot()), `fell back to the cwd: ${resolved}`);
  } finally {
    process.chdir(original);
    fs.rmSync(elsewhere, { recursive: true, force: true });
  }
});

export function testInstallRoot(): void {
  for (const { name, fn } of tests) {
    fn();
    console.log(`  PASS  ${name}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  testInstallRoot();
  console.log(`\n${tests.length} passed.`);
}
