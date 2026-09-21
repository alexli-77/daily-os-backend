import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../config/schema.js';
import type { Evidence, EvidenceSource } from '../workflows/types.js';
import { DEFAULT_TOP_N, loadScorerWeights, type ScorerWeights } from './scorer-config.js';
import { getCarryOverDaysById, getCompletedCandidateIds } from './feedback.js';
import { resolveDayShape, type DayShape } from '../user/rhythm.js';

/**
 * LEO-209 — programmatic todo scorer.
 *
 * Normalizes the four candidate sources (todo_inbox, Linear, vault open todos,
 * Feishu weekly priorities) into a single `TodoCandidate` pool, dedupes them,
 * and applies a transparent weighted score so the daily-plan prompt receives a
 * ranked top-N with a per-item breakdown instead of an unscored blob.
 */
export type TodoSource = 'todo_inbox' | 'linear' | 'vault' | 'weekly_priorities';

export interface TodoCandidate {
  id: string;
  title: string;
  source: TodoSource;
  dueDate?: string;
  priority?: string;
  /** Linear workflow state name as shown on the board, e.g. "In Progress" / "In Review". */
  stateName?: string;
  /** Linear workflow state type, e.g. `started` / `unstarted` / `backlog`. */
  stateType?: string;
  carryOverDays?: number;
  okrKrId?: string;
  calendarProximityMin?: number;
  isCustomerFacing?: boolean;
  /** Weaker OKR signal that only comes from a Feishu weekly-priority tag. */
  weeklyOkrHit?: boolean;
}

export interface ScoreBreakdown {
  overdue?: number;
  dueWithin24h?: number;
  dueWithin72h?: number;
  linearPriority?: number;
  linearState?: number;
  calendarWithin2h?: number;
  carryOver?: number;
  okr?: number;
  customerFacing?: number;
  manualCapture?: number;
  /** Negative. Work-sourced candidate on a rest day — see `ScorerWeights.restDayWorkDamping`. */
  restDayDamping?: number;
}

/**
 * Sources that represent work somebody else is waiting on.
 *
 * `todo_inbox` and `vault` are excluded on purpose: those are the user's own
 * lines, and on a Saturday "给大汪汪做饭" arrives through exactly the same pipe as
 * a work task. Damping them would suppress the rest day rather than protect it.
 */
const WORK_SOURCES: ReadonlySet<TodoSource> = new Set<TodoSource>(['linear', 'weekly_priorities']);

export interface ScoredTodoCandidate extends TodoCandidate {
  rank: number;
  score: number;
  breakdown: ScoreBreakdown;
  /**
   * Same value as `id`, under the name the daily-plan prompt asks the model to
   * echo back. `prompts/daily_plan.md` documents `top[].candidateId` and says to
   * return it verbatim, but this payload only ever carried `id` — the two ends
   * of the contract disagreed. Models used to paper over it by inferring the
   * mapping; a stricter one instead refused to invent the missing field and
   * returned an empty plan. Emitting both keeps `id` for every internal
   * consumer (dedupe, completion ledger, carry-over) and makes "return it
   * verbatim" literally true.
   */
  candidateId: string;
}

