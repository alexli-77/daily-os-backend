import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCommand } from '../utils/command.js';
import type { AgentInput } from './openai-agent.js';
import { buildCliPrompt, normalizeAgentOutput } from './openai-agent.js';
import { AgentTimeoutError, describeAgentTimeout, resolveAgentTimeoutMs } from './runtime-env.js';

export async function runCodexAgent(input: AgentInput): Promise<string> {
  const codexBin = process.env.CODEX_BIN || 'codex';
  const prompt = buildCliPrompt(input);
  const model = input.config.llm.model;
  const outputPath = path.join(os.tmpdir(), `daily-os-feishu-${Date.now()}-${process.pid}.md`);
  const args = [
    'exec',
    '--skip-git-repo-check',
    '--ignore-rules',
    '--ephemeral',
    '--output-last-message',
    outputPath,
    '-',
  ];
  if (!['', 'default', 'auto'].includes(model.trim())) {
    args.splice(4, 0, '-m', model);
  }
  const timeoutMs = resolveAgentTimeoutMs(input.config);
  const startedAt = Date.now();
  const result = await runCommand(codexBin, args, {
    input: prompt,
    timeoutMs: timeoutMs > 0 ? timeoutMs : undefined,
  });
  if (!result.ok) {
    if (result.timedOut) {
      throw new AgentTimeoutError(describeAgentTimeout('codex', model, prompt.length, Date.now() - startedAt, timeoutMs));
    }
    throw new Error(`Codex failed: ${(result.stderr || result.stdout).slice(0, 3000)}`);
  }
  const text = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : result.stdout;
  fs.rmSync(outputPath, { force: true });
  return normalizeAgentOutput(text);
}
