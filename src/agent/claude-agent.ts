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
    throw new Error(`Claude Code failed: ${(result.stderr || result.stdout).slice(0, 3000)}`);
  }
  return normalizeAgentOutput(extractStreamJsonText(result.stdout));
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
