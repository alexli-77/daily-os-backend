/**
 * Keep the work part of this cycle's 要务 in step with Linear, once a day.
 *
 * The 要务 are written at the start of a cycle; Linear moves every day. By the
 * second week the two disagreed: an issue done in Linear still showed open in
 * the 要务, and issues started since were in neither the 要务 nor the plan's
 * idea of the cycle. Run with the morning plan, this:
 *
 * - marks a 要务 line ✅ when the Linear issue it names (`CUTTO-1250`) is done;
 * - adds every started issue (In Progress / In Review) the 要务 do not name,
 *   under the work group, as `- 标题 (CUTTO-1343)`.
 *
 * Only adds and ticks. A line is never removed or reworded, unstarted issues
 * are not pulled in (that is the backlog, not the cycle), and a pending draft
 * of the 要务 is kept.
 */
import type { AppConfig } from '../config/schema.js';
import type { EvidenceSource } from '../workflows/types.js';
import { currentCycle } from '../workflows/weekly-priorities.js';
import { readCycle, writeSection } from './file.js';
import { insertUnderHeading, priorityGroups } from './unplanned.js';

export interface LinearIssue {
  identifier: string;
  title: string;
  /** Linear's state type: started / unstarted / completed / canceled / backlog / triage. */
  stateType: string;
}

export interface LinearSyncResult {
  cycleId: string;
  done: string[];
  added: string[];
}

const ISSUE_ID = /\b([A-Z][A-Z0-9]+-\d+)\b/g;
const DONE = '✅';

/** Issues from the Linear evidence source: the active ones and the recently completed. */
export function linearIssues(source: EvidenceSource | undefined): LinearIssue[] {
  if (!source || source.state !== 'available' || !isRecord(source.data)) return [];
  const data = source.data;
  const raw = [...(Array.isArray(data.items) ? data.items : []), ...(Array.isArray(data.recently_completed) ? data.recently_completed : [])];
  const seen = new Set<string>();
  const issues: LinearIssue[] = [];
  for (const item of raw) {
    if (!isRecord(item) || typeof item.identifier !== 'string' || seen.has(item.identifier)) continue;
    seen.add(item.identifier);
    const state = isRecord(item.state) ? item.state : {};
    issues.push({
      identifier: item.identifier,
      title: typeof item.title === 'string' ? item.title.trim() : '',
      stateType: typeof state.type === 'string' ? state.type : '',
    });
  }
  return issues;
}

/**
 * The 要务 text after applying Linear. `workHeading` is where new issues go:
 * the group whose lines already name the most Linear issues, else the one
 * whose heading says 工作. No work group, nothing is added.
 */
export function applyLinear(content: string, issues: LinearIssue[]): { content: string; done: string[]; added: string[] } {
  const byId = new Map(issues.map((issue) => [issue.identifier, issue]));
  const done: string[] = [];
  const named = new Set<string>();

  const lines = content.split('\n').map((line) => {
    const bullet = /^(\s*(?:[-*+]|\d+[.)])\s+)(.+)$/.exec(line);
    if (!bullet) return line;
    const ids = [...bullet[2]!.matchAll(ISSUE_ID)].map((match) => match[1]!);
    for (const id of ids) named.add(id);
    if (ids.length === 0 || /[✅❌]/.test(line)) return line;
    // Done when every issue the line names is done in Linear.
    const known = ids.map((id) => byId.get(id)).filter((issue): issue is LinearIssue => Boolean(issue));
    if (known.length === 0 || known.length < ids.length || !known.every((issue) => issue.stateType === 'completed')) return line;
    done.push(ids.join(' '));
    return `${line.replace(/\s*🚧\s*$/, '').replace(/\s+$/, '')} ${DONE}`;
  });
  let next = lines.join('\n');

  const started = issues.filter((issue) => issue.stateType === 'started' && issue.title && !named.has(issue.identifier));
  const heading = workHeading(next);
  const added: string[] = [];
  if (heading) {
    for (const issue of started) {
      next = insertUnderHeading(next, heading, `${issue.title} (${issue.identifier})`);
      added.push(issue.identifier);
    }
  }
  return { content: next, done, added };
}

function workHeading(content: string): string | null {
  const groups = priorityGroups(content);
  let best: { heading: string; count: number } | null = null;
  for (const group of groups) {
    const count = group.items.filter((item) => /\b[A-Z][A-Z0-9]+-\d+\b/.test(item)).length;
    if (count > 0 && (!best || count > best.count)) best = { heading: group.heading, count };
  }
  return best?.heading ?? groups.find((group) => /工作/.test(group.heading))?.heading ?? null;
}

/** Bring the current cycle's 要务 in step with Linear. Null when there is nothing to do. */
export function syncLinearIntoPriorities(config: AppConfig, date: string, source: EvidenceSource | undefined): LinearSyncResult | null {
  const issues = linearIssues(source);
  if (issues.length === 0) return null;
  const cycle = currentCycle(config, date);
  if (!cycle) return null;
  const doc = readCycle(config, cycle.id);
  const content = doc?.sections['要务']?.content || '';
  if (!doc || !content.trim()) return null;
  const result = applyLinear(content, issues);
  if (result.done.length === 0 && result.added.length === 0) return null;
  writeSection(config, doc.id, '要务', result.content, doc.sections['要务']?.source ?? 'user', { keepDraft: true });
  return { cycleId: doc.id, done: result.done, added: result.added };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
