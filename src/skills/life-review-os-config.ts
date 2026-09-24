import fs from 'node:fs';
import yaml from 'js-yaml';

/**
 * Is life-review-os's config.yaml actually filled in?
 *
 * The repo ships `config.example.yaml` with values like
 * `table_block_id: YOUR_2026_DOG_WEEKLY_TABLE_BLOCK_ID`. A config that still
 * carries one of those does not fail on load — it fails on the first Feishu
 * call, as `1770001 invalid param`, which names neither the field nor the file.
 * That is how a template copied over a working install went unnoticed for two
 * weeks (#218). Checking here turns it into an error that says what to fill in
 * and where.
 *
 * Only the fields every run needs are checked: the weekly doc's `token` and
 * `table_block_id`. Optional documents (`five_year_plan`, …) may legitimately
 * stay as placeholders for users who do not have them.
 */

const PLACEHOLDER = /^YOUR_[A-Z0-9_]*$/;

export interface SkillConfigCheck {
  /** Dotted paths of required fields that are missing or still a placeholder. */
  unfilled: string[];
  /** Set when the file could not be read or parsed at all. */
  error?: string;
}

export function checkLifeReviewOsConfig(configPath: string, year = new Date().getFullYear()): SkillConfigCheck {
  let parsed: unknown;
  try {
    parsed = yaml.load(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    return { unfilled: [], error: error instanceof Error ? error.message : String(error) };
  }
  const weekly = readWeeklyDocs(parsed);
  if (weekly.length === 0) return { unfilled: ['documents.weekly'] };

  // Same selection as life-review-os's weeklyTarget(): this year's doc, else the first.
  const index = Math.max(0, weekly.findIndex((doc) => Number(doc.year) === year));
  const doc = weekly[index] ?? {};
  const label = `documents.weekly[${doc.year ?? index}]`;
  return {
    unfilled: (['token', 'table_block_id'] as const)
      .filter((key) => isUnfilled(doc[key]))
      .map((key) => `${label}.${key}`),
  };
}

/** True when the config exists and every required field is filled. */
export function isFilledLifeReviewOsConfig(configPath: string): boolean {
  if (!fs.existsSync(configPath)) return false;
  const check = checkLifeReviewOsConfig(configPath);
  return !check.error && check.unfilled.length === 0;
}

function readWeeklyDocs(parsed: unknown): Array<Record<string, unknown>> {
  const documents = (parsed as { documents?: { weekly?: unknown } } | null)?.documents;
  const weekly = documents?.weekly;
  return Array.isArray(weekly) ? weekly.filter((doc): doc is Record<string, unknown> => Boolean(doc) && typeof doc === 'object') : [];
}

function isUnfilled(value: unknown): boolean {
  const text = typeof value === 'string' ? value.trim() : value == null ? '' : String(value);
  return !text || PLACEHOLDER.test(text);
}
