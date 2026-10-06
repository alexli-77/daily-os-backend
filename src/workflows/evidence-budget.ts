import type { WorkflowName } from '../config/schema.js';
import type { Evidence, EvidenceSource } from './types.js';

/**
 * Keep the assembled prompt inside a context window.
 *
 * The failure this exists to stop was silent and total: evidence grew to
 * 685k characters — a prompt of 868k, comfortably past any model's context —
 * and every scheduled `daily_plan` died on the agent's own 180s timeout. The
 * run ledger recorded it, `safeTick` logged it to stderr, and the user simply
 * never received a morning plan. Nothing in the pipeline had an opinion about
 * how big a prompt was allowed to be.
 *
 * So this is a backstop, not a tuning knob. The connectors should return
 * something reasonable; this makes sure that when one of them stops being
 * reasonable — a doc grows, a repo gets chatty — the run degrades into a
 * smaller plan instead of producing nothing at all. Everything it removes is
 * reported in `notes`, because a budget that trims in silence just moves the
 * invisible failure one layer down.
 */

/** Characters of evidence JSON allowed into a prompt. */
export const EVIDENCE_BUDGET_CHARS = 120_000;

/**
 * Longest single string kept inside a source, by source-name suffix.
 *
 * Long strings are where the weight is: a Feishu doc arrives as one 160k-char
 * blob, while an IM history is hundreds of short ones. Capping per string
 * rather than per source keeps the structure intact — the agent still sees
 * every message, every doc, just not every word of the longest ones.
 */
const STRING_LIMITS: Array<[RegExp, number]> = [
  [/_docs$/, 4_000],
  [/_im_history$/, 800],
  [/^progress_ledger$/, 8_000],
];
const DEFAULT_STRING_LIMIT = 2_000;

/**
 * Ceiling on a single source, enforced by dropping list items.
 *
 * Deliberately generous compared with the string limits above: this is the step
 * that keeps one chatty source from eating the whole budget, not an attempt to
 * decide how much chat is interesting.
 */
const SOURCE_CAPS: Array<[RegExp, number]> = [
  [/_im_history$/, 12_000],
  [/_docs$/, 20_000],
  // Roomier than the rest on purpose. Trimming here halves one repository's
  // issue list — `longestArray` picks a single array — so a cap that bites
  // leaves one repo half-represented and the others whole, which is worse than
  // carrying the extra characters. With projected issues the whole set fits.
  [/^github$/, 45_000],
];
const DEFAULT_SOURCE_CAP = 25_000;

/**
 * Which sources survive when the total is still too big, least valuable last.
 *
 * Ordered by what a plan cannot be made without. The user's own priorities and
 * inbox come first because they are the answer; chat and open browser tabs come
 * last because they are atmosphere.
 */
const KEEP_ORDER = [
  'weekly_priorities',
  'todo_inbox',
  'progress_ledger',
  'linear',
  'github',
  'vault',
  'apple_calendar_snapshot',
  'feishu_work_calendar',
  'feishu_work_tasks',
  'feishu_work_docs',
  'feishu_minutes_bot_latest_docs',
  'feishu_work_im_history',
  'feishu_minutes_bot_im_history',
  'chrome_snapshot',
];

/**
 * Sidecars that are real evidence for one workflow and pure weight for another.
 *
 * `recently_completed` is the clear case: the Linear connector keeps finished
 * issues out of `items` precisely so they can never become a todo candidate,
 * then ships them alongside for the review to reason about. In a `daily_plan`
 * they are 60k characters answering a question nobody asked.
 */
const WORKFLOW_DROPS: Partial<Record<WorkflowName, Array<{ source: string; path: string[]; why: string }>>> = {
  daily_plan: [
    { source: 'linear', path: ['data', 'recently_completed'], why: '已完成的 issue 不会成为今天的待办' },
    // The raw open-issue list. Every issue that may be planned today is already
    // in `todo_scored`, filtered by `anchorToCycle`; the rest are exactly the
    // ones the user left out of the cycle. Shown them anyway, the model wrote
    // one into the plan's note — an issue the user had ticked done that
    // morning, which the plan run cannot see.
    { source: 'linear', path: ['data', 'items'], why: '能排的 issue 已在 todo_scored 里，其余是用户没放进本期要务的' },
  ],
};

export interface BudgetOutcome {
  evidence: Evidence;
  before: number;
  after: number;
  /** Human-readable record of everything removed. Empty when nothing was. */
  notes: string[];
}

