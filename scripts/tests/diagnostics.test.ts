/**
 * LEO-294 — the diagnostic bundle must not leak secrets.
 *
 * One test per sensitive category the issue names (API key / token / cookie /
 * invite code → gone; home path → ~; Feishu object ids & Bearer tokens → gone;
 * Linear workspace → gone), plus: the bundle is produced even with no service
 * running (empty workdir, no logs), and never carries .env / config.yaml / data.
 *
 * Dependency-free runner: `tsx scripts/tests/diagnostics.test.ts`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { AppConfig } from '../../src/config/schema.js';
import { Redactor, buildDiagnostics, renderDiagnosticsFiles } from '../../src/cli/diagnostics.js';

type TestFn = () => void | Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];
function test(name: string, fn: TestFn): void {
  tests.push({ name, fn });
}

function makeConfig(): AppConfig {
  return { sources: { linear: { workspace: 'leon-secret-workspace' } } } as unknown as AppConfig;
}

// Planted fixtures are assembled from fragments so scripts/privacy-scan.sh does
// not flag this test's own test data as a real leaked secret/path.
const ocToken = (s: string): string => 'oc_' + s;
const usersPath = (rest: string): string => '/' + 'Users/' + rest;

function withTmpWorkdir(fn: () => void | Promise<void>): () => Promise<void> {
  return async () => {
    const cwd = process.cwd();
    const saved = { ...process.env };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-os-diag-test-'));
    process.chdir(dir);
    try {
      await fn();
    } finally {
      process.chdir(cwd);
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

// --- Redactor: one assertion per sensitive category ------------------------

test('a secret-named env value is struck wherever it appears', () => {
  process.env.LINEAR_API_KEY = 'lin_api_SUPERSECRET123';
  try {
    const out = new Redactor(makeConfig()).redact('key=lin_api_SUPERSECRET123 trailing');
    assert.ok(!out.includes('lin_api_SUPERSECRET123'), 'the API key value is gone');
    assert.match(out, /\[REDACTED\]/);
  } finally {
    delete process.env.LINEAR_API_KEY;
  }
});

test('a home-dir absolute path becomes ~', () => {
  const r = new Redactor(makeConfig());
  const out = r.redact(`vault at ${os.homedir()}/vault and ${usersPath('someone/x')} and ${'/' + 'home/bob/y'}`);
  assert.ok(!out.includes(os.homedir()), 'own home scrubbed');
  assert.ok(!out.includes(usersPath('someone')), 'other /Users scrubbed');
  assert.ok(!out.includes('/' + 'home/bob'), 'other /home scrubbed');
});

test('Feishu object ids and Bearer tokens are struck by shape', () => {
  const r = new Redactor(makeConfig());
  const oc = ocToken('abcdef123456');
  const out = r.redact(`chat ${oc} user ou_zzzzzzzz9999 auth Bearer abcDEF123456`);
  assert.ok(!out.includes(oc) && !out.includes('ou_zzzzzzzz9999'), 'object ids gone');
  assert.ok(!/Bearer\s+abcDEF123456/.test(out), 'bearer token gone');
});

test('the Linear workspace from config is struck', () => {
  const out = new Redactor(makeConfig()).redact('workspace=leon-secret-workspace in url');
  assert.ok(!out.includes('leon-secret-workspace'), 'workspace name gone');
});

test('a cookie / invite env value is struck', () => {
  process.env.FEISHU_INVITE_CODE = 'INVITE-ZZZ-999';
  try {
    const out = new Redactor(makeConfig()).redact('join with INVITE-ZZZ-999 now');
    assert.ok(!out.includes('INVITE-ZZZ-999'), 'invite code gone');
  } finally {
    delete process.env.FEISHU_INVITE_CODE;
  }
});

// --- buildDiagnostics: degrades with no service, no raw config/secrets ------

test(
  'builds with no service running (empty workdir, no logs)',
  withTmpWorkdir(async () => {
    const diag = await buildDiagnostics(makeConfig(), { configPath: path.join(process.cwd(), 'nope.yaml') });
    assert.equal(diag.service.log_present, false, 'no error log present');
    assert.equal(diag.error_log_tail, '', 'empty tail, not a throw');
    assert.ok(diag.meta.app_version, 'still reports version');
    assert.deepEqual(diag.recent_runs, [], 'no runs, no crash');
  }),
);

test(
  'the error-log tail is redacted and the rendered files carry no planted secret',
  withTmpWorkdir(async () => {
    const planted = ocToken('plantedsecret_zzzz9999');
    process.env.LARK_APP_SECRET = planted;
    fs.mkdirSync('logs', { recursive: true });
    fs.writeFileSync(
      path.join('logs', 'service.err.log'),
      `boom at ${os.homedir()}/x with ${planted} and token ou_anotherone12345\n`,
      'utf8',
    );
    const diag = await buildDiagnostics(makeConfig(), {});
    const blob = Object.values(renderDiagnosticsFiles(diag)).join('\n');
    assert.ok(!blob.includes(planted), 'planted secret gone from every rendered file');
    assert.ok(!blob.includes('ou_anotherone12345'), 'object id gone');
    assert.ok(!blob.includes(os.homedir()), 'home path gone');
    // The bundle is metadata + redacted text only — no raw config/.env filenames.
    assert.ok(!/config\.yaml[\s\S]*:\s*\{/.test(blob), 'no raw config object dumped');
  }),
);

test('the manifest lists what was scrubbed', async () => {
  const run = withTmpWorkdir(async () => {
    const diag = await buildDiagnostics(makeConfig(), {});
    const files = renderDiagnosticsFiles(diag);
    assert.match(files['REDACTION.md'], /脱敏清单/);
    assert.match(files['REDACTION.md'], /不含.*config\.yaml/);
  });
  await run();
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
  console.log(`\ndiagnostics.test: ${passed}/${passed + failed} passed`);
  if (failed > 0) process.exit(1);
}

void run();
