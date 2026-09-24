import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AppConfig } from '../config/schema.js';
import { parseWorkflowRevisionItems, type WorkflowRevisionItemType } from '../interaction/workflow-revision.js';
import { writeFileAtomic } from '../utils/atomic-write.js';

export type TodoInboxStatus = 'open' | 'done' | 'deferred' | 'deleted';
export type TodoInboxItemType = WorkflowRevisionItemType | 'reminder';

export interface TodoInboxItem {
  id: string;
  created_at: string;
  updated_at: string;
  source: string;
  message_id?: string;
  raw_text: string;
  text: string;
  type: TodoInboxItemType;
  status: TodoInboxStatus;
  due_hint?: string;
  note?: string;
}

export type TodoInboxCommand =
  | { type: 'capture'; text: string; itemType?: TodoInboxItemType }
  | { type: 'update'; action: 'done' | 'defer' | 'delete'; target: string; note?: string }
  | { type: 'rename'; target: string; replacement: string };

export interface TodoInboxCommandResult {
  handled: boolean;
  reply?: string;
  items?: TodoInboxItem[];
}

export interface TodoInboxItemUpdate {
  text?: string;
  type?: TodoInboxItemType;
  status?: TodoInboxStatus;
  note?: string;
}

const GENERATED_START = '<!-- daily-os-todo-inbox:start -->';
const GENERATED_END = '<!-- daily-os-todo-inbox:end -->';
const REMINDER_PATTERN = /提醒我|remind me/i;
const DUE_HINT_PATTERN =
  /(今天|明天|后天|今晚|上午|下午|中午|晚上|周[一二三四五六日天]|星期[一二三四五六日天]|\d{1,2}[:：]\d{2}|\d{1,2}\s*[点时])/i;

