import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../config/schema.js';
import { detectTableLayout } from '../skills/weekly-review-writeback.js';
import { buildCycleId, writeCycle, type CycleDoc, type CyclePatch, type CycleSection } from './file.js';

/**
 * One-shot history migration (LEO-280): life-review-os run records + the Feishu
 * weekly tables -> cycle markdown files.
 *
 * Two sources, and neither one is complete on its own:
 *
 *   run records   要务 (the planner's write-back payload) and the AI review
 *   Feishu tables retro (hand-written, only ever lives in the table)
 *
 * Three facts drive the whole module, and each one is a trap:
 *
 * 1. A run's `review` is about `evidence.review_week` — the cycle that just
 *    *ended* — not about `writeback.target_week`, the cycle it is planning.
 *    life-review-os writes it into the reviewed cycle's retro cell (SKILL.md
 *    "retro 记录的是已结束周期的复盘，不写进正在规划的目标周"), and the one
 *    review that made it into Feishu is physically inside the 8.10-8.23 retro
 *    cell. Filing it under `target_week` would put a review of August 10-23
 *    next to the priorities for August 24 - September 6.
 *
 * 2. Because that review is appended *inside* the retro cell under a `🕙review`
 *    line, the retro has to be split back apart or the text lands twice.
 *
 * 3. The retro column is not on a fixed side of its 要务 column. 🐶 Q3 is
 *    retro-then-task, 🐧 Q3 is task-then-retro, and 🐶 Q2 flips relative to
 *    🐶 Q3 — so the side is a per-table property, resolved by the same
 *    `detectTableLayout` the live write-back uses.
 *
 * Writes go through `cycles/file.ts` only: this module decides *what* a cycle
 * says, never how a cycle file is spelled.
 */

export type CycleOwner = 'self' | 'partner';

export interface MigrationRunItem {
  text: string;
  isMit: boolean;
  targetRow: number;
  targetRowLabel: string;
}

export interface MigrationRun {
  runId: string;
  createdAt: string;
  /** File mtime: "last run for this cycle" is decided by this, not by content. */
  orderKey: number;
  mode: string;
  targetWeek: string;
  reviewWeek: string;
  docYear: number;
  items: MigrationRunItem[];
  reviewText: string;
}

export interface FeishuTable {
  blockId: string;
  rows: number;
  columns: number;
  headers: string[];
  /** `cells[row][column]`, already flattened to plain text. */
  cells: string[][];
  layout: 'retro_before_task' | 'task_before_retro';
}

export interface CyclePlan {
  owner: CycleOwner;
  id: string;
  label: string;
  mode: string;
  startDate: string;
  runId: string;
  sections: Partial<Record<CycleSection, string>>;
  /** Machine-readable report lines, e.g. `missing:retro`. */
  notes: string[];
}

export interface CycleApplyResult {
  id: string;
  owner: CycleOwner;
  status: 'created' | 'updated' | 'unchanged' | 'failed';
  written: CycleSection[];
  /** Sections staged as a pending draft (user-edited, not overwritten). */
  drafted: CycleSection[];
  skipped: Array<{ section: CycleSection; reason: string }>;
  error?: string;
}

const REVIEW_MARKER = /^\s*🕙\s*review\b.*$/i;
const LABEL_PATTERN = /^(\d{1,2})\.(\d{1,2})-(\d{1,2})\.(\d{1,2})$/;
const TASK_HEADER_SUFFIX = '要务';
const RETRO_HEADER_SUFFIX = 'retro';

// --- run records -------------------------------------------------------------

/** Read every `*.json` in a life-review-os `.runs` directory. Skips junk files. */
export function loadRuns(dir: string): MigrationRun[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const runs: MigrationRun[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    let raw: unknown;
    let orderKey = 0;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      orderKey = fs.statSync(file).mtimeMs;
    } catch {
      continue;
    }
    const run = parseRun(raw, orderKey);
    if (run) runs.push(run);
  }
  return runs;
}

