import type { AppConfig } from '../config/schema.js';
import { listCycles } from '../cycles/file.js';
import type { EvidenceSource } from './types.js';

export interface WeeklyPriorityItem {
  source: string;
  scope: string;
  week: string;
  okr: string;
  item: string;
}

export function extractWeeklyPrioritiesFromFeishuDocs(source: EvidenceSource | undefined, date: string): EvidenceSource {
  if (!source || source.state !== 'available') return { state: 'missing', detail: 'Feishu docs source is unavailable' };
  const docs = documentContents(source.data);
  const week = resolveWeekLabel(docs, date);
  const items: WeeklyPriorityItem[] = [];
  for (const doc of docs) {
    items.push(...extractWeeklyPrioritiesFromXml(doc.content, week, doc.name));
  }
  return items.length > 0
    ? { state: 'available', detail: `Extracted ${items.length} weekly priority items for ${week}`, data: { week, items } }
    : { state: 'empty', detail: `No Feishu weekly priorities found for ${week}`, data: { week, items: [] } };
}

/**
 * The current cycle's 要务, read from the local cycle file.
 *
 * Since Feishu write-back went default-off (#211) the plan lives only in
 * `20_CYCLES/*.md`: the Feishu weekly table never gets a column for the new
 * cycle, so `extractWeeklyPrioritiesFromFeishuDocs` finds nothing and the
 * daily plan loses its strategy anchor every single day (#220). The local file
 * is the source of truth now; Feishu stays as the fallback for installs that
 * still write back or have no cycle file for today.
 */
export function extractWeeklyPrioritiesFromLocalCycle(config: AppConfig, date: string): EvidenceSource {
  const doc = currentCycle(config, date);
  if (!doc) return { state: 'missing', detail: `No local cycle covers ${date}` };
  const content = doc.sections['要务']?.content || '';
  const items = parseCyclePriorities(content, doc.cycle, doc.id);
  return items.length > 0
    ? { state: 'available', detail: `Extracted ${items.length} weekly priority items for ${doc.cycle} from local cycle ${doc.id}`, data: { week: doc.cycle, items } }
    : { state: 'empty', detail: `Local cycle ${doc.id} has no 要务 yet`, data: { week: doc.cycle, items: [] } };
}

/** Local cycle first; Feishu only when the local file has nothing to offer. */
export function preferLocalPriorities(local: EvidenceSource, feishu: EvidenceSource): EvidenceSource {
  return local.state === 'available' ? local : feishu;
}

/**
 * `### <OKR heading>` groups `- <item>` lines. Items keep their markers (✅,
 * **MIT**, Linear ids) verbatim — the scorer already drops ✅ rows, and
 * rewriting the text here would make the candidate stop matching what the user
 * sees in the Cycles page.
 */
export function parseCyclePriorities(markdown: string, week: string, source = 'local_cycle'): WeeklyPriorityItem[] {
  const out: WeeklyPriorityItem[] = [];
  let okr = '';
  for (const raw of markdown.split('\n')) {
    const line = raw.trim();
    const heading = line.match(/^#{1,6}\s+(.+)$/);
    if (heading) {
      okr = completeText(heading[1] || '', 220);
      continue;
    }
    const bullet = line.match(/^(?:[-*+]|\d+[.)])\s+(.+)$/);
    if (!bullet) continue;
    const item = completeText(bullet[1] || '', 260);
    if (item.length < 2) continue;
    out.push({ source, scope: 'local', week, okr, item });
  }
  return out;
}

/**
 * The cycle whose span contains `date`. The label carries no year, so the
 * start date is what pins it; the label supplies the end. Narrowest wins when
 * two overlap, same rule as the Feishu header lookup.
 */
