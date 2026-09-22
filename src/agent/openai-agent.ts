import fs from 'node:fs';
import path from 'node:path';
import OpenAI from 'openai';
import type { AppConfig, WorkflowName } from '../config/schema.js';
import type { Evidence } from '../workflows/types.js';
import type { MemoryBundle } from '../storage/memory.js';
import { billingFromConfig, checkBudget, estimateCostUsd, recordUsage } from './token-meter.js';
import { bundledAsset } from '../utils/install-root.js';
import { fitEvidenceToBudget } from '../workflows/evidence-budget.js';
import { renderRhythmPromptSection, resolveDayShape } from '../user/rhythm.js';
import { AgentTimeoutError, describeAgentTimeout, resolveAgentTimeoutMs } from './runtime-env.js';

export interface AgentInput {
  config: AppConfig;
  workflow: WorkflowName;
  date: string;
  evidence: Evidence;
  memory: MemoryBundle;
  /** Stable id for the current workflow run; used for per-task budget accounting. */
  runId?: string;
}

export async function runOpenAiAgent(input: AgentInput): Promise<string> {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required when llm.provider=openai');
  const billing = billingFromConfig(input.config);
  const runId = input.runId ?? `${input.workflow}-${input.date}`;
  // Three-tier budget circuit breaker: block the call if any tier is already spent.
  checkBudget(billing, { runId });
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const timeoutMs = resolveAgentTimeoutMs(input.config);
  const userPrompt = buildUserPrompt(input);
  const startedAt = Date.now();
  let response;
  try {
    response = await client.chat.completions.create(
      {
        model: input.config.llm.model,
        messages: [
          { role: 'system', content: buildSystemPrompt() },
          { role: 'user', content: userPrompt },
        ],
      },
      // timeout_ms=0 disables the cap (daily-os #199); otherwise the SDK aborts
      // the request at the configured bound.
      timeoutMs > 0 ? { timeout: timeoutMs } : {},
    );
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    if (/timeout/i.test(name) || (error instanceof Error && /timed out/i.test(error.message))) {
      throw new AgentTimeoutError(describeAgentTimeout('openai', input.config.llm.model, userPrompt.length, Date.now() - startedAt, timeoutMs));
    }
    throw error;
  }
  const inputTokens = response.usage?.prompt_tokens ?? 0;
  const outputTokens = response.usage?.completion_tokens ?? 0;
  const cost = estimateCostUsd(input.config.llm.model, inputTokens, outputTokens, billing.price_overrides);
  recordUsage(runId, 'openai', input.config.llm.model, inputTokens, outputTokens, cost);
  return normalizeAgentOutput(response.choices[0]?.message.content || '');
}

export function buildSystemPrompt(): string {
  return [readPrompt('system.md'), outputContract()].join('\n\n');
}

export function buildCliPrompt(input: AgentInput): string {
  return [`# System\n${buildSystemPrompt()}`, buildUserPrompt(input)].join('\n\n');
}

export function buildUserPrompt(input: AgentInput): string {
  const workflowPrompt = readPrompt(`${input.workflow}.md`);
  // Every provider funnels through here, so the budget cannot be bypassed by
  // picking a different `llm.provider` — which matters, because the prompt that
  // was too big for Codex was exactly as too big for Claude.
  const { evidence, notes } = fitEvidenceToBudget(input.evidence, input.workflow);
  for (const note of notes) console.warn(`[evidence] ${note}`);
  // The date line used to be the bare `2026-09-13`, which left the model to
  // derive the weekday itself — a calculation models get wrong often enough that
  // "don't plan seven work items on my Saturday" could not be stated as a rule,
  // because nothing downstream reliably knew it was Saturday. Spell it out.
  const shape = resolveDayShape(input.config, input.date);
  const rhythmSection = renderRhythmPromptSection(input.config, input.date);
  return [
    `# Workflow\n${workflowPrompt}`,
    `# User\n${JSON.stringify(input.config.user, null, 2)}`,
    `# Planning Configuration\n${JSON.stringify(input.config.planning, null, 2)}`,
    `# Date\n${input.date} ${shape.weekdayLabel}${shape.enabled ? `（${shape.dayTypeLabel}）` : ''}`,
    ...(rhythmSection ? [`# 作息\n${rhythmSection}`] : []),
    `# Memory\n${JSON.stringify(input.memory, null, 2)}`,
    // Compact rather than indented. Two-space indentation on a JSON document
    // this size is tens of thousands of characters of whitespace that carries
    // no meaning to a model — it was pure context spent on looking tidy.
    `# Evidence\n${JSON.stringify(evidence)}`,
    '# 输出',
    '只返回最终可直接发送到飞书的消息。不要包含工具调用或隐藏推理过程。',
  ].join('\n\n');
}

export function normalizeAgentOutput(text: string): string {
  return text
    .replace(/^\s*```(?:markdown|md|text)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .split('\n')
    .map((line) =>
      line
        .replace(/^\s*-{3,}\s*$/, '')
        .replace(/^(\s*#{1,4}\s*)?\*\*\s*\d+[.)、]\s*([^*]+?)\s*\*\*\s*$/, '**$2**')
        .replace(/^(\s*#{1,4}\s*)?\d+[.)、]\s+(今日重点|为什么|Codex|用户|暂不|阻塞|重要信号|已完成|已推进|没完成|未闭环|需要您|明天|缺失|本周|下周|OKR|优先级|MIT)(.*)$/, '$1$2$3'),
    )
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function outputContract(): string {
  return [
    '# Daily OS 输出契约',
    '- 这个契约对 codex、claude、openai 三种 provider 都生效；provider 只能影响调用方式，不能影响用户看到的结构和语气。',
    '- 严格按当前 Workflow 要求的栏目输出；不要擅自新增“总结”“分析”“建议”等报告模板栏目。',
    '- 栏目标题不要编号；写“已完成 / 已推进”，不要写“1. 已完成 / 已推进”。',
    '- 不要使用 Markdown 分隔线 `---`、代码块、表格，除非 Workflow 明确要求。',
    '- 语气像真人助理给老板发工作便签：短句、具体、可执行。不要写成长篇项目报告。',
    '- 每条事项必须说明：是什么、为什么重要、下一步怎么处理；不能只写短标签。',
    '- 飞书卡片和看详情使用同一份正文，因此正文必须适合直接展示给用户。',
  ].join('\n');
}

function readPrompt(name: string): string {
  return fs.readFileSync(bundledAsset('prompts', name), 'utf8');
}