/** Normalize one run record. Returns null when it carries no cycle label. */
export function parseRun(raw: unknown, orderKey: number): MigrationRun | null {
  const record = asRecord(raw);
  const writeback = asRecord(record.writeback);
  const evidence = asRecord(record.evidence);
  const targetWeek = normalizeLabel(asString(writeback.target_week) || asString(evidence.target_week));
  if (!targetWeek) return null;
  const review = asRecord(writeback.review);
  return {
    runId: asString(record.run_id),
    createdAt: asString(record.created_at),
    orderKey,
    mode: asString(record.mode) || 'weekly',
    targetWeek,
    reviewWeek: normalizeLabel(asString(evidence.review_week)),
    docYear: Number(writeback.doc_year) || Number((asString(record.created_at) || '').slice(0, 4)) || 0,
    items: (Array.isArray(writeback.items) ? writeback.items : []).map((entry) => {
      const item = asRecord(entry);
      return {
        text: asString(item.text),
        isMit: item.is_mit === true,
        targetRow: Number(item.target_row) || 0,
        targetRowLabel: asString(item.target_row_label),
      };
    }).filter((item) => item.text.length > 0),
    reviewText: asString(review.text),
  };
}

/**
 * The last run per key, by mtime. A cycle was re-planned up to 14 times; only
 * the final one describes what actually went into the table.
 */
export function latestRunByKey(runs: MigrationRun[], key: (run: MigrationRun) => string): Map<string, MigrationRun> {
  const latest = new Map<string, MigrationRun>();
  for (const run of runs) {
    const value = key(run);
    if (!value) continue;
    const current = latest.get(value);
    if (!current || run.orderKey > current.orderKey) latest.set(value, run);
  }
  return latest;
}

// --- Feishu block dump -------------------------------------------------------

/**
 * Rebuild every table in a `GET /docx/v1/documents/{doc}/blocks` dump.
 *
 * The whole document is one paged list, so a single dump (11 pages / ~12s for
 * this document) reconstructs all six tables. Reading cell by cell over the API
 * is the same data at ~100x the requests.
 */
export function parseFeishuTables(blocks: unknown[]): FeishuTable[] {
  const byId = new Map<string, Record<string, unknown>>();
  for (const entry of blocks) {
    const block = asRecord(entry);
    const id = asString(block.block_id);
    if (id) byId.set(id, block);
  }

  const tables: FeishuTable[] = [];
  for (const block of byId.values()) {
    const table = asRecord(block.table);
    const property = asRecord(table.property);
    const cellIds = asStringArray(table.cells);
    const columns = Number(property.column_size) || 0;
    const rows = Number(property.row_size) || 0;
    if (!columns || !rows || cellIds.length < columns * rows) continue;

    const cells: string[][] = [];
    for (let row = 0; row < rows; row += 1) {
      const line: string[] = [];
      for (let column = 0; column < columns; column += 1) line.push(cellText(byId, cellIds[row * columns + column]));
      cells.push(line);
    }
    const headers = cells[0].map((header) => header.replace(/\n+/g, ' ').trim());
    tables.push({
      blockId: asString(block.block_id),
      rows,
      columns,
      headers,
      cells,
      layout: detectTableLayout(headers, RETRO_HEADER_SUFFIX, TASK_HEADER_SUFFIX),
    });
  }
  return tables;
}

/** The owner marker (`🐶` / `🐧`) a table's corner cell is tagged with. */
export function tableMarker(table: FeishuTable): string {
  const corner = table.headers[0] || '';
  const match = corner.match(/\p{Extended_Pictographic}/u);
  return match ? match[0] : '';
}

/**
 * The 要务 column for `label` and the retro column that belongs to it.
 *
 * The retro column is the neighbour on the table's own layout side, and only
 * counts when that neighbour really is a retro header — three 🐶 Q2 cycles sit
 * next to another 要务 column and simply have no retro.
 */
export function findCycleColumns(table: FeishuTable, label: string): { taskColumn: number; retroColumn: number } {
  const wanted = normalizeLabel(label);
  const taskColumn = table.headers.findIndex((header, index) => index > 0 && isTaskHeader(header) && labelFromHeader(header) === wanted);
  if (taskColumn < 0) return { taskColumn: -1, retroColumn: -1 };
  const candidate = table.layout === 'retro_before_task' ? taskColumn - 1 : taskColumn + 1;
  const valid = candidate > 0 && candidate < table.columns && isRetroHeader(table.headers[candidate]);
  return { taskColumn, retroColumn: valid ? candidate : -1 };
}

/** Every cycle label the table has a 要务 column for, newest column first. */
export function tableCycleLabels(table: FeishuTable): string[] {
  const labels: string[] = [];
  for (let column = 1; column < table.columns; column += 1) {
    const header = table.headers[column];
    if (!isTaskHeader(header)) continue;
    const label = labelFromHeader(header);
    if (label && !labels.includes(label)) labels.push(label);
  }
  return labels;
}

