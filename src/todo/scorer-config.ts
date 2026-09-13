import fs from 'node:fs';
import path from 'node:path';

/**
 * Weight constants for the programmatic todo scorer (LEO-209).
 *
 * These are intentionally kept out of `src/config/schema.ts` so the scorer can
 * evolve independently of the user-facing config surface. The defaults below are
 * the source of truth; an optional `data/runtime/scorer-weights.json` may
 * override any subset of them. That override file is a placeholder for the
 * feedback loop (adoption stats -> reweighting) and is not required to exist.
 */
export interface ScorerWeights {
  /** Item whose due date/next-review is already in the past. */
  overdue: number;
  /** Item due within the next 24h (but not yet overdue). */
  dueWithin24h: number;
  /**
   * Item due within the next 72h (but not within 24h and not yet overdue).
   * Without this tier a task due the day after tomorrow scores exactly the same
   * as one with no due date at all, so it stays invisible until the morning it
   * is already late.
   */
  dueWithin72h: number;
  /** Linear priority = Urgent (1). */
  linearUrgent: number;
  /** Linear priority = High (2). */
  linearHigh: number;
  /**
   * Linear issue actively being worked (state type `started`, e.g. "In Progress").
   * Work already started carries a sunk start-up cost, so it outranks an
   * untouched issue of the same priority.
   */
  linearInProgress: number;
  /**
   * Linear issue handed off and waiting on someone else (e.g. "In Review").
   * Still open, but the next move is usually not the user's — weighted below
   * `linearInProgress`.
   */
  linearInReview: number;
  /** A calendar block within 2h is associated with the item. */
  calendarWithin2h: number;
  /** Per carry-over day bonus. */
  carryOverPerDay: number;
  /** Cap on the total carry-over bonus. */
  carryOverCap: number;
  /** Item linked to a real (non-placeholder) local OKR key result. */
  okrLinked: number;
  /**
   * Weaker OKR signal: item only matched a Feishu weekly-priority OKR tag.
   * This is a transitional fallback until the local OKR files are populated.
   */
  okrWeeklyHit: number;
  /** Item carries a customer / delivery facing signal. */
  customerFacing: number;
  /**
   * Item the user captured by hand (My todos / Feishu capture).
   *
   * Every other source arrives with structural signal — a Linear priority, an
   * OKR link, a parseable due date — so a hand-typed line scored zero and lost
   * to everything, however deliberately it was written down. Deliberately below
   * `overdue` (35): something jotted this morning should reach the shortlist,
   * not outrank a delivery that is already late.
   */
  manualCapture: number;
  /**
   * Penalty applied to a work-sourced candidate (`linear` / `weekly_priorities`)
   * on one of the user's rest days.
   *
   * Negative, and deliberately smaller in magnitude than `overdue` (35): a rest
   * day should reshuffle the day, not black out work entirely. Something already
   * late still surfaces — and in fact anything overdue or due within 24h skips
   * this penalty outright, because the one work item a user *does* want to hear
   * about on a Saturday is the one that is already burning.
   *
   * Tuned against `manualCapture` (20): a life todo the user typed by hand
   * outranks an untouched, undated Linear issue on a rest day, which is the
   * whole point, while a High-priority issue (12) plus an OKR link (12) can
   * still climb back over it if it genuinely matters.
   */
  restDayWorkDamping: number;
}

export const DEFAULT_SCORER_WEIGHTS: ScorerWeights = {
  overdue: 35,
  dueWithin24h: 25,
  dueWithin72h: 12,
  linearUrgent: 20,
  linearHigh: 12,
  linearInProgress: 15,
  linearInReview: 8,
  calendarWithin2h: 15,
  carryOverPerDay: 5,
  carryOverCap: 15,
  okrLinked: 12,
  okrWeeklyHit: 6,
  customerFacing: 10,
  manualCapture: 20,
  restDayWorkDamping: -18,
};

export const DEFAULT_TOP_N = 10;

export const SCORER_WEIGHTS_OVERRIDE_PATH = 'data/runtime/scorer-weights.json';

/**
 * Resolve the effective weights: defaults merged with an optional local
 * override file. Any malformed or missing file silently falls back to defaults
 * so a bad override never breaks the daily plan.
 */
export function loadScorerWeights(overridePath: string = SCORER_WEIGHTS_OVERRIDE_PATH): ScorerWeights {
  try {
    const resolved = path.resolve(overridePath);
    if (!fs.existsSync(resolved)) return { ...DEFAULT_SCORER_WEIGHTS };
    const raw = JSON.parse(fs.readFileSync(resolved, 'utf8')) as Partial<ScorerWeights>;
    const merged = { ...DEFAULT_SCORER_WEIGHTS };
    for (const key of Object.keys(DEFAULT_SCORER_WEIGHTS) as Array<keyof ScorerWeights>) {
      const value = raw[key];
      if (typeof value === 'number' && Number.isFinite(value)) merged[key] = value;
    }
    return merged;
  } catch {
    return { ...DEFAULT_SCORER_WEIGHTS };
  }
}
