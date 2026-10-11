/**
 * LEO-339 notification settings: master switch → source → channel.
 *
 * Independent, tsx-runnable:  npx tsx scripts/tests/notifications.test.ts
 *
 * Two things are worth pinning. First, a config written before `notifications`
 * existed must behave exactly as it did — every source on, Feishu on, and
 * `output.feishu.enabled: false` still meaning no Feishu at all. Second, the
 * settings mute *scheduled* sends only. Muting the 21:30 review must not make a
 * 复盘 command typed into Feishu go unanswered; that send is a reply.
 *
 * The workflow half runs the real `runWorkflow` against a stub codex binary and
 * a deliberately missing chat id, so "tried to send" shows up as a rejection
 * naming that env var and "did not try" as a run whose send was skipped.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import yaml from 'js-yaml';

import { AppConfigSchema, type AppConfig } from '../../src/config/schema.js';
import { notificationAllowed } from '../../src/notifications/policy.js';
import { listRecentWorkflowRuns } from '../../src/workflows/run-ledger.js';
import { runWorkflow } from '../../src/workflows/run-workflow.js';

type TestFn = () => void | Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];
function test(name: string, fn: TestFn): void {
  tests.push({ name, fn });
}

const EXAMPLE = path.resolve('config/config.example.yaml');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-os-notifications-'));
process.env.DAILY_OS_DB_PATH = path.join(tmp, 'daily-os.db');

/** The shipped example, which predates `notifications` and so carries none. */
function exampleConfig(): AppConfig {
  return AppConfigSchema.parse(yaml.load(fs.readFileSync(EXAMPLE, 'utf8')));
}

const SOURCES = ['daily_plan', 'daily_review', 'weekly_review', 'progress_reminder', 'background_suggestions'] as const;

test('a config without a notifications block allows every source, as before', () => {
  const config = exampleConfig();
  assert.equal(config.notifications.enabled, true);
  for (const source of SOURCES) assert.equal(notificationAllowed(config, source, 'feishu'), true, source);
});

test('the master switch silences every source', () => {
  const config = exampleConfig();
  config.notifications.enabled = false;
  for (const source of SOURCES) assert.equal(notificationAllowed(config, source, 'feishu'), false, source);
});

test('turning one source off leaves the others alone', () => {
  const config = exampleConfig();
  config.notifications.sources.daily_review.enabled = false;
  assert.equal(notificationAllowed(config, 'daily_review', 'feishu'), false);
  assert.equal(notificationAllowed(config, 'daily_plan', 'feishu'), true);
});

test('unticking a channel on a source mutes that channel only for that source', () => {
  const config = exampleConfig();
  config.notifications.sources.daily_review.feishu = false;
  assert.equal(notificationAllowed(config, 'daily_review', 'feishu'), false);
  assert.equal(notificationAllowed(config, 'weekly_review', 'feishu'), true);
});

test('output.feishu.enabled=false still means no Feishu at all', () => {
  const config = exampleConfig();
  config.output.feishu.enabled = false;
  for (const source of SOURCES) assert.equal(notificationAllowed(config, source, 'feishu'), false, source);
});

test('a partial notifications block fills the rest from defaults', () => {
  const raw = yaml.load(fs.readFileSync(EXAMPLE, 'utf8')) as Record<string, unknown>;
  raw.notifications = { sources: { daily_review: { feishu: false } } };
  const config = AppConfigSchema.parse(raw);
  assert.equal(config.notifications.enabled, true);
  assert.deepEqual(config.notifications.sources.daily_review, { enabled: true, feishu: false });
  assert.deepEqual(config.notifications.sources.daily_plan, { enabled: true, feishu: true });
});

// ── through runWorkflow ──────────────────────────────────────────────────────

function workflowConfig(): AppConfig {
  const config = exampleConfig();
  for (const source of ['vault', 'chrome_snapshot', 'apple_calendar_snapshot', 'feishu', 'github', 'linear'] as const) {
    config.sources[source].enabled = false;
  }
  config.progress.enabled = false;
  config.llm.provider = 'codex';
  config.output.feishu.enabled = true;
  config.output.feishu.provider = 'lark_cli';
  config.output.feishu.chat_id_env = 'MISSING_TEST_FEISHU_CHAT_ID';
  config.memory.daily_dir = path.join(tmp, 'daily');
  config.memory.long_term_path = path.join(tmp, 'long-term.md');
  config.memory.repository_path = path.join(tmp, 'repository');
  config.memory.workflow_runs_dir = path.join(tmp, 'workflow-runs');
  return config;
}

function installFakeCodex(): () => void {
  const fakeCodex = path.join(tmp, 'fake-codex');
  fs.writeFileSync(
    fakeCodex,
    [
      '#!/usr/bin/env node',
      "const fs = require('fs');",
      'const args = process.argv.slice(2);',
      "const outputPath = args[args.indexOf('--output-last-message') + 1];",
      "fs.writeFileSync(outputPath, '本周回顾：完成了 A，B 顺延。');",
    ].join('\n'),
    'utf8',
  );
  fs.chmodSync(fakeCodex, 0o755);
  const previous = process.env.CODEX_BIN;
  process.env.CODEX_BIN = fakeCodex;
  return () => {
    if (previous === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = previous;
  };
}

test('a scheduled run of a muted source is generated but not sent', async () => {
  const config = workflowConfig();
  config.notifications.sources.weekly_review.feishu = false;
  const restore = installFakeCodex();
  try {
    const text = await runWorkflow(config, 'weekly_review', { send: true, trigger: 'scheduler', source: 'notifications-test' });
    assert.match(text, /本周回顾/);
  } finally {
    restore();
  }
  const [run] = listRecentWorkflowRuns(config, 1);
  assert.equal(run?.status, 'succeeded');
  assert.equal(run?.send.status, 'skipped');
});

test('a command run of the same muted source still sends — it is a reply', async () => {
  const config = workflowConfig();
  config.notifications.sources.weekly_review.feishu = false;
  const restore = installFakeCodex();
  try {
    await assert.rejects(
      () => runWorkflow(config, 'weekly_review', { send: true, trigger: 'feishu_command', source: 'notifications-test' }),
      /MISSING_TEST_FEISHU_CHAT_ID/,
    );
  } finally {
    restore();
  }
});

test('a scheduled run of a source left on still sends', async () => {
  const config = workflowConfig();
  config.notifications.sources.daily_review.feishu = false;
  const restore = installFakeCodex();
  try {
    await assert.rejects(
      () => runWorkflow(config, 'weekly_review', { send: true, trigger: 'scheduler', source: 'notifications-test' }),
      /MISSING_TEST_FEISHU_CHAT_ID/,
    );
  } finally {
    restore();
  }
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`not ok - ${name}`);
    console.error(error);
  }
}
fs.rmSync(tmp, { recursive: true, force: true });
if (failed > 0) {
  console.error(`${failed} notification test(s) failed`);
  process.exit(1);
}
console.log(`notifications: ${tests.length} passed`);
