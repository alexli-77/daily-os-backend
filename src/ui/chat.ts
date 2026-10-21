import crypto from 'node:crypto';
import type { AppConfig } from '../config/schema.js';
import type { Role } from './auth.js';
import {
  activeFeishuSession,
  clearFeishuSession,
  ensureFeishuSession,
  listActiveSessions,
  updateSessionByScopeId,
  type FeishuSessionRecord,
} from '../interaction/session-catalog.js';
import {
  agentModeControlEffect,
  agentWorkdir,
  startFeishuAgentModeRun,
  type FeishuAgentModeEvent,
  type FeishuAgentModeRun,
} from '../interaction/agent-mode.js';
import { decideFeishuControl, type FeishuAccessDecision } from '../interaction/access-policy.js';
import { handleDailyOsCommand, parseDailyOsCommand } from '../interaction/daily-os-command.js';
import { billingFromConfig, BudgetExceededError, checkBudget, recordUsage } from '../agent/token-meter.js';
import { scanAndIndex } from '../storage/artifacts.js';
import { dbInsertChatMessage, dbListChatMessages, dbListChatSessions } from '../storage/db.js';

/**
 * LEO-236 — web console chat controller. It wires the browser Chat page into the
 * exact same backends the Feishu agent-mode channel uses:
 *
 *   - session continuity + channel separation via session-catalog (channel='web')
 *   - access-policy (member → allowed_chat = whitelist-only) via decideFeishuControl
 *   - workflow / todo / status commands via handleDailyOsCommand (run-ledger inside)
 *   - free-form Q&A (with vault/OKR evidence) via startFeishuAgentModeRun (codex)
 *   - TokenMeter budget circuit-breaker + per-turn usage ledger entry
 *   - Artifacts index refresh after each turn
 *
 * Nothing here touches the Feishu network, so the page keeps working with
 * interaction.feishu.enabled = false (M8: "Feishu can be fully disabled").
 */

const CHANNEL = 'web';

export type WebChatEvent =
  | { type: 'started'; runId: string }
  | { type: 'status'; message: string }
  | { type: 'reply'; content: string }
  | { type: 'denied'; message: string }
  | { type: 'error'; message: string }
  | { type: 'stopped' }
  | { type: 'done'; runId: string };

export interface WebChatSessionSummary {
  id: string;
  title: string;
  messages: number;
  updatedAt: string;
}

export interface WebChatMessage {
  id: string;
  role: string;
  content: string;
  createdAt: string;
}

// Active codex runs keyed by scope_id, so a Stop button (or a client disconnect)
// can terminate the in-flight turn for that session.
const activeRuns = new Map<string, FeishuAgentModeRun>();

/**
 * Map a web console role to a Feishu access decision so the shared control policy
 * applies unchanged: admin behaves like the owner (full command surface), member
 * behaves like an allowed_chat participant (read + workflow_trigger only). This is
 * what makes "member 仅白名单指令 / 越权被拒" fall out of the existing policy.
 */
export function mapWebRoleToAccess(role: Role): FeishuAccessDecision {
  if (role === 'admin') return { ok: true, role: 'owner' };
  return { ok: true, role: 'allowed_chat' };
}

function scopeKeyForNewSession(): string {
  return `web:${crypto.randomBytes(12).toString('hex')}`;
}

export function createWebChatSession(config: AppConfig): WebChatSessionSummary {
  const scopeKey = scopeKeyForNewSession();
  const record = ensureFeishuSession(
    config,
    { scopeKey, chatId: scopeKey, chatType: 'p2p', mode: 'p2p', channel: CHANNEL },
    { workdir: agentWorkdir(config) },
  );
  return { id: record.scope_id, title: 'New chat', messages: 0, updatedAt: record.updated_at };
}

