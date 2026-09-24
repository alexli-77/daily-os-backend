import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../config/schema.js';
import { buildCycleId, readCycle, type CycleSection } from './file.js';
import { readOkrSnapshot } from '../ui/okr-lite.js';
import {
  applyCyclePlan,
  parseRun,
  renderPrioritiesFromRun,
  startDateForLabel,
  type CyclePlan,
  type MigrationRun,
} from './migration.js';

/**
 * LEO-278 — a finished life-review-os run lands in `20_CYCLES` instead of only
 * in Feishu.
 *
 * Before this, the one production writer of a cycle file was the UI's save
 * endpoint: a human typing into a textarea. The whole history in `20_CYCLES`
 * came from the one-shot LEO-280 migration, so running a new biweekly produced
 * nothing the Cycles page could show.
 *
 * The two writes go to two *different* cycles, and that asymmetry is the only
 * thing here worth being careful about:
 *
 *   要务    -> `writeback.target_week`, the cycle being planned
 *   review  -> `evidence.review_week`, the cycle that just ended
 *
 * That is the same rule the migration encodes, and the same one PR #28 fixed in
 * the Feishu path after a review was written next to the wrong column. Rather
 * than restate it, this module reuses `migration.ts` outright — `parseRun`,
 * `renderPrioritiesFromRun`, `startDateForLabel` and `applyCyclePlan` — so the
 * markdown a new run produces is byte-identical to the migrated history and
 * there is exactly one implementation of "what does a cycle file say".
 *
 * `applyCyclePlan` also carries the re-run rules for free: a section the user
 * has edited (`source: user`) is never clobbered, and an unchanged section is
 * not rewritten, so re-planning the same cycle is a no-op rather than a
 * timestamp bump.
 */

export interface LocalCycleWrite {
  section: CycleSection;
  cycleId: string;
  label: string;
  status: 'created' | 'updated' | 'unchanged' | 'failed' | 'skipped' | 'drafted';
  chars: number;
  /** Why nothing was written. Set for `skipped`, `unchanged`, and `drafted`. */
  reason?: string;
  error?: string;
}

export interface LocalCycleWritebackResult {
  runId: string;
  writes: LocalCycleWrite[];
  /** Set when the run record itself could not be used at all. */
  error?: string;
}

export interface LocalCycleWritebackOptions {
  now?: string;
  dryRun?: boolean;
}

/**
 * Mirror one run record into the local cycle files.
 *
 * Deliberately never throws. This runs as the last step of a biweekly that has
 * already succeeded and whose draft is already in the run record; turning a
 * local file-write problem into a failed run would report a success as a
 * failure and invite the user to re-run a 9-minute job.
 */
export function writeLocalCyclesFromRun(
  config: AppConfig,
  runsDir: string,
  runId: string,
  options: LocalCycleWritebackOptions = {},
): LocalCycleWritebackResult {
  const run = readRunRecord(runsDir, runId);
  if (!run) return { runId, writes: [], error: `no usable run record for ${runId} in ${runsDir}` };

  const writes: LocalCycleWrite[] = [];
  for (const plan of planLocalCycles(run, okrRowLabels(config), writes)) {
    const section = Object.keys(plan.sections)[0] as CycleSection;
    const content = plan.sections[section] || '';
    let existing = null;
    try {
      existing = readCycle(config, plan.id);
    } catch (error) {
      writes.push({ section, cycleId: plan.id, label: plan.label, status: 'failed', chars: content.length, error: message(error) });
      continue;
    }
    const applied = applyCyclePlan(config, plan, existing, { dryRun: Boolean(options.dryRun), now: options.now });
    const wasDrafted = applied.drafted.includes(section);
    writes.push({
      section,
      cycleId: plan.id,
      label: plan.label,
      // A drafted section didn't overwrite the body — report it as its own status
      // so the log/UI can say "staged a draft" rather than "updated".
      status: wasDrafted ? 'drafted' : applied.status,
      chars: content.length,
      reason: wasDrafted ? 'user-edited' : applied.skipped.find((entry) => entry.section === section)?.reason,
      error: applied.error,
    });
  }
  return { runId, writes };
}

/**
 * The plans for one run: at most one 要务 plan and one review plan.
 *
 * Each plan carries a single section on purpose. They target different cycles,
 * and keeping them separate is what lets one be skipped (a user-edited retro,
 * a run with no review) without affecting the other.
 */