export function parseTodoInboxCommand(text: string): TodoInboxCommand | null {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;

  const rename =
    normalized.match(/^(?:修改|调整)\s*todo[:：]?\s*把[“"']?(.+?)[”"']?\s*(?:改成|改为|改到)\s*[“"']?(.+?)[”"']?。?$/i) ||
    normalized.match(/^(?:修改|调整)\s*待办[:：]?\s*把[“"']?(.+?)[”"']?\s*(?:改成|改为|改到)\s*[“"']?(.+?)[”"']?。?$/i);
  if (rename?.[1] && rename[2]) return { type: 'rename', target: cleanText(rename[1]), replacement: cleanText(rename[2]) };

  const stateChange =
    normalized.match(/^(完成|done|暂缓|延期|defer|删除|移除|delete)\s*(?:todo|待办)?[:：]?\s*(.+)$/i) ||
    normalized.match(/^(?:todo|待办)\s*(完成|done|暂缓|延期|defer|删除|移除|delete)[:：]?\s*(.+)$/i);
  if (stateChange?.[1] && stateChange[2]) {
    const action = normalizeStateAction(stateChange[1]);
    const { target, note } = splitTargetAndNote(stateChange[2]);
    return { type: 'update', action, target, ...(note ? { note } : {}) };
  }

  const capture =
    normalized.match(/^(?:todo|待办|记到\s*todo|记录到\s*todo|帮我记一下|记一下|帮我补充|今天加|提醒我)[:：,，\s]*(.+)$/i) ||
    normalized.match(/^(?:请|麻烦)?(?:帮我|帮忙)(?:记录|记下|加上|新增|补充)[:：,，\s]*(.+)$/i);
  if (capture?.[1]?.trim()) {
    return {
      type: 'capture',
      text: capture[1].trim(),
      ...(REMINDER_PATTERN.test(normalized) ? { itemType: 'reminder' as const } : {}),
    };
  }

  return null;
}

export function isTodoInboxCaptureText(text: string): boolean {
  return parseTodoInboxCommand(text)?.type === 'capture';
}

export function handleTodoInboxCommand(
  config: AppConfig,
  command: TodoInboxCommand,
  meta: { source: string; messageId?: string } = { source: 'manual' },
): TodoInboxCommandResult {
  if (!config.todo_inbox.enabled) return { handled: true, reply: 'todo_inbox.enabled=false；Todo inbox 已禁用。' };
  if (command.type === 'capture') return captureTodoItems(config, command.text, meta, command.itemType);
  if (command.type === 'rename') return renameTodoItem(config, command.target, command.replacement);
  return updateTodoItem(config, command.action, command.target, command.note);
}

export function captureTodoItems(
  config: AppConfig,
  text: string,
  meta: { source: string; messageId?: string } = { source: 'manual' },
  forcedType?: TodoInboxItemType,
): TodoInboxCommandResult {
  const now = new Date().toISOString();
  const parsed = parseWorkflowRevisionItems(text);
  const items: TodoInboxItem[] = parsed.map((item) => ({
    id: `todo-${now.replace(/[-:.TZ]/g, '').slice(0, 14)}-${crypto.randomBytes(3).toString('hex')}`,
    created_at: now,
    updated_at: now,
    source: meta.source,
    ...(meta.messageId ? { message_id: meta.messageId } : {}),
    raw_text: text,
    text: item.text,
    type: forcedType || (REMINDER_PATTERN.test(text) ? 'reminder' : item.type),
    status: 'open',
    ...(extractDueHint(item.text) ? { due_hint: extractDueHint(item.text) } : {}),
  }));

  appendTodoInboxItems(config, items);
  syncTodoInboxVaultNote(config);
  return {
    handled: true,
    items,
    reply: [
      `已写入 Todo Inbox：${items.length} 条。`,
      ...items.map((item, index) => `${index + 1}. ${typeLabel(item.type)}：${item.text}`),
      '',
      `Vault 笔记：${resolveTodoInboxVaultPath(config)}`,
    ].join('\n'),
  };
}

export function listTodoInboxItems(config: AppConfig): TodoInboxItem[] {
  const ledgerPath = path.resolve(config.todo_inbox.ledger_path);
  if (!fs.existsSync(ledgerPath)) return [];
  return fs
    .readFileSync(ledgerPath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as TodoInboxItem;
      } catch {
        return null;
      }
    })
    .filter((item): item is TodoInboxItem => Boolean(item && item.id && item.text));
}

export function openTodoInboxItems(config: AppConfig): TodoInboxItem[] {
  return listTodoInboxItems(config).filter((item) => item.status === 'open');
}

export function updateTodoInboxItemById(config: AppConfig, id: string, update: TodoInboxItemUpdate): TodoInboxCommandResult {
  const items = listTodoInboxItems(config);
  const match = items.find((item) => item.id === id);
  if (!match) return { handled: true, reply: `没有找到 todo：${id}` };

  const nextText = update.text?.trim();
  if (nextText) {
    match.text = nextText;
    match.due_hint = extractDueHint(nextText);
  }
  if (update.type) match.type = update.type;
  if (update.status) match.status = update.status;
  if (update.note !== undefined) {
    const note = update.note.trim();
    if (note) match.note = note;
    else delete match.note;
  }
  match.updated_at = new Date().toISOString();

  writeTodoInboxItems(config, items);
  syncTodoInboxVaultNote(config);
  return { handled: true, reply: `Todo 已更新：${match.text}`, items: [match] };
}

/**
 * Carry a plan-row state change on an inbox-sourced row back to the inbox.
 *
 * A row on the Today plan whose candidateId is `todo_inbox:<id>` *is* that
 * inbox item, but ticking it only wrote the feedback ledger. The inbox kept
 * saying `open`, so the two disagreed — and since the scorer now lets the inbox
 * decide what is finished after the day of the tick (#220), an unsynced tick
 * would bring the item straight back tomorrow.
 *
 * `defer` is deliberately not mapped: on the plan it means "tomorrow", which is
 * still open work, not the inbox's `deferred` (shelved, out of the plan).
 * Returns whether the inbox changed; unknown ids and non-inbox rows are no-ops.
 */
export function syncTodoInboxFromPlanRow(config: AppConfig, candidateId: string, event: string): boolean {
  if (!candidateId.startsWith('todo_inbox:')) return false;
  const status: TodoInboxStatus | undefined =
    event === 'complete' ? 'done' : event === 'reopen' || event === 'partial' ? 'open' : undefined;
  if (!status) return false;
  const id = candidateId.slice('todo_inbox:'.length);
  const match = listTodoInboxItems(config).find((item) => item.id === id);
  if (!match || match.status === status) return false;
  updateTodoInboxItemById(config, id, { status });
  return true;
}

/** How long a done/deferred todo stays visible in the console's History / Deferred lists. */
export const TODO_HISTORY_RETENTION_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Done (or deferred) todos from the retention window, newest first. Anything that
 * fell out of the window is dropped by `purgeExpiredTodoInboxHistory` on the next
 * read, so this only ever shows the last month of activity.
 */
export function listTodoInboxHistory(
  config: AppConfig,
  status: 'done' | 'deferred',
  now: Date = new Date(),
): TodoInboxItem[] {
  const cutoff = now.getTime() - TODO_HISTORY_RETENTION_DAYS * DAY_MS;
  return listTodoInboxItems(config)
    .filter((item) => item.status === status)
    .filter((item) => {
      const ts = Date.parse(item.updated_at || item.created_at);
      return Number.isNaN(ts) ? true : ts >= cutoff;
    })
    .sort((left, right) => (left.updated_at < right.updated_at ? 1 : left.updated_at > right.updated_at ? -1 : 0));
}

/**
 * Retire done/deferred todos whose retention window has passed by marking them
 * `deleted` (the inbox's existing tombstone — nothing is hard-removed, so the
 * ledger stays append-only and auditable). Returns how many were retired; a no-op
 * write is skipped so this is cheap to call on every console render.
 */
export function purgeExpiredTodoInboxHistory(config: AppConfig, now: Date = new Date()): number {
  const cutoff = now.getTime() - TODO_HISTORY_RETENTION_DAYS * DAY_MS;
  const items = listTodoInboxItems(config);
  let retired = 0;
  for (const item of items) {
    if (item.status !== 'done' && item.status !== 'deferred') continue;
    const ts = Date.parse(item.updated_at || item.created_at);
    if (Number.isNaN(ts) || ts >= cutoff) continue;
    item.status = 'deleted';
    retired += 1;
  }
  if (retired > 0) {
    writeTodoInboxItems(config, items);
    syncTodoInboxVaultNote(config);
  }
  return retired;
}

export function todoInboxEvidence(config: AppConfig): { path: string; open: TodoInboxItem[]; recent: TodoInboxItem[] } {
  const items = listTodoInboxItems(config);
  return {
    path: resolveTodoInboxVaultPath(config),
    open: items.filter((item) => item.status === 'open').slice(-30),
    recent: items.filter((item) => item.status !== 'deleted').slice(-30),
  };
}

export function syncTodoInboxVaultNote(config: AppConfig): string {
  const vaultPath = resolveTodoInboxVaultPath(config);
  fs.mkdirSync(path.dirname(vaultPath), { recursive: true });
  const current = fs.existsSync(vaultPath) ? fs.readFileSync(vaultPath, 'utf8') : '# Daily OS Todo Inbox\n';
  const block = renderGeneratedTodoBlock(listTodoInboxItems(config));
  const next = replaceGeneratedBlock(current, block);
  writeFileAtomic(vaultPath, next);
  return vaultPath;
}

function appendTodoInboxItems(config: AppConfig, items: TodoInboxItem[]): void {
  const ledgerPath = path.resolve(config.todo_inbox.ledger_path);
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.appendFileSync(ledgerPath, `${items.map((item) => JSON.stringify(item)).join('\n')}\n`, 'utf8');
}

function writeTodoInboxItems(config: AppConfig, items: TodoInboxItem[]): void {
  const ledgerPath = path.resolve(config.todo_inbox.ledger_path);
  writeFileAtomic(ledgerPath, `${items.map((item) => JSON.stringify(item)).join('\n')}${items.length ? '\n' : ''}`);
}

function updateTodoItem(config: AppConfig, action: 'done' | 'defer' | 'delete', target: string, note?: string): TodoInboxCommandResult {
  const items = listTodoInboxItems(config);
  const match = findOpenItem(items, target);
  if (!match) return { handled: true, reply: `没有找到 open todo：${target}` };
  const now = new Date().toISOString();
  match.status = action === 'done' ? 'done' : action === 'delete' ? 'deleted' : 'deferred';
  match.updated_at = now;
  if (note) match.note = note;
  writeTodoInboxItems(config, items);
  syncTodoInboxVaultNote(config);
  return { handled: true, reply: `${stateActionLabel(action)}：${match.text}` };
}

function renameTodoItem(config: AppConfig, target: string, replacement: string): TodoInboxCommandResult {
  const items = listTodoInboxItems(config);
  const match = findOpenItem(items, target);
  if (!match) return { handled: true, reply: `没有找到 open todo：${target}` };
  const previous = match.text;
  match.text = replacement;
  match.updated_at = new Date().toISOString();
  writeTodoInboxItems(config, items);
  syncTodoInboxVaultNote(config);
  return { handled: true, reply: `已修改 todo：${previous} -> ${replacement}` };
}

function findOpenItem(items: TodoInboxItem[], target: string): TodoInboxItem | null {
  const normalized = normalizeMatchText(target);
  return (
    items.find((item) => item.status === 'open' && normalizeMatchText(item.text) === normalized) ||
    items.find((item) => item.status === 'open' && normalizeMatchText(item.text).includes(normalized)) ||
    null
  );
}

function renderGeneratedTodoBlock(items: TodoInboxItem[]): string {
  const open = items.filter((item) => item.status === 'open');
  const done = items.filter((item) => item.status === 'done').slice(-30);
  const deferred = items.filter((item) => item.status === 'deferred').slice(-30);
  return [
    GENERATED_START,
    '## Open',
    ...(open.length ? open.map((item) => renderTaskLine(item, false)) : ['_No open Daily OS todo._']),
    '',
    '## Deferred',
    ...(deferred.length ? deferred.map((item) => renderTaskLine(item, false)) : ['_No deferred Daily OS todo._']),
    '',
    '## Done',
    ...(done.length ? done.map((item) => renderTaskLine(item, true)) : ['_No completed Daily OS todo yet._']),
    GENERATED_END,
  ].join('\n');
}

function renderTaskLine(item: TodoInboxItem, checked: boolean): string {
  const parts = [`- [${checked ? 'x' : ' '}]`, `<!-- daily-os:id=${item.id} type=${item.type} -->`, `${typeLabel(item.type)}：${item.text}`];
  if (item.due_hint) parts.push(`（${item.due_hint}）`);
  if (item.note) parts.push(`- ${item.note}`);
  return parts.join(' ');
}

function replaceGeneratedBlock(current: string, block: string): string {
  if (current.includes(GENERATED_START) && current.includes(GENERATED_END)) {
    const pattern = new RegExp(`${escapeRegExp(GENERATED_START)}[\\s\\S]*?${escapeRegExp(GENERATED_END)}`);
    return `${current.replace(pattern, block).trim()}\n`;
  }
  return `${current.trim()}\n\n${block}\n`;
}

function resolveTodoInboxVaultPath(config: AppConfig): string {
  if (config.todo_inbox.vault_path.trim()) return path.resolve(config.todo_inbox.vault_path);
  if (config.sources.vault.enabled && config.sources.vault.provider === 'local' && config.sources.vault.local_path.trim()) {
    return path.resolve(config.sources.vault.local_path, config.todo_inbox.vault_relative_path);
  }
  return path.resolve('./data/memory/daily-os-todo.md');
}

function normalizeStateAction(value: string): 'done' | 'defer' | 'delete' {
  const normalized = value.toLowerCase();
  if (/删除|移除|delete/.test(normalized)) return 'delete';
  if (/暂缓|延期|defer/.test(normalized)) return 'defer';
  return 'done';
}

function splitTargetAndNote(value: string): { target: string; note?: string } {
  const [target = '', ...rest] = value.split(/[，,；;]/);
  const note = rest.join('，').trim();
  return { target: cleanText(target), ...(note ? { note } : {}) };
}

function cleanText(value: string): string {
  return value.replace(/^[“"'`]+|[”"'`。]+$/g, '').trim();
}

function normalizeMatchText(value: string): string {
  return value.replace(/[“”"'`。 ，,；;:：]/g, '').toLowerCase();
}

function extractDueHint(text: string): string | undefined {
  return text.match(DUE_HINT_PATTERN)?.[0];
}

function typeLabel(type: TodoInboxItemType): string {
  if (type === 'time_boundary') return '时间边界';
  if (type === 'reminder') return '提醒';
  if (type === 'note') return '备注';
  return '待办';
}

function stateActionLabel(action: 'done' | 'defer' | 'delete'): string {
  if (action === 'done') return '已完成 todo';
  if (action === 'delete') return '已删除 todo';
  return '已暂缓 todo';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
