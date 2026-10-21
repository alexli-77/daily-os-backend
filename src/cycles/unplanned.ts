/**
 * 计划外 — what a cycle's days were spent on outside its 要务.
 *
 * The 要务 reach each day through the plan; nothing came back the other way.
 * A friend's visit, an afternoon of shopping, a week of tool-building were
 * captured on Today and then forgotten by the cycle: the retro asked "计划外吃掉
 * 时间的事" and the answer had to come from memory.
 *
 * Built from the capture inbox and the feedback ledger, not from the stored
 * plans: plans are pruned to about a week and a cycle is two, while both of
 * these are kept. A capture counts on a day it was written or touched, unless
 * that day's last word on it was 删除.
 *
 * A capture tied to a 要务 is not 计划外: added from Today with a 要务 picked
 * (an ad-hoc session carries its id), or worded as one of the cycle's 要务 —
 * which is also what 加进要务 does, so a promoted item leaves this list.
 * Nor is one worded as a block of the 作息 (英语口语 written down as a to-do):
 * that time was planned, by the routine.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../config/schema.js';
import { listTodoFeedback } from '../todo/feedback.js';
import { listTodoInboxItems } from '../todo/inbox.js';
import { readRoutines } from '../user/routine.js';
import { readCycle, writeSection, type CycleDoc } from './file.js';
import { cycleDays, cycleScheduleItems, readSchedule } from './schedule.js';

export interface UnplannedItem {
  /** The text with case, spaces and punctuation taken out; what groups repeats. */
  key: string;
  /** The latest wording. */
  text: string;
  /** Days it was on, first to last. */
  days: string[];
  /** Sum of the estimates the user gave; null when none were. */
  minutes: number | null;
  /** Ticked 完成 or 部分 on at least one day. */
  done: boolean;
  captureIds: string[];
}

/**
 * Where 加进要务 files a line when it cannot tell which OKR it serves (no
 * model to ask, or the model found none that fits). Normally a line goes under
 * the OKR heading it belongs to; this is the holding pen, not the default.
 */
export const PROMOTED_HEADING = '### 计划外新增';

/** The ad-hoc session a capture added from Today is filed under. */
export function adhocSessionId(captureId: string): string {
  return `a-${captureId.slice(-8).replace(/[^a-z0-9]/g, '')}`;
}

export function unplannedKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/\*\*mit\*\*|✅|🚧|❌/g, '')
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

/** The cycle's 计划外, the most time first. Only days up to `until` count. */
export function unplannedForCycle(config: AppConfig, doc: CycleDoc, until: string): UnplannedItem[] {
  const days = new Set(cycleDays(doc).filter((day) => day <= until));
  if (days.size === 0) return [];
  const priorityKeys = cycleScheduleItems(doc).map((item) => unplannedKey(item.text));
  const linkedSessions = new Set(
    (readSchedule(config, doc.id)?.sessions ?? []).filter((session) => session.adhoc).map((session) => session.id),
  );
  const isPriority = (key: string): boolean =>
    priorityKeys.some((priority) => priority === key || (key.length >= 4 && priority.includes(key)));
  const routineKeys = new Set(routineTitles(config, [...days]).map(unplannedKey).filter(Boolean));

  // Per capture, per day: the last event wins, and the last estimate given.
  const byCapture = new Map<string, Map<string, { event: string; minutes?: number; done: boolean }>>();
  for (const entry of listTodoFeedback(config)) {
    if (!entry.candidateId.startsWith('todo_inbox:') || !days.has(entry.date)) continue;
    const id = entry.candidateId.slice('todo_inbox:'.length);
    const perDay = byCapture.get(id) ?? new Map();
    const previous = perDay.get(entry.date);
    perDay.set(entry.date, {
      event: entry.event === 'update' && previous ? previous.event : entry.event,
      minutes: entry.minutes !== undefined ? entry.minutes : previous?.minutes,
      done: (previous?.done ?? false) || entry.event === 'complete' || entry.event === 'partial',
    });
    byCapture.set(id, perDay);
  }

  const groups = new Map<string, UnplannedItem>();
  const dayMinutes = new Map<string, Map<string, number>>();
  for (const item of listTodoInboxItems(config)) {
    if (item.status === 'deleted') continue;
    if (linkedSessions.has(adhocSessionId(item.id))) continue;
    const key = unplannedKey(item.text);
    if (!key || isPriority(key) || routineKeys.has(key)) continue;

    const perDay = byCapture.get(item.id) ?? new Map();
    const created = dateIn(config.user.timezone, item.created_at);
    if (created && days.has(created) && !perDay.has(created)) perDay.set(created, { event: 'capture', done: false });
    const onDays = [...perDay.entries()].filter(([, day]) => day.event !== 'remove');
    if (onDays.length === 0) continue;

    const group = groups.get(key) ?? { key, text: item.text, days: [], minutes: null, done: false, captureIds: [] };
    // The same thing written down twice on one day is one stretch of time, not
    // two: per day the longest estimate counts.
    const perDayMinutes = dayMinutes.get(key) ?? new Map<string, number>();
    for (const [day, state] of onDays) {
      if (!group.days.includes(day)) group.days.push(day);
      if (state.minutes && state.minutes > 0) perDayMinutes.set(day, Math.max(perDayMinutes.get(day) ?? 0, state.minutes));
      if (state.done) group.done = true;
    }
    dayMinutes.set(key, perDayMinutes);
    group.minutes = perDayMinutes.size ? [...perDayMinutes.values()].reduce((sum, value) => sum + value, 0) : null;
    if (item.status === 'done') group.done = true;
    group.captureIds.push(item.id);
    group.text = item.text;
    groups.set(key, group);
  }

  return [...groups.values()]
    .map((group) => ({ ...group, days: group.days.sort() }))
    .sort((left, right) => (right.minutes ?? 0) - (left.minutes ?? 0) || right.days.length - left.days.length || left.text.localeCompare(right.text));
}

