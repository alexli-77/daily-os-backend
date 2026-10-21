/**
 * LEO-207 billing / TokenMeter / budget circuit-breaker tests.
 *
 * Independent, dependency-free test runner (run with: `tsx scripts/tests/billing.test.ts`).
 * Covers: Anthropic provider response parsing, three-tier budget breaker, and usage metering
 * persistence. Mocks global.fetch — no network, no real API key needed.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';

import { AppConfigSchema, type AppConfig } from '../../src/config/schema.js';
import type { AgentInput } from '../../src/agent/openai-agent.js';
import { runAnthropicAgent } from '../../src/agent/anthropic-agent.js';
import {
  BudgetExceededError,
  checkBudget,
  estimateCostUsd,
  getUsageSummary,
  readLedger,
  recordUsage,
  resolveModelPrice,
} from '../../src/agent/token-meter.js';

type TestFn = () => void | Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];
function test(name: string, fn: TestFn): void {
  tests.push({ name, fn });
}

const REPO_ROOT = path.resolve(process.cwd());
const originalFetch = globalThis.fetch;

function makeTmpWorkdir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'billing-test-'));
  // buildSystemPrompt/buildUserPrompt read prompts relative to cwd; copy them in.
  fs.mkdirSync(path.join(dir, 'prompts'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'data', 'runtime'), { recursive: true });
  for (const name of ['system.md', 'daily_review.md', 'weekly_review.md']) {
    fs.copyFileSync(path.join(REPO_ROOT, 'prompts', name), path.join(dir, 'prompts', name));
  }
  fs.cpSync(path.join(REPO_ROOT, 'prompts', 'skills'), path.join(dir, 'prompts', 'skills'), { recursive: true });
  return dir;
}

function makeConfig(overrides: Partial<{ per_task: number; daily: number; monthly: number; model: string }> = {}): AppConfig {
  // The 7 core schema sections (assistant/user/llm/workflows/output/sources/memory)
  // are intentionally non-defaultable, so parse the shipped example config to get a
  // fully-populated baseline, then apply billing/provider overrides on top.
  const raw = yaml.load(fs.readFileSync(path.join(REPO_ROOT, 'config', 'config.example.yaml'), 'utf8'));
  const config = AppConfigSchema.parse(raw);
  config.llm.provider = 'anthropic';
  config.llm.model = overrides.model ?? 'claude-sonnet-5';
  config.billing.per_task_usd = overrides.per_task ?? 2;
  config.billing.daily_usd = overrides.daily ?? 10;
  config.billing.monthly_usd = overrides.monthly ?? 100;
  return config;
}

function makeInput(config: AppConfig, runId: string): AgentInput {
  return {
    config,
    workflow: 'daily_plan',
    date: '2026-07-17',
    evidence: { generated_at: new Date().toISOString(), date: '2026-07-17', sources: {} },
    memory: {} as AgentInput['memory'],
    runId,
  };
}

/** Minimal fetch stub returning an Anthropic Messages API shaped payload. */
function stubFetch(payload: unknown, init: { ok?: boolean; status?: number } = {}): { calls: number } {
  const state = { calls: 0 };
  globalThis.fetch = (async () => {
    state.calls += 1;
    return {
      ok: init.ok ?? true,
      status: init.status ?? 200,
      text: async () => JSON.stringify(payload),
    } as unknown as Response;
  }) as typeof fetch;
  return state;
}

// ---------------------------------------------------------------------------

test('price table: resolveModelPrice + estimateCostUsd compute claude-sonnet-5 cost', () => {
  const price = resolveModelPrice('claude-sonnet-5');
  assert.ok(price, 'claude-sonnet-5 should be priced');
  assert.equal(price!.input, 3);
  assert.equal(price!.output, 15);
  // prefix match for versioned ids
  assert.ok(resolveModelPrice('claude-sonnet-5-20260101'), 'versioned id should resolve via prefix');
  const cost = estimateCostUsd('claude-sonnet-5', 1_000_000, 1_000_000);
  assert.equal(cost, 18); // 3 + 15
  assert.equal(estimateCostUsd('unknown-model-xyz', 1000, 1000), 0);
});

test('metering: recordUsage appends JSONL and getUsageSummary aggregates', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'));
  const ledgerPath = path.join(dir, 'usage-ledger.jsonl');
  recordUsage('run-a', 'anthropic', 'claude-sonnet-5', 1000, 500, 0.5, { ledgerPath });
  recordUsage('run-a', 'anthropic', 'claude-sonnet-5', 2000, 1000, 1.0, { ledgerPath });
  const rows = readLedger(ledgerPath);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].runId, 'run-a');
  const daySummary = getUsageSummary('day', { ledgerPath });
  assert.equal(daySummary.calls, 2);
  assert.equal(daySummary.inputTokens, 3000);
  assert.equal(Number(daySummary.estCostUsd.toFixed(2)), 1.5);
  const monthSummary = getUsageSummary('month', { ledgerPath });
  assert.equal(monthSummary.calls, 2);
});

test('budget breaker: checkBudget throws BudgetExceededError for per_task tier', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'));
  const ledgerPath = path.join(dir, 'usage-ledger.jsonl');
  const alertPath = path.join(dir, 'alerts.jsonl');
  recordUsage('run-b', 'anthropic', 'claude-sonnet-5', 100, 100, 2.5, { ledgerPath });
  assert.throws(
    () => checkBudget({ per_task_usd: 2, daily_usd: 10, monthly_usd: 100 }, { runId: 'run-b', ledgerPath, alertPath }),
    (err: unknown) => err instanceof BudgetExceededError && err.scope === 'per_task',
  );
  // alert log written
  assert.ok(fs.existsSync(alertPath), 'budget alert log should be written');
  const alert = JSON.parse(fs.readFileSync(alertPath, 'utf8').trim());
  assert.equal(alert.scope, 'per_task');
});