export function fitEvidenceToBudget(
  evidence: Evidence,
  workflow: WorkflowName,
  budget = EVIDENCE_BUDGET_CHARS,
): BudgetOutcome {
  const before = measure(evidence);
  const notes: string[] = [];
  // Deep copy: the same evidence object is handed to the run ledger and the
  // console's evidence view, and trimming it for the prompt must not quietly
  // edit what those show. `deletePath` below mutates, so the copy is required,
  // not defensive habit.
  const sources = structuredClone(evidence.sources) as Record<string, EvidenceSource>;

  for (const drop of WORKFLOW_DROPS[workflow] ?? []) {
    const source = sources[drop.source];
    if (!source) continue;
    const removed = deletePath(source, drop.path);
    if (removed > 0) {
      sources[drop.source] = source;
      notes.push(`${workflow}: 丢弃 ${drop.source}.${drop.path.join('.')}（${fmt(removed)} 字符）——${drop.why}`);
    }
  }

  for (const [name, source] of Object.entries(sources)) {
    const limit = stringLimitFor(name);
    const sizeBefore = measure(source);
    const capped = capStrings(source, limit) as EvidenceSource;
    const sizeAfter = measure(capped);
    if (sizeAfter < sizeBefore) {
      sources[name] = capped;
      notes.push(`${name}: 长文本截断到 ${fmt(limit)} 字符/条（${fmt(sizeBefore)} → ${fmt(sizeAfter)}）`);
    }
  }

  // Shrink oversized sources by dropping list items rather than by deleting the
  // source. Fifty chat messages capped to the first fifteen still tells the
  // agent what today is about; no chat history at all does not.
  for (const [name, source] of Object.entries(sources)) {
    const cap = sourceCapFor(name);
    const sizeBefore = measure(source);
    if (sizeBefore <= cap) continue;
    const dropped = trimArraysToFit(source, cap);
    if (dropped > 0) {
      notes.push(`${name}: 丢掉 ${dropped} 条列表项以收进 ${fmt(cap)} 字符（${fmt(sizeBefore)} → ${fmt(measure(source))}）`);
    }
  }

  // Whole-source eviction, last resort. Only runs when the steps above were not
  // enough, which means a source is big in a shape neither of them can see into.
  let total = measure({ ...evidence, sources });
  for (const name of evictionOrder(sources)) {
    if (total <= budget) break;
    const size = measure(sources[name]);
    // Evicting something tiny cannot get us under budget; it would only add
    // noise to `notes` and hide the source that actually matters.
    if (size < 1_000) continue;
    sources[name] = { state: 'empty', detail: '因 prompt 体积预算被裁掉' };
    total = measure({ ...evidence, sources });
    notes.push(`${name}: 整源裁掉（${fmt(size)} 字符）——总量仍超出 ${fmt(budget)} 字符预算`);
  }

  const trimmed: Evidence = { ...evidence, sources };
  return { evidence: trimmed, before, after: measure(trimmed), notes };
}

function stringLimitFor(name: string): number {
  for (const [pattern, limit] of STRING_LIMITS) {
    if (pattern.test(name)) return limit;
  }
  return DEFAULT_STRING_LIMIT;
}

function sourceCapFor(name: string): number {
  for (const [pattern, cap] of SOURCE_CAPS) {
    if (pattern.test(name)) return cap;
  }
  return DEFAULT_SOURCE_CAP;
}

/**
 * Shrink `holder` under `cap` by repeatedly halving its longest array.
 *
 * Halving rather than computing an exact cut because the cost of an item is not
 * uniform — one 3k-character message among forty short ones makes any
 * "keep N items" arithmetic wrong. Items come off the end, which keeps whatever
 * order the connector chose to lead with.
 *
 * Returns how many items were dropped in total.
 */
function trimArraysToFit(holder: unknown, cap: number): number {
  let dropped = 0;
  for (let guard = 0; guard < 40 && measure(holder) > cap; guard += 1) {
    const longest = longestArray(holder);
    if (!longest || longest.length <= 1) break;
    const keep = Math.max(1, Math.floor(longest.length / 2));
    dropped += longest.length - keep;
    longest.splice(keep);
  }
  return dropped;
}

function longestArray(value: unknown): unknown[] | null {
  let best: unknown[] | null = null;
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      if (!best || node.length > best.length) best = node;
      node.forEach(visit);
      return;
    }
    if (node && typeof node === 'object') Object.values(node as Record<string, unknown>).forEach(visit);
  };
  visit(value);
  return best;
}

/**
 * Least valuable first, and anything unknown before anything ranked.
 *
 * A source nobody thought to rank is by definition not one the plan was built
 * around, so it should go before `chrome_snapshot` rather than after `github`.
 */
function evictionOrder(sources: Record<string, EvidenceSource>): string[] {
  const ranked = KEEP_ORDER.filter((name) => name in sources);
  const unranked = Object.keys(sources).filter((name) => !KEEP_ORDER.includes(name));
  return [...unranked.reverse(), ...ranked.reverse()];
}

function capStrings(value: unknown, limit: number): unknown {
  if (typeof value === 'string') {
    return value.length > limit ? `${value.slice(0, limit)}…[截断 ${fmt(value.length - limit)} 字符]` : value;
  }
  if (Array.isArray(value)) return value.map((item) => capStrings(item, limit));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, capStrings(v, limit)]));
  }
  return value;
}

/** Removes `path` from `holder` in place; returns the characters reclaimed. */
function deletePath(holder: unknown, path: string[]): number {
  let cursor: unknown = holder;
  for (const step of path.slice(0, -1)) {
    if (!cursor || typeof cursor !== 'object') return 0;
    cursor = (cursor as Record<string, unknown>)[step];
  }
  const leaf = path[path.length - 1];
  if (!cursor || typeof cursor !== 'object' || leaf === undefined) return 0;
  const container = cursor as Record<string, unknown>;
  if (!(leaf in container)) return 0;
  const size = measure(container[leaf]);
  delete container[leaf];
  return size;
}

function measure(value: unknown): number {
  return JSON.stringify(value ?? null)?.length ?? 0;
}

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}