/** One line for the retro and the 总结: 「逛街（2 天，3h）、见朋友（1 天）」. */
export function formatUnplanned(items: UnplannedItem[]): string {
  return items
    .map((item) => {
      const parts = [`${item.days.length} 天`];
      if (item.minutes) parts.push(formatMinutes(item.minutes));
      return `${item.text}（${parts.join('，')}）`;
    })
    .join('、');
}

/**
 * Worth asking whether it belongs in the 要务: it came back on a second day,
 * or took two hours or more. One-offs are left alone.
 */
export function shouldSuggestPromote(item: UnplannedItem): boolean {
  return item.days.length >= 2 || (item.minutes ?? 0) >= 120;
}

/** One OKR group of a cycle's 要务: its `###` heading and the lines under it. */
export interface PriorityGroup {
  heading: string;
  items: string[];
}

/** The 要务's OKR groups, in file order, without the holding pen. */
export function priorityGroups(content: string): PriorityGroup[] {
  const groups: PriorityGroup[] = [];
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    const heading = /^###\s+(.+)$/.exec(line);
    if (heading) {
      groups.push({ heading: line, items: [] });
      continue;
    }
    const bullet = /^(?:[-*+]|\d+[.)])\s+(.+)$/.exec(line);
    if (bullet && groups.length > 0) groups[groups.length - 1]!.items.push(bullet[1]!.trim());
  }
  return groups.filter((group) => group.heading !== PROMOTED_HEADING);
}

