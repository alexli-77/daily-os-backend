import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * What the 总结 of a cycle is written from, besides the 要务 and the 复盘.
 *
 * 2026-11-02, the user: the 总结 has to weigh the 双周's completion, its 计划外
 * and her 复盘 together, and judge them by The 7 Habits of Highly Effective
 * People — the method her biweekly plan and review have followed for years,
 * on paper before Daily OS. The single-cycle review prompt had the 要务 and the
 * retro only: no numbers, the 计划外 pasted under the retro, and no framework.
 */

export interface GroupProgress {
  heading: string;
  done: number;
  partial: number;
  missed: number;
  unmarked: number;
  mit: string[];
}

/** Per OKR group: how many 要务 were done (✅), half done (🚧), not done (❌), unmarked. */
export function cycleProgress(priorities: string): GroupProgress[] {
  const groups: GroupProgress[] = [];
  for (const raw of priorities.split('\n')) {
    const line = raw.trim();
    const heading = /^#{2,6}\s+(.+)$/.exec(line);
    if (heading) {
      groups.push({ heading: heading[1]!.trim(), done: 0, partial: 0, missed: 0, unmarked: 0, mit: [] });
      continue;
    }
    const bullet = /^(?:[-*+]|\d+[.)])\s+(.+)$/.exec(line);
    if (!bullet) continue;
    if (groups.length === 0) groups.push({ heading: '（未分组）', done: 0, partial: 0, missed: 0, unmarked: 0, mit: [] });
    const group = groups[groups.length - 1]!;
    const text = bullet[1]!;
    // The last mark wins, as in the Cycles page.
    const mark = [...text.matchAll(/✅|🚧|❌/g)].at(-1)?.[0];
    if (mark === '✅') group.done += 1;
    else if (mark === '🚧') group.partial += 1;
    else if (mark === '❌') group.missed += 1;
    else group.unmarked += 1;
    if (/\*\*MIT\*\*/i.test(text)) group.mit.push(`${text.replace(/\*\*MIT\*\*|✅|🚧|❌/gi, '').trim()}（${mark ?? '未标'}）`);
  }
  return groups.filter((group) => group.done + group.partial + group.missed + group.unmarked > 0 && group.heading !== '计划外新增');
}

export function renderProgress(groups: GroupProgress[]): string {
  const total = groups.reduce((sum, group) => sum + group.done + group.partial + group.missed + group.unmarked, 0);
  const done = groups.reduce((sum, group) => sum + group.done, 0);
  const partial = groups.reduce((sum, group) => sum + group.partial, 0);
  const lines = [`全部 ${total} 条：完成 ${done}，部分完成 ${partial}，完成率 ${total ? Math.round((done / total) * 100) : 0}%（部分完成不算）。`];
  for (const group of groups) {
    const count = group.done + group.partial + group.missed + group.unmarked;
    lines.push(`- ${group.heading.slice(0, 24)}：${count} 条，完成 ${group.done}、部分 ${group.partial}、没做 ${group.missed}${group.unmarked ? `、未标 ${group.unmarked}` : ''}`);
  }
  const mits = groups.flatMap((group) => group.mit);
  if (mits.length) lines.push(`MIT：${mits.join('；')}`);
  return lines.join('\n');
}

const HABITS_LIMIT = 6000;

/**
 * The 7 Habits as the user keeps them: her own `stephen-covey` skill when it is
 * installed for Claude, then the review skill's framework file. Bounded, so a
 * long skill cannot crowd out the cycle itself.
 */
export function habitsGuide(skillPath: string | undefined): string {
  const parts: string[] = [];
  const own = path.join(os.homedir(), '.claude', 'skills', 'stephen-covey', 'SKILL.md');
  try {
    const text = fs.readFileSync(own, 'utf8').replace(/^---[\s\S]*?\n---\n/, '');
    const core = text.indexOf('## 核心框架概览');
    const end = text.indexOf('## 子技能读取方式');
    parts.push((core >= 0 ? text.slice(core, end > core ? end : undefined) : text).trim());
  } catch {
    // Not installed: the framework file below carries the habits on its own.
  }
  if (skillPath) {
    try {
      parts.push(fs.readFileSync(path.join(path.dirname(skillPath), 'frameworks', 'stephen-covey.md'), 'utf8').trim());
    } catch {
      // A skill without the framework file.
    }
  }
  return parts.join('\n\n').slice(0, HABITS_LIMIT);
}

/** The `context` of a single-cycle review: numbers, 计划外, the habits, and how to weigh them. */
export function buildReviewContext(input: { priorities: string; unplanned: string; habits: string }): string {
  return [
    '## 完成度（系统按要务上的 ✅🚧❌ 统计）',
    renderProgress(cycleProgress(input.priorities)),
    '',
    '## 计划外（系统统计，不是用户写的）',
    input.unplanned.trim() || '没有记录到计划外的事。',
    '',
    '## 怎么写这份总结',
    '用户的双周计划和复盘一直按《高效能人士的七个习惯》来做。这份总结要把上面的完成度、计划外和用户手写的复盘放在一起，给一个综合评价，用下面的七个习惯框架来判断：',
    '- 第一段（肯定）：用完成度里的具体数字，说这一期做成了什么；点名它体现了哪个习惯（比如 要事第一、磨锐锯子），用复盘里的事实说话。',
    '- 第二段（待改进）：说清卡在哪个习惯上（比如 Q2 的要事被 Q1 和计划外挤掉、P/PC 失衡、以终为始不清楚），计划外吃掉了什么；最后给下一期一条最关键的调整，具体到怎么做。',
    '- 只点名真正相关的一两个习惯，不要把七个都列一遍，不要说教，不要复述复盘原文。',
    '',
    '## 七个习惯（用户自己的柯维 skill 与框架）',
    input.habits || '（没找到柯维 skill；按《高效能人士的七个习惯》的原则判断）',
  ].join('\n');
}
