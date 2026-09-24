import type { AppConfig } from '../config/schema.js';
import { addDays, todayInTimezone } from '../utils/date.js';
import { listCycles, type CycleDoc } from './file.js';
import { shortLabel } from './migration.js';
import { okrRowLabels } from './writeback.js';

/**
 * The local-md replacement for what life-review-os used to read out of the Feishu
 * weekly table (LEO — local-first). Everything the planner needs about the OKR
 * rows and the previous/target cycle now lives in `10_OKR` + `20_CYCLES`, so we
 * build a structured `cycle_context`, drop it in the skill input pack, and
 * life-review-os reads it instead of the table — no Feishu token required to run.
 *
 * Only the *read* moves here. Feishu remains available as a supplemental
 * *source* (docs/IM/…) through the rest of the evidence pack, untouched.
 */

export interface CycleContextRow {
  /** Row index, aligned to `okrRows` / okrRowLabels: 1..N, 0 is the header. */
  row: number;
  okr: string;
  /** The row's 要务 as raw bullet text, verbatim (Linear ids and MIT kept). */
  tasks: string;
}

export interface CycleContextWeek {
  label: string;
  start: string;
  end: string;
}

export interface CycleContext {
  schema: 1;
  mode: string;
  reviewWeek: CycleContextWeek;
  targetWeek: CycleContextWeek;
  okrRows: Array<{ row_index: number; okr: string }>;
  reviewRows: CycleContextRow[];
  /** The previous cycle's retro — one block per cycle (not per row). */
  reviewRetro: string;
  targetRows: CycleContextRow[];
}

const SPAN_DAYS: Record<string, number> = { weekly: 7, biweekly: 14 };

function weekOf(doc: CycleDoc): CycleContextWeek {
  const span = SPAN_DAYS[doc.mode] ?? 14;
  return { label: doc.cycle, start: doc.startDate, end: addDays(doc.startDate, span - 1) };
}

function contains(doc: CycleDoc, today: string): boolean {
  return doc.startDate <= today && today <= weekOf(doc).end;
}

/**
 * Parse a 要务 section's markdown (`### O名` then `- bullet` lines) back into
 * per-OKR-row task blocks — the inverse of `renderPrioritiesFromRun`. Rows follow
 * `labels` (okrRowLabels) order so `row` matches an item's `target_row`. A row
 * with nothing planned comes back with empty `tasks` (its heading may be absent,
 * or present as the placeholder, which is not a bullet and so contributes no task).
 */
export function parsePrioritiesByOkr(content: string, labels: string[]): CycleContextRow[] {
  const groups = new Map<string, string[]>();
  let heading = '';
  for (const raw of (content || '').split('\n')) {
    const line = raw.trim();
    const match = /^###\s+(.+)$/.exec(line);
    if (match) {
      heading = match[1].trim();
      if (!groups.has(heading)) groups.set(heading, []);
      continue;
    }
    // Only bullet lines are tasks; the "本周期无安排" placeholder is plain text.
    if (heading && (line.startsWith('- ') || line.startsWith('* '))) groups.get(heading)!.push(line);
  }
  const rows: CycleContextRow[] = [];
  for (let row = 1; row < labels.length; row += 1) {
    const okr = labels[row] || '';
    if (!okr.trim()) continue;
    const lines = groups.get(shortLabel(okr)) ?? groups.get(okr) ?? [];
    rows.push({ row, okr, tasks: lines.join('\n') });
  }
  return rows;
}

/**
 * Build the cycle context from local files, or null when it cannot — no local
 * OKR rows, or today is not inside any cycle. Null means "no context", and
 * life-review-os falls back to reading the Feishu table, so a missing/edge setup
 * degrades to the old behavior rather than failing.
 */
export function buildCycleContext(config: AppConfig): CycleContext | null {
  const labels = okrRowLabels(config);
  const okrRows = labels
    .map((okr, index) => ({ row_index: index, okr }))
    .filter((entry) => entry.row_index > 0 && entry.okr.trim().length > 0);
  if (okrRows.length === 0) return null;

  const today = todayInTimezone(config);
  const cycles = listCycles(config); // id-descending: newest first
  const target = cycles.find((doc) => contains(doc, today));
  if (!target) return null;
  // The most recent cycle that starts before the target one — its predecessor.
  const review = cycles.find((doc) => doc.startDate < target.startDate);

  return {
    schema: 1,
    mode: target.mode,
    targetWeek: weekOf(target),
    reviewWeek: review ? weekOf(review) : { label: '', start: '', end: '' },
    okrRows,
    reviewRows: review ? parsePrioritiesByOkr(review.sections['要务']?.content ?? '', labels) : [],
    reviewRetro: (review?.sections.retro?.content ?? '').trim(),
    targetRows: parsePrioritiesByOkr(target.sections['要务']?.content ?? '', labels),
  };
}

/** The `## Cycle Context` pack body: a fenced JSON block life-review-os parses. */
export function renderCycleContextBlock(context: CycleContext | null): string {
  if (!context) return '';
  return ['```json', JSON.stringify(context), '```'].join('\n');
}
