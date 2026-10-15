import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppConfig } from '../config/schema.js';
import { collectEvidence } from '../workflows/evidence.js';
import { todayInTimezone } from '../utils/date.js';
import { loadMemory } from '../storage/memory.js';
import { buildFeishuAgentContextPack } from './context-pack.js';
import { describeClaudeFailure } from '../agent/claude-agent.js';
import type { FeishuAccessDecision } from './access-policy.js';
import type { FeishuControlEffect } from './access-policy.js';
import type { FeishuSessionRecord } from './session-catalog.js';

export interface FeishuAgentBridgeContext {
  chatId: string;
  chatType: 'p2p' | 'group';
  senderId: string;
  threadId?: string;
  messageIds: string[];
  scopeId: string;
  scopeHash: string;
  source: 'feishu' | 'web';
}

export interface FeishuAgentModeInput {
  config: AppConfig;
  text: string;
  bridge: FeishuAgentBridgeContext;
  access: FeishuAccessDecision;
  session: FeishuSessionRecord;
  onEvent?: (event: FeishuAgentModeEvent) => void;
}

export interface FeishuAgentModeResult {
  reply: string;
  threadId?: string;
}

export interface FeishuAgentModeRun {
  runId: string;
  done: Promise<FeishuAgentModeResult>;
  stop: () => Promise<void>;
}

export interface FeishuAgentModeEvent {
  type: 'started' | 'thread' | 'progress' | 'stderr' | 'completed' | 'failed' | 'stopped' | 'timeout';
  message: string;
  threadId?: string;
}

export async function startFeishuAgentModeRun(input: FeishuAgentModeInput): Promise<FeishuAgentModeRun> {
  // Free chat runs on the same engine as the workflows. With provider=claude
  // that is the user's Claude subscription login, never an API key.
  if (input.config.llm.provider === 'claude') return startClaudeAgentModeRun(input);
  const runId = `run_${Date.now()}_${process.pid}`;
  const outputPath = path.join(os.tmpdir(), `daily-os-feishu-agent-${runId}.md`);
  const codexBin = process.env.CODEX_BIN || 'codex';
  const workdir = agentWorkdir(input.config);
  const args = codexArgs(input, outputPath, workdir);
  const prompt = await buildFeishuAgentPrompt(input);
  const child = spawn(codexBin, args, { stdio: ['pipe', 'pipe', 'pipe'], cwd: workdir, env: { ...process.env } });
  let stdout = '';
  let stderr = '';
  let threadId = input.session.codex_session_id;
  let stopped = false;
  let timedOut = false;
  let settled = false;
  let stdoutBuffer = '';

  const timeout = setTimeout(() => {
    stopped = true;
    timedOut = true;
    input.onEvent?.({ type: 'timeout', message: 'Codex 执行超时，正在停止。' });
    stopChild(child);
  }, input.config.interaction.feishu.agent_mode.timeout_ms);

  input.onEvent?.({ type: 'started', message: 'Codex 进程已启动。' });
  child.stdout.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    stdout += text;
    stdoutBuffer += text;
    const parsed = drainJsonLines(stdoutBuffer);
    stdoutBuffer = parsed.remainder;
    for (const event of parsed.events) {
      const progress = codexProgressEvent(event);
      if (progress.threadId) threadId = progress.threadId;
      if (progress.message) input.onEvent?.(progress);
    }
    threadId = parseThreadId(stdout) || threadId;
  });
  child.stderr.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    stderr += text;
    input.onEvent?.({ type: 'stderr', message: text.slice(0, 500) });
  });
  child.stdin.end(prompt, 'utf8');

  const done = new Promise<FeishuAgentModeResult>((resolve, reject) => {
    child.on('error', (error) => {
      clearTimeout(timeout);
      settled = true;
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      settled = true;
      const reply = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8').trim() : '';
      fs.rmSync(outputPath, { force: true });
      if (code === 0 || stopped) {
        if (timedOut) input.onEvent?.({ type: 'timeout', message: 'Codex 已因超时停止。' });
        else if (stopped) input.onEvent?.({ type: 'stopped', message: 'Codex 已停止。' });
        else input.onEvent?.({ type: 'completed', message: 'Codex 已完成。' });
        resolve({
          reply: timedOut ? 'Codex 执行超时，已停止当前会话。' : stopped ? '已停止当前 Codex 会话。' : reply || 'Codex 已完成，但没有返回可发送内容。',
          ...(threadId ? { threadId } : {}),
        });
        return;
      }
      input.onEvent?.({ type: 'failed', message: 'Codex 执行失败。' });
      reject(new Error(`Codex agent mode failed: ${(stderr || stdout).slice(0, 2000)}`));
    });
  });

  return {
    runId,
    done,
    stop: async () => {
      if (settled) return;
      stopped = true;
      input.onEvent?.({ type: 'stopped', message: '已请求停止 Codex。' });
      await stopChild(child);
    },
  };
}

