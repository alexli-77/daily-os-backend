import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../config/schema.js';
import {
  analyzeChatContext,
  type ChatAnalysisMode,
  type ChatContextAnalysisResult,
  type ChatContextSuggestion,
} from '../chat/context-analysis.js';
import { sendFeishuMessage } from '../connectors/lark-cli.js';
import { notificationAllowed } from '../notifications/policy.js';
import { appendDailyMemory, appendFeedbackLog } from '../storage/memory.js';
import { todayInTimezone } from '../utils/date.js';

export interface BackgroundSuggestionsState {
  last_run_at?: string;
  next_run_at?: string;
  last_status?: 'success' | 'skipped' | 'error';
  last_error?: string;
  last_error_at?: string;
  last_suggestion_count?: number;
  last_inspected_messages?: number;
  last_sent_at?: string;
  last_signature?: string;
}

export interface PendingBackgroundSuggestions {
  created_at: string;
  expires_at: string;
  date: string;
  mode: ChatAnalysisMode;
  window_label: string;
  suggestions: PendingBackgroundSuggestion[];
}

export interface PendingBackgroundSuggestion {
  index: number;
  id: string;
  kind: string;
  title: string;
  summary: string;
  targets: string[];
  confidence: 'low' | 'medium' | 'high';
  owner?: string;
  due?: string;
}

export interface PendingBackgroundSuggestionReply {
  handled: boolean;
  reply?: string;
}

export async function runBackgroundSuggestions(config: AppConfig, now = new Date()): Promise<BackgroundSuggestionsState> {
  if (!config.background_suggestions.enabled) return readBackgroundSuggestionsState(config);
  const state = readBackgroundSuggestionsState(config);
  if (!isBackgroundSuggestionDue(config, state, now)) return state;

  try {
    const date = dateInZone(now, config.user.timezone);
    const result = await analyzeChatContext(config, date, config.background_suggestions.mode as ChatAnalysisMode);
    const suggestions = filterSuggestions(config, result.suggestions);
    const signature = suggestionSignature(suggestions);
    writePendingBackgroundSuggestions(config, result, suggestions, now);
    const nextState: BackgroundSuggestionsState = {
      ...state,
      last_run_at: now.toISOString(),
      next_run_at: nextRunAt(config, now).toISOString(),
      last_status: 'success',
      last_error: undefined,
      last_error_at: undefined,
      last_suggestion_count: suggestions.length,
      last_inspected_messages: result.inspected_messages,
      last_signature: signature,
    };

    const shouldSend =
      config.background_suggestions.send_to_feishu &&
      notificationAllowed(config, 'background_suggestions', 'feishu') &&
      suggestions.length > 0 &&
      (!config.background_suggestions.send_on_change_only || signature !== state.last_signature);
    if (shouldSend) {
      await sendFeishuMessage(config, formatBackgroundSuggestionsMessage(result, suggestions));
      nextState.last_sent_at = now.toISOString();
    }

    writeBackgroundSuggestionsState(config, nextState);
    return nextState;
  } catch (error) {
    const nextState: BackgroundSuggestionsState = {
      ...state,
      last_run_at: now.toISOString(),
      next_run_at: nextRunAt(config, now).toISOString(),
      last_status: 'error',
      last_error: safeErrorSummary(error),
      last_error_at: now.toISOString(),
    };
    writeBackgroundSuggestionsState(config, nextState);
    return nextState;
  }
}

export function readBackgroundSuggestionsState(config: AppConfig): BackgroundSuggestionsState {
  const statePath = backgroundSuggestionsStatePath(config);
  if (!fs.existsSync(statePath)) {
    return {
      next_run_at: nextRunAt(config, new Date()).toISOString(),
      last_status: 'skipped',
    };
  }
  try {
    return sanitizeState(JSON.parse(fs.readFileSync(statePath, 'utf8')));
  } catch {
    return {
      next_run_at: nextRunAt(config, new Date()).toISOString(),
      last_status: 'error',
      last_error: 'Could not read background suggestions state file.',
    };
  }
}

export function readPendingBackgroundSuggestions(config: AppConfig, now = new Date()): PendingBackgroundSuggestions | null {
  const pendingPath = backgroundSuggestionsPendingPath(config);
  if (!fs.existsSync(pendingPath)) return null;
  try {
    const pending = sanitizePending(JSON.parse(fs.readFileSync(pendingPath, 'utf8')));
    if (!pending) return null;
    if (Date.parse(pending.expires_at) <= now.getTime()) {
      fs.rmSync(pendingPath, { force: true });
      return null;
    }
    return pending;
  } catch {
    return null;
  }
}

