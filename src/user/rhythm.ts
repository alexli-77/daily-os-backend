import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../config/schema.js';
import { resolveMemoryRepositoryPath } from '../storage/memory.js';
import { isWeekdayCode, weekdayCode, weekdayLabelZh, type WeekdayCode } from '../utils/date.js';

/**
 * The user's weekly rhythm — which days are work days, which are rest days, and
 * whatever else about their week the planner should respect.
 *
 * ## Why this exists
 *
 * Before this module, nothing in daily-os knew what day of the week it was.
 * `buildUserPrompt` injected `# Date\n2026-09-13` and stopped there: no weekday,
 * no notion of a weekend. The scorer ranked purely on due dates, Linear priority
 * and board state. A grep for 工作日 / 休息日 / workday / working_hours across
 * `src/`, `prompts/` and `config/` returned nothing at all.
 *
 * So Saturday got the same seven-item work plan as Tuesday, and there was no
 * setting to fix it — the dimension did not exist. A user asked for "fewer work
 * tasks on my rest days" and the honest answer was that there was nowhere to put
 * that preference.
 *
 * ## The two halves, and why both
 *
 * A rhythm is half structure and half prose, and collapsing either into the
 * other loses something real:
 *
 * - **Structured** (`user.rhythm.rest_days`, `work_task_cap_on_rest_days`) —
 *   machine-readable, so `scoreCandidate` can damp work-source candidates on a
 *   rest day. Ranking cannot be driven by prose; something has to be a number.
 * - **Prose** (`rhythm.md` in the memory vault) — "周二周四 19:00 教球，不可占用"
 *   is not expressible as a weight, and trying to schematise every such rule
 *   produces a config language nobody wants to write. The model reads this
 *   directly, same mechanism as `decision-policy.md`.
 *
 * The structured half decides *ranking*; the prose half decides *judgement*.
 * `resolveDayShape` is what both the prompt and the scorer read, so the two can
 * never disagree about whether today is a rest day.
 */

export const DEFAULT_RHYTHM_FILE = 'rhythm.md';

const DEFAULT_RHYTHM_MD = `# 作息

<!-- 这个文件由你自己写。Daily OS 在做日计划和复盘时会读它。 -->
<!-- 结构化的「哪几天是休息日」在设置里改（Rhythm 页 / config 的 user.rhythm）； -->
<!-- 这里写的是排不进配置项的那些规则，用大白话即可。 -->

## 工作日

<!-- 例：工作时间 09:30-18:30，19:00 之后不要再排工作任务。 -->

-

## 休息日

<!-- 例：休息日只处理已经逾期的事；其余时间留给生活、家人、爱好。 -->

-

## 固定占用

<!-- 每周固定、不可被工作任务占用的时段。 -->
<!-- 例：周二、周四 19:00-21:00 教球。 -->

-

## 其他

<!-- 任何你希望排计划时被尊重的节奏。 -->

-
`;

/** The work day the timeline lays items out across. "HH:mm" 24h. */
export interface WorkingHours {
  start: string;
  end: string;
}

/** A block to keep tasks out of (a meal). "HH:mm" 24h. */
export interface MealBlock {
  label: string;
  start: string;
  end: string;
}

export const DEFAULT_WORKING_HOURS: WorkingHours = { start: '09:30', end: '18:30' };
export const DEFAULT_MEAL_BLOCKS: MealBlock[] = [{ label: '午餐', start: '12:00', end: '13:00' }];

/** A weekday's resolved shape — the single answer both the prompt and the scorer read. */
export interface DayShape {
  date: string;
  weekday: WeekdayCode;
  /** Chinese weekday label, e.g. "星期六". */
  weekdayLabel: string;
  isRestDay: boolean;
  /** "工作日" | "休息日" */
  dayTypeLabel: string;
  /**
   * Max work-sourced tasks the plan should contain today. `null` on a work day —
   * the cap there is the user's decision-policy / the prompt default, not this.
   */
  workTaskCap: number | null;
  /** Whether rhythm handling is switched on at all. */
  enabled: boolean;
  /** The user's working hours, so the timeline knows the day's bounds. */
  workingHours: WorkingHours;
  /** Blocks the plan should not schedule tasks into (meals). */
  mealBlocks: MealBlock[];
}

export interface RhythmFiles {
  repositoryPath: string;
  notesPath: string;
}

export function rhythmFiles(config: AppConfig): RhythmFiles {
  const repositoryPath = resolveMemoryRepositoryPath(config);
  const configured = (config.user?.rhythm?.file ?? '').trim() || DEFAULT_RHYTHM_FILE;
  return { repositoryPath, notesPath: path.join(repositoryPath, configured) };
}

/** Seed the rhythm template if the user has none yet. Mirrors `ensureDecisionPolicyFiles`. */
export function ensureRhythmFile(config: AppConfig): RhythmFiles {
  const files = rhythmFiles(config);
  if (!fs.existsSync(files.notesPath)) {
    fs.mkdirSync(path.dirname(files.notesPath), { recursive: true });
    fs.writeFileSync(files.notesPath, DEFAULT_RHYTHM_MD, 'utf8');
  }
  return files;
}