/** Sessions are stored in the same field as Codex threads, tagged so neither engine resumes the other's id. */
const CLAUDE_SESSION_PREFIX = 'claude:';

/**
 * Free chat on `claude -p`, confined to `agent_mode.workdir`.
 *
 * - Built-in tools only, and no Bash: Read/Glob/Grep, plus Edit/Write unless
 *   the sandbox is read-only. Writes outside the working directory need a
 *   permission prompt, which `-p` cannot show, so they are refused.
 * - `--setting-sources project` keeps the user's own Claude Code settings —
 *   their hooks, plugins and output styles — out of the reply.
 * - `--strict-mcp-config` with no config: no MCP servers.
 */
export function claudeAgentArgs(config: AppConfig, session: FeishuSessionRecord): string[] {
  const writable = config.interaction.feishu.agent_mode.sandbox !== 'read-only';
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--strict-mcp-config',
    '--setting-sources',
    'project',
    '--tools',
    writable ? 'Read,Glob,Grep,Edit,Write' : 'Read,Glob,Grep',
    '--permission-mode',
    writable ? 'acceptEdits' : 'default',
  ];
  if (!['', 'default', 'auto'].includes(config.llm.model.trim())) args.push('--model', config.llm.model);
  const previous = session.codex_session_id;
  if (previous?.startsWith(CLAUDE_SESSION_PREFIX)) args.push('--resume', previous.slice(CLAUDE_SESSION_PREFIX.length));
  return args;
}

async function startClaudeAgentModeRun(input: FeishuAgentModeInput): Promise<FeishuAgentModeRun> {
  const runId = `run_${Date.now()}_${process.pid}`;
  const claudeBin = process.env.CLAUDE_BIN || 'claude';
  const workdir = agentWorkdir(input.config);
  const prompt = await buildFeishuAgentPrompt(input);
  const child = spawn(claudeBin, claudeAgentArgs(input.config, input.session), {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: workdir,
    env: { ...process.env },
  });
  let stdout = '';
  let stderr = '';
  let stdoutBuffer = '';
  let sessionId: string | undefined;
  let reply = '';
  let failed = false;
  let stopped = false;
  let timedOut = false;
  let settled = false;

  const timeout = setTimeout(() => {
    stopped = true;
    timedOut = true;
    input.onEvent?.({ type: 'timeout', message: '对话超时，正在停止。' });
    void stopChild(child);
  }, input.config.interaction.feishu.agent_mode.timeout_ms);

  input.onEvent?.({ type: 'started', message: '正在想…' });
  child.stdout.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    stdout += text;
    stdoutBuffer += text;
    const parsed = drainJsonLines(stdoutBuffer);
    stdoutBuffer = parsed.remainder;
    for (const event of parsed.events) {
      if (!isObject(event)) continue;
      if (event.type === 'system' && event.subtype === 'init' && typeof event.session_id === 'string') {
        sessionId = event.session_id;
      } else if (event.type === 'assistant') {
        const message = claudeToolProgress(event);
        if (message) input.onEvent?.({ type: 'progress', message });
      } else if (event.type === 'result') {
        if (typeof event.result === 'string') reply = event.result.trim();
        if (event.is_error) failed = true;
      }
    }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  child.stdin.end(prompt, 'utf8');

  const done = new Promise<FeishuAgentModeResult>((resolve, reject) => {
    child.on('error', (error) => {
      clearTimeout(timeout);
      settled = true;
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      settled = true;
      const threadId = sessionId ? `${CLAUDE_SESSION_PREFIX}${sessionId}` : undefined;
      if (stopped) {
        input.onEvent?.({ type: timedOut ? 'timeout' : 'stopped', message: timedOut ? '对话超时，已停止。' : '已停止。' });
        resolve({ reply: timedOut ? '这次对话超时了，已经停下。' : '已停止。', ...(threadId ? { threadId } : {}) });
        return;
      }
      if (code !== 0 || failed) {
        input.onEvent?.({ type: 'failed', message: '对话失败了。' });
        reject(new Error(describeClaudeFailure(stdout, stderr)));
        return;
      }
      input.onEvent?.({ type: 'completed', message: '完成。' });
      resolve({ reply: reply || '做完了，但没有回复内容。', ...(threadId ? { threadId } : {}) });
    });
  });

  return {
    runId,
    done,
    stop: async () => {
      if (settled) return;
      stopped = true;
      await stopChild(child);
    },
  };
}