export function listWebChatSessions(config: AppConfig): WebChatSessionSummary[] {
  const sessions = listActiveSessions(config, CHANNEL);
  const byId = new Map(dbListChatSessions(CHANNEL).map((row) => [row.session_id, row]));
  return sessions.map((record) => {
    const row = byId.get(record.scope_id);
    return {
      id: record.scope_id,
      title: sessionTitle(row?.first_user_content),
      messages: row?.messages ?? 0,
      updatedAt: record.updated_at,
    };
  });
}

export function listWebChatMessages(sessionId: string): WebChatMessage[] {
  return dbListChatMessages(sessionId).map((row) => ({
    id: row.id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
  }));
}

export function deleteWebChatSession(config: AppConfig, sessionId: string): boolean {
  return clearFeishuSession(config, sessionId, 'web_deleted');
}

/**
 * Whether a member (allowed_chat) is permitted to run the given text as a turn.
 * Used by the HTTP layer to reject over-privileged turns with a clean 403 before
 * opening the SSE stream. Commands enforce their own control inside the run.
 */
/**
 * Bare keywords a web-chat user can type without the `daily-os` prefix — the
 * console auto-completes them into full commands (typing "plan" should just
 * work). Exact match only, so free-form sentences never get hijacked.
 */
const BARE_COMMAND_KEYWORDS = new Set([
  'plan',
  'review',
  'weekly',
  'progress',
  'status',
  'details',
  'help',
  '计划',
  '复盘',
  '周报',
  '写回',
  '写回预览',
  '确认写回',
  '确认写回 okr',
  '写入 review',
  '确认写入 review',
  'write review',
  'confirm write review',
  'okr writeback',
  'okr 写回',
]);

/** Short aliases that expand into full command bodies (still prefixed). */
const COMMAND_ALIASES = new Map<string, string>([
  ['biweekly', 'skills run weekly-review biweekly'],
  ['双周复盘', 'skills run weekly-review biweekly'],
  // The evening review of today, named so it is not read as the cycle's 复盘.
  ['今日复盘', 'review'],
  ['quarterly', 'skills run weekly-review quarterly'],
]);

export function autoPrefixCommand(text: string, prefix: string): string {
  const trimmed = text.trim();
  const exactAlias = COMMAND_ALIASES.get(trimmed.toLowerCase());
  if (exactAlias) return `${prefix} ${exactAlias}`;
  if (BARE_COMMAND_KEYWORDS.has(trimmed.toLowerCase())) return `${prefix} ${trimmed}`;
  // Keyword with trailing text after a colon: `biweekly : 7.27 做了X` /
  // `plan：今天优先Y`. The head must still be an exact keyword/alias, so
  // free-form sentences are never hijacked.
  const colon = trimmed.match(/^([^:：]+?)\s*[:：]\s*([\s\S]+)$/);
  if (colon) {
    const head = colon[1].trim().toLowerCase();
    const rest = colon[2].trim();
    const headAlias = COMMAND_ALIASES.get(head);
    if (headAlias) return `${prefix} ${headAlias} : ${rest}`;
    if (BARE_COMMAND_KEYWORDS.has(head)) return `${prefix} ${colon[1].trim()} : ${rest}`;
  }
  return trimmed;
}

export function isWebChatTurnAllowed(
  config: AppConfig,
  role: Role,
  text: string,
): { ok: true } | { ok: false; reason: string } {
  const access = mapWebRoleToAccess(role);
  const command = parseDailyOsCommand(autoPrefixCommand(text, config.interaction.feishu.command_prefix), config.interaction.feishu.command_prefix);
  if (command.type !== 'ignore') return { ok: true }; // command control enforced in handleDailyOsCommand
  const control = decideFeishuControl(config, access, {
    effect: agentModeControlEffect(config),
    workspacePath: agentWorkdir(config),
  });
  return control.ok ? { ok: true } : { ok: false, reason: control.reason || 'not permitted' };
}

export async function stopWebChatSession(sessionId: string): Promise<boolean> {
  const run = activeRuns.get(sessionId);
  if (!run) return false;
  await run.stop();
  return true;
}

export interface RunWebChatTurnInput {
  config: AppConfig;
  sessionId: string;
  role: Role;
  text: string;
  onEvent: (event: WebChatEvent) => void;
}