test('budget breaker: daily and monthly tiers trip independently', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'));
  const ledgerPath = path.join(dir, 'usage-ledger.jsonl');
  const alertPath = path.join(dir, 'alerts.jsonl');
  // two different runs, each under per_task ($2) but summing over daily ($3 > $3? use 11 > 10)
  recordUsage('run-c1', 'anthropic', 'claude-sonnet-5', 10, 10, 1.5, { ledgerPath });
  recordUsage('run-c2', 'anthropic', 'claude-sonnet-5', 10, 10, 9.6, { ledgerPath });
  // run-c3 is fresh (per_task ok) but daily total 11.1 >= 10 -> daily trips
  assert.throws(
    () => checkBudget({ per_task_usd: 5, daily_usd: 10, monthly_usd: 100 }, { runId: 'run-c3', ledgerPath, alertPath }),
    (err: unknown) => err instanceof BudgetExceededError && err.scope === 'daily',
  );
  // raise daily above spend, monthly still trips
  assert.throws(
    () => checkBudget({ per_task_usd: 5, daily_usd: 100, monthly_usd: 10 }, { runId: 'run-c3', ledgerPath, alertPath }),
    (err: unknown) => err instanceof BudgetExceededError && err.scope === 'monthly',
  );
});

test('anthropic provider: parses Messages API response and records usage', async () => {
  const dir = makeTmpWorkdir();
  const prev = process.cwd();
  process.chdir(dir);
  try {
    const state = stubFetch({
      content: [{ type: 'text', text: '今日重点：完成 LEO-207。' }],
      usage: { input_tokens: 1200, output_tokens: 800 },
    });
    const config = makeConfig();
    const out = await runAnthropicAgent(makeInput(config, 'run-anthropic-1'));
    assert.equal(state.calls, 1, 'fetch should be called once');
    assert.ok(out.includes('今日重点'), 'normalized output should contain model text');
    const ledgerPath = path.join(dir, 'data', 'runtime', 'usage-ledger.jsonl');
    const rows = readLedger(ledgerPath);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].provider, 'anthropic');
    assert.equal(rows[0].model, 'claude-sonnet-5');
    assert.equal(rows[0].inputTokens, 1200);
    assert.equal(rows[0].outputTokens, 800);
    // cost = 1200/1e6*3 + 800/1e6*15 = 0.0036 + 0.012 = 0.0156
    assert.equal(Number(rows[0].estCostUsd.toFixed(4)), 0.0156);
  } finally {
    process.chdir(prev);
    globalThis.fetch = originalFetch;
  }
});

test('anthropic provider: a max_tokens-truncated response throws instead of returning partial text', async () => {
  const dir = makeTmpWorkdir();
  const prev = process.cwd();
  process.chdir(dir);
  try {
    stubFetch({
      content: [{ type: 'text', text: '{ "todos": [ { "rank": 1, "text": "写决策文档", "candidateId": "LEO-9' }],
      usage: { input_tokens: 1200, output_tokens: 8192 },
      stop_reason: 'max_tokens',
    });
    const config = makeConfig();
    await assert.rejects(
      () => runAnthropicAgent(makeInput(config, 'run-truncated')),
      /truncated the response at max_tokens/,
    );
  } finally {
    process.chdir(prev);
    globalThis.fetch = originalFetch;
  }
});

test('anthropic provider: budget breaker blocks the call before fetch when a tier is exhausted', async () => {
  const dir = makeTmpWorkdir();
  const prev = process.cwd();
  process.chdir(dir);
  try {
    // pre-seed the default ledger (under tmp cwd) so per_task is already blown for this run
    const ledgerPath = path.join(dir, 'data', 'runtime', 'usage-ledger.jsonl');
    recordUsage('run-blocked', 'anthropic', 'claude-sonnet-5', 10, 10, 5.0, { ledgerPath });
    const state = stubFetch({ content: [{ type: 'text', text: 'should not run' }], usage: {} });
    const config = makeConfig({ per_task: 2 });
    await assert.rejects(
      () => runAnthropicAgent(makeInput(config, 'run-blocked')),
      (err: unknown) => err instanceof BudgetExceededError && err.scope === 'per_task',
    );
    assert.equal(state.calls, 0, 'fetch must NOT be called once budget is exhausted');
  } finally {
    process.chdir(prev);
    globalThis.fetch = originalFetch;
  }
});

test('anthropic provider: missing ANTHROPIC_API_KEY throws a clear error', async () => {
  const prev = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    await assert.rejects(
      () => runAnthropicAgent(makeInput(makeConfig(), 'run-nokey')),
      /ANTHROPIC_API_KEY is required/,
    );
  } finally {
    if (prev !== undefined) process.env.ANTHROPIC_API_KEY = prev;
  }
});

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // ensure an API key exists for the happy-path tests (mocked fetch never uses it)
  process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key';
  let passed = 0;
  const failures: Array<{ name: string; error: unknown }> = [];
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed += 1;
      console.log(`  ok   ${name}`);
    } catch (error) {
      failures.push({ name, error });
      console.error(`  FAIL ${name}`);
      console.error(error);
    }
  }
  console.log(`\nbilling.test: ${passed}/${tests.length} passed`);
  if (failures.length > 0) process.exit(1);
}

void main();