/** "正在改 routines.json" for an assistant turn that calls a tool; empty otherwise. */
function claudeToolProgress(event: Record<string, unknown>): string {
  const message = isObject(event.message) ? event.message : null;
  const content = message && Array.isArray(message.content) ? message.content : [];
  for (const block of content) {
    if (!isObject(block) || block.type !== 'tool_use') continue;
    const toolInput = isObject(block.input) ? block.input : {};
    const target = typeof toolInput.file_path === 'string' ? path.basename(toolInput.file_path) : typeof toolInput.pattern === 'string' ? toolInput.pattern : '';
    const verb = block.name === 'Edit' || block.name === 'Write' ? '正在改' : '正在看';
    return target ? `${verb} ${target}` : `${verb}文件`;
  }
  return '';
}

export function agentWorkdir(config: AppConfig): string {
  return path.resolve(config.interaction.feishu.agent_mode.workdir.trim() || process.cwd());
}

export function agentModeControlEffect(config: AppConfig): FeishuControlEffect {
  const sandbox = config.interaction.feishu.agent_mode.sandbox;
  if (sandbox === 'read-only') return 'workspace_read';
  if (sandbox === 'workspace-write') return 'workspace_write';
  return 'full_control';
}

function codexArgs(input: FeishuAgentModeInput, outputPath: string, workdir: string): string[] {
  const agent = input.config.interaction.feishu.agent_mode;
  const common = ['--skip-git-repo-check', '--ignore-rules', '--json', '--output-last-message', outputPath];
  if (!['', 'default', 'auto'].includes(input.config.llm.model.trim())) {
    common.push('-m', input.config.llm.model);
  }

  if (input.session.codex_session_id) {
    return ['exec', 'resume', ...common, input.session.codex_session_id, '-'];
  }

  if (agent.sandbox === 'danger-full-access') {
    common.push('--sandbox', 'danger-full-access');
  } else {
    common.push('--sandbox', agent.sandbox);
  }
  return ['exec', ...common, '--cd', workdir, '-'];
}

/**
 * Where things live in the vault, for a chat that is asked to change them.
 * The pages read these files directly, so an edit shows up on the next load.
 */
const DAILY_OS_FILE_GUIDE = [
  '当前工作目录就是 Daily OS 的数据目录，用户让你改作息、排期、要务、OKR 时，直接改这里的文件。',
  '00_System/routines.json：作息。periods[].dayTypes[].modes[].blocks[] 是每种日子的时间块（id、title、start、end，时间用 HH:mm）；dayOverrides 按日期放单日改动。改时间块时保留 id，同一 mode 里按 start 排好顺序。',
  '20_CYCLES/<周期>.md：双周周期，要务在里面；20_CYCLES/<周期>.schedule.json：这个周期的排期。',
  '10_OKR/：OKR。rhythm.md：作息规则的文字说明。',
  '改 JSON 时保持合法 JSON，不要动和这次请求无关的字段。改之前先读文件，改完用一两句话说清改了什么。',
  '今天的计划不在这个目录，改不了；用户想改今天的计划，告诉他们在今天页上改，或者改作息后重新生成。',
  '不确定用户指的是哪一块、改动可能影响很多天时，先问一句再改。',
];