export interface ScoreAndRankOptions {
  weights?: ScorerWeights;
  topN?: number;
  now?: Date;
  /**
   * LEO-232 — consecutive carry-over days per candidateId, sourced from the todo
   * feedback ledger. Overlaid onto candidates before scoring so that a task the
   * user keeps deferring at daily-review time climbs the ranking. Injectable for
   * tests; falls back to reading the ledger from disk in `buildScoredTodos`.
   */
  carryOverDaysById?: Map<string, number>;
  /**
   * candidateIds already marked complete (Feishu ✅ / console "完成"), excluded from
   * the candidate pool so a finished todo is never re-proposed tomorrow.
   * Injectable for tests; falls back to the ledger in `buildScoredTodos`.
   */
  completedCandidateIds?: Set<string>;
  /**
   * What kind of day this is for the user. On a rest day, work-sourced
   * candidates are damped so the ranking the model receives is already shaped
   * like a weekend instead of leaving the model to notice on its own.
   *
   * Injectable for tests; `buildScoredTodos` resolves it from config + date.
   * Omitted entirely means "no rhythm applied" — a work day.
   */
  dayShape?: DayShape;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const CUSTOMER_SIGNAL =
  /客户|甲方|合同|签约|付费|交付|对接|demo|演示|上线|发布|回款|投放|customer|client|delivery|ship|launch|invoice/i;

// --- public API ------------------------------------------------------------

/**
 * Build the ranked top-N candidates directly from collected evidence. This is
 * the entry point the daily-plan input assembly uses.
 */
export function buildScoredTodos(
  config: AppConfig,
  evidence: Evidence,
  date: string,
  options: ScoreAndRankOptions = {},
): {
  generated_at: string;
  weights: ScorerWeights;
  top: ScoredTodoCandidate[];
  total_candidates: number;
  day_shape: DayShape;
} {
  const weights = options.weights ?? loadScorerWeights();
  const dayShape = options.dayShape ?? resolveDayShape(config, date);
  const now = options.now ?? new Date(`${date}T00:00:00`);
  const all = normalizeCandidates({ config, evidence, date, now });
  // Drop anything the user already ticked complete: a completed todo must never be
  // re-proposed by a later plan, however its source still reports it.
  const completed = options.completedCandidateIds ?? getCompletedCandidateIds(config);
  const candidates = completed.size ? all.filter((candidate) => !completed.has(candidate.id)) : all;
  // LEO-232: overlay the carry-over streak (from the daily-review reconciliation
  // ledger) so a task the user keeps deferring gains carryOverDays even when its
  // source (e.g. Linear/vault) carries no creation timestamp.
  const carryOverDaysById = options.carryOverDaysById ?? getCarryOverDaysById(config);
  const enriched = carryOverDaysById.size
    ? candidates.map((candidate) => {
        const days = carryOverDaysById.get(candidate.id);
        return days && days > (candidate.carryOverDays ?? 0) ? { ...candidate, carryOverDays: days } : candidate;
      })
    : candidates;
  const top = scoreAndRank(enriched, { ...options, weights, now, dayShape });
  return {
    generated_at: new Date().toISOString(),
    weights,
    top,
    total_candidates: candidates.length,
    // Emitted alongside the ranking so the prompt's 作息 section and the numbers
    // it is explaining come from one resolution, and so the console can show the
    // user what today actually resolved to rather than only what they configured.
    day_shape: dayShape,
  };
}

/**
 * Collect + dedupe candidates from the four evidence sources.
 */
export function normalizeCandidates(input: {
  config: AppConfig;
  evidence: Evidence;
  date: string;
  now?: Date;
}): TodoCandidate[] {
  const { evidence, date } = input;
  const now = input.now ?? new Date(`${date}T00:00:00`);
  // `config` here can be a hand-rolled object (tests, callers that only fill in
  // what they need), so `memory` may be absent — never let that throw.
  const okrIndex = loadOkrIndex(input.config?.memory?.repository_path);
  const raw: TodoCandidate[] = [
    ...fromTodoInbox(evidence.sources.todo_inbox, now),
    ...fromLinear(evidence.sources.linear),
    ...fromVault(evidence.sources.vault_scan),
    ...fromWeeklyPriorities(evidence.sources.weekly_priorities),
  ].map((candidate) => enrichOkr(candidate, okrIndex));
  return dedupeCandidates(raw);
}

/**
 * Score + rank candidates, returning the top-N with a per-item breakdown.
 */
export function scoreAndRank(candidates: TodoCandidate[], options: ScoreAndRankOptions = {}): ScoredTodoCandidate[] {
  const weights = options.weights ?? loadScorerWeights();
  const now = options.now ?? new Date();
  const topN = options.topN ?? DEFAULT_TOP_N;
  const scored = candidates.map((candidate) => {
    const { score, breakdown } = scoreCandidate(candidate, weights, now, options.dayShape);
    return { ...candidate, score, breakdown, rank: 0, candidateId: candidate.id };
  });
  scored.sort((left, right) => right.score - left.score || left.title.localeCompare(right.title));
  return scored.slice(0, topN).map((candidate, index) => ({ ...candidate, rank: index + 1 }));
}

/**
 * Weighted score for a single candidate.
 *
 * score = overdue?35 | dueWithin24h?25 | dueWithin72h?12 +
 *         linear(Urgent20/High12) + linearState(InProgress15/InReview8) +
 *         calendarProximity(<=120min?15) + min(carryOverDays*5,15) +
 *         okr(linked12 | weeklyHit6) + customerFacing?10 +
 *         restDayDamping(work source on a rest day, not urgent ? -18)
 */
export function scoreCandidate(
  candidate: TodoCandidate,
  weights: ScorerWeights,
  now: Date = new Date(),
  dayShape?: DayShape,
): { score: number; breakdown: ScoreBreakdown } {
  const breakdown: ScoreBreakdown = {};

  const dueMs = parseDateMs(candidate.dueDate);
  // Urgency is computed once and reused by the rest-day damping below: an item
  // that is already late, or lands today, is the exception that survives a rest
  // day. Deriving it twice from `dueMs` is how the two would eventually drift.
  let urgent = false;
  if (dueMs !== null) {
    if (dueMs < now.getTime()) {
      breakdown.overdue = weights.overdue;
      urgent = true;
    } else if (dueMs - now.getTime() <= DAY_MS) {
      breakdown.dueWithin24h = weights.dueWithin24h;
      urgent = true;
    } else if (dueMs - now.getTime() <= 3 * DAY_MS) {
      breakdown.dueWithin72h = weights.dueWithin72h;
    }
  }

  const linearPoints = linearPriorityPoints(candidate, weights);
  if (linearPoints > 0) breakdown.linearPriority = linearPoints;

  const statePoints = linearStatePoints(candidate, weights);
  if (statePoints > 0) breakdown.linearState = statePoints;

  if (typeof candidate.calendarProximityMin === 'number' && candidate.calendarProximityMin <= 120) {
    breakdown.calendarWithin2h = weights.calendarWithin2h;
  }

  if (typeof candidate.carryOverDays === 'number' && candidate.carryOverDays > 0) {
    breakdown.carryOver = Math.min(candidate.carryOverDays * weights.carryOverPerDay, weights.carryOverCap);
  }

  if (candidate.okrKrId) breakdown.okr = weights.okrLinked;
  else if (candidate.weeklyOkrHit) breakdown.okr = weights.okrWeeklyHit;

  if (candidate.isCustomerFacing) breakdown.customerFacing = weights.customerFacing;

  if (candidate.source === 'todo_inbox') breakdown.manualCapture = weights.manualCapture;

  if (dayShape?.isRestDay && WORK_SOURCES.has(candidate.source) && !urgent) {
    breakdown.restDayDamping = weights.restDayWorkDamping;
  }

  const score = Object.values(breakdown).reduce((sum, value) => sum + (value ?? 0), 0);
  return { score, breakdown };
}

// --- source normalizers ----------------------------------------------------

function fromTodoInbox(source: EvidenceSource | undefined, now: Date): TodoCandidate[] {
  if (!source || source.state !== 'available' || !isRecord(source.data)) return [];
  const open = Array.isArray(source.data.open) ? source.data.open : [];
  return open
    .filter(isRecord)
    .filter((item) => typeof item.text === 'string' && item.text.trim())
    .map((item) => {
      const title = String(item.text).trim();
      const createdMs = parseDateMs(typeof item.created_at === 'string' ? item.created_at : undefined);
      const carryOverDays = createdMs !== null ? Math.max(0, Math.floor((now.getTime() - createdMs) / DAY_MS)) : undefined;
      return {
        id: `todo_inbox:${typeof item.id === 'string' ? item.id : title}`,
        title,
        source: 'todo_inbox' as const,
        ...dueDateFromHint(typeof item.due_hint === 'string' ? item.due_hint : undefined, now),
        ...(carryOverDays !== undefined ? { carryOverDays } : {}),
        isCustomerFacing: CUSTOMER_SIGNAL.test(title),
      };
    });
}

function fromLinear(source: EvidenceSource | undefined): TodoCandidate[] {
  if (!source || source.state !== 'available') return [];
  return linearItems(source.data)
    .filter(isRecord)
    .filter((item) => typeof item.identifier === 'string')
    .map((item) => {
      const identifier = String(item.identifier);
      const title = typeof item.title === 'string' && item.title ? item.title : identifier;
      const priorityLabel = linearPriorityLabel(item.priority);
      const state = isRecord(item.state) ? item.state : undefined;
      const stateName = typeof state?.name === 'string' ? state.name : '';
      const stateType = typeof state?.type === 'string' ? state.type : '';
      return {
        id: `linear:${identifier}`,
        title: `${identifier} ${title}`.trim(),
        source: 'linear' as const,
        ...(typeof item.dueDate === 'string' && item.dueDate ? { dueDate: item.dueDate } : {}),
        ...(priorityLabel ? { priority: priorityLabel } : {}),
        ...(stateName ? { stateName } : {}),
        ...(stateType ? { stateType } : {}),
        isCustomerFacing: CUSTOMER_SIGNAL.test(title),
      };
    });
}

function fromVault(source: EvidenceSource | undefined): TodoCandidate[] {
  if (!source || source.state !== 'available' || !isRecord(source.data)) return [];
  const candidates = Array.isArray(source.data.candidates) ? source.data.candidates : [];
  return candidates
    .filter(isRecord)
    .filter((item) => typeof item.title === 'string' && item.title.trim())
    .map((item) => {
      const title = String(item.title).trim();
      const summary = typeof item.summary === 'string' ? item.summary : '';
      const due = typeof item.due === 'string' && item.due ? item.due : typeof item.next_review === 'string' ? item.next_review : undefined;
      return {
        id: `vault:${typeof item.path === 'string' ? item.path : title}`,
        title,
        source: 'vault' as const,
        ...(due ? { dueDate: due } : {}),
        ...(typeof item.priority === 'string' && item.priority ? { priority: item.priority } : {}),
        isCustomerFacing: CUSTOMER_SIGNAL.test(`${title} ${summary}`),
      };
    });
}

function fromWeeklyPriorities(source: EvidenceSource | undefined): TodoCandidate[] {
  if (!source || source.state !== 'available' || !isRecord(source.data) || !Array.isArray(source.data.items)) return [];
  return source.data.items
    .filter(isRecord)
    .map((item, index): TodoCandidate | null => {
      const text = typeof item.item === 'string' ? item.item.trim() : '';
      if (!text || /✅/.test(text)) return null;
      const okrTag = typeof item.okr === 'string' ? item.okr.trim() : '';
      return {
        id: `weekly:${index}:${text.slice(0, 24)}`,
        title: text,
        source: 'weekly_priorities' as const,
        ...(okrTag ? { weeklyOkrHit: true } : {}),
        isCustomerFacing: CUSTOMER_SIGNAL.test(text),
      };
    })
    .filter((candidate): candidate is TodoCandidate => Boolean(candidate));
}

// --- dedupe ----------------------------------------------------------------

const SOURCE_PRIORITY: Record<TodoSource, number> = {
  linear: 4,
  todo_inbox: 3,
  weekly_priorities: 2,
  vault: 1,
};

function dedupeCandidates(candidates: TodoCandidate[]): TodoCandidate[] {
  const kept: TodoCandidate[] = [];
  for (const candidate of candidates) {
    const key = normalizeTitle(candidate.title);
    const existingIndex = kept.findIndex(
      (other) =>
        other.id === candidate.id ||
        sharesIssueKeyAcrossSources(other, candidate) ||
        titlesSimilar(normalizeTitle(other.title), key),
    );
    if (existingIndex === -1) {
      kept.push(candidate);
      continue;
    }
    // Same-id duplicates or near-identical titles: keep the higher-priority
    // source, merging any signal the winner is missing.
    const existing = kept[existingIndex];
    const winner = SOURCE_PRIORITY[candidate.source] > SOURCE_PRIORITY[existing.source] ? candidate : existing;
    const loser = winner === candidate ? existing : candidate;
    kept[existingIndex] = mergeCandidate(winner, loser);
  }
  return kept;
}

function mergeCandidate(winner: TodoCandidate, loser: TodoCandidate): TodoCandidate {
  return {
    ...winner,
    dueDate: winner.dueDate ?? loser.dueDate,
    priority: winner.priority ?? loser.priority,
    stateName: winner.stateName ?? loser.stateName,
    stateType: winner.stateType ?? loser.stateType,
    carryOverDays: winner.carryOverDays ?? loser.carryOverDays,
    okrKrId: winner.okrKrId ?? loser.okrKrId,
    calendarProximityMin: winner.calendarProximityMin ?? loser.calendarProximityMin,
    isCustomerFacing: winner.isCustomerFacing || loser.isCustomerFacing,
    weeklyOkrHit: winner.weeklyOkrHit || loser.weeklyOkrHit,
  };
}

const ISSUE_KEY_PATTERN = /\b[A-Z][A-Z0-9]*-\d+\b/g;

/**
 * Same tracker issue, two different sources — e.g. Linear's own
 * "CUTTO-777 PRD & Demo" and the Feishu priority row "整理…（CUTTO-777）".
 * Title similarity does not catch these (the wordings barely overlap), so match
 * on the issue key instead.
 *
 * Deliberately restricted to *cross-source* pairs: one Feishu priority column
 * routinely lists several distinct actions against a single issue
 * ("完成 4K 终版（CUTTO-301）" / "重录宣传 Demo（CUTTO-301）"), and those must
 * survive as separate candidates.
 */
function sharesIssueKeyAcrossSources(left: TodoCandidate, right: TodoCandidate): boolean {
  if (left.source === right.source) return false;
  const keys = issueKeys(left.title);
  if (keys.size === 0) return false;
  for (const key of issueKeys(right.title)) {
    if (keys.has(key)) return true;
  }
  return false;
}

function issueKeys(title: string): Set<string> {
  return new Set(title.toUpperCase().match(ISSUE_KEY_PATTERN) || []);
}

function normalizeTitle(value: string): string {
  return value
    .replace(/[A-Z][A-Z0-9]+-\d+/g, (m) => m) // keep issue ids for signal
    .replace(/[\s\p{P}\p{S}]/gu, '')
    .toLowerCase();
}

function titlesSimilar(left: string, right: string): boolean {
  if (!left || !right) return false;
  if (left === right) return true;
  const shorter = left.length <= right.length ? left : right;
  const longer = shorter === left ? right : left;
  if (shorter.length >= 6 && longer.includes(shorter)) return true;
  // Shared long token overlap (handles Chinese phrases without word breaks).
  // The shared run must be a *substantial* fraction of the shorter title
  // (>=60%, min 6 chars) so genuinely different tasks that merely share a short
  // common phrase — e.g. a year/quarter marker like "2026年度" — are not
  // wrongly merged (LEO-211 dedupe false-positive fix).
  const windowLen = Math.max(6, Math.ceil(shorter.length * 0.6));
  if (shorter.length < windowLen) return false;
  for (let index = 0; index <= shorter.length - windowLen; index += 1) {
    if (longer.includes(shorter.slice(index, index + windowLen))) return true;
  }
  return false;
}

// --- OKR (lightweight local parse) -----------------------------------------

/**
 * Parse the OKR markdown files into a flat list of real (non-placeholder) key
 * result **ids**. Kept private to the scorer per the LEO-209 boundary — the
 * dedicated OKR loader lives elsewhere and is off-limits.
 *
 * Ids only, since LEO-318. The rows used to carry their `description` column too,
 * for a fuzzy title match that no longer exists — see `enrichOkr`.
 *
 * LEO-317: the root used to be the hardcoded relative `memory-vault/default/10_OKR`,
 * which `path.resolve` anchors at `process.cwd()`. The packaged service runs with
 * cwd = ~/Library/Application Support/DailyOS, where no vault exists, so the index
 * was always empty and `okrLinked` never scored once. Resolve the user's real vault
 * first — same two-step as `okrDir()` in src/ui/okr-lite.ts — and keep the repo
 * scaffold as the fallback for a dev checkout / an unconfigured vault.
 */
function loadOkrIndex(repositoryPath?: string): string[] {
  try {
    const vault = (repositoryPath || '').trim();
    const fromVault = vault ? path.resolve(vault, '10_OKR') : '';
    const dir = fromVault && fs.existsSync(fromVault) ? fromVault : path.resolve('memory-vault', 'default', '10_OKR');
    if (!fs.existsSync(dir)) return [];
    const files = fs.readdirSync(dir).filter((name) => name.endsWith('.md'));
    const ids: string[] = [];
    for (const file of files) {
      const content = fs.readFileSync(path.join(dir, file), 'utf8');
      for (const line of content.split('\n')) {
        // KR table rows: | O1-KR1 | Description | ... |
        const match = line.match(/^\s*\|\s*([A-Z]\d+-KR\d+)\s*\|\s*([^|]+?)\s*\|/);
        if (!match) continue;
        const description = match[2].trim();
        // Scaffold rows read `TODO — measurable key result`, and `^todo` already
        // catches every one of them. The `includes('—')` half that used to sit
        // beside it caught real key results instead: an em dash in a hand-written
        // description is ordinary, and a KR dropped here is dropped silently —
        // no error, no log, it simply never links (LEO-318).
        if (/^todo\b/i.test(description)) continue;
        ids.push(match[1].trim());
      }
    }
    return ids;
  } catch {
    return [];
  }
}

/**
 * Link a candidate to a key result, by **explicit id only**.
 *
 * There used to be a second, fuzzy arm: the first 6 characters of the KR's
 * description, punctuation stripped, matched anywhere in the title. It never ran
 * in production — the index was always empty (LEO-317) — and the moment that was
 * fixed it started mislabelling. Against the real vault, all four of these link
 * to the wrong key result and collect the full `okrLinked` weight:
 *
 *     每周 4 次 30 分钟英语听力练习  → O5-KR2 (每周 4 次 30 分钟补强训练)
 *     读完 1 本书并写读后感          → O4-KR2 (读完 1 本书并沉淀 1 篇笔记)
 *     living cost 预算表更新         → O7-KR1 (living-docs 人脉网)
 *     整理 2026 Q3 的报销单          → O2-KR1 (2026 Q3 家庭财富报告)
 *
 * Six characters is not a similarity measure. With whitespace and punctuation
 * removed, a cadence like "每周 4 次 30 分钟" reads identically in any domain,
 * and short English or numeric prefixes (`living`, `2026q3`) match anything that
 * merely mentions them.
 *
 * `okrLinked` is +12, which is enough to reorder a morning. Missing a link costs
 * a few points; inventing one puts an unrelated task at the top of the day with
 * no visible reason — the harder of the two to debug. So: no guessing. A title
 * that means to name its key result can name it (LEO-318).
 */
function enrichOkr(candidate: TodoCandidate, okrIds: string[]): TodoCandidate {
  if (candidate.okrKrId) return candidate;
  const haystack = candidate.title.toLowerCase();
  for (const id of okrIds) {
    if (haystack.includes(id.toLowerCase())) return { ...candidate, okrKrId: id };
  }
  return candidate;
}

// --- helpers ---------------------------------------------------------------

function linearPriorityPoints(candidate: TodoCandidate, weights: ScorerWeights): number {
  if (candidate.source !== 'linear' || !candidate.priority) return 0;
  const label = candidate.priority.toLowerCase();
  if (label.includes('urgent')) return weights.linearUrgent;
  if (label.includes('high')) return weights.linearHigh;
  return 0;
}

/**
 * Board-state weighting. Linear collapses both "In Progress" and "In Review"
 * into state type `started`, so the human-facing state name is what separates
 * "I am working on this" from "this is parked on someone else's review queue".
 */
function linearStatePoints(candidate: TodoCandidate, weights: ScorerWeights): number {
  if (candidate.source !== 'linear') return 0;
  const name = (candidate.stateName || '').toLowerCase();
  const type = (candidate.stateType || '').toLowerCase();
  if (name.includes('review')) return weights.linearInReview;
  if (type === 'started') return weights.linearInProgress;
  return 0;
}

function linearPriorityLabel(value: unknown): string {
  if (typeof value !== 'number') return '';
  if (value === 1) return 'Urgent (1)';
  if (value === 2) return 'High (2)';
  if (value === 3) return 'Medium (3)';
  if (value === 4) return 'Low (4)';
  return '';
}

function linearItems(data: unknown): unknown[] {
  for (const keyPath of [['items'], ['data', 'issues', 'nodes'], ['issues', 'nodes']]) {
    let current: unknown = data;
    let ok = true;
    for (const key of keyPath) {
      if (!isRecord(current)) {
        ok = false;
        break;
      }
      current = current[key];
    }
    if (ok && Array.isArray(current)) return current;
  }
  return [];
}

function parseDateMs(value: string | undefined): number | null {
  if (!value) return null;
  const isoLike = value.match(/\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2})?/)?.[0];
  if (!isoLike) return null;
  const ms = Date.parse(isoLike.length === 10 ? `${isoLike}T00:00:00` : isoLike.replace(' ', 'T'));
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Normalize a capture hint into the `dueDate` field. A hint that resolves to a
 * real day is stored as `YYYY-MM-DD` so the urgency tiers and the card renderer
 * both understand it; anything else is kept verbatim so the user still sees
 * what they typed, and simply earns no urgency points.
 */