/**
 * Split a retro cell into the hand-written retro and the `🕙review` block the
 * write-back appends to its bottom.
 */
export function splitRetroAndReview(cell: string): { retro: string; review: string } {
  const lines = (cell || '').replace(/\r\n/g, '\n').split('\n');
  const marker = lines.findIndex((line) => REVIEW_MARKER.test(line));
  if (marker < 0) return { retro: cell.trim(), review: '' };
  return {
    retro: lines.slice(0, marker).join('\n').trim(),
    review: lines.slice(marker + 1).join('\n').trim(),
  };
}

// --- planning ----------------------------------------------------------------

export interface PlanInput {
  runs: MigrationRun[];
  tables: FeishuTable[];
  selfMarker: string;
  partnerMarker: string;
  /** Year the weekly document covers; a `12.29-1.4` label starts the year before. */
  year: number;
}

/**
 * Turn runs + tables into one plan entry per cycle, newest first.
 *
 * The 🐶 cycle set is every `target_week` *and* every `review_week` seen in the
 * runs: a cycle that was only ever reviewed (8.10-8.23) still has a retro and a
 * review worth keeping, and a cycle whose sections all come out empty is
 * dropped rather than written as a stub.
 */
export function planCycles(input: PlanInput): CyclePlan[] {
  const selfTables = input.tables.filter((table) => tableMarker(table) === input.selfMarker);
  const partnerTables = input.tables.filter((table) => tableMarker(table) === input.partnerMarker);
  const plans = [...planSelfCycles(input, selfTables), ...planPartnerCycles(input, partnerTables)];
  return plans.sort((left, right) => (left.owner === right.owner ? (left.id < right.id ? 1 : -1) : left.owner === 'self' ? -1 : 1));
}

function planSelfCycles(input: PlanInput, tables: FeishuTable[]): CyclePlan[] {
  const byTarget = latestRunByKey(input.runs, (run) => run.targetWeek);
  const byReview = latestRunByKey(input.runs.filter((run) => run.reviewText.trim().length > 0), (run) => run.reviewWeek);

  const labels = new Set<string>([...byTarget.keys(), ...byReview.keys()]);
  const plans: CyclePlan[] = [];
  for (const label of labels) {
    const planRun = byTarget.get(label);
    const reviewRun = byReview.get(label);
    const mode = planRun?.mode || reviewRun?.mode || inferMode(label);
    const year = planRun?.docYear || reviewRun?.docYear || input.year;
    const startDate = startDateForLabel(label, year || input.year);
    if (!startDate) continue;

    const notes: string[] = [];
    const sections: Partial<Record<CycleSection, string>> = {};
    const located = locateInTables(tables, label);

    // The table's first column holds the real OKR row names; a run only carries
    // the KR paragraphs it matched against, so prefer the table when we have it.
    const rowLabels = located ? located.table.cells.map((row) => row[0]) : [];
    const priorities = planRun ? renderPrioritiesFromRun(planRun.items, rowLabels) : '';
    if (priorities) sections['要务'] = priorities;
    else notes.push(planRun ? 'empty:要务(run had no items)' : 'missing:要务(no run targeted this cycle)');

    if (!located) notes.push('missing:retro(no 要务 column in the Feishu tables)');
    else if (located.retroColumn < 0) notes.push('missing:retro(no retro column next to the 要务 column)');
    else {
      const split = splitRetroAndReview(located.table.cells[1][located.retroColumn]);
      if (split.retro) sections.retro = split.retro;
      else notes.push('missing:retro(retro cell is empty)');
      if (split.review) notes.push('info:feishu-review-present');
    }

    if (reviewRun?.reviewText) sections.review = reviewRun.reviewText.trim();
    else notes.push('missing:review(no run reviewed this cycle)');

    if (Object.keys(sections).length === 0) continue;
    plans.push({
      owner: 'self',
      id: buildCycleId(startDate, label),
      label,
      mode,
      startDate,
      runId: planRun?.runId || reviewRun?.runId || '',
      sections,
      notes,
    });
  }
  return plans;
}

