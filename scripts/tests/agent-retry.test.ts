/**
 * Fail-fast + retry for agent runs, driven by the idle (no-output) timeout.
 *
 * A `claude` CLI under launchd is bimodal — it streams an answer within a minute
 * or two, or it hangs producing nothing forever (#199). So `runClaudeAgent` runs
 * with a streaming output format and `runCommand` kills an attempt that emits no
 * output for `llm.idle_timeout_ms`; `runAgent` retries a timeout up to
 * `llm.max_attempts`. Crucially, a slow-but-streaming run keeps resetting the
 * window and is NEVER misjudged — that is the property the last case pins down.
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

const IDLE_MS = 500;
const RESULT_LINE = '{"type":"result","result":"今日重点：写完这个测试"}';

/**
 * A fake `claude`. Each behaviour writes stream-json to stdout the way the real
 * CLI does, so `extractStreamJsonText` has something to parse.
 * - hang-once:  1st call goes silent past the idle window, later calls answer.
 * - always-hang: every call goes silent (a persistent hang).
 * - slow-stream: streams a heartbeat every 150ms for ~1.2s (well past the idle
 *   window in total), then answers — a slow-but-working run that must survive.
 */
function writeFakeClaude(behaviour: 'hang-once' | 'always-hang' | 'slow-stream'): string {
  const bin = path.join(tmp, `claude-${behaviour}.sh`);
  const hang = 'sleep 3'; // no output — the idle timer (500ms) must kill this
  const stream = `i=0
while [ "$i" -lt 8 ]; do
  echo '{"type":"stream_event"}'
  sleep 0.15
  i=$((i + 1))
done`;
  let body: string;
  if (behaviour === 'hang-once') {
    body = `if [ "$c" -eq 1 ]; then\n${hang}\nfi\necho '${RESULT_LINE}'`;
  } else if (behaviour === 'always-hang') {
    body = hang;
  } else {
    body = `${stream}\necho '${RESULT_LINE}'`;
  }
  fs.writeFileSync(
    bin,
    `#!/bin/sh
c=$(cat "${counterFile}" 2>/dev/null || echo 0)
c=$((c + 1))
echo "$c" > "${counterFile}"
${body}
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
  config.llm.timeout_ms = 0; // isolate the idle path — no absolute ceiling here
  config.llm.idle_timeout_ms = IDLE_MS;
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

// Skip the launchd CLI probe: it would run the fake once itself and throw off
// the attempt counter. The probe is exercised by runtime-env's own tests.
process.env.DAILY_OS_SKIP_CLI_PROBE = '1';

try {
  // 1) Hang once, then succeed: the first attempt goes silent and is killed by
  //    the idle timer; the retry streams a real answer — two invocations.
  fs.writeFileSync(counterFile, '0');
  process.env.CLAUDE_BIN = writeFakeClaude('hang-once');
  const out = await runAgent(makeInput(makeConfig()));
  assert.match(out, /今日重点/, 'retry recovered a real answer');
  assert.equal(fs.readFileSync(counterFile, 'utf8').trim(), '2', 'it took exactly two attempts');

  // 2) Always hang: after max_attempts it gives up with AgentTimeoutError and
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

  // 4) No false positive: a slow-but-streaming run runs far longer than the idle
  //    window in total, yet keeps emitting, so it is never killed — one attempt,
  //    a real answer. This is the large-context case the idle timer protects.
  fs.writeFileSync(counterFile, '0');
  process.env.CLAUDE_BIN = writeFakeClaude('slow-stream');
  const streamed = await runAgent(makeInput(makeConfig()));
  assert.match(streamed, /今日重点/, 'a slow-but-streaming run completes');
  assert.equal(fs.readFileSync(counterFile, 'utf8').trim(), '1', 'a streaming run is not misjudged as a hang — no retry');

  console.log('agent-retry.test.ts: all tests passed');
} finally {
  delete process.env.CLAUDE_BIN;
  delete process.env.DAILY_OS_SKIP_CLI_PROBE;
  fs.rmSync(tmp, { recursive: true, force: true });
}
