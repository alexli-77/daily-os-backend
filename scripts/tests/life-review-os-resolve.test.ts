/**
 * life-review-os CLI resolution + bundled runtime.
 *
 * The CLI can now ship inside the Mac app, but that must not change anything for
 * a machine that already runs it from a checkout. These tests pin the invariant:
 * an existing checkout always wins over the bundled copy, and only a CLI that
 * actually lives in the bundle gets its config/runs redirected to the writable
 * data dir.
 *
 * Run: tsx scripts/tests/life-review-os-resolve.test.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveLifeReviewOsCli, bundledCliRuntime } from '../../src/skills/life-review-os.js';
import { installRoot } from '../../src/utils/install-root.js';
import type { AppConfig } from '../../src/config/schema.js';

type SkillEntry = AppConfig['skills']['registry'][number];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lros-resolve-'));
const originalCwd = process.cwd();

function makeEntry(overrides: Partial<SkillEntry>): SkillEntry {
  return {
    id: 'weekly-review',
    provider: 'auto',
    path: path.join(tmp, 'SKILL.md'),
    workdir: '',
    default_mode: 'weekly',
    effects: ['read', 'draft'],
    require_confirmation_for: [],
    ...overrides,
  } as SkillEntry;
}

try {
  // 1) An existing checkout wins over the bundled copy — the "no change for a
  //    clone" invariant. Give the entry a workdir with a real CLI file.
  const checkout = path.join(tmp, 'checkout');
  fs.mkdirSync(path.join(checkout, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(checkout, 'bin', 'life-review-os.mjs'), '// fake');
  const resolved = resolveLifeReviewOsCli(makeEntry({ workdir: checkout }));
  assert.equal(resolved, path.join(checkout, 'bin', 'life-review-os.mjs'), 'a real checkout must win');

  // 2) A checkout CLI gets no bundled runtime — it runs exactly as before.
  assert.equal(bundledCliRuntime(path.join(checkout, 'bin', 'life-review-os.mjs')), null, 'checkout CLI: null runtime');

  // 3) The bundled CLI (a path under installRoot()/life-review-os) redirects
  //    config + runs to the data dir (cwd) and sets the runs-dir env.
  const dataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lros-data-')));
  process.chdir(dataDir); // the service's cwd is the writable data dir
  try {
    const bundledCli = path.join(installRoot(), 'life-review-os', 'bin', 'life-review-os.mjs');
    const runtime = bundledCliRuntime(bundledCli);
    assert.ok(runtime, 'bundled CLI must get a runtime');
    assert.deepEqual(runtime!.extraArgs, ['--config', path.join(dataDir, 'life-review-os', 'config.yaml')]);
    assert.equal(runtime!.env.LIFE_REVIEW_OS_RUNS_DIR, path.join(dataDir, 'life-review-os', '.runs'));
    assert.equal(runtime!.cwd, path.join(dataDir, 'life-review-os'));
    assert.ok(fs.existsSync(path.join(dataDir, 'life-review-os', '.runs')), 'runs dir is created up front');
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  console.log('life-review-os-resolve.test.ts: all tests passed');
} finally {
  process.chdir(originalCwd);
  fs.rmSync(tmp, { recursive: true, force: true });
}