function planLocalCycles(run: MigrationRun, rowLabels: string[], writes: LocalCycleWrite[]): CyclePlan[] {
  const plans: CyclePlan[] = [];

  const priorities = renderPrioritiesFromRun(run.items, rowLabels);
  if (!priorities) {
    writes.push({ section: '要务', cycleId: '', label: run.targetWeek, status: 'skipped', chars: 0, reason: 'run carried no priorities' });
  } else {
    const plan = planFor(run, run.targetWeek, '要务', priorities);
    if (plan) plans.push(plan);
    else writes.push({ section: '要务', cycleId: '', label: run.targetWeek, status: 'skipped', chars: priorities.length, reason: `cannot date cycle ${run.targetWeek || '(none)'}` });
  }

  const review = run.reviewText.trim();
  if (!review) {
    writes.push({ section: 'review', cycleId: '', label: run.reviewWeek, status: 'skipped', chars: 0, reason: 'run carried no review' });
  } else {
    const plan = planFor(run, run.reviewWeek, 'review', review);
    if (plan) plans.push(plan);
    // A review with nowhere to go is worth saying out loud: it means the run
    // reviewed a cycle whose label we cannot turn into a date, so the text
    // would otherwise vanish.
    else writes.push({ section: 'review', cycleId: '', label: run.reviewWeek, status: 'skipped', chars: review.length, reason: `cannot date reviewed cycle ${run.reviewWeek || '(none)'}` });
  }

  return plans;
}

function planFor(run: MigrationRun, label: string, section: CycleSection, content: string): CyclePlan | null {
  const year = run.docYear || Number((run.createdAt || '').slice(0, 4)) || new Date().getUTCFullYear();
  const startDate = startDateForLabel(label, year);
  if (!startDate) return null;
  return {
    owner: 'self',
    id: buildCycleId(startDate, label),
    label,
    mode: run.mode,
    startDate,
    runId: run.runId,
    sections: { [section]: content },
    notes: [],
  };
}

/**
 * Group headings for the 要务 section, indexed the way `renderPrioritiesFromRun`
 * wants them: by the item's `target_row`, with row 0 being the table header.
 *
 * A run only carries the KR paragraph each item matched against, so grouping by
 * that alone gives headings like `### KR1 完成 PhD / AI 工程求职三条路径的…`.
 * The migration avoided this by reading the Feishu table's first column, which
 * holds the objective names — but a fresh run has no table read to borrow from.
 *
 * The quarterly OKR file is the same list in the same order (`Objective O1..O7`
 * against table rows 1..7), and it is local, so it is the natural stand-in. The
 * row/objective correspondence is an assumption; when it does not hold the
 * heading is merely wrong, never the item text, and a short list falls back to
 * the KR paragraph rather than mislabelling a row it cannot account for.
 */
export function okrRowLabels(config: AppConfig): string[] {
  const vault = (config.memory.repository_path || '').trim();
  if (!vault) return [];
  try {
    const snapshot = readOkrSnapshot(vault);
    // readOkrSnapshot falls back to the repo's bundled `memory-vault/default`
    // scaffold when the vault has no 10_OKR. Those objectives are placeholders
    // ("TODO — state your most important outcome for this cycle"), and using
    // them would stamp scaffold text onto the user's own priorities. Only the
    // vault's own file may name a row.
    if (path.resolve(snapshot.dir) !== path.resolve(vault, '10_OKR')) return [];
    const objectives = snapshot.current.objectives;
    if (objectives.length === 0) return [];
    // Index 0 is the table's header row, which no item ever targets.
    return ['', ...objectives.map((objective) => objective.title.trim()).filter(Boolean)];
  } catch {
    return [];
  }
}

function readRunRecord(runsDir: string, runId: string): MigrationRun | null {
  const file = path.join(runsDir, `${runId}.json`);
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    return parseRun(raw, fs.statSync(file).mtimeMs);
  } catch {
    return null;
  }
}

/** One line per write, for the chat reply and the run log. */
export function formatLocalCycleWriteback(result: LocalCycleWritebackResult): string {
  if (result.error) return `本地周期未写入：${result.error}`;
  const lines = result.writes.map((write) => {
    const where = write.cycleId || write.label || '(未知周期)';
    if (write.status === 'failed') return `${write.section} → ${where}：写入失败（${write.error || '未知错误'}）`;
    if (write.status === 'skipped') return `${write.section} → ${where}：跳过（${write.reason || '无内容'}）`;
    if (write.status === 'unchanged') return `${write.section} → ${where}：无变化${write.reason === 'user-edited' ? '（你手动改过，未覆盖）' : ''}`;
    if (write.status === 'drafted') return `${write.section} → ${where}：已生成新草稿待合入（你手动改过，没有覆盖）`;
    return `${write.section} → ${where}：已写入 ${write.chars} 字`;
  });
  return lines.join('\n');
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