export function handlePendingBackgroundSuggestionReply(
  config: AppConfig,
  text: string,
  metadata: { messageId: string; source: string; now?: Date },
): PendingBackgroundSuggestionReply {
  const pending = readPendingBackgroundSuggestions(config, metadata.now || new Date());
  if (!pending) return { handled: false };

  const parsed = parsePendingSuggestionReply(text, pending);
  if (!parsed) return { handled: false };

  const selected = pending.suggestions.filter((suggestion) => parsed.indexes.includes(suggestion.index));
  if (selected.length === 0) {
    return {
      handled: true,
      reply: `我现在只有 ${pending.suggestions.length} 条待确认建议。请回复“采纳第 1 条”或“忽略第 1 条”。`,
    };
  }

  if (parsed.action === 'dismiss') {
    appendFeedbackLog(
      config,
      selected.map((suggestion) => `用户不采纳后台建议 ${suggestion.index}：${suggestion.title}`).join('\n'),
      { message_id: metadata.messageId, source: metadata.source, action: 'dismiss_background_suggestion' },
    );
    writePendingBackgroundSuggestionSnapshot(config, {
      ...pending,
      suggestions: pending.suggestions.filter((suggestion) => !parsed.indexes.includes(suggestion.index)),
    });
    return {
      handled: true,
      reply: [
        `收到，已忽略${formatIndexes(selected)}。`,
        '',
        ...selected.map((suggestion) => `- ${suggestion.title}`),
        '',
        '我不会把它写入日历、Linear 或记忆库。',
      ].join('\n'),
    };
  }

  const date = todayInTimezone(config);
  const note = selected
    .map(
      (suggestion) =>
        `用户采纳后台建议 ${suggestion.index}：${suggestion.title}\n建议：${suggestion.summary}\n用户回复：${text.trim()}\n目标：${suggestion.targets.join('、')}`,
    )
    .join('\n\n');
  appendDailyMemory(config, selected.some((suggestion) => suggestion.targets.includes('review')) ? 'daily_review' : 'daily_plan', date, note);
  appendFeedbackLog(config, note, { message_id: metadata.messageId, source: metadata.source, action: 'accept_background_suggestion' });
  writePendingBackgroundSuggestionSnapshot(config, {
    ...pending,
    suggestions: pending.suggestions.filter((suggestion) => !parsed.indexes.includes(suggestion.index)),
  });

  return {
    handled: true,
    reply: [
      `收到，已记录${formatIndexes(selected)}。`,
      '',
      ...selected.map((suggestion) => `- ${suggestion.title}`),
      '',
      '我会在下一次计划/复盘里参考这条确认。',
      `你的回复：${text.trim()}`,
      '说明：我刚才只是记录了你的批示，还没有直接修改日历或 Linear。',
    ].join('\n'),
  };
}

function isBackgroundSuggestionDue(config: AppConfig, state: BackgroundSuggestionsState, now: Date): boolean {
  if (!config.chat_analysis.enabled) return false;
  if (!state.last_run_at) return true;
  const lastRun = Date.parse(state.last_run_at);
  if (!Number.isFinite(lastRun)) return true;
  return now.getTime() >= lastRun + config.background_suggestions.interval_minutes * 60_000;
}

function filterSuggestions(config: AppConfig, suggestions: ChatContextSuggestion[]): ChatContextSuggestion[] {
  const minimum = confidenceRank(config.background_suggestions.min_confidence);
  return suggestions.filter((suggestion) => confidenceRank(suggestion.confidence) >= minimum);
}

function formatBackgroundSuggestionsMessage(result: ChatContextAnalysisResult, suggestions: ChatContextSuggestion[]): string {
  return [
    `# 后台工作建议 - ${result.date}`,
    '',
    `老板，我在后台看了 ${result.inspected_messages} 条聊天记录，发现 ${suggestions.length} 件事可能需要你定一下。`,
    '',
    ...suggestions.slice(0, 5).flatMap((suggestion, index) => formatSuggestionForFeishu(suggestion, index + 1)),
    '',
    '你可以直接回复：',
    ...(suggestions.length === 1 ? ['- 不采纳这个建议', '- 采纳这个建议'] : ['- 不采纳全部', '- 不采纳第 1 条']),
    '- 采纳第 1 条',
    '- 第 1 条改成明天跟进',
    '',
    '我会先回你一条确认。涉及日历或 Linear 的实际改动，不会在你确认前自动执行。',
  ].join('\n');
}

