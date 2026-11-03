import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../config/schema.js';
import { askClaudeOnce } from '../agent/claude-agent.js';
import { renderGuides } from '../habits/guides.js';
import { writeFileAtomic } from '../utils/atomic-write.js';
import { currentCycle } from '../workflows/weekly-priorities.js';
import { cyclesDir, listCycles, type CycleDoc } from './file.js';
import { cycleProgress, renderProgress } from './review-context.js';

/**
 * A cycle's 柯维诊断 and the 小实验 it hands the next cycle (2026-11-03).
 *
 * Every biweekly run already wrote a 7 Habits diagnosis — Q2 share, MIT rate,
 * what is stuck and why, one small experiment for the next two weeks — and it
 * went nowhere: only the 要务 and a 350-character 总结 reached the cycle file,
 * so the app never showed it and the next day's plan never heard of the
 * experiment. It is kept beside the cycle now (`<id>.habits.json`), shown on
 * the cycle's page, and the experiment rides into the next cycle's daily plans.
 */

export interface CycleHabits {
  /** The diagnosis, markdown. */
  diagnosis: string;
  /** The one experiment for the next cycle, a sentence. '' when none was given. */
  experiment: string;
  /** `review`: written with 生成总结; `run`: lifted from a biweekly run's draft. */
  source: 'review' | 'run';
  updatedAt: string;
}

function habitsFile(config: AppConfig, cycleId: string): string {
  return path.join(cyclesDir(config), `${cycleId}.habits.json`);
}

export function readCycleHabits(config: AppConfig, cycleId: string): CycleHabits | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(habitsFile(config, cycleId), 'utf8')) as Partial<CycleHabits>;
    if (typeof parsed.diagnosis !== 'string' || !parsed.diagnosis.trim()) return null;
    return {
      diagnosis: parsed.diagnosis,
      experiment: typeof parsed.experiment === 'string' ? parsed.experiment : '',
      source: parsed.source === 'run' ? 'run' : 'review',
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
    };
  } catch {
    return null;
  }
}

export function writeCycleHabits(config: AppConfig, cycleId: string, habits: Omit<CycleHabits, 'updatedAt'>): CycleHabits {
  const saved = { ...habits, updatedAt: new Date().toISOString() };
  const file = habitsFile(config, cycleId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, `${JSON.stringify(saved, null, 2)}\n`);
  return saved;
}

/**
 * The diagnosis out of a biweekly run's draft: from its 柯维诊断 heading to the
 * next top-level section, plus the 双周趋势 section when there is one. The
 * experiment is the line (or bullets) after 「小实验」.
 */
export function extractHabitsFromDraft(draft: string): Pick<CycleHabits, 'diagnosis' | 'experiment'> | null {
  const lines = draft.split('\n');
  const start = lines.findIndex((line) => /^#{1,4}\s*.*柯维诊断/.test(line.trim()));
  if (start < 0) return null;
  const kept: string[] = [];
  let inTrend = false;
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index]!;
    const heading = /^(#{1,4})\s*(.+)$/.exec(line.trim());
    if (index > start && heading && heading[1]!.length <= 2) {
      if (/双周趋势|趋势/.test(heading[2]!) && !inTrend) {
        inTrend = true;
      } else {
        break;
      }
    }
    if (/^\s*-{3,}\s*$/.test(line)) continue;
    kept.push(line);
  }
  const diagnosis = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!diagnosis) return null;
  return { diagnosis, experiment: experimentFrom(diagnosis) };
}