function currentCycle(config: AppConfig, date: string): ReturnType<typeof listCycles>[number] | null {
  let best: { doc: ReturnType<typeof listCycles>[number]; span: number } | null = null;
  for (const doc of listCycles(config)) {
    if (!doc.startDate || doc.startDate > date) continue;
    const span = labelSpanCoveringDate(doc.cycle, date);
    if (span === null) continue;
    const elapsed = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${doc.startDate}T00:00:00Z`)) / DAY_MS);
    if (elapsed >= span) continue;
    if (!best || span < best.span) best = { doc, span };
  }
  return best?.doc ?? null;
}

export function extractWeeklyPrioritiesFromXml(xml: string, week: string, source = 'document'): WeeklyPriorityItem[] {
  const out: WeeklyPriorityItem[] = [];
  const target = compactLabel(`${week} 要务`);
  for (const table of xml.split(/<table>/).slice(1).map((value) => value.split('</table>')[0] || '')) {
    const rows = table.split(/<tr>/).slice(1).map((value) => value.split('</tr>')[0] || '');
    if (rows.length < 2) continue;
    const headers = tableCells(rows[0]).map(stripDocXml);
    // Compare on whitespace-stripped labels: the doc writes both "7.6 - 7.12 要务"
    // and "8.10-8.23 要务". Prefer the column whose header is exactly the label —
    // a hand-added sibling like "8.10-8.23 要务 · 重写稿" also contains it, and the
    // canonical column is the one the weekly-review write-back targets.
    const headerKeys = headers.map(compactLabel);
    const weekIndex = headerKeys.indexOf(target) >= 0 ? headerKeys.indexOf(target) : headerKeys.findIndex((header) => header.includes(target));
    if (weekIndex < 0) continue;
    const scope = scopeFromHeader(headers[0] || '');
    for (const row of rows.slice(1)) {
      const cells = tableCells(row);
      const okr = stripDocXml(cells[0] || '');
      const weeklyCell = cells[weekIndex] || '';
      if (!weeklyCell.trim()) continue;
      for (const item of listItems(weeklyCell)) {
        out.push({ source, scope, week, okr: completeText(okr, 220), item: completeText(item, 260) });
      }
    }
  }
  return out;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Matches the "8.10-8.23" part of a "8.10-8.23 要务" column header. */
const WEEK_HEADER_PATTERN = /(\d{1,2}\s*\.\s*\d{1,2}\s*-\s*\d{1,2}\s*\.\s*\d{1,2})\s*要务/g;

/**
 * Pick the priority-column label from the labels the document actually uses.
 *
 * The Feishu weekly doc moved from a 7-day cadence to a 14-day one on
 * 2026-06-29. A locally computed Monday–Sunday label ("8.10-8.16") stopped
 * matching the real header ("8.10-8.23"), so the whole weekly_priorities source
 * silently reported empty and the daily plan lost its strategy anchor. Read the
 * headers instead of assuming the cadence, and keep the computed weekly label
 * only as a fallback for docs that offer no column covering today.
 */
function resolveWeekLabel(docs: Array<{ name: string; content: string }>, date: string): string {
  let best: { label: string; span: number } | null = null;
  for (const doc of docs) {
    for (const match of doc.content.matchAll(WEEK_HEADER_PATTERN)) {
      const label = match[1];
      const span = labelSpanCoveringDate(label, date);
      if (span === null) continue;
      // Narrowest covering range wins, so a doc carrying both a weekly and a
      // biweekly column for today resolves to the more specific one.
      if (!best || span < best.span) best = { label, span };
    }
  }
  return best ? best.label : weekLabel(date);
}

/**
 * Length in days of `label` if it covers `date`, otherwise null. Labels carry no
 * year, so try the neighbouring years too — that is what makes a wrap-around
 * range like "12.29-1.4" resolve for a January date.
 */
function labelSpanCoveringDate(label: string, date: string): number | null {
  const parts = compactLabel(label).match(/^(\d{1,2})\.(\d{1,2})-(\d{1,2})\.(\d{1,2})$/);
  if (!parts) return null;
  const [startMonth, startDay, endMonth, endDay] = parts.slice(1).map(Number);
  const target = Date.parse(`${date}T00:00:00Z`);
  const year = Number(date.slice(0, 4));
  if (Number.isNaN(target) || Number.isNaN(year)) return null;
  for (const startYear of [year - 1, year, year + 1]) {
    const start = Date.UTC(startYear, startMonth - 1, startDay);
    const wraps = endMonth < startMonth || (endMonth === startMonth && endDay < startDay);
    const end = Date.UTC(wraps ? startYear + 1 : startYear, endMonth - 1, endDay);
    if (target >= start && target <= end) return Math.round((end - start) / DAY_MS) + 1;
  }
  return null;
}

function compactLabel(value: string): string {
  return value.replace(/\s+/g, '');
}

function weekLabel(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const day = d.getUTCDay();
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() + (day === 0 ? -6 : 1 - day));
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  return `${monday.getUTCMonth() + 1}.${monday.getUTCDate()}-${sunday.getUTCMonth() + 1}.${sunday.getUTCDate()}`;
}

function documentContents(data: unknown): Array<{ name: string; content: string }> {
  const docs: Array<{ name: string; content: string }> = [];
  visit(data, (value, path) => {
    if (typeof value === 'string' && value.includes('<table>') && value.includes('要务')) {
      docs.push({ name: path.slice(-5).find((part) => part && part !== 'content') || 'document', content: value });
    }
  });
  return docs;
}

function visit(value: unknown, fn: (value: unknown, path: string[]) => void, path: string[] = []): void {
  fn(value, path);
  if (Array.isArray(value)) {
    value.forEach((item, index) => visit(item, fn, [...path, String(index)]));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) visit(child, fn, [...path, key]);
}

function tableCells(row: string): string[] {
  return row.split(/<td[^>]*>/).slice(1).map((value) => value.split('</td>')[0] || '');
}

function listItems(cell: string): string[] {
  const matches = Array.from(cell.matchAll(/<li(?:\s[^>]*)?>([\s\S]*?)<\/li>/g)).map((match) => stripDocXml(match[1] || ''));
  const cleaned = matches.map((item) => completeText(item, 260)).filter((item) => item.length >= 4);
  if (cleaned.length > 0) return cleaned;
  const fallback = stripDocXml(cell);
  return fallback ? [fallback] : [];
}

function stripDocXml(value: string): string {
  return value
    .replace(/<cite[^>]*title="([^"]+)"[^>]*><\/cite>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/\s+/g, ' ')
    .trim();
}

function completeText(value: string, max: number): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  return clean.slice(0, max - 1).replace(/[，,、；;\s-]+$/u, '').trim() + '…';
}

function scopeFromHeader(value: string): string {
  const match = value.match(/[🐧🐶]/u);
  return match?.[0] || value.replace(/\s*重点OKR\s*/g, '').trim() || 'weekly';
}