export async function runWebChatTurn(input: RunWebChatTurnInput): Promise<void> {
  const { config, sessionId, role, text, onEvent } = input;
  const trimmed = text.trim();
  if (!trimmed) {
    onEvent({ type: 'error', message: '消息为空。' });
    return;
  }

  const session = activeFeishuSession(config, sessionId);
  if (!session || session.channel !== CHANNEL) {
    onEvent({ type: 'error', message: '会话不存在或已归档，请新建会话。' });
    return;
  }

  const access = mapWebRoleToAccess(role);
  const runId = `web-${sessionId.slice(0, 12)}-${Date.now()}`;
  persistMessage(sessionId, 'user', trimmed, null);
  onEvent({ type: 'started', runId });

  // Per-turn budget circuit-breaker (shared TokenMeter). Blocks the turn if any
  // tier (per-task / daily / monthly) is already spent.
  try {
    checkBudget(billingFromConfig(config), { runId });
  } catch (error) {
    if (error instanceof BudgetExceededError) {
      const message = error.message;
      persistMessage(sessionId, 'assistant', message, runId);
      onEvent({ type: 'error', message });
      onEvent({ type: 'done', runId });
      return;
    }
    throw error;
  }

  // Record a per-turn usage marker so every conversation turn lands in the ledger,
  // even read-only commands. Real token spend from a triggered workflow / LLM call
  // is recorded separately by that call under its own runId.
  recordUsage(runId, 'web_chat', config.llm.model || 'unknown', 0, 0, 0);

  // Bare keywords ("plan") auto-complete into full commands ("daily-os plan").
  const effective = autoPrefixCommand(trimmed, config.interaction.feishu.command_prefix);
  const command = parseDailyOsCommand(effective, config.interaction.feishu.command_prefix);

  try {
    if (command.type !== 'ignore') {
      await runCommandTurn({ config, session, access, sessionId, text: effective, runId, onEvent });
    } else {
      await runAgentTurn({ config, session, access, sessionId, text: trimmed, runId, onEvent });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    persistMessage(sessionId, 'assistant', `执行失败：${message}`, runId);
    onEvent({ type: 'error', message });
  } finally {
    // Index any files the turn produced (workflow outputs, codex writes) so they
    // show up on the Artifacts page. Best-effort; never fail the turn on this.
    try {
      scanAndIndex();
    } catch {
      // ignore artifact indexing errors
    }
    onEvent({ type: 'done', runId });
  }
}

interface TurnContext {
  config: AppConfig;
  session: FeishuSessionRecord;
  access: FeishuAccessDecision;
  sessionId: string;
  text: string;
  runId: string;
  onEvent: (event: WebChatEvent) => void;
}

async function runCommandTurn(ctx: TurnContext): Promise<void> {
  const replies: string[] = [];
  const prefix = ctx.config.interaction.feishu.command_prefix;
  const parsed = parseDailyOsCommand(ctx.text, prefix);
  const isCycleReview = parsed.type === 'skill_run' && parsed.skillId === 'weekly-review';
  await handleDailyOsCommand({
    config: ctx.config,
    messageId: ctx.runId,
    text: ctx.text,
    source: `web-chat:${ctx.sessionId}`,
    prefix: ctx.config.interaction.feishu.command_prefix,
    // Keep channels in sync: a workflow triggered from web chat also pushes
    // its summary to the configured IM, same as a scheduler run (send degrades
    // gracefully when Feishu output is not configured).
    sendWorkflowOutput: true,
    accessDecision: ctx.access,
    sessionScopeId: ctx.sessionId,
    stopAgentRun: async () => stopWebChatSession(ctx.sessionId),
    reply: async (reply) => {
      const shown = isCycleReview ? condenseCycleReviewReply(reply) : reply;
      replies.push(shown);
      ctx.onEvent({ type: 'reply', content: shown });
    },
  });
  const completion = '执行完成。';
  replies.push(completion);
  ctx.onEvent({ type: 'reply', content: completion });
  const combined = replies.join('\n\n').trim() || '已处理。';
  persistMessage(ctx.sessionId, 'assistant', combined, ctx.runId);
}

/**
 * A 双周复盘 in the chat: what it wrote and where, not the draft itself.
 *
 * The full run output — every 要务 under its ### heading, the KR JSON — is the
 * cycle page's to show. Repeated in the chat it was noise, and the one line
 * that mattered (下期要务 已写入) sat at the bottom of it. Progress messages
 * and errors, which carry no cycle note, pass through unchanged.
 */
export function condenseCycleReviewReply(reply: string): string {
  const marker = reply.indexOf('📁 本地周期');
  if (marker === -1) return reply;
  const writes = reply
    .slice(marker)
    .split('\n')
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean);
  return ['双周复盘做完了：', ...writes.map((line) => `- ${line}`), '', '总结和下期要务在周期页，去那里看和改。'].join('\n');
}