async function buildFeishuAgentPrompt(input: FeishuAgentModeInput): Promise<string> {
  const context = await buildOptionalContext(input);
  return [
    section('bridge_context', input.bridge),
    section('session', {
      scope_id: input.session.scope_id,
      has_codex_session: Boolean(input.session.codex_session_id),
      workdir: agentWorkdir(input.config),
      sandbox: input.config.interaction.feishu.agent_mode.sandbox,
      access_role: input.access.role,
      access_level: input.config.interaction.feishu.security.access_level,
    }),
    section('instructions', [
      input.config.llm.provider === 'claude' ? '你是 Daily OS 里的对话助手。' : '你是 Daily OS 的 Feishu 远程 Codex agent mode。',
      input.bridge.source === 'web' ? '用中文回复，回复显示在 Daily OS 的对话页里。' : '用中文回复，回复内容会直接发回飞书。',
      '优先像助手一样和用户自然协作；如果需要执行代码或读取文件，遵守当前 sandbox 和远程控制策略。',
      '不要泄露 token、密钥、完整本地隐私路径或隐藏推理。',
      '如果用户要求超出当前权限，解释缺少的配置或权限，不要假装已经执行。',
      '如果你完成了可以由 Codex 代做的工作，简短说明结果、文件或下一步。',
      '当 daily_os_context 里有 context_pack 时，把它当成当前 Daily OS 助手工作台：先看最新 workflow、progress ledger、decision policy 和 evidence summary。',
      '如果 context_pack.pending_background_suggestions 存在，用户可能会用“第 N 条”“刚才那个”“这些都忽略/写入/改成……”来跟进后台建议；请按自然语言理解并继续操作。',
      '回答计划/复盘/任务优先级问题时，用“确认的 / 暂缓的 / 新增的”组织，不要输出原始证据流水账。',
      '涉及分工时明确写出“Codex 可以做”和“需要用户本人做”。',
    ]),
    input.config.llm.provider === 'claude' ? section('daily_os_files', DAILY_OS_FILE_GUIDE) : '',
    context ? section('daily_os_context', context) : '',
    section('user_input', { text: input.text }),
  ]
    .filter(Boolean)
    .join('\n\n');
}

async function buildOptionalContext(input: FeishuAgentModeInput): Promise<unknown> {
  const agent = input.config.interaction.feishu.agent_mode;
  const context: Record<string, unknown> = {};
  if (agent.context_pack.enabled) context.context_pack = await buildFeishuAgentContextPack(input.config);
  if (agent.include_memory) context.memory = loadMemory(input.config);
  if (agent.include_evidence) context.raw_evidence = await buildEvidenceContext(input.config);
  return Object.keys(context).length > 0 ? context : null;
}

export async function buildEvidenceContext(config: AppConfig): Promise<unknown | null> {
  if (!config.interaction.feishu.agent_mode.include_evidence) return null;
  return collectEvidence(config, todayInTimezone(config));
}

function section(tag: string, value: unknown): string {
  return `<${tag}>\n${safeJson(value)}\n</${tag}>`;
}

function safeJson(value: unknown): string {
  return (JSON.stringify(value, null, 2) || 'null')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function parseThreadId(stdout: string): string | undefined {
  for (const line of stdout.split('\n')) {
    try {
      const parsed = JSON.parse(line) as { type?: unknown; thread_id?: unknown };
      if (parsed.type === 'thread.started' && typeof parsed.thread_id === 'string') return parsed.thread_id;
    } catch {
      // Ignore non-JSON progress lines.
    }
  }
  return undefined;
}

function drainJsonLines(buffer: string): { events: unknown[]; remainder: string } {
  const lines = buffer.split('\n');
  const remainder = lines.pop() ?? '';
  const events: unknown[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // Ignore non-JSON progress lines.
    }
  }
  return { events, remainder };
}

function codexProgressEvent(event: unknown): FeishuAgentModeEvent {
  if (!isObject(event)) return { type: 'progress', message: '' };
  const type = typeof event.type === 'string' ? event.type : '';
  if (type === 'thread.started' && typeof event.thread_id === 'string') {
    return { type: 'thread', message: 'Codex 会话已建立。', threadId: event.thread_id };
  }
  if (type === 'turn.started') return { type: 'progress', message: 'Codex 正在处理这轮请求。' };
  if (type === 'turn.completed') return { type: 'progress', message: 'Codex 已完成这轮请求。' };
  if (type === 'item.started') return { type: 'progress', message: describeCodexItem(event, '开始') };
  if (type === 'item.completed') return { type: 'progress', message: describeCodexItem(event, '完成') };
  if (type === 'error') return { type: 'failed', message: stringifyEventMessage(event) || 'Codex 返回错误事件。' };
  return { type: 'progress', message: '' };
}

function describeCodexItem(event: Record<string, unknown>, verb: string): string {
  const item = isObject(event.item) ? event.item : event;
  const itemType = typeof item.type === 'string' ? item.type : 'step';
  if (itemType.includes('command') || itemType.includes('exec')) return `${verb}执行本地命令。`;
  if (itemType.includes('tool')) return `${verb}调用工具。`;
  if (itemType.includes('message')) return `${verb}生成回复。`;
  if (itemType.includes('reasoning')) return `${verb}推理步骤。`;
  return `${verb}处理步骤。`;
}

function stringifyEventMessage(event: Record<string, unknown>): string {
  for (const key of ['message', 'error', 'detail']) {
    const value = event[key];
    if (typeof value === 'string') return value;
  }
  return '';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      resolve();
    }, 5000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