function planPartnerCycles(input: PlanInput, tables: FeishuTable[]): CyclePlan[] {
  const plans: CyclePlan[] = [];
  const seen = new Set<string>();
  for (const table of tables) {
    for (const label of tableCycleLabels(table)) {
      if (seen.has(label)) continue;
      const startDate = startDateForLabel(label, input.year);
      if (!startDate) continue;
      const { taskColumn, retroColumn } = findCycleColumns(table, label);
      if (taskColumn < 0) continue;

      const notes: string[] = [];
      const sections: Partial<Record<CycleSection, string>> = {};
      const priorities = renderPrioritiesFromTable(table, taskColumn);
      if (priorities) sections['要务'] = priorities;
      else notes.push('missing:要务(要务 column is empty)');

      if (retroColumn < 0) notes.push('missing:retro(no retro column next to the 要务 column)');
      else {
        const split = splitRetroAndReview(table.cells[1][retroColumn]);
        if (split.retro) sections.retro = split.retro;
        else notes.push('missing:retro(retro cell is empty)');
        if (split.review) sections.review = split.review;
      }
      if (!sections.review) notes.push('missing:review(partner cycles have no run records)');

      if (Object.keys(sections).length === 0) continue;
      seen.add(label);
      plans.push({
        owner: 'partner',
        id: buildCycleId(startDate, label),
        label,
        mode: inferMode(label),
        startDate,
        runId: '',
        sections,
        notes,
      });
    }
  }
  return plans;
}

function locateInTables(tables: FeishuTable[], label: string): { table: FeishuTable; taskColumn: number; retroColumn: number } | null {
  for (const table of tables) {
    const columns = findCycleColumns(table, label);
    if (columns.taskColumn >= 0) return { table, ...columns };
  }
  return null;
}

// --- rendering ---------------------------------------------------------------

/**
 * Priorities grouped by their OKR row, the way the table stores them.
 * `rowLabels` is the table's first column when the cycle still has one.
 */
/** What an OKR row with nothing planned this cycle gets, so every O still shows. */
export const EMPTY_PRIORITY_PLACEHOLDER = '本周期无安排';

export function renderPrioritiesFromRun(items: MigrationRunItem[], rowLabels: string[] = []): string {
  // No items at all = a failed/empty run. Keep 要务 empty so the failure stays
  // visible (the App shows "未生成" + a regenerate button); do NOT paper over it
  // with a full set of placeholders, which would look like a successful blank plan.
  if (items.length === 0) return '';
  // Items grouped by the OKR row they target.
  const byRow = new Map<number, string[]>();
  for (const item of items) {
    const lines = byRow.get(item.targetRow) || [];
    lines.push(bulletFor(item.text, item.isMit));
    byRow.set(item.targetRow, lines);
  }

  const chunks: string[] = [];
  const rendered = new Set<number>();
  // Every OKR row, in order — an O with nothing planned still shows, with the
  // placeholder, instead of silently vanishing. Without this a cycle that only
  // planned into 3 of 7 objectives looked like it only had 3.
  for (let row = 1; row < rowLabels.length; row += 1) {
    const label = (rowLabels[row] || '').trim();
    if (!label) continue;
    rendered.add(row);
    const lines = byRow.get(row) || [];
    chunks.push([`### ${shortLabel(rowLabels[row])}`, ...(lines.length ? lines : [EMPTY_PRIORITY_PLACEHOLDER])].join('\n'));
  }
  // Items whose target row has no label (fell back to target_row_label): keep
  // them rather than drop, appended after the enumerated objectives.
  const extra = new Map<string, string[]>();
  for (const item of items) {
    if (rendered.has(item.targetRow)) continue;
    const heading = shortLabel(rowLabels[item.targetRow] || item.targetRowLabel);
    const lines = extra.get(heading) || [];
    lines.push(bulletFor(item.text, item.isMit));
    extra.set(heading, lines);
  }
  for (const [heading, lines] of extra) {
    if (lines.length === 0) continue;
    chunks.push([`### ${heading}`, ...lines].join('\n'));
  }
  return chunks.join('\n\n');
}

/** Same shape, from a 要务 table column: one group per OKR row. */
export function renderPrioritiesFromTable(table: FeishuTable, column: number): string {
  const groups = new Map<string, string[]>();
  for (let row = 1; row < table.rows; row += 1) {
    const cell = table.cells[row][column];
    if (!cell.trim()) continue;
    const heading = shortLabel(table.cells[row][0]);
    const lines = groups.get(heading) || [];
    for (const raw of cell.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      const mit = /(\s|^)(MIT|🔴)\s*$/.test(line);
      lines.push(bulletFor(line.replace(/(\s|^)(MIT|🔴)\s*$/, '').trim(), mit));
    }
    groups.set(heading, lines);
  }
  return renderGroups(groups);
}

