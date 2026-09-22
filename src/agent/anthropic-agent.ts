import type { AgentInput } from './openai-agent.js';
import { buildSystemPrompt, buildUserPrompt, normalizeAgentOutput } from './openai-agent.js';
import {
  billingFromConfig,
  checkBudget,
  estimateCostUsd,
  recordUsage,
} from './token-meter.js';
import { AgentTimeoutError, describeAgentTimeout, resolveAgentTimeoutMs } from './runtime-env.js';

/**
 * Anthropic API-key provider — a first-class programmatic provider that talks to
 * the Anthropic Messages API directly over Node 22's built-in fetch. No SDK, no
 * new dependency. This is the compliant path for scheduled/programmatic runs
 * (subscription CLIs are not licensed for automation).
 */

const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-sonnet-5';
// Headroom over the small JSON outputs these workflows emit (a daily plan is 5-8
// short todos). The old 4096 cap could truncate a plan/review mid-array, and the
// caller then saw invalid JSON; see the stop_reason guard below.
const MAX_TOKENS = 8192;

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
}

interface AnthropicResponse {
  content?: Array<{ type?: string; text?: string }>;
  usage?: AnthropicUsage;
  stop_reason?: string;
  error?: { type?: string; message?: string };
}

export function resolveAnthropicModel(model: string): string {
  const trimmed = (model ?? '').trim();
  if (['', 'default', 'auto'].includes(trimmed)) return DEFAULT_MODEL;
  return trimmed;
}

function runIdFor(input: AgentInput): string {
  return input.runId ?? `${input.workflow}-${input.date}`;
}

export async function runAnthropicAgent(input: AgentInput): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is required when llm.provider=anthropic');

  const model = resolveAnthropicModel(input.config.llm.model);
  const billing = billingFromConfig(input.config);
  const runId = runIdFor(input);

  // Three-tier budget circuit breaker: block the call if any tier is already spent.
  checkBudget(billing, { runId });

  const timeoutMs = resolveAgentTimeoutMs(input.config);
  const userPrompt = buildUserPrompt(input);
  const startedAt = Date.now();
  const controller = new AbortController();
  // timeout_ms=0 disables the cap entirely (daily-os #199): a legitimately slow
  // long-context generation is allowed to finish rather than being killed.
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
  let response: Response;
  try {
    response = await fetch(ANTHROPIC_MESSAGES_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model,
        max_tokens: MAX_TOKENS,
        system: buildSystemPrompt(),
        messages: [{ role: 'user', content: userPrompt }],
      }),
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new AgentTimeoutError(describeAgentTimeout('anthropic', model, userPrompt.length, Date.now() - startedAt, timeoutMs));
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }

  const raw = await response.text();
  let payload: AnthropicResponse;
  try {
    payload = JSON.parse(raw) as AnthropicResponse;
  } catch {
    throw new Error(`Anthropic API returned non-JSON response (status ${response.status}): ${raw.slice(0, 500)}`);
  }

  if (!response.ok || payload.error) {
    const message = payload.error?.message || raw.slice(0, 500);
    throw new Error(`Anthropic API failed (status ${response.status}): ${message}`);
  }

  // The response was cut off at max_tokens: the text is truncated (e.g. a workflow's
  // JSON stops mid-array). Fail loudly instead of returning half a document that the
  // caller cannot parse — a retry/regenerate is the correct recovery.
  if (payload.stop_reason === 'max_tokens') {
    throw new Error(`Anthropic API truncated the response at max_tokens=${MAX_TOKENS}; output is incomplete.`);
  }

  const text = (payload.content ?? [])
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('');

  const inputTokens = payload.usage?.input_tokens ?? 0;
  const outputTokens = payload.usage?.output_tokens ?? 0;
  const cost = estimateCostUsd(model, inputTokens, outputTokens, billing.price_overrides);
  recordUsage(runId, 'anthropic', model, inputTokens, outputTokens, cost);

  return normalizeAgentOutput(text);
}