/** The user's prose rhythm notes, or '' when absent. Never throws. */
export function readRhythmNotes(config: AppConfig): string {
  try {
    const files = rhythmFiles(config);
    if (!fs.existsSync(files.notesPath)) return '';
    return fs.readFileSync(files.notesPath, 'utf8');
  } catch {
    return '';
  }
}

/** The built-in template, for the console's "reset to default" affordance. */
export function defaultRhythmMarkdown(): string {
  return DEFAULT_RHYTHM_MD;
}

/**
 * True when the notes are still the untouched template — every bullet empty.
 *
 * Used by the console to tell "you have not written your rhythm yet" apart from
 * "you wrote one and it happens to be short". Seeding a template then reporting
 * it as configured would be the same class of bug as `claude auth status`
 * returning `loggedIn: true` on an expired token: a check that always passes.
 */
export function rhythmNotesAreTemplate(markdown: string): boolean {
  const meaningful = markdown
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('<!--') && !line.startsWith('#'))
    .filter((line) => line !== '-');
  return meaningful.length === 0;
}

/**
 * Resolve what kind of day `date` is for this user.
 *
 * Pure apart from the config it is handed, so the scorer, the prompt builder and
 * the console API all derive the same verdict from the same input.
 */
export function resolveDayShape(config: AppConfig, date: string): DayShape {
  // `user.rhythm` is materialised by the schema for anything that went through
  // `loadConfig`, so this is not the ordinary path — but `scoreCandidate` and
  // `buildScoredTodos` are also reached with hand-built config objects, and the
  // cost of being wrong here is the whole morning plan throwing on a missing
  // key. Absent rhythm degrades to "every day is a work day", i.e. exactly the
  // behaviour that shipped before this feature existed.
  const rhythm = config.user?.rhythm;
  const weekday = weekdayCode(date);
  const weekdayLabel = weekdayLabelZh(date);
  const enabled = Boolean(rhythm?.enabled);
  const restDays = normalizeRestDays(rhythm?.rest_days ?? []);
  const isRestDay = enabled && restDays.includes(weekday);
  return {
    date,
    weekday,
    weekdayLabel,
    isRestDay,
    dayTypeLabel: isRestDay ? '休息日' : '工作日',
    workTaskCap: isRestDay ? Math.max(0, rhythm?.work_task_cap_on_rest_days ?? 1) : null,
    enabled,
    // Materialised by the schema for anything through `loadConfig`; the `??`
    // covers the hand-built config objects `scoreCandidate` is also reached with.
    workingHours: rhythm?.working_hours ?? DEFAULT_WORKING_HOURS,
    mealBlocks: rhythm?.meal_blocks ?? DEFAULT_MEAL_BLOCKS,
  };
}

/**
 * Drop anything that is not a weekday code, and de-duplicate.
 *
 * The config is a hand-edited YAML file; `rest_days: [SAT, Sun, saturday]` is the
 * kind of thing people actually write. Case is normalised and unknown entries are
 * ignored rather than throwing — a typo in one entry must not take the whole
 * daily plan down, and a rest day that silently fails to apply is visible in the
 * console's resolved preview.
 */
export function normalizeRestDays(values: readonly string[]): WeekdayCode[] {
  const out: WeekdayCode[] = [];
  for (const value of values) {
    const code = value.trim().toUpperCase().slice(0, 3);
    if (isWeekdayCode(code) && !out.includes(code)) out.push(code);
  }
  return out;
}

/**
 * The `# 作息` prompt section, or '' when there is nothing worth saying.
 *
 * Kept here rather than in the prompt builder so the wording lives next to the
 * model it describes.
 */
export function renderRhythmPromptSection(config: AppConfig, date: string): string {
  const shape = resolveDayShape(config, date);
  if (!shape.enabled) return '';
  const notes = readRhythmNotes(config).trim();
  const lines: string[] = [
    `今天是 ${shape.weekdayLabel}，属于${shape.dayTypeLabel}。`,
  ];
  // Soft guidance so the timeline lays items across the real work day instead of
  // piling everything from the start. Bounds only — the model still decides order.
  const meals = shape.mealBlocks.map((block) => `${block.start}–${block.end} ${block.label}`).join('、');
  lines.push(
    `工作时间 ${shape.workingHours.start}–${shape.workingHours.end}${meals ? `；${meals}` : ''}。把任务安排在工作时间内，不要排进上面这些用餐时段；条目之间留合理间歇，不要从早上一路堆到中午。`,
  );
  if (shape.isRestDay) {
    lines.push(
      shape.workTaskCap === 0
        ? '休息日：今天不要安排任何工作任务。只排生活、休息、个人项目类的事。'
        : `休息日：工作任务最多 ${shape.workTaskCap} 条，且只应该是已经逾期、或今天必须交付的项。剩下的位置留给生活、休息、个人项目。`,
      '注意：`todo_scored.top` 里工作来源（linear / weekly_priorities）的候选今天已经被降权，`breakdown.restDayDamping` 就是扣掉的分。这不是让你忽略它们，是提醒你今天不该按工作日的密度排。',
    );
  }
  if (notes && !rhythmNotesAreTemplate(notes)) {
    lines.push('', '用户自己写的作息表（优先级高于上面的默认规则，冲突时听用户的）：', '', notes);
  }
  return lines.join('\n');
}