function renderGroups(groups: Map<string, string[]>): string {
  const chunks: string[] = [];
  for (const [heading, lines] of groups) {
    if (lines.length === 0) continue;
    chunks.push([`### ${heading}`, ...lines].join('\n'));
  }
  return chunks.join('\n\n');
}

function bulletFor(text: string, isMit: boolean): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return isMit ? `- ${clean} **MIT**` : `- ${clean}`;
}

/**
 * OKR row labels are whole KR paragraphs, and a run's copy is a ` / `-joined
 * cell that can start with the separator for a line it never captured.
 */
export function shortLabel(value: string): string {
  const first = (value || '')
    .split('\n')
    .map((line) => line.replace(/^[\s/]+/, '').trim())
    .find((line) => line.length > 0) || '';
  if (!first) return '未匹配主线';
  return first.length > 60 ? `${first.slice(0, 60)}…` : first;
}

// --- applying ----------------------------------------------------------------

export interface ApplyOptions {
  dryRun: boolean;
  now?: string;
}

/**
 * Merge one plan into the cycle file, or report what it would do.
 *
 * Two rules keep re-runs safe. A section the user owns (`source: user`) is never
 * touched — that includes every retro this migration itself writes, so a retro
 * is written once and then belongs to the user. A section whose stored content
 * already matches is not rewritten either, which is what makes a second run a
 * no-op instead of a timestamp bump on every file.
 */
export function applyCyclePlan(
  config: AppConfig,
  plan: CyclePlan,
  existing: CycleDoc | null,
  options: ApplyOptions,
): CycleApplyResult {
  const result: CycleApplyResult = {
    id: plan.id,
    owner: plan.owner,
    status: existing ? 'unchanged' : 'created',
    written: [],
    drafted: [],
    skipped: [],
  };

  const patch: CyclePatch = { cycle: plan.label, mode: plan.mode, runId: plan.runId, sections: {} };
  for (const [section, content] of Object.entries(plan.sections) as Array<[CycleSection, string]>) {
    const stored = existing?.sections[section];
    if (stored && stored.source === 'user' && stored.content !== normalizeContent(content)) {
      // Hand-edited and the plan wants something different: don't overwrite —
      // stage the new content as a pending draft to compare and merge. Skip if
      // the same draft is already staged, so a re-run does not restamp it.
      if (stored.pendingDraft?.content === normalizeContent(content)) {
        result.skipped.push({ section, reason: 'draft-unchanged' });
        continue;
      }
      patch.sections![section] = { pendingDraft: { content, source: sourceFor(section) } };
      result.drafted.push(section);
      continue;
    }
    if (stored && stored.content === normalizeContent(content)) {
      result.skipped.push({ section, reason: 'unchanged' });
      continue;
    }
    // A fresh write settles the body and clears any stale draft (see writeCycle).
    patch.sections![section] = { content, source: sourceFor(section) };
    result.written.push(section);
  }

  if (result.written.length === 0 && result.drafted.length === 0) {
    result.status = 'unchanged';
    return result;
  }
  result.status = existing ? 'updated' : 'created';
  if (options.dryRun) return result;

  try {
    writeCycle(config, plan.id, patch, { now: options.now });
  } catch (error) {
    result.status = 'failed';
    result.error = error instanceof Error ? error.message : String(error);
  }
  return result;
}

/**
 * Section ownership, which is the whole point of the frontmatter: retro is the
 * user's even when this migration is the one copying it out of Feishu.
 */
function sourceFor(section: CycleSection): 'planner' | 'user' | 'ai' {
  if (section === 'retro') return 'user';
  if (section === 'review') return 'ai';
  return 'planner';
}

// --- labels and dates --------------------------------------------------------

/** `7.6 - 7.12 要务` and `7.6-7.12` are the same cycle. */
export function normalizeLabel(value: string): string {
  const compact = (value || '').replace(/\s+/g, '');
  return LABEL_PATTERN.test(compact) ? compact : '';
}

export function isTaskHeader(header: string): boolean {
  if (isRetroHeader(header)) return false;
  return labelFromHeader(header).length > 0;
}