/** The 小实验 in a diagnosis: the text on its line after the label, or the bullets under it. */
export function experimentFrom(diagnosis: string): string {
  const lines = diagnosis.split('\n');
  const at = lines.findIndex((line) => /小实验/.test(line));
  if (at < 0) return '';
  const inline = lines[at]!.split(/小实验[^：:]*[：:]/)[1]?.replace(/\*\*/g, '').trim();
  if (inline) return inline.replace(/^[-*]\s*/, '');
  const bullets: string[] = [];
  for (let index = at + 1; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (!line) {
      if (bullets.length) break;
      continue;
    }
    if (/^#/.test(line)) break;
    const bullet = /^[-*]\s+(.+)$/.exec(line);
    if (!bullet) break;
    bullets.push(bullet[1]!.replace(/\*\*/g, '').trim());
  }
  return bullets.join('；');
}

/**
 * The 小实验 the current cycle is running: the one the cycle before it handed
 * over. When no cycle covers today (a new one not set yet), the last one's.
 */
export function currentExperiment(config: AppConfig, date: string): { experiment: string; from: string } | null {
  try {
    const cycles = listCycles(config).filter((doc) => doc.startDate);
    const current = currentCycle(config, date);
    const previous: CycleDoc | undefined = current
      ? cycles.filter((doc) => doc.startDate < current.startDate).sort((left, right) => right.startDate.localeCompare(left.startDate))[0]
      : cycles.filter((doc) => doc.startDate <= date).sort((left, right) => right.startDate.localeCompare(left.startDate))[0];
    if (!previous) return null;
    const habits = readCycleHabits(config, previous.id);
    return habits?.experiment ? { experiment: habits.experiment, from: previous.cycle || previous.id } : null;
  } catch {
    return null;
  }
}

/** The current cycle's MIT lines not yet ticked done. */
export function openMits(config: AppConfig, date: string): string[] {
  try {
    const doc = currentCycle(config, date);
    const content = doc?.sections['要务']?.content || '';
    return content
      .split('\n')
      .filter((line) => /\*\*MIT\*\*/i.test(line) && !/✅/.test(line))
      .map((line) => line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').replace(/\*\*MIT\*\*|🚧|❌/gi, '').trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * 生成总结's second half: the cycle's 柯维诊断 and its 小实验, from the same
 * facts as the 总结 and the habits skills the user keeps. Claude only (the
 * subscription CLI); elsewhere the biweekly run's diagnosis is what there is.
 */
export async function generateCycleDiagnosis(
  config: AppConfig,
  cycle: CycleDoc,
  input: { priorities: string; retro: string; unplanned: string; fallbackGuide: string },
  ask: (prompt: string) => Promise<string> = (prompt) => askClaudeOnce(prompt, 600_000),
): Promise<CycleHabits | null> {
  const guide = renderGuides(config, config.habits?.cycle_review ?? []) || input.fallbackGuide;
  const before = listCycles(config)
    .filter((doc) => doc.startDate && doc.startDate < cycle.startDate)
    .sort((left, right) => right.startDate.localeCompare(left.startDate))[0];
  const previousExperiment = before ? readCycleHabits(config, before.id)?.experiment ?? '' : '';
  const prompt = [
    '你是用户的柯维教练。用户的双周计划和复盘一直按《高效能人士的七个习惯》来做。',
    '根据下面这一期的完成度、计划外、用户手写的复盘，以及上一期定下的小实验（做到没有），写这一期的「柯维诊断」，再给下一期一个小实验。',
    '',
    '只输出一个 JSON 对象，不要代码块、不要别的字：{"diagnosis": "...", "experiment": "..."}',
    '- diagnosis：Markdown。按框架里「柯维诊断摘要」的样子写：Q2 占比、MIT 完成率、象限分布各一行；「主要发现」2-3 条，每条一句话点出现象和背后卡住的习惯（用复盘和完成度里的事实）；上一期有小实验时，加一行说它做到没有、效果怎样。不要复述复盘原文。',
    '- experiment：下一期的一个小实验，一句话，具体到什么时间、做什么、两周后怎么判断有没有用。',
    '- 语气：先移情后诊断；不说「你应该」，说「数据显示」「你的复盘里写到」；不归咎执行力，找结构性原因。',
    '',
    `# 周期 ${cycle.cycle || cycle.id}`,
    '## 完成度',
    renderProgress(cycleProgress(input.priorities)),
    '## 要务（计划，✅ 完成 🚧 部分 ❌ 没做）',
    input.priorities || '（没有）',
    '## 计划外（系统统计）',
    input.unplanned || '没有记录到计划外的事。',
    '## 用户手写的复盘',
    input.retro || '（还没写）',
    '## 上一期定下的小实验',
    previousExperiment || '（没有）',
    '',
    '# 七个习惯（用户自己的 skill 与框架）',
    guide || '（没读到 skill；按《高效能人士的七个习惯》的原则判断）',
  ].join('\n');
  try {
    const raw = await ask(prompt);
    const json = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
    const parsed = JSON.parse(json) as { diagnosis?: unknown; experiment?: unknown };
    const diagnosis = typeof parsed.diagnosis === 'string' ? parsed.diagnosis.trim() : '';
    if (!diagnosis) return null;
    const experiment = typeof parsed.experiment === 'string' && parsed.experiment.trim() ? parsed.experiment.trim() : experimentFrom(diagnosis);
    return writeCycleHabits(config, cycle.id, { diagnosis, experiment, source: 'review' });
  } catch (error) {
    console.warn(`[habits] diagnosis not written for ${cycle.id}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
