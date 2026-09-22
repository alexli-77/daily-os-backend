import type { AgentInput } from './openai-agent.js';
import { runAnthropicAgent } from './anthropic-agent.js';
import { runClaudeAgent } from './claude-agent.js';
import { runCodexAgent } from './codex-agent.js';
import { runOpenAiAgent } from './openai-agent.js';
import { AgentTimeoutError, assertCliProviderUsable, resolveMaxAttempts } from './runtime-env.js';

export async function runAgent(input: AgentInput): Promise<string> {
  const provider = input.config.llm.provider;
  // daily-os #199: don't launch a doomed run in the background — but decide that
  // by asking this CLI, not by its name. The first version of this gate refused
  // `claude` and `codex` alike under launchd; on the machine that reported the
  // bug, codex answered in 10s and had 77 successful scheduled runs behind it
  // while claude hung. Blocking by provider name took away the only provider
  // that worked. `assertCliProviderUsable` spends one trivial prompt per process
  // finding out, then gets out of the way.
  await assertCliProviderUsable(provider, cliBinFor(provider));
  // Policy note (2026-05): Anthropic sanctions headless `claude -p` / Agent SDK usage
  // under a subscription via the monthly Agent SDK credit (Pro $20 / Max $100-$200,
  // billed at API rates; rollout paused as of 2026-06, currently still subscription
  // limits). The `claude` CLI provider is therefore a compliant no-API-key path for
  // the operator's own instance. Customer instances must authenticate the customer's
  // own Claude account (credits are per-user) or use a BYOK API key.
  if (provider === 'codex') {
    console.warn(
      '[provider] codex CLI 用于程序化调度请确认 OpenAI 订阅条款允许，或改用 API-key provider（anthropic/openai）。',
    );
  } else if (provider === 'claude') {
    console.info(
      '[provider] claude CLI（headless）走订阅 Agent SDK 额度（2026-05 政策，Pro $20/月，暂未生效前仍计订阅额度）。注意：额度按用户计，客户实例须用客户自己的账号或 API key。',
    );
  }
  // Fail fast, then retry. A per-attempt timeout (llm.timeout_ms) turns a hang
  // into a quick failure; a hung `claude` under launchd is bimodal — answers in a
  // minute or never — so a fresh attempt has a real chance where waiting longer
  // does not (#199). Only a timeout is retried: a real error (bad model, spent
  // budget, missing key) would fail identically and only burn budget/quota.
  const maxAttempts = resolveMaxAttempts(input.config);
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await dispatchAgent(provider, input);
    } catch (error) {
      if (error instanceof AgentTimeoutError && attempt < maxAttempts) {
        console.warn(`[agent] ${provider} 第 ${attempt}/${maxAttempts} 次尝试超时，快速失败后立即重试。`);
        continue;
      }
      throw error;
    }
  }
}

function dispatchAgent(provider: string, input: AgentInput): Promise<string> {
  if (provider === 'anthropic') return runAnthropicAgent(input);
  if (provider === 'openai') return runOpenAiAgent(input);
  if (provider === 'claude') return runClaudeAgent(input);
  return runCodexAgent(input);
}

/**
 * The binary each CLI provider runs, resolved the same way the agent will.
 *
 * Kept next to the dispatcher so the probe and the real run can never disagree
 * about which executable is being judged — probing `claude` on PATH and then
 * running the one in `CLAUDE_BIN` would make the verdict meaningless.
 */
function cliBinFor(provider: string): string {
  if (provider === 'claude') return process.env.CLAUDE_BIN || 'claude';
  if (provider === 'codex') return process.env.CODEX_BIN || 'codex';
  return provider;
}