async function runAgentTurn(ctx: TurnContext): Promise<void> {
  if (!ctx.config.interaction.feishu.agent_mode.enabled) {
    const message = '自由对话（agent mode）未启用。请在配置中开启 interaction.feishu.agent_mode.enabled，或使用 plan / review / weekly 等指令。';
    persistMessage(ctx.sessionId, 'assistant', message, ctx.runId);
    ctx.onEvent({ type: 'reply', content: message });
    return;
  }

  const control = decideFeishuControl(ctx.config, ctx.access, {
    effect: agentModeControlEffect(ctx.config),
    workspacePath: agentWorkdir(ctx.config),
  });
  if (!control.ok) {
    const message = `权限不足：${control.reason}`;
    persistMessage(ctx.sessionId, 'assistant', message, ctx.runId);
    ctx.onEvent({ type: 'denied', message });
    return;
  }

  const run = await startFeishuAgentModeRun({
    config: ctx.config,
    text: ctx.text,
    access: ctx.access,
    session: ctx.session,
    onEvent: (event: FeishuAgentModeEvent) => forwardAgentEvent(event, ctx.onEvent),
    bridge: {
      chatId: ctx.session.chat_id,
      chatType: 'p2p',
      senderId: `web:${ctx.access.role}`,
      messageIds: [ctx.runId],
      scopeId: ctx.session.scope_id,
      scopeHash: ctx.session.scope_hash,
      source: 'web',
    },
  });
  activeRuns.set(ctx.sessionId, run);
  try {
    const result = await run.done;
    if (result.threadId) updateSessionByScopeId(ctx.config, ctx.sessionId, { codexSessionId: result.threadId });
    else updateSessionByScopeId(ctx.config, ctx.sessionId, {});
    persistMessage(ctx.sessionId, 'assistant', result.reply, ctx.runId);
    ctx.onEvent({ type: 'reply', content: result.reply });
  } finally {
    activeRuns.delete(ctx.sessionId);
  }
}

function forwardAgentEvent(event: FeishuAgentModeEvent, onEvent: (event: WebChatEvent) => void): void {
  if (event.type === 'stopped' || event.type === 'timeout') {
    onEvent({ type: 'stopped' });
    return;
  }
  if (event.type === 'failed') {
    onEvent({ type: 'error', message: event.message });
    return;
  }
  if (event.type === 'completed') return; // final reply is emitted from run.done
  if (event.message) onEvent({ type: 'status', message: event.message });
}

function persistMessage(sessionId: string, role: 'user' | 'assistant' | 'system', content: string, runId: string | null): void {
  dbInsertChatMessage({
    id: `msg_${crypto.randomBytes(10).toString('hex')}`,
    session_id: sessionId,
    channel: CHANNEL,
    role,
    content,
    run_id: runId,
    created_at: new Date().toISOString(),
  });
}

function sessionTitle(firstUserContent: string | null | undefined): string {
  const text = (firstUserContent || '').trim().replace(/\s+/g, ' ');
  if (!text) return 'New chat';
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}