function formatSuggestionForFeishu(suggestion: ChatContextSuggestion, index: number): string[] {
  return [
    `${index}. 我看到你提到：${suggestion.title}`,
    `   我的建议：${suggestion.summary}`,
    `   可能影响：${suggestion.targets.map(targetLabel).join('、')}`,
    ...(suggestion.due ? [`   时间：${suggestion.due}`] : []),
    `   判断把握：${confidenceLabel(suggestion.confidence)}`,
    '   是否采纳？请老板批示。',
  ];
}

function suggestionSignature(suggestions: ChatContextSuggestion[]): string {
  const ids = suggestions.map((suggestion) => suggestion.id).sort().join('\n');
  return crypto.createHash('sha256').update(ids).digest('hex').slice(0, 16);
}

function sanitizeState(value: unknown): BackgroundSuggestionsState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const out: BackgroundSuggestionsState = {};
  for (const key of [
    'last_run_at',
    'next_run_at',
    'last_error',
    'last_error_at',
    'last_sent_at',
    'last_signature',
  ] as const) {
    if (typeof raw[key] === 'string') out[key] = raw[key];
  }
  if (raw.last_status === 'success' || raw.last_status === 'skipped' || raw.last_status === 'error') out.last_status = raw.last_status;
  if (typeof raw.last_suggestion_count === 'number') out.last_suggestion_count = raw.last_suggestion_count;
  if (typeof raw.last_inspected_messages === 'number') out.last_inspected_messages = raw.last_inspected_messages;
  return out;
}

function writeBackgroundSuggestionsState(config: AppConfig, state: BackgroundSuggestionsState): void {
  const statePath = backgroundSuggestionsStatePath(config);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
}

function writePendingBackgroundSuggestions(
  config: AppConfig,
  result: ChatContextAnalysisResult,
  suggestions: ChatContextSuggestion[],
  now: Date,
): void {
  const pendingPath = backgroundSuggestionsPendingPath(config);
  if (suggestions.length === 0) {
    fs.rmSync(pendingPath, { force: true });
    return;
  }
  const pending: PendingBackgroundSuggestions = {
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + config.background_suggestions.pending_ttl_hours * 60 * 60_000).toISOString(),
    date: result.date,
    mode: result.mode,
    window_label: result.window_label,
    suggestions: suggestions.slice(0, config.chat_analysis.max_suggestions).map((suggestion, index) => ({
      index: index + 1,
      id: suggestion.id,
      kind: suggestion.kind,
      title: suggestion.title,
      summary: suggestion.summary,
      targets: suggestion.targets,
      confidence: suggestion.confidence,
      ...(suggestion.owner ? { owner: suggestion.owner } : {}),
      ...(suggestion.due ? { due: suggestion.due } : {}),
    })),
  };
  fs.mkdirSync(path.dirname(pendingPath), { recursive: true });
  fs.writeFileSync(pendingPath, JSON.stringify(pending, null, 2), 'utf8');
}