function dueDateFromHint(hint: string | undefined, now: Date): { dueDate?: string } {
  if (!hint) return {};
  const resolved = resolveDueHintMs(hint, now);
  if (resolved === null) return { dueDate: hint };
  const day = new Date(resolved);
  const pad = (part: number): string => String(part).padStart(2, '0');
  return { dueDate: `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}` };
}

const WEEKDAY_HINTS: Record<string, number> = {
  日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6,
};

/**
 * Resolve the relative Chinese date hints the todo capture produces.
 *
 * Capture stores what the user typed — `周六`, `明天`, `下周三` — but scoring
 * only understood ISO dates, so every hand-captured deadline evaluated as "no
 * due date at all" and earned nothing from the urgency tiers. A todo written as
 * "周六下午 6-8PM 去打球" was invisible on the Saturday it was due.
 *
 * Returns midnight of the resolved day, or null when the hint is not a date.
 * Absolute `YYYY-MM-DD` text keeps taking precedence via `parseDateMs`.
 */
export function resolveDueHintMs(hint: string | undefined, now: Date): number | null {
  const absolute = parseDateMs(hint);
  if (absolute !== null) return absolute;
  if (!hint) return null;
  const text = hint.replace(/\s+/g, '');
  const midnight = (offsetDays: number): number => {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    day.setDate(day.getDate() + offsetDays);
    return day.getTime();
  };

  if (/^(今天|今日|今晚)/.test(text)) return midnight(0);
  if (/^(明天|明日|明晚)/.test(text)) return midnight(1);
  if (/^(后天|後天)/.test(text)) return midnight(2);

  // 周六 / 周6 / 星期六 / 礼拜六, optionally prefixed with 本 / 这 / 下 / 下下.
  const weekday = text.match(/^(本|这|這|下下|下)?(?:周|週|星期|礼拜|禮拜)([日天一二三四五六]|[0-6])/);
  if (!weekday) return null;
  const token = weekday[2];
  const target = /[0-6]/.test(token) ? Number(token) % 7 : WEEKDAY_HINTS[token];
  if (target === undefined) return null;

  // "下周X" means the same weekday one week on; a bare or 本/这 prefixed weekday
  // means the next occurrence, counting today as a hit so a Saturday todo
  // written on Saturday is due today rather than a week out.
  const weeksAhead = weekday[1] === '下' ? 1 : weekday[1] === '下下' ? 2 : 0;
  const delta = (target - now.getDay() + 7) % 7;
  return midnight(delta + weeksAhead * 7);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
