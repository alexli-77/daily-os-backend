import os from 'node:os';
import { runCommand } from '../utils/command.js';
import type { AgentInput } from './openai-agent.js';
import { buildCliPrompt, normalizeAgentOutput } from './openai-agent.js';
import { AgentTimeoutError, describeAgentTimeout, resolveAgentTimeoutMs } from './runtime-env.js';

export async function runClaudeAgent(input: AgentInput): Promise<string> {
  const claudeBin = process.env.CLAUDE_BIN || 'claude';
  const prompt = buildCliPrompt(input);
  const model = input.config.llm.model;
  const args = ['-p', '--output-format', 'text', '--strict-mcp-config'];
  if (!['', 'default', 'auto'].includes(model.trim())) {
    args.push('--model', model);
  }
  const timeoutMs = resolveAgentTimeoutMs(input.config);
  const startedAt = Date.now();
  const result = await runCommand(claudeBin, args, {
    input: prompt,
    timeoutMs: timeoutMs > 0 ? timeoutMs : undefined,
    cwd: os.tmpdir(),
  });
  if (!result.ok) {
    if (result.timedOut) {
      throw new AgentTimeoutError(describeAgentTimeout('claude', model, prompt.length, Date.now() - startedAt, timeoutMs));
    }
    throw new Error(`Claude Code failed: ${(result.stderr || result.stdout).slice(0, 3000)}`);
  }
  return normalizeAgentOutput(result.stdout);
}
