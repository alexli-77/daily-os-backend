import type { AppConfig } from '../config/schema.js';
import { listCycles } from './file.js';

/**
 * LEO-279 — the retro the user writes in the Cycles page reaches the next
 * planning run.
 *
 * Until now a hand-written retro only existed in the Feishu retro cell, and
 * that is where life-review-os reads it from ("优先参考 weekly_rows 里同一
 * retro 单元格已有的状态、做得好、待改进"). Once the retro is written in the
 * local UI instead, that cell is empty and the planner reviews a cycle with no
 * account of what actually happened in it.
 *
 * The cycle files were already reaching the skill input pack — inside the
 * "Memory Repository Files" dump. But life-review-os reads only the first
 * 20,000 characters of the pack, and that dump starts around offset 59,000, so
 * the retro has never once been seen by a planning run. Measured against a real
 * pack:
 *
 *     581  ## Local OKR Chain          (12.7 KB)
 *   13905  ## Latest Workflow
 *   17801  ## Recent Daily Memory      <- the 20,000 cut lands here
 *   45867  ## Memory Repository Files  <- the cycle files, never read
 *
 * So this block is emitted near the top, ahead of "Latest Workflow", and is
 * capped: the whole point is defeated if it pushes the OKR chain or the Linear
 * snapshot past the cut instead.
 */

/** Cycles worth showing: enough for the biweekly trend read, not enough to blow the budget. */
const MAX_CYCLES = 2;
const MAX_CHARS_PER_CYCLE = 1500;
const MAX_TOTAL_CHARS = 3200;

export interface LocalRetroEntry {
  cycleId: string;
  label: string;
  mode: string;
  updatedAt: string;
  retro: string;
  truncated: boolean;
}

/**
 * The most recent cycles that actually have a retro, newest first.
 *
 * Cycles without one are skipped rather than listed as empty: an empty heading
 * in the prompt reads as "the user wrote nothing this cycle", which is a claim
 * this function cannot make — the retro may simply live in Feishu.
 */
export function recentLocalRetros(config: AppConfig): LocalRetroEntry[] {
  const entries: LocalRetroEntry[] = [];
  let budget = MAX_TOTAL_CHARS;
  for (const doc of listCycles(config)) {
    if (entries.length >= MAX_CYCLES) break;
    const section = doc.sections.retro;
    const text = (section?.content || '').trim();
    if (!text) continue;
    const limit = Math.min(MAX_CHARS_PER_CYCLE, budget);
    if (limit <= 0) break;
    const truncated = text.length > limit;
    entries.push({
      cycleId: doc.id,
      label: doc.cycle || doc.id,
      mode: doc.mode || '',
      updatedAt: section?.updatedAt || doc.updatedAt || '',
      retro: truncated ? `${text.slice(0, limit)}…（已截断）` : text,
      truncated,
    });
    budget -= limit;
  }
  return entries;
}

/**
 * The input-pack block. Returns '' when there is nothing to say, so the caller
 * can fall back to a one-line placeholder rather than emitting a heading with
 * an empty body.
 */
export function renderLocalRetroBlock(entries: LocalRetroEntry[]): string {
  if (entries.length === 0) return '';
  return entries
    .map((entry) => {
      const meta = [entry.mode, entry.updatedAt ? `更新于 ${entry.updatedAt.slice(0, 10)}` : ''].filter(Boolean).join(' · ');
      return `### ${entry.label}${meta ? `（${meta}）` : ''}\n${entry.retro}`;
    })
    .join('\n\n');
}

/**
 * #220 — the 要务 the user actually planned, from the local cycle files.
 *
 * life-review-os reads the previous cycle's 要务 from the Feishu weekly table.
 * With Feishu write-back off (#211) that column is never written, so the
 * planner reviews a cycle with no plan in it and its "carry unfinished items
 * forward verbatim" rule has nothing to carry: 9.7-9.20's 🚧 CUTTO-1093/1094
 * simply vanished from 9.21-10.4, neither carried nor marked 本期不做.
 *
 * Same placement and budget reasoning as the retro block above.
 */
const MAX_PRIORITY_CYCLES = 2;
const MAX_PRIORITY_CHARS_PER_CYCLE = 1800;
const MAX_PRIORITY_TOTAL_CHARS = 3200;

export interface LocalPrioritiesEntry {
  cycleId: string;
  label: string;
  mode: string;
  priorities: string;
  truncated: boolean;
}

/**
 * Cycles that have started by `date` and have 要务, newest first. Started, not
 * finished: planning often runs on the last weekend of a cycle, when the cycle
 * being reviewed is still the current one.
 */
export function recentLocalPriorities(config: AppConfig, date: string): LocalPrioritiesEntry[] {
  const entries: LocalPrioritiesEntry[] = [];
  let budget = MAX_PRIORITY_TOTAL_CHARS;
  for (const doc of listCycles(config)) {
    if (entries.length >= MAX_PRIORITY_CYCLES) break;
    if (!doc.startDate || doc.startDate > date) continue;
    const text = (doc.sections['要务']?.content || '').trim();
    if (!text) continue;
    const limit = Math.min(MAX_PRIORITY_CHARS_PER_CYCLE, budget);
    if (limit <= 0) break;
    const truncated = text.length > limit;
    entries.push({
      cycleId: doc.id,
      label: doc.cycle || doc.id,
      mode: doc.mode || '',
      priorities: truncated ? `${text.slice(0, limit)}…（已截断）` : text,
      truncated,
    });
    budget -= limit;
  }
  return entries;
}

export function renderLocalPrioritiesBlock(entries: LocalPrioritiesEntry[]): string {
  if (entries.length === 0) return '';
  return entries
    .map((entry) => `### ${entry.label} 要务${entry.mode ? `（${entry.mode}）` : ''}\n${entry.priorities}`)
    .join('\n\n');
}
