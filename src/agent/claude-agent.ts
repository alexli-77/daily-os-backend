import os from 'node:os';
import { runCommand } from '../utils/command.js';
import type { AgentInput } from './openai-agent.js';
import { buildCliPrompt, normalizeAgentOutput } from './openai-agent.js';
import { AgentTimeoutError, describeAgentTimeout, resolveAgentTimeoutMs, resolveIdleTimeoutMs } from './runtime-env.js';

export async function runClaudeAgent(input: AgentInput): Promise<string> {
  const claudeBin = process.env.CLAUDE_BIN || 'claude';
  const prompt = buildCliPrompt(input);
  const model = input.config.llm.model;
  // Stream JSON with partial messages so the run has a heartbeat: `claude` emits
  // token deltas as it works, which is what the idle timer watches. In plain
  // `--output-format text` nothing reaches stdout until the very end, so a
  // slow-but-working run and a hung one look identical — the mistake we are
  // avoiding (#199). `--verbose` is required for stream-json under `-p`.
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--strict-mcp-config',
  ];
  if (!['', 'default', 'auto'].includes(model.trim())) {
    args.push('--model', model);
  }
  const timeoutMs = resolveAgentTimeoutMs(input.config);
  const idleTimeoutMs = resolveIdleTimeoutMs(input.config);
  const startedAt = Date.now();
  const result = await runCommand(claudeBin, args, {
    input: prompt,
    timeoutMs: timeoutMs > 0 ? timeoutMs : undefined,
    idleTimeoutMs: idleTimeoutMs > 0 ? idleTimeoutMs : undefined,
    cwd: os.tmpdir(),
  });
  if (!result.ok) {
    if (result.timedOut) {
      const idle = result.timeoutKind === 'idle';
      throw new AgentTimeoutError(
        describeAgentTimeout('claude', model, prompt.length, Date.now() - startedAt, idle ? idleTimeoutMs : timeoutMs, idle ? 'idle' : 'total'),
      );
    }
    throw new Error(`Claude Code failed: ${describeClaudeFailure(result.stdout, result.stderr)}`);
  }
  return normalizeAgentOutput(extractStreamJsonText(result.stdout));
}

/**
 * The reason a `claude -p` run failed, in a form that fits the run ledger.
 *
 * The stream opens with SessionStart hook events, so the first 500 characters
 * of stdout — all the ledger keeps — were hook noise, and an expired login
 * failed two days of plans without anyone seeing why. The terminal
 * `type:"result"` event carries the actual message; prefer it. An expired or
 * missing login gets a plain fix, since the user has to do that one by hand.
 */
export function describeClaudeFailure(stdout: string, stderr: string): string {
  let reason = '';
  let authFailed = false;
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let event: { type?: string; is_error?: boolean; result?: unknown; error?: unknown; api_error_status?: unknown };
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (event.type === 'assistant' && event.error === 'authentication_failed') authFailed = true;
    if (event.type === 'result' && event.is_error && typeof event.result === 'string') {
      reason = event.result.trim();
      if (event.api_error_status === 401) authFailed = true;
    }
  }
  if (authFailed) {
    return `Claude Code 登录过期了，在终端运行 claude 再输入 /login 重新登录。（${reason || 'authentication_failed'}）`;
  }
  if (reason) return reason.slice(0, 3000);
  return (stderr.trim() || stdout).slice(0, 3000);
}

/**
 * Reconstruct the assistant's final text from a `stream-json` transcript.
 *
 * The stream is newline-delimited JSON. The terminal `type:"result"` event
 * carries the whole answer in `.result`; if it is missing (e.g. the stream was
 * cut) we fall back to concatenating the text blocks of every `assistant`
 * message. Non-JSON lines are ignored so a stray log line cannot break parsing.
 */
export function extractStreamJsonText(stdout: string): string {
  let resultText = '';
  const assistantChunks: string[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!event || typeof event !== 'object') continue;
    const record = event as { type?: string; result?: unknown; message?: { content?: unknown } };
    if (record.type === 'result' && typeof record.result === 'string') {
      resultText = record.result;
    } else if (record.type === 'assistant' && record.message && Array.isArray(record.message.content)) {
      for (const block of record.message.content) {
        if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
          const text = (block as { text?: unknown }).text;
          if (typeof text === 'string') assistantChunks.push(text);
        }
      }
    }
  }
  if (resultText.trim()) return resultText;
  if (assistantChunks.length > 0) return assistantChunks.join('');
  // Nothing parsed as stream-json — treat the raw stdout as the answer rather
  // than silently returning empty (keeps behavior sane if the format changes).
  return stdout;
}