function writePendingBackgroundSuggestionSnapshot(config: AppConfig, pending: PendingBackgroundSuggestions): void {
  const pendingPath = backgroundSuggestionsPendingPath(config);
  if (pending.suggestions.length === 0) {
    fs.rmSync(pendingPath, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(pendingPath), { recursive: true });
  fs.writeFileSync(pendingPath, JSON.stringify(pending, null, 2), 'utf8');
}

function backgroundSuggestionsStatePath(config: AppConfig): string {
  return path.resolve(config.background_suggestions.state_path);
}

function backgroundSuggestionsPendingPath(config: AppConfig): string {
  return path.resolve(config.background_suggestions.pending_path);
}

function nextRunAt(config: AppConfig, now: Date): Date {
  return new Date(now.getTime() + config.background_suggestions.interval_minutes * 60_000);
}

function dateInZone(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function confidenceRank(value: 'low' | 'medium' | 'high'): number {
  return value === 'high' ? 3 : value === 'medium' ? 2 : 1;
}

function confidenceLabel(value: 'low' | 'medium' | 'high'): string {
  if (value === 'high') return '高';
  if (value === 'medium') return '中';
  return '低';
}

function targetLabel(target: string): string {
  const labels: Record<string, string> = {
    todo: '待办',
    daily_plan: '今日计划',
    calendar: '日历',
    document: '文档',
    linear: 'Linear',
    memory: '记忆库',
    review: '复盘',
  };
  return labels[target] || target;
}

function parsePendingSuggestionReply(
  text: string,
  pending: PendingBackgroundSuggestions,
): { action: 'accept' | 'dismiss'; indexes: number[] } | null {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  if (/^(?:\/?daily-os|@daily-os)\b/i.test(normalized)) return null;

  const dismiss = /(不采纳|不采用|不要|不用|忽略|先忽略|先不|取消|算了|否|no\b|reject\b|dismiss\b)/i.test(normalized);
  const accept = /(采纳|采用|可以|同意|确认|写入|记录|加入|安排|创建|调整|改成|跟进|yes\b|ok\b|okay\b)/i.test(normalized);
  if (!dismiss && !accept) return null;

  const indexes = extractReferencedSuggestionIndexes(normalized, pending);
  if (indexes.length === 0) return null;
  return { action: dismiss ? 'dismiss' : 'accept', indexes };
}

function extractReferencedSuggestionIndexes(text: string, pending: PendingBackgroundSuggestions): number[] {
  if (/(全部|都|这些)/.test(text)) return pending.suggestions.map((suggestion) => suggestion.index);

  const indexes = new Set<number>();
  for (const match of text.matchAll(/第\s*(\d+)\s*条/g)) indexes.add(Number(match[1]));
  for (const match of text.matchAll(/\b(\d+)\b/g)) indexes.add(Number(match[1]));

  if (indexes.size === 0 && pending.suggestions.length === 1 && /(这个|这条|该建议|这个建议|刚才|建议)/.test(text)) {
    indexes.add(pending.suggestions[0].index);
  }
  if (indexes.size === 0 && /(不采纳|不采用|不要|不用|忽略|先忽略|先不|取消|算了|否|no\b|reject\b|dismiss\b)/i.test(text) && /(这个|这条|该建议|这个建议|刚才|建议)/.test(text)) {
    for (const suggestion of pending.suggestions) indexes.add(suggestion.index);
  }

  const available = new Set(pending.suggestions.map((suggestion) => suggestion.index));
  return [...indexes].filter((index) => available.has(index));
}

function formatIndexes(suggestions: PendingBackgroundSuggestion[]): string {
  if (suggestions.length === 1) return `第 ${suggestions[0].index} 条建议`;
  return `第 ${suggestions.map((suggestion) => suggestion.index).join('、')} 条建议`;
}

function safeErrorSummary(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/(is required|not configured|disabled)/i.test(message)) return message.replace(/\s+/g, ' ').slice(0, 180);
  if (/Failed to send Feishu message/i.test(message)) return 'Failed to send Feishu message.';
  if (/Failed to read Feishu messages/i.test(message)) return 'Failed to read Feishu messages.';
  return 'Background suggestions run failed. Check service logs.';
}

function sanitizePending(value: unknown): PendingBackgroundSuggestions | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.created_at !== 'string' ||
    typeof raw.expires_at !== 'string' ||
    typeof raw.date !== 'string' ||
    !['manual', 'todo', 'review'].includes(String(raw.mode)) ||
    typeof raw.window_label !== 'string' ||
    !Array.isArray(raw.suggestions)
  ) {
    return null;
  }
  return {
    created_at: raw.created_at,
    expires_at: raw.expires_at,
    date: raw.date,
    mode: raw.mode as ChatAnalysisMode,
    window_label: raw.window_label,
    suggestions: raw.suggestions.map(sanitizePendingSuggestion).filter((item): item is PendingBackgroundSuggestion => Boolean(item)),
  };
}

function sanitizePendingSuggestion(value: unknown): PendingBackgroundSuggestion | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.index !== 'number' ||
    typeof raw.id !== 'string' ||
    typeof raw.kind !== 'string' ||
    typeof raw.title !== 'string' ||
    typeof raw.summary !== 'string' ||
    !Array.isArray(raw.targets) ||
    !['low', 'medium', 'high'].includes(String(raw.confidence))
  ) {
    return null;
  }
  return {
    index: raw.index,
    id: raw.id,
    kind: raw.kind,
    title: raw.title,
    summary: raw.summary,
    targets: raw.targets.filter((target): target is string => typeof target === 'string'),
    confidence: raw.confidence as 'low' | 'medium' | 'high',
    ...(typeof raw.owner === 'string' ? { owner: raw.owner } : {}),
    ...(typeof raw.due === 'string' ? { due: raw.due } : {}),
  };
}
