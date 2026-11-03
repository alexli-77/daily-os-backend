import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../../src/config/load-config.js';
import { runDoctor } from '../../src/cli/doctor.js';
import type { AppConfig } from '../../src/config/schema.js';

// daily-os-macos #3: doctor must not report ok for a vault path that exists but
// is the empty template (no 10_OKR/) — that was the silent OKR/cycles loss.

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-vault-'));

function configWith(vault: string): AppConfig {
  const config = loadConfig('config/config.example.yaml');
  config.memory.repository_path = vault;
  return config;
}
function memoryCheck(checks: Awaited<ReturnType<typeof runDoctor>>) {
  return checks.find((check) => check.name.startsWith('记忆仓库路径'));
}

try {
  const seeded = fs.mkdtempSync(path.join(tmp, 'seeded-'));
  fs.mkdirSync(path.join(seeded, '10_OKR'), { recursive: true });
  const okCheck = memoryCheck(await runDoctor(configWith(seeded)));
  assert.ok(okCheck, 'memory check exists');
  assert.equal(okCheck!.ok, true, 'a seeded vault (has 10_OKR) is ok');
  assert.equal(okCheck!.level, 'ok');

  const empty = fs.mkdtempSync(path.join(tmp, 'empty-'));
  fs.writeFileSync(path.join(empty, 'decision-policy.md'), 'template');
  const warnCheck = memoryCheck(await runDoctor(configWith(empty)));
  assert.equal(warnCheck!.ok, false, 'a vault without 10_OKR is not ok');
  assert.equal(warnCheck!.level, 'warning', 'it warns rather than passing silently');
  assert.match(String(warnCheck!.detail), /10_OKR/);

  const missingCheck = memoryCheck(await runDoctor(configWith(path.join(tmp, 'does-not-exist'))));
  assert.equal(missingCheck!.ok, false, 'a missing vault is not ok');
  assert.equal(missingCheck!.level, 'missing');

  console.log('doctor-vault.test.ts: all tests passed');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