export function isRetroHeader(header: string): boolean {
  return (header || '').toLowerCase().includes(RETRO_HEADER_SUFFIX);
}

/**
 * The cycle label a 要务 column header starts with. Headers carry trailing
 * noise (`4.13 - 4.20 要务 个人影响力`) and 2026 Q1 columns drop the 要务
 * suffix entirely, so anchor on the date range and ignore the rest. Summary
 * columns (`OKR进展 4.6-5.3`) do not start with one and are excluded.
 */
export function labelFromHeader(header: string): string {
  const compact = (header || '').replace(/\s+/g, '');
  const match = compact.match(/^(\d{1,2}\.\d{1,2}-\d{1,2}\.\d{1,2})/);
  return match ? match[1] : '';
}

/** `8.24-9.6` + 2026 -> `2026-08-24`. A label that wraps starts the year before. */
export function startDateForLabel(label: string, year: number): string {
  const match = LABEL_PATTERN.exec(normalizeLabel(label));
  if (!match || !year) return '';
  const startMonth = Number(match[1]);
  const startDay = Number(match[2]);
  const endMonth = Number(match[3]);
  const startYear = startMonth > endMonth ? year - 1 : year;
  const date = new Date(Date.UTC(startYear, startMonth - 1, startDay));
  if (date.getUTCMonth() !== startMonth - 1 || date.getUTCDate() !== startDay) return '';
  return date.toISOString().slice(0, 10);
}

/**
 * Runs carry their mode; a table column only has its span to go on. Measured in
 * a leap year so a `2.23-3.8` style label keeps its real length, and rolled into
 * the next year when the label wraps (`12.29-1.4`).
 */
export function inferMode(label: string): string {
  const match = LABEL_PATTERN.exec(normalizeLabel(label));
  if (!match) return 'weekly';
  const [startMonth, startDay, endMonth, endDay] = match.slice(1).map(Number);
  const start = Date.UTC(2024, startMonth - 1, startDay);
  const end = Date.UTC(endMonth < startMonth ? 2025 : 2024, endMonth - 1, endDay);
  return Math.round((end - start) / 86_400_000) >= 10 ? 'biweekly' : 'weekly';
}

// --- Feishu block text -------------------------------------------------------

const TEXT_BEARING_KEYS = [
  'text',
  'heading1',
  'heading2',
  'heading3',
  'heading4',
  'heading5',
  'heading6',
  'bullet',
  'ordered',
  'code',
  'quote',
  'todo',
] as const;

function cellText(byId: Map<string, Record<string, unknown>>, cellId: string): string {
  const cell = byId.get(cellId);
  if (!cell) return '';
  const lines: string[] = [];
  for (const childId of asStringArray(cell.children)) collectBlockText(byId, childId, lines);
  return lines.join('\n').trim();
}

function collectBlockText(byId: Map<string, Record<string, unknown>>, blockId: string, lines: string[]): void {
  const block = byId.get(blockId);
  if (!block) return;
  const text = blockText(block);
  if (text.trim()) lines.push(text.trim());
  for (const childId of asStringArray(block.children)) collectBlockText(byId, childId, lines);
}

/**
 * Inline text of one block. Doc mentions carry their title inline — an OKR row
 * reading "以家庭理财计划为核心" is a mention, not a text run, and dropping it
 * silently eats words out of the middle of a sentence. A user mention only
 * carries an open id, which has no business in a vault file, so it renders as a
 * bare `@`.
 */
function blockText(block: Record<string, unknown>): string {
  for (const key of TEXT_BEARING_KEYS) {
    const value = asRecord(block[key]);
    if (!Array.isArray(value.elements)) continue;
    const chunks: string[] = [];
    for (const entry of value.elements) {
      const element = asRecord(entry);
      const run = asRecord(element.text_run);
      if (typeof run.content === 'string') {
        chunks.push(run.content);
        continue;
      }
      const mentionDoc = asRecord(element.mention_doc);
      if (typeof mentionDoc.title === 'string') {
        chunks.push(mentionDoc.title);
        continue;
      }
      if (element.mention_user) chunks.push('@');
    }
    return chunks.join('');
  }
  return '';
}

// --- small helpers -----------------------------------------------------------

/** Mirrors `cycles/file.ts` so "would this write change anything?" is honest. */
function normalizeContent(value: string): string {
  return (value || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function asString(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return String(value);
  return '';
}
