/**
 * Fail-fast + retry for agent runs.
 *
 * A `claude` CLI under launchd is bimodal — it answers in a minute or two, or it
 * hangs forever (#199). So `runAgent` uses a short per-attempt timeout and, on a
 * timeout only, retries up to `llm.max_attempts`. This test drives that with a
 * fake `claude` that hangs on the first call and answers on the second.
 *
 * Run: tsx scripts/tests/agent-retry.test.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';

import { AppConfigSchema, type AppConfig } from '../../src/config/schema.js';
import type { AgentInput } from '../../src/agent/openai-agent.js';
import { runAgent } from '../../src/agent/index.js';
import { AgentTimeoutError } from '../../src/agent/runtime-env.js';

const REPO_ROOT = path.resolve(process.cwd());
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-retry-'));
const counterFile = path.join(tmp, 'count');

/** A fake `claude`: 1st call sleeps past the timeout, later calls answer fast. */
function writeFakeClaude(behaviour: 'hang-once' | 'always-hang'): string {
  const bin = path.join(tmp, `claude-${behaviour}.sh`);
  const answerBranch =
    behaviour === 'hang-once'
      ? 'if [ "$c" -eq 1 ]; then sleep 5; fi'
      : 'sleep 5';
  fs.writeFileSync(
    bin,
    `#!/bin/sh
c=$(cat "${counterFile}" 2>/dev/null || echo 0)
c=$((c + 1))
echo "$c" > "${counterFile}"
${answerBranch}
echo "今日重点：写完这个测试"
`,
    { mode: 0o755 },
  );
  return bin;
}

function makeConfig(): AppConfig {
  const raw = yaml.load(fs.readFileSync(path.join(REPO_ROOT, 'config', 'config.example.yaml'), 'utf8'));
  const config = AppConfigSchema.parse(raw);
  config.llm.provider = 'claude';
  config.llm.model = 'default';
  config.llm.timeout_ms = 800; // fail fast — well under the fake's 5s hang
  config.llm.max_attempts = 2;
  return config;
}

function makeInput(config: AppConfig): AgentInput {
  return {
    config,
    workflow: 'daily_plan',
    date: '2026-09-22',
    evidence: { generated_at: new Date().toISOString(), date: '2026-09-22', sources: {} },
    memory: {} as AgentInput['memory'],
    runId: 'agent-retry-test',
  };
}

try {
  // 1) Hang once, then succeed: runAgent must fail the first attempt fast and
  //    recover on the retry — two invocations, a real answer out.
  fs.writeFileSync(counterFile, '0');
  process.env.CLAUDE_BIN = writeFakeClaude('hang-once');
  const out = await runAgent(makeInput(makeConfig()));
  assert.match(out, /今日重点/, 'retry recovered a real answer');
  assert.equal(fs.readFileSync(counterFile, 'utf8').trim(), '2', 'it took exactly two attempts');

  // 2) Always hang: after max_attempts it gives up with AgentTimeoutError, and it
  //    does not attempt more than max_attempts (no infinite retry).
  fs.writeFileSync(counterFile, '0');
  process.env.CLAUDE_BIN = writeFakeClaude('always-hang');
  await assert.rejects(() => runAgent(makeInput(makeConfig())), AgentTimeoutError, 'a persistent hang throws AgentTimeoutError');
  assert.equal(fs.readFileSync(counterFile, 'utf8').trim(), '2', 'it stopped at max_attempts, no infinite retry');

  // 3) max_attempts=1 disables the retry: a hang fails after a single attempt.
  fs.writeFileSync(counterFile, '0');
  const once = makeConfig();
  once.llm.max_attempts = 1;
  process.env.CLAUDE_BIN = writeFakeClaude('always-hang');
  await assert.rejects(() => runAgent(makeInput(once)), AgentTimeoutError);
  assert.equal(fs.readFileSync(counterFile, 'utf8').trim(), '1', 'max_attempts=1 means no retry');

  console.log('agent-retry.test.ts: all tests passed');
} finally {
  delete process.env.CLAUDE_BIN;
  fs.rmSync(tmp, { recursive: true, force: true });
}