/** `content` with `- line` added at the end of the `heading` group; the group is made when missing. */
export function insertUnderHeading(content: string, heading: string, line: string): string {
  const lines = content.replace(/\s+$/, '').split('\n').filter((value, index, all) => all.length > 1 || value !== '');
  const at = lines.findIndex((value) => value.trim() === heading);
  if (at === -1) {
    lines.push(...(lines.length ? [''] : []), heading, `- ${line}`);
  } else {
    let end = at + 1;
    while (end < lines.length && !/^#{1,6}\s/.test(lines[end]!.trim())) end += 1;
    while (end > at + 1 && !lines[end - 1]!.trim()) end -= 1;
    lines.splice(end, 0, `- ${line}`);
  }
  return `${lines.join('\n')}\n`;
}

/** `content` without the holding pen's lines that were refiled, and without the pen once it is empty. */
function removeFromPen(content: string, moved: Set<string>): string {
  const lines = content.split('\n');
  const at = lines.findIndex((value) => value.trim() === PROMOTED_HEADING);
  if (at === -1) return content;
  let end = at + 1;
  while (end < lines.length && !/^#{1,6}\s/.test(lines[end]!.trim())) end += 1;
  const kept = lines.slice(at + 1, end).filter((value) => {
    const bullet = /^(?:[-*+]|\d+[.)])\s+(.+)$/.exec(value.trim());
    return !(bullet && moved.has(bullet[1]!.trim()));
  });
  const block = kept.some((value) => value.trim()) ? [lines[at]!, ...kept] : [];
  const next = [...lines.slice(0, at), ...block, ...lines.slice(end)];
  return `${next.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '')}\n`;
}

type Ask = (prompt: string) => Promise<string>;

/**
 * Which OKR group each line serves, asked of the model in one go. A line with
 * no group that fits, or any failure, maps to null — the holding pen.
 */
export async function pickHeadings(texts: string[], groups: PriorityGroup[], ask: Ask): Promise<Array<string | null>> {
  if (texts.length === 0) return [];
  if (groups.length === 0) return texts.map(() => null);
  const prompt = [
    '把下面每条新要务归到最合适的 OKR 分组。按「条目编号:分组编号」每行回复一条，例如「1:3」，不要别的字。哪组都不合适就写 0。',
    '',
    '分组：',
    ...groups.map((group, index) => `${index + 1}. ${group.heading.replace(/^###\s+/, '')}${group.items.length ? `\n   已有：${group.items.slice(0, 4).join('；')}` : ''}`),
    '',
    '新要务：',
    ...texts.map((text, index) => `${index + 1}. ${text}`),
  ].join('\n');
  try {
    const reply = await ask(prompt);
    const picked: Array<string | null> = texts.map(() => null);
    for (const match of reply.matchAll(/(\d+)\s*[:：]\s*(\d+)/g)) {
      const item = Number(match[1]) - 1;
      const group = Number(match[2]) - 1;
      if (item >= 0 && item < texts.length && group >= 0 && group < groups.length) picked[item] = groups[group]!.heading;
    }
    return picked;
  } catch (error) {
    console.warn(`[unplanned] OKR not picked: ${error instanceof Error ? error.message : String(error)}`);
    return texts.map(() => null);
  }
}

/**
 * 加进要务: file `text` under the OKR group it serves (the holding pen when no
 * group fits). Nothing changes when the cycle already has it as a 要务. A
 * pending draft of the 要务 is kept.
 */
export async function promoteToPriorities(
  config: AppConfig,
  cycleId: string,
  text: string,
  ask?: Ask,
): Promise<{ added: boolean; heading: string; doc: CycleDoc }> {
  const doc = readCycle(config, cycleId);
  if (!doc) throw new Error(`没有这个周期：${cycleId}`);
  const line = text.replace(/\s+/g, ' ').trim();
  if (!line) throw new Error('要加的内容是空的。');
  const key = unplannedKey(line);
  if (cycleScheduleItems(doc).some((item) => unplannedKey(item.text) === key)) return { added: false, heading: '', doc };

  const content = doc.sections['要务']?.content || '';
  const [picked] = ask ? await pickHeadings([line], priorityGroups(content), ask) : [null];
  const heading = picked ?? PROMOTED_HEADING;
  const written = writeSection(config, cycleId, '要务', insertUnderHeading(content, heading, line), 'user', { keepDraft: true });
  return { added: true, heading, doc: written };
}

/** Move what sits in the holding pen to the OKR groups it serves. */
export async function refilePromoted(config: AppConfig, cycleId: string, ask: Ask): Promise<Array<{ text: string; heading: string }>> {
  const doc = readCycle(config, cycleId);
  if (!doc) throw new Error(`没有这个周期：${cycleId}`);
  let content = doc.sections['要务']?.content || '';
  const lines = content.split('\n');
  const at = lines.findIndex((value) => value.trim() === PROMOTED_HEADING);
  if (at === -1) return [];
  const pen: string[] = [];
  for (let index = at + 1; index < lines.length && !/^#{1,6}\s/.test(lines[index]!.trim()); index += 1) {
    const bullet = /^(?:[-*+]|\d+[.)])\s+(.+)$/.exec(lines[index]!.trim());
    if (bullet) pen.push(bullet[1]!.trim());
  }
  const picked = await pickHeadings(pen, priorityGroups(content), ask);
  const moved: Array<{ text: string; heading: string }> = [];
  pen.forEach((text, index) => {
    const heading = picked[index];
    if (heading) moved.push({ text, heading });
  });
  if (moved.length === 0) return [];
  content = removeFromPen(content, new Set(moved.map((entry) => entry.text)));
  for (const entry of moved) content = insertUnderHeading(content, entry.heading, entry.text);
  writeSection(config, cycleId, '要务', content, 'user', { keepDraft: true });
  return moved;
}

/** Every block title of the 作息 periods covering these days, in any day type or mode. */
function routineTitles(config: AppConfig, days: string[]): string[] {
  try {
    const first = days.reduce((min, day) => (day < min ? day : min), days[0] ?? '');
    const last = days.reduce((max, day) => (day > max ? day : max), days[0] ?? '');
    return readRoutines(config)
      .periods.filter((period) => period.from <= last && first <= period.to)
      .flatMap((period) => period.dayTypes.flatMap((type) => type.modes.flatMap((mode) => mode.blocks.map((block) => block.title))));
  } catch {
    return [];
  }
}

const SUGGESTED_PATH = 'data/runtime/unplanned-suggested.json';

/**
 * Record that 加进要务 was offered for `key` in this cycle. False when it
 * already was: the question is asked once, not on every add.
 */
export function markSuggested(cycleId: string, key: string, file: string = SUGGESTED_PATH): boolean {
  const target = path.resolve(file);
  let seen: Record<string, string[]> = {};
  try {
    seen = JSON.parse(fs.readFileSync(target, 'utf8')) as Record<string, string[]>;
  } catch {
    seen = {};
  }
  const keys = Array.isArray(seen[cycleId]) ? seen[cycleId]! : [];
  if (keys.includes(key)) return false;
  // Only this cycle's list is kept; an older cycle's questions are settled.
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify({ [cycleId]: [...keys, key] }, null, 2), 'utf8');
  return true;
}

function dateIn(timeZone: string, iso: string): string | null {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(time));
}

function formatMinutes(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (!hours) return `${rest}m`;
  return rest ? `${hours}h${rest}m` : `${hours}h`;
}
