import type { AppConfig, WorkflowName } from '../config/schema.js';
import type { MemoryBundle } from '../storage/memory.js';
import type { Evidence } from './types.js';
import { collectSyncDrift, filterUndecidedFindings, renderSyncDriftSection } from '../progress/sync-drift.js';
import { linearIssueUrl } from '../utils/linear-link.js';

const MAX_SUMMARY_CHARS = 2200;
const MAX_DETAIL_CHARS = 7000;
const MAX_ROW_TITLE_CHARS = 96;
const MAX_ROW_GOAL_CHARS = 80;

/** A single ranked todo emitted by the daily-plan LLM (LEO-209). */
export interface DailyPlanTodo {
  rank: number;
  text: string;
  candidateId: string;
  /**
   * Rough minutes the model thinks this takes. Optional on purpose: every plan
   * written before the prompt asked for it has none, and a missing estimate has
   * to stay missing rather than become a plausible default — the number exists
   * so "four priorities is six hours" is visible in the morning, and a filled-in
   * guess would make that check meaningless.
   */
  minutes?: number;
}

/** Bounds on a plan estimate, in minutes. */
const MIN_PLAN_MINUTES = 5;
const MAX_PLAN_MINUTES = 480;

/**
 * Coerce whatever the model (or the user's edit) supplied into a usable number
 * of minutes, or undefined. Clamped rather than rejected: an eight-hour ceiling
 * keeps one hallucinated `6000` from swallowing the whole proportional bar,
 * while still letting a genuinely long block through.
 */
export function normalizePlanMinutes(value: unknown): number | undefined {
  const raw = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(raw) || raw <= 0) return undefined;
  return Math.min(Math.max(Math.round(raw), MIN_PLAN_MINUTES), MAX_PLAN_MINUTES);
}

export interface DailyPlanTodoPlan {
  todos: DailyPlanTodo[];
  note?: string;
}

/**
 * Parse the LEO-209 daily-plan JSON output `{ todos: [{ rank, text,
 * candidateId }], note? }`. Returns null when the content is not the expected
 * JSON so callers can fall back to the legacy long-form extraction path.
 */
export function parseDailyPlanTodoPlan(content: string): DailyPlanTodoPlan | null {
  const json = extractJsonObject(content);
  if (!json) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { todos?: unknown }).todos)) return null;
  const todos = ((parsed as { todos: unknown[] }).todos)
    .map((todo, index): DailyPlanTodo | null => {
      if (!todo || typeof todo !== 'object') return null;
      const record = todo as Record<string, unknown>;
      const text = typeof record.text === 'string' ? record.text.trim() : '';
      if (!text) return null;
      const rank = typeof record.rank === 'number' && Number.isFinite(record.rank) ? record.rank : index + 1;
      const candidateId = typeof record.candidateId === 'string' ? record.candidateId : '';
      const minutes = normalizePlanMinutes(record.minutes);
      return { rank, text, candidateId, ...(minutes ? { minutes } : {}) };
    })
    .filter((todo): todo is DailyPlanTodo => Boolean(todo))
    .sort((left, right) => left.rank - right.rank)
    .map((todo, index) => ({ ...todo, rank: index + 1 }));
  if (todos.length === 0) return null;
  const note = typeof (parsed as { note?: unknown }).note === 'string' ? (parsed as { note: string }).note.trim() : '';
  return { todos, ...(note ? { note } : {}) };
}

/** Structured todos for card buttons; [] when content is not the LEO-209 JSON. */
export function extractDailyPlanTodos(content: string): DailyPlanTodo[] {
  return parseDailyPlanTodoPlan(content)?.todos ?? [];
}

/** LEO-232 — one reconciled line of the daily review against the morning todo. */
export type DailyReviewReconStatus = 'done' | 'progressed' | 'open';

export interface DailyReviewReconItem {
  candidateId: string;
  text: string;
  status: DailyReviewReconStatus;
  evidence?: string;
}

export interface DailyReviewReconciliation {
  reconciliation: DailyReviewReconItem[];
  carryOver: string[];
  note?: string;
}

/**
 * Parse the LEO-232 daily-review reconciliation JSON
 * `{ reconciliation: [{ candidateId, text, status, evidence }], carry_over: [candidateId...], note? }`.
 * Returns null when the content is not that JSON, or when the reconciliation
 * list is empty, so callers fall back to the legacy grouped render.
 */
export function parseDailyReviewReconciliation(content: string): DailyReviewReconciliation | null {
  const json = extractJsonObject(content);
  if (!json) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { reconciliation?: unknown }).reconciliation)) {
    return null;
  }
  const reconciliation = ((parsed as { reconciliation: unknown[] }).reconciliation)
    .map((item): DailyReviewReconItem | null => {
      if (!item || typeof item !== 'object') return null;
      const record = item as Record<string, unknown>;
      const text = typeof record.text === 'string' ? record.text.trim() : '';
      if (!text) return null;
      const candidateId = typeof record.candidateId === 'string' ? record.candidateId.trim() : '';
      const status = normalizeReconStatus(record.status);
      const evidence = typeof record.evidence === 'string' ? record.evidence.trim() : '';
      return { candidateId, text, status, ...(evidence ? { evidence } : {}) };
    })
    .filter((item): item is DailyReviewReconItem => Boolean(item));
  if (reconciliation.length === 0) return null;
  const carryOver = Array.isArray((parsed as { carry_over?: unknown }).carry_over)
    ? ((parsed as { carry_over: unknown[] }).carry_over)
        .map((id) => (typeof id === 'string' ? id.trim() : ''))
        .filter(Boolean)
    : [];
  const note = typeof (parsed as { note?: unknown }).note === 'string' ? (parsed as { note: string }).note.trim() : '';
  return { reconciliation, carryOver, ...(note ? { note } : {}) };
}

/**
 * LEO-232 — the carry-over candidateIds to persist when the review is confirmed:
 * the model's `carry_over` list restricted to items that are still `open` (a
 * done/progressed item is never carried forward, even if the model lists it).
 */
/**
 * The carry-over ids the model proposed, minus anything it also called finished.
 *
 * `progressed` is allowed through alongside `open`. The guard exists to stop a
 * row being carried and reported `done` in the same breath — half-finished work
 * is the *most* carry-worthy thing on the list, and filtering it out meant the
 * model had to downgrade a genuinely advanced task to `open` to keep it for
 * tomorrow, i.e. lie about the day to preserve the task.
 *
 * This became load-bearing with the `partial` feedback event: a row the user
 * marks "worked on it, not done" is required to reconcile as `progressed`, so
 * an `open`-only filter would have silently dropped every one of them.
 */
export function selectCarryOverCandidateIds(recon: DailyReviewReconciliation): string[] {
  const unfinishedIds = new Set(
    recon.reconciliation
      .filter((item) => (item.status === 'open' || item.status === 'progressed') && item.candidateId)
      .map((item) => item.candidateId),
  );
  return recon.carryOver.filter((id) => unfinishedIds.has(id));
}

function normalizeReconStatus(value: unknown): DailyReviewReconStatus {
  if (value === 'done' || value === 'progressed' || value === 'open') return value;
  return 'open';
}

const RECON_ICON: Record<DailyReviewReconStatus, string> = { done: '✅', progressed: '🔨', open: '⏳' };

/**
 * LEO-232 — render the reconciliation card. Any candidateId the user already
 * ticked "complete" on the morning todo card is force-set to `done` and cannot
 * be re-judged by the LLM. `driftLines` re-uses the existing sync-drift section.
 */
export function renderDailyReviewReconciliationSummary(
  recon: DailyReviewReconciliation,
  completedIds: Set<string> = new Set(),
  driftLines: string[] = [],
): string {
  const items = recon.reconciliation.map((item) =>
    item.candidateId && completedIds.has(item.candidateId) ? { ...item, status: 'done' as const } : item,
  );
  const doneCount = items.filter((item) => item.status === 'done').length;
  const lines = [`**✅ 完成 ${doneCount}/${items.length}**`, ''];
  for (const item of items) {
    const evidence = item.evidence ? `（${item.evidence}）` : '';
    lines.push(`${RECON_ICON[item.status]} ${item.text}${evidence}`);
  }
  const openById = new Map(items.filter((item) => item.candidateId).map((item) => [item.candidateId, item]));
  const carryTexts = recon.carryOver
    .map((id) => openById.get(id))
    .filter((item): item is DailyReviewReconItem => Boolean(item))
    .map((item) => item.text);
  const carryCount = carryTexts.length > 0 ? carryTexts.length : recon.carryOver.length;
  if (carryCount > 0) {
    const preview = carryTexts.slice(0, 3).join('、');
    lines.push('', `> 明天继续 ${carryCount} 项${preview ? `：${preview}` : ''}`);
  }
  if (recon.note) lines.push('', `> ${recon.note}`);
  if (driftLines.length > 0) lines.push('', ...driftLines);
  return trimSummary(lines.join('\n'), MAX_SUMMARY_CHARS);
}

/** candidateIds the user ticked "complete" on the morning todo card, from injected evidence. */
function completedCandidateIdsFromEvidence(evidence?: Evidence): Set<string> {
  const source = evidence?.sources.todo_feedback;
  if (!source || source.state !== 'available' || !isRecord(source.data) || !Array.isArray(source.data.entries)) return new Set();
  return new Set(
    source.data.entries
      .filter((entry): entry is Record<string, unknown> => isRecord(entry))
      .filter((entry) => entry.event === 'complete' && typeof entry.candidateId === 'string')
      .map((entry) => String(entry.candidateId)),
  );
}

interface LinearIssueBrief {
  identifier: string;
  url: string;
  title: string;
  priority: number;
  dueDate: string;
  stateName: string;
  stateType: string;
}

/** Index the linear evidence items by identifier for the plan briefing. */
function linearIssueIndex(evidence?: Evidence): Map<string, LinearIssueBrief> {
  const index = new Map<string, LinearIssueBrief>();
  const data = evidence?.sources?.linear?.data as { items?: unknown[] } | undefined;
  for (const raw of data?.items ?? []) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    if (typeof item.identifier !== 'string') continue;
    const state = (item.state ?? {}) as Record<string, unknown>;
    index.set(item.identifier, {
      identifier: item.identifier,
      url: typeof item.url === 'string' ? item.url : '',
      title: typeof item.title === 'string' ? item.title : '',
      priority: typeof item.priority === 'number' ? item.priority : 0,
      dueDate: typeof item.dueDate === 'string' ? item.dueDate : '',
      stateName: typeof state.name === 'string' ? state.name : '',
      stateType: typeof state.type === 'string' ? state.type : '',
    });
  }
  return index;
}

/** Linear priority number -> the P-label used in the briefing (1=Urgent -> P0). */
function priorityLabel(priority: number): string {
  if (priority === 1) return 'P0';
  if (priority === 2) return 'P1';
  if (priority === 3) return 'P2';
  if (priority === 4) return 'P3';
  return '—';
}

function overdueDays(dueDate: string, today: string): number {
  const due = Date.parse(dueDate);
  const now = Date.parse(today);
  if (!Number.isFinite(due) || !Number.isFinite(now)) return 0;
  return Math.floor((now - due) / (24 * 60 * 60 * 1000));
}

/** One row of the daily-plan table card (Feishu card 2.0 table component). */
export interface DailyPlanTableRow {
  rank: string;
  priority: string;
  priorityColor: string;
  taskMd: string;
  due: string;
  status: string;
  statusColor: string;
}

export interface DailyPlanTableModel {
  /** 🔴 follow-up section as card markdown ('' when nothing is overdue). */
  followupMd: string;
  rows: DailyPlanTableRow[];
}

const STATE_COLOR: Record<string, string> = { started: 'blue', unstarted: 'grey', backlog: 'grey', triage: 'purple' };

/**
 * Structured model for the daily-plan table card: the 🔴 follow-up markdown and
 * one table row per ranked todo (priority/status as colored option tags, task
 * cell as lark_md with a clickable Linear link). Null when the content is not
 * the LEO-209 todo JSON — callers then fall back to the markdown-only card.
 */
export function buildDailyPlanTable(content: string, date: string, evidence?: Evidence, config?: AppConfig): DailyPlanTableModel | null {
  const plan = parseDailyPlanTodoPlan(content);
  if (!plan) return null;
  const index = linearIssueIndex(evidence);
  const workspace = config?.sources.linear.workspace || '';
  const link = (identifier: string, evidenceUrl = ''): string =>
    `[${identifier}](${linearIssueUrl(identifier, workspace, evidenceUrl)})`;

  const followupLines: string[] = [];
  const urgent = [...index.values()]
    .filter((issue) => issue.dueDate && issue.dueDate <= date && issue.stateType !== 'completed' && issue.stateType !== 'canceled')
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
    .slice(0, 5);
  if (urgent.length > 0) {
    followupLines.push('🔴 **需要立即跟进**');
    urgent.forEach((issue, i) => {
      const days = overdueDays(issue.dueDate, date);
      followupLines.push(`**${i + 1}. ${issue.title}**（${link(issue.identifier, issue.url)}）`);
      followupLines.push(`　　截止 ${issue.dueDate}（**${days > 0 ? `已逾期 ${days} 天` : '今天截止'}**）· ${priorityLabel(issue.priority)} · ${issue.stateName || '未完成'}`);
    });
  }

  const rows = plan.todos.map((todo): DailyPlanTableRow => {
    const issueId = todo.candidateId.startsWith('linear:') ? todo.candidateId.slice('linear:'.length) : '';
    const issue = issueId ? index.get(issueId) : undefined;
    const priority = issue ? priorityLabel(issue.priority) : '—';
    // Feishu table cells do NOT wrap or auto-grow (long content is cropped, the
    // client shows the rest on hover), and a leading "1." renders as an ordered
    // list that breaks the cropping. So: no list marker (rank is its own
    // column) and a hard-truncated title that fits the two-line row height.
    // Row height is pinned at the platform max (124px ≈ 5-6 lines), enough for
    // full task titles; the 120-char guard only protects pathological cases.
    const title = todo.text.length > 120 ? `${todo.text.slice(0, 120)}…` : todo.text;
    return {
      rank: String(todo.rank),
      priority,
      priorityColor: priority === 'P0' ? 'red' : priority === 'P1' ? 'orange' : 'grey',
      // Full-width "）" so the rank never parses as a markdown ordered list.
      taskMd: `${todo.rank}）${title}${issueId ? ` ${link(issueId, issue?.url)}` : ''}`,
      due: issue?.dueDate ? issue.dueDate.slice(5) : '无截止',
      status: issue?.stateName || '未关联',
      statusColor: issue ? STATE_COLOR[issue.stateType] || 'grey' : 'grey',
    };
  });
  return { followupMd: followupLines.join('\n'), rows };
}

/**
 * Two-part daily briefing: 🔴 overdue / due Linear issues that need immediate
 * follow-up, then 🟡 today's ranked todos — each todo linked to a Linear issue
 * carries its priority / due / state line. Degrades to the plain list when no
 * Linear evidence is available.
 */
function renderDailyPlanTodoSummary(plan: DailyPlanTodoPlan, date?: string, evidence?: Evidence, config?: AppConfig): string {
  const index = linearIssueIndex(evidence);
  const today = date || '';
  const workspace = config?.sources.linear.workspace || '';
  // Feishu card markdown supports **bold** and [links](url). Prefer the
  // connector's canonical URL, then fall back to a locally resolvable URL.
  const issueRef = (identifier: string, evidenceUrl = ''): string =>
    `[${identifier}](${linearIssueUrl(identifier, workspace, evidenceUrl)})`;
  const lines: string[] = [];

  if (today && index.size > 0) {
    const urgent = [...index.values()]
      .filter((issue) => issue.dueDate && issue.dueDate <= today && issue.stateType !== 'completed' && issue.stateType !== 'canceled')
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
      .slice(0, 5);
    if (urgent.length > 0) {
      lines.push('🔴 **需要立即跟进**');
      urgent.forEach((issue, i) => {
        const days = overdueDays(issue.dueDate, today);
        const dueNote = days > 0 ? `已逾期 ${days} 天` : '今天截止';
        lines.push(`**${i + 1}. ${issue.title}**（${issueRef(issue.identifier, issue.url)}）`);
        lines.push(`　　截止 ${issue.dueDate}（**${dueNote}**）· ${priorityLabel(issue.priority)} · ${issue.stateName || '未完成'}`);
      });
      lines.push('', '---', '');
    }
  }

  lines.push('🟡 **今日待办**');
  for (const todo of plan.todos) {
    lines.push(`**${todo.rank}. ${todo.text}**`);
    const issueId = todo.candidateId.startsWith('linear:') ? todo.candidateId.slice('linear:'.length) : '';
    const issue = issueId ? index.get(issueId) : undefined;
    if (issue) {
      const due = issue.dueDate ? (today && issue.dueDate <= today ? `截止 ${issue.dueDate} **已逾期**` : `截止 ${issue.dueDate}`) : '无截止';
      lines.push(`　　${priorityLabel(issue.priority)} · ${issueRef(issue.identifier, issue.url)} · ${due} · ${issue.stateName || '未完成'}`);
    } else if (issueId) {
      lines.push(`　　${issueRef(issueId)}`);
    }
  }
  if (plan.note) lines.push('', `> ${plan.note}`);
  lines.push('', '完成一条就点它下面的「✅ 完成」按钮；想调整点「我要调整」。');
  return trimSummary(lines.join('\n'), MAX_SUMMARY_CHARS);
}

function extractJsonObject(content: string): string | null {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const source = (fenced ?? content).trim();
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  return source.slice(start, end + 1);
}

/**
 * True when content was meant to be a JSON object — it opens with `{` after an
 * optional ```json fence. Unlike extractJsonObject this does not require a closing
 * `}`, so it still catches output truncated mid-object at the token cap.
 */
function looksLikeJsonObject(content: string): boolean {
  return content.trim().replace(/^```(?:json)?\s*/i, '').trimStart().startsWith('{');
}

/**
 * True when content is any object carrying a `reconciliation` array (regardless of
 * item count). Distinguishes the "empty morning plan" case — which
 * `parseDailyReviewReconciliation` collapses to null — from unrelated JSON.
 */
function isDailyReviewReconciliationJson(content: string): boolean {
  const json = extractJsonObject(content);
  if (!json) return false;
  try {
    const parsed = JSON.parse(json);
    return Boolean(parsed && typeof parsed === 'object' && Array.isArray((parsed as { reconciliation?: unknown }).reconciliation));
  } catch {
    return false;
  }
}

/** No morning plan to reconcile: a clean card instead of leaking `{"reconciliation": []...}`. */
function renderEmptyDailyReviewSummary(driftLines: string[] = []): string {
  const lines = [
    '老板，今天没有可对账的晨间安排（没跑今日安排，或今日安排为空），所以没有可逐条勾对的清单。',
    '',
    '如果今天有进展想记账，直接回复：daily-os 修改今日复盘：……',
  ];
  if (driftLines.length > 0) lines.push('', ...driftLines);
  return trimSummary(lines.join('\n'), MAX_SUMMARY_CHARS);
}

/** JSON output that failed to parse (truncated/malformed): ask to regenerate, never leak raw JSON. */
function renderJsonGenerationFailureSummary(workflow: WorkflowName, driftLines: string[] = []): string {
  const label = workflow === 'daily_plan' ? '今日安排' : '今日复盘';
  const lines = [
    `老板，今天的${label}没能正常生成（内容可能被截断了）。`,
    '',
    '点「重排一次」我再整理一遍；如果反复失败，回复 daily-os details 我把原始内容发给你排查。',
  ];
  if (driftLines.length > 0) lines.push('', ...driftLines);
  return trimSummary(lines.join('\n'), MAX_SUMMARY_CHARS);
}

export function formatWorkflowSummaryForFeishu(workflow: WorkflowName, date: string, content: string, evidence?: Evidence, config?: AppConfig): string {
  if (workflow === 'daily_plan') {
    const plan = parseDailyPlanTodoPlan(content);
    if (plan) return renderDailyPlanTodoSummary(plan, date, evidence, config);
    console.warn('[summary] daily_plan output was not LEO-209 todo JSON; falling back to legacy long-form extraction.');
  }
  if (workflow === 'daily_review') {
    // LEO-232: reconcile against the morning todo.
    const recon = parseDailyReviewReconciliation(content);
    if (recon) {
      const completedIds = completedCandidateIdsFromEvidence(evidence);
      const driftLines = syncDriftSectionLines(date, evidence, config);
      return renderDailyReviewReconciliationSummary(recon, completedIds, driftLines);
    }
    // The prompt emits `{"reconciliation": [], "carry_over": []}` when there was no
    // morning plan to reconcile. That is valid-but-empty JSON, not prose — the legacy
    // grouped render would leak the raw JSON into the card, so render a clean
    // "nothing to reconcile" message instead.
    if (isDailyReviewReconciliationJson(content)) {
      return renderEmptyDailyReviewSummary(syncDriftSectionLines(date, evidence, config));
    }
    console.warn('[summary] daily_review output was not LEO-232 reconciliation JSON; falling back to legacy grouped render.');
  }
  // Guard: a JSON workflow output that failed structured parsing (truncated at the
  // token cap, or otherwise malformed) must never reach the prose extractor below —
  // it would dump raw JSON fragments into the card (the "莫名其妙的内容" symptom).
  if ((workflow === 'daily_plan' || workflow === 'daily_review') && looksLikeJsonObject(content)) {
    console.warn(`[summary] ${workflow} output looked like JSON but failed to parse; rendering a regenerate prompt instead of leaking raw JSON.`);
    const driftLines = workflow === 'daily_review' ? syncDriftSectionLines(date, evidence, config) : [];
    return renderJsonGenerationFailureSummary(workflow, driftLines);
  }
  const clean = normalize(content);
  const intro = introFor(workflow, clean);
  const overview = workflowOverview(workflow, clean, evidence, config);
  const fallback = sentencePreview(clean, 420);
  const fallbackLines = normalizedTextKey(fallback) === normalizedTextKey(intro) ? [] : [fallback];
  const driftLines = workflow === 'daily_review' ? syncDriftSectionLines(date, evidence, config) : [];
  const lines = [
    intro,
    '',
    ...(overview.length > 0 ? overview : fallbackLines),
    ...(driftLines.length > 0 ? ['', ...driftLines] : []),
    '',
    actionHint(workflow),
    closingLine(workflow),
  ];
  return trimSummary(lines.join('\n'), MAX_SUMMARY_CHARS);
}

/**
 * LEO-120: append the "🔄 可能需要同步的任务" section to the daily-review card
 * only when the optional check is enabled and there are undecided findings.
 * Disabled or no-drift -> zero trace, so the review card stays clean.
 */
function syncDriftSectionLines(date: string, evidence?: Evidence, config?: AppConfig): string[] {
  if (!config?.progress_sync_check.enabled || !evidence) return [];
  const findings = filterUndecidedFindings(collectSyncDrift(evidence, config).findings, date);
  return renderSyncDriftSection(findings);
}

export function formatLatestWorkflowDetails(input: { workflow: WorkflowName; date: string; generated_at: string; content: string; evidence_trace?: string }): string {
  return truncate(
    [
      `最近一次${workflowLabel(input.workflow)}`,
      `日期：${input.date}`,
      `生成时间：${input.generated_at}`,
      ...(input.evidence_trace?.trim() ? ['', input.evidence_trace.trim()] : []),
      '',
      '完整内容',
      '',
      input.content.trim(),
    ].join('\n'),
    MAX_DETAIL_CHARS,
  );
}

export function buildWorkflowEvidenceTrace(input: { evidence: Evidence; memory: MemoryBundle }): string {
  const policyYaml = input.memory.repository.some((file) => file.path === 'decision-policy.yaml');
  const policyNotes = input.memory.repository.some((file) => file.path === 'decision-policy.md');
  const sourceLines = Object.entries(input.evidence.sources)
    .slice(0, 14)
    .map(([name, source]) => `- ${name}：${source.state}${source.detail ? `，${completePhrase(source.detail, 90)}` : sourceDataHint(name, source.data)}`)
    .filter(Boolean);
  const weeklyRows = weeklyPriorityRows(input.evidence);
  const linearRows = linearIssueRows(input.evidence);

  return [
    '这次用了这些依据',
    '',
    '决策规则',
    `- decision-policy.yaml：${policyYaml ? '已读' : '未读'}`,
    `- decision-policy.md：${policyNotes ? '已读' : '未读'}`,
    `- memory 文件：${input.memory.repository.length}`,
    '',
    '来源状态',
    ...(sourceLines.length > 0 ? sourceLines : ['- 没有来源状态']),
    ...(weeklyRows.length > 0 ? ['', 'Feishu Weekly 要务', ...weeklyRows] : []),
    ...(linearRows.length > 0 ? ['', 'Linear 任务', ...linearRows] : []),
  ].join('\n');
}

function introFor(workflow: WorkflowName, content: string): string {
  if (workflow === 'daily_plan') {
    return `老板，今天我先帮您压成一张清单。`;
  }
  if (workflow === 'daily_review') {
    return `老板，我把今天的进展先分好类了。`;
  }
  return `老板，我把本周总结和下周安排先压成重点版。`;
}

function extractSectionBullets(content: string, headings: string[], limit: number): string[] {
  const sections = splitSections(content);
  const wanted = headings.map((heading) => heading.toLowerCase());
  return sections
    .filter((section) => wanted.some((heading) => section.heading.toLowerCase().includes(heading)))
    .flatMap((section) => extractBullets(section.body))
    .slice(0, limit);
}

function workflowOverview(workflow: WorkflowName, content: string, evidence?: Evidence, config?: AppConfig): string[] {
  if (workflow === 'daily_plan') return dailyPlanOverview(content, evidence, config);
  if (workflow === 'daily_review') return dailyReviewOverview(content, evidence);
  return weeklyReviewOverview(content, evidence);
}

function dailyPlanOverview(content: string, evidence?: Evidence, config?: AppConfig): string[] {
  if (config?.output.feishu.summary_style === 'style2') return dailyPlanOverviewStyle2(content, evidence, config);
  const linear = linearMetadataFromEvidence(evidence);
  const alignment = strategyAlignmentRows(content, config);
  const alignmentTitle = strategyAlignmentTitle(config);
  const openLoopRows = dailyPlanOpenLoopRows(content);
  const priorities = extractSectionBullets(content, ['今日重点'], 3);
  const codex = extractSectionBullets(content, ['Codex 可以做', '我可以帮您', '我可以帮您安排 Codex 做'], 3);
  const user = extractSectionBullets(content, ['用户必须做', '需要您批示', '需要您本人处理'], 3);
  const paused = extractSectionBullets(content, ['暂不处理', '阻塞'], 2);
  const confirmedRows = priorities.map((item, index) =>
    taskRow(item, index === 0 ? 'P0' : 'P1', ownerFor(item, codex, user), '今天有明确价值，先推进到可检查结果', linear),
  );
  const newRows = dedupe(
    [
      ...codex.filter((item) => !overlapsAny(item, priorities)).map((item) => taskRow(item, 'P1', 'Codex', '先产出草稿、检查结果或拆解方案', linear)),
      ...user.filter((item) => !overlapsAny(item, priorities)).map((item) => taskRow(item, 'P1', '您', '需要您判断、沟通或拍板', linear)),
    ],
  ).slice(0, 3);
  const pausedRows = paused.map((item) => taskRow(item, 'P2', '暂缓', '今天先不抢主线，避免分散注意力', linear)).slice(0, 2);
  const overview = groupedOverview('今天先看这几件事', [
    { label: '确认的', rows: confirmedRows.slice(0, 3) },
    { label: '新增的', rows: newRows },
    { label: '暂缓的', rows: pausedRows },
  ]);
  if (overview.length === 0) return overview;
  const contextRows = [
    ...(alignment.length > 0 ? [`**${alignmentTitle}**`, ...alignment] : []),
    ...(openLoopRows.length > 0 ? ['', '**未闭环依据**', ...openLoopRows] : []),
  ];
  return contextRows.length === 0 ? overview : [overview[0], '', ...contextRows, ...overview.slice(1)];
}

function dailyPlanOverviewStyle2(content: string, evidence?: Evidence, config?: AppConfig): string[] {
  const linear = linearMetadataFromEvidence(evidence);
  const alignment = strategyAlignmentRows(content, config);
  const alignmentTitle = strategyAlignmentTitle(config);
  const openLoopRows = dailyPlanOpenLoopRows(content);
  const priorities = extractSectionBullets(content, ['今日重点'], 3);
  const codex = extractSectionBullets(content, ['Codex 可以做', '我可以帮您', '我可以帮您安排 Codex 做'], 3);
  const user = extractSectionBullets(content, ['用户必须做', '需要您批示', '需要您本人处理'], 3);
  const paused = extractSectionBullets(content, ['暂不处理', '阻塞'], 2);

  const tasks = [
    ...priorities.map((item, index) => taskRowStyle2(item, ownerFor(item, codex, user), index, '今天有明确价值，先推进到可检查结果', linear)),
    ...codex
      .filter((item) => !overlapsAny(item, priorities))
      .map((item, index) => taskRowStyle2(item, 'Codex', 20 + index, '先产出草稿、检查结果或拆解方案', linear)),
    ...user
      .filter((item) => !overlapsAny(item, priorities))
      .map((item, index) => taskRowStyle2(item, '您', 40 + index, '需要您判断、沟通或拍板', linear)),
    ...paused.map((item, index) => taskRowStyle2(item, '暂缓', 80 + index, '今天先不抢主线，避免分散注意力', linear)),
  ]
    .sort((left, right) => left.rank - right.rank)
    .filter((task, index, all) => all.findIndex((candidate) => normalizedTextKey(candidate.title) === normalizedTextKey(task.title)) === index)
    .slice(0, 8);

  const taskLines = tasks.flatMap((task, index) => [`${index + 1}. ${task.title}`, ...(task.meta ? [`   > Linear：${task.meta}`] : [])]);
  const contextRows = [
    ...(alignment.length > 0 ? [`**${alignmentTitle}**`, ...alignment, ''] : []),
    ...(openLoopRows.length > 0 ? ['**未闭环依据**', ...openLoopRows, ''] : []),
  ];
  return ['**今天先看这几件事**', '', ...contextRows, ...taskLines];
}

function dailyReviewOverview(content: string, evidence?: Evidence): string[] {
  const linear = linearMetadataFromEvidence(evidence);
  const done = extractSectionBullets(content, ['已完成', '已推进'], 3);
  const open = extractSectionBullets(content, ['没完成', '未闭环', '明天带走'], 3);
  const codex = extractSectionBullets(content, ['我可以帮您继续做', 'Codex 可以做'], 2);
  return groupedOverview('今天先按这三类看', [
    { label: '确认的', rows: done.map((item) => taskRow(item, '完成', '已推进', '这是今天可以记账的进展', linear)).slice(0, 3) },
    { label: '暂缓的', rows: open.map((item) => taskRow(item, '未闭环', '您', '需要确认明天是否继续', linear)).slice(0, 3) },
    { label: '新增的', rows: codex.map((item) => taskRow(item, '下一步', 'Codex', '我可以先准备后续动作', linear)).slice(0, 2) },
  ]);
}

function weeklyReviewOverview(content: string, evidence?: Evidence): string[] {
  const linear = linearMetadataFromEvidence(evidence);
  const done = extractPrefixedSectionRows(content, ['本周已经完成', '已推进'], ['确认的', '完成', '已推进'], 3);
  const open = extractPrefixedSectionRows(content, ['本周没做完', '需要继续盯', '未闭环'], ['未闭环', '逐条核对'], 3);
  const weeklyOpen = weeklyPriorityOpenRows(evidence);
  const decision = weeklyDecisionRows(content);
  const mit = extractSectionBullets(content, ['下周 MIT'], 1);
  const plan = extractSectionBullets(content, ['下周主要安排'], 4);
  const codex = extractSectionBullets(content, ['我可以帮您安排 Codex 做', 'Codex 可以做'], 2);
  const planAfterMit = plan.filter((item) => !overlapsAny(item, mit));
  const codexAfterPlan = codex.filter((item) => !overlapsAny(item, [...mit, ...planAfterMit]));
  return groupedOverview('先复盘本周，再决定下周带走', [
    { label: '本周确认', rows: done.map((item) => taskRow(item, '完成', '已推进', '本周已经能沉淀为结果', linear)).slice(0, 2) },
    { label: '本周未闭环', rows: open.map((item) => taskRow(item, '未闭环', '您', '下周需要继续盯到可验证结果', linear)).slice(0, 2) },
    { label: 'Weekly 🐶 未完成', rows: weeklyOpen.map((item) => taskRow(item, '未完成', '待确认', '按 Feishu Weekly 逐条带走', linear)).slice(0, 3) },
    { label: '决策依据', rows: decision.map((item) => taskRow(item, '规则', '已加载', '本次复盘已按这条规则排序', linear)).slice(0, 1) },
    {
      label: '下周带走',
      rows: [
        ...mit.map((item) => taskRow(item, 'P0', ownerFor(item, codex, []), '下周唯一主线', linear)),
        ...planAfterMit.map((item, index) => taskRow(item, index === 0 ? 'P1' : 'P2', ownerFor(item, codex, []), '推进到可检查结果', linear)),
        ...codexAfterPlan.map((item) => taskRow(item, 'P1', 'Codex', '先准备可交付产物', linear)),
      ].slice(0, 5),
    },
  ]);
}

function weeklyPriorityOpenRows(evidence?: Evidence): string[] {
  const source = evidence?.sources.weekly_priorities;
  if (!source || source.state !== 'available' || !isRecord(source.data) || !Array.isArray(source.data.items)) return [];
  const rows = source.data.items
    .filter((item): item is Record<string, unknown> => isRecord(item))
    .filter((item) => item.scope === '🐶')
    .map((item) => (typeof item.item === 'string' ? item.item : ''))
    .filter((item) => item && !/✅/.test(item));
  const highSignal = rows.filter((item) => /portfolio|作品集|build in public|强制令|Leon 学长/i.test(item));
  return dedupe([...highSignal, ...rows]).slice(0, 6);
}

function groupedOverview(title: string, groups: Array<{ label: string; rows: string[] }>): string[] {
  const lines: string[] = [`**${title}**`];
  for (const group of groups) {
    const rows = dedupe(group.rows).slice(0, 3);
    if (rows.length === 0) continue;
    lines.push('', `**${group.label}**`);
    rows.forEach((row, index) => lines.push(`${index + 1}. ${row}`));
  }
  return lines.length > 1 ? lines : [];
}

function taskRow(item: string, priority: string, owner: string, goal: string, linear: Map<string, LinearIssueMetadata> = new Map()): string {
  const clean = compactItem(item);
  const meta = linearMetadataLine(item, linear);
  return `**${priority}｜${owner}**：${clean}\n   目标：${goalFromItem(item, goal)}${meta ? `\n   > Linear：${meta}` : ''}`;
}

function taskRowStyle2(
  item: string,
  owner: string,
  rank: number,
  goal: string,
  linear: Map<string, LinearIssueMetadata> = new Map(),
): { title: string; goal: string; meta: string; rank: number } {
  const clean = compactItem(item);
  const suffix = owner === 'Codex' ? '（AI）' : '';
  return {
    title: `**${clean}${suffix}**`,
    goal: goalFromItem(item, goal),
    meta: linearMetadataLine(item, linear),
    rank,
  };
}

function ownerFor(item: string, codexItems: string[], userItems: string[]): string {
  const key = normalizedTextKey(item);
  if (/verify|验收|亲自|本人|您需要|判断|确认/.test(item.toLowerCase())) return '您';
  if (codexItems.some((candidate) => key.includes(normalizedTextKey(candidate).slice(0, 18)))) return 'Codex';
  if (userItems.some((candidate) => key.includes(normalizedTextKey(candidate).slice(0, 18)))) return '您';
  const codexLike = /codex|我可以帮|助手|自动|生成|整理|检查|草稿|修复|修改|改成|实现|写|补齐/i.test(item);
  const userLike = /您|用户|本人|确认|沟通|审批|判断|批示|联系/.test(item);
  if (codexLike) return 'Codex';
  if (userLike) return '您';
  return '您';
}

function compactItem(item: string): string {
  const clean = completePhrase(
    removeEvidenceTail(
      stripMarkdown(item)
        .replace(/^(MIT|P[0-3]|优先级[:：]?)\s*/i, '')
        .replace(/^辅助重点\s*\d*\s*[:：]\s*/, '')
        .replace(/^[:：]\s*/, '')
        .replace(/^(确认的|暂缓的|新增的|未闭环)[:：\s]*/, '')
        .replace(/^(完成|已推进|未闭环|下一步|P[0-3])\s*[|｜]\s*(?:已推进|您|Codex)?\s*[:：]\s*/, '')
        .replace(/^(完成|已推进|未闭环|下一步|P[0-3])[:：\s]*/, '')
        .replace(/^(?:Codex|我可以先|我可以|我|您|用户)\s*(?:可以先|可以|需要|先)?\s*/, '')
        .replace(/^今天最大的进展是/, '')
        .replace(/\s+/g, ' ')
        .trim(),
    ),
    MAX_ROW_TITLE_CHARS,
  );
  return clean || '需要确认这一项';
}

function goalFromItem(item: string, fallback: string): string {
  const clean = stripMarkdown(item).replace(/\s+/g, ' ').trim();
  const match =
    clean.match(/(?:完成标准|预期产物|目标|结果|产物)(?:是|为|：|:)\s*([^。；;]+)/) ||
    clean.match(/(?:确保|形成|产出|完成|确认(?!过)|决定)([^。；;，,]{6,60})/);
  return completePhrase(match?.[1]?.trim() || fallback, MAX_ROW_GOAL_CHARS);
}

interface LinearIssueMetadata {
  identifier: string;
  title?: string;
  project?: string;
  dueDate?: string;
  priority?: string;
}

function linearMetadataLine(item: string, linear: Map<string, LinearIssueMetadata>): string {
  const issueIds = Array.from(new Set(stripMarkdown(item).match(/[A-Z][A-Z0-9]+-\d+/g) || []));
  const lines = issueIds
    .map((id) => linear.get(id))
    .filter((meta): meta is LinearIssueMetadata => Boolean(meta))
    .map((meta) =>
      [
        meta.project ? `Project ${meta.project}` : '',
        meta.dueDate ? `Due ${meta.dueDate}` : '',
        meta.priority ? meta.priority : '',
      ]
        .filter(Boolean)
        .join(' · ')
        .replace(/^Project\s+/, ''),
    )
    .filter(Boolean);
  return lines.slice(0, 2).join(' / ');
}

function linearMetadataFromEvidence(evidence?: Evidence): Map<string, LinearIssueMetadata> {
  const out = new Map<string, LinearIssueMetadata>();
  const source = evidence?.sources.linear;
  if (!source || source.state !== 'available') return out;
  for (const item of linearItems(source.data)) {
    if (!isRecord(item) || typeof item.identifier !== 'string') continue;
    const title = typeof item.title === 'string' ? item.title : '';
    out.set(item.identifier, {
      identifier: item.identifier,
      ...(title ? { title } : {}),
      ...(linearProjectName(item) ? { project: linearProjectName(item) } : {}),
      ...(linearDueDate(item, evidence?.date) ? { dueDate: linearDueDate(item, evidence?.date) } : {}),
      ...(linearPriority(item) ? { priority: linearPriority(item) } : {}),
    });
  }
  return out;
}

function linearItems(data: unknown): unknown[] {
  for (const path of [
    ['items'],
    ['data', 'issues', 'nodes'],
    ['issues', 'nodes'],
  ]) {
    const items = getArrayAtPath(data, path);
    if (items) return items;
  }
  return [];
}

function sourceDataHint(name: string, data: unknown): string {
  if (Array.isArray(data)) return `，${data.length} 条`;
  if (typeof data === 'string' && data.trim()) return '，有内容';
  if (!isRecord(data)) return '';
  const items = linearItems(data);
  if (items.length > 0) return `，${items.length} 条`;
  if (name === 'weekly_priorities' && isRecord(data) && Array.isArray(data.items)) return `，${data.items.length} 条`;
  return '';
}

function getArrayAtPath(data: unknown, path: string[]): unknown[] | null {
  let current = data;
  for (const key of path) {
    if (!isRecord(current)) return null;
    current = current[key];
  }
  return Array.isArray(current) ? current : null;
}

function linearProjectName(item: Record<string, unknown>): string {
  const project = item.project;
  if (typeof project === 'string') return project;
  if (isRecord(project) && typeof project.name === 'string') return project.name;
  return '';
}

function linearDueDate(item: Record<string, unknown>, date?: string): string {
  if (typeof item.dueDate === 'string' && item.dueDate) return item.dueDate;
  const title = typeof item.title === 'string' ? item.title : '';
  const match = title.match(/\[(\d{1,2})\/(\d{1,2})\]/);
  if (!match) return '';
  const year = date?.match(/^(\d{4})-/)?.[1] || String(new Date().getFullYear());
  return `${year}-${match[1].padStart(2, '0')}-${match[2].padStart(2, '0')}`;
}

function linearPriority(item: Record<string, unknown>): string {
  const title = typeof item.title === 'string' ? item.title : '';
  const titlePriority = title.match(/\[(P[0-4])\]/i)?.[1]?.toUpperCase();
  if (titlePriority) return titlePriority;
  return linearPriorityLabel(item.priority);
}

function linearPriorityLabel(value: unknown): string {
  if (typeof value !== 'number') return '';
  if (value === 0) return 'None (0)';
  if (value === 1) return 'Urgent (1)';
  if (value === 2) return 'High (2)';
  if (value === 3) return 'Medium (3)';
  if (value === 4) return 'Low (4)';
  return String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function weeklyPriorityRows(evidence: Evidence): string[] {
  const source = evidence.sources.weekly_priorities;
  if (!source || source.state !== 'available' || !isRecord(source.data) || !Array.isArray(source.data.items)) return [];
  return source.data.items
    .filter((item): item is Record<string, unknown> => isRecord(item))
    .slice(0, 8)
    .map((item) => {
      const scope = typeof item.scope === 'string' ? item.scope : 'weekly';
      const okr = typeof item.okr === 'string' && item.okr ? ` ${completePhrase(item.okr, 24)}` : '';
      const text = typeof item.item === 'string' ? completePhrase(item.item, 120) : '';
      return text ? `- ${scope}${okr}：${text}` : '';
    })
    .filter(Boolean);
}

function linearIssueRows(evidence: Evidence): string[] {
  const rows = Array.from(linearMetadataFromEvidence(evidence).values())
    .slice(0, 8)
    .map((item) => {
      const title = item.title ? ` ${completePhrase(item.title, 90)}` : '';
      const meta = [item.project, item.dueDate, item.priority].filter(Boolean).join(' · ');
      return `- ${item.identifier}${title}${meta ? `（${meta}）` : ''}`;
    });
  return rows;
}

function strategyAlignmentRows(content: string, config?: AppConfig): string[] {
  if (config?.planning.strategy_alignment.enabled === false) return [];
  const rows = extractSectionBullets(content, strategyAlignmentHeadings(config), 2);
  return rows.map((row) => `- ${completePhrase(row, 120)}`).slice(0, 2);
}

function strategyAlignmentTitle(config?: AppConfig): string {
  return config?.planning.strategy_alignment.alignment_heading || '策略对齐';
}

function strategyAlignmentHeadings(config?: AppConfig): string[] {
  const strategy = config?.planning.strategy_alignment;
  return dedupe(
    [
      strategy?.alignment_heading,
      ...(strategy?.primary_labels || []),
      ...(strategy?.primary_markers || []),
      '策略对齐',
      'Strategy alignment',
      '主策略对齐',
      '本周要务',
      '每周要务对齐',
      'Weekly alignment',
    ].filter((value): value is string => Boolean(value && value.trim())),
  );
}

function extractPrefixedSectionRows(content: string, headings: string[], prefixes: string[], limit: number): string[] {
  const sections = splitSections(content);
  const wanted = headings.map((heading) => heading.toLowerCase());
  const prefixPattern = new RegExp(`^(?:${prefixes.map(escapeRegExp).join('|')})[:：\\s]`);
  const rows = sections
    .filter((section) => wanted.some((heading) => section.heading.toLowerCase().includes(heading)))
    .flatMap((section) =>
      section.body
        .split('\n')
        .map((line) => stripMarkdown(line).trim())
        .filter((line) => prefixPattern.test(line))
        .map((line) => completePhrase(line, 160)),
    );
  if (rows.length > 0) return dedupe(rows).slice(0, limit);
  return extractSectionBullets(content, headings, limit);
}

function weeklyDecisionRows(content: string): string[] {
  const stripped = stripMarkdown(content).replace(/\s+/g, ' ');
  const match =
    stripped.match(/已确认决策规则影响排序[:：]\s*([^。]+)/) ||
    stripped.match(/决策规则影响排序[:：]\s*([^。]+)/) ||
    stripped.match(/周日必须 review Feishu Weekly[^。]+/);
  return match?.[1] ? [match[1]] : [];
}

function dailyPlanOpenLoopRows(content: string): string[] {
  const text = stripMarkdown(content).replace(/\s+/g, ' ');
  const match =
    text.match(/今日需要补进 todo 的未闭环项是[:：]\s*([^。]+)/) ||
    text.match(/未闭环项(?:是|包括)[:：]\s*([^。]+)/);
  if (!match?.[1]) return [];
  return splitOpenLoopItems(match[1])
    .map((item) => `- ${completePhrase(item, 120)}`)
    .slice(0, 3);
}

function splitOpenLoopItems(value: string): string[] {
  return value
    .split(/；|;|、(?=`?LEO-|未来|飞书|Feishu|Weekly)/)
    .map((item) => item.replace(/^和/, '').trim())
    .filter((item) => item.length >= 6);
}

function removeEvidenceTail(value: string): string {
  return value
    .split(/(?:因为|完成标准|今天完成标准|；今天|，今天)/)[0]
    .split(/(?:证据来自|证据为|依据[:：]?|来源[:：]?)/i)[0]
    .split(/[。；;，,]\s*(?:Feishu IM|Linear\s|local files|Chrome snapshot|GitHub\s|Vault\s)/i)[0]
    .split(/(?:。|；|;)\s*(?:证据|依据|来源|Linear|Feishu|Vault|GitHub|Chrome)/i)[0]
    .split(/(?:，|,)\s*(?:证据|依据|来源|Linear|Feishu|Vault|GitHub|Chrome|但|不过)/i)[0]
    .trim();
}

function completePhrase(value: string, max: number): string {
  const clean = value
    .replace(/^(MIT|P[0-3]|优先级[:：]?)\s*/i, '')
    .replace(/^(确认的|暂缓的|新增的|未闭环)[:：\s]*/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[「“"']+|[」”"']+$/g, '');
  if (clean.length <= max) return clean;
  const explicitTask = clean.match(/(?:(?:LEO|CUTTO|POLY|MOOSE|SWAT)-\d+|PR\s*#?\d+|#\d+)[\w-]*\s*[^，。；;]{0,48}/i)?.[0]?.trim();
  if (explicitTask && explicitTask.length <= max) return tidyPhrase(explicitTask);
  for (const delimiter of ['。', '；', ';', '，', ',', '：', ':', '（', '(']) {
    const head = clean.split(delimiter)[0]?.trim();
    if (head && head.length >= 6 && head.length <= max) return tidyPhrase(head);
  }
  const soft = clean.slice(0, max);
  const boundary = soft.match(/^(.+?)(?:\s+(?:和|与|及|以及|还有)\s*)[^和与及还有]*$/u)?.[1];
  const phrase = tidyPhrase((boundary || soft).replace(/[，,、：:｜|/\\\s-]+$/u, '').trim());
  return phrase && phrase.length < clean.length ? `${phrase}…` : phrase;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function tidyPhrase(value: string): string {
  return value.replace(/^[「“"']+|[」”"']+$/g, '').trim();
}

function actionHint(workflow: WorkflowName): string {
  if (workflow === 'daily_plan') {
    return '如果这张安排不对，点「我要调整」，或直接回复：daily-os 修改今日安排：……';
  }
  if (workflow === 'daily_review') {
    return '如果复盘有漏记，直接回复：daily-os 修改今日复盘：……';
  }
  return '如果本周结论或下周带走项要改，直接回复：daily-os 修改周计划：……';
}

function closingLine(workflow: WorkflowName): string {
  if (workflow === 'daily_plan') return '您看这样排可以吗？今天还有没有额外紧急事项需要加入？';
  if (workflow === 'daily_review') return '您确认一下，哪些可以记为今天完成？';
  return '您确认一下：本周结论和下周带走项对吗？';
}

function splitSections(content: string): Array<{ heading: string; body: string }> {
  const lines = content.split('\n');
  const sections: Array<{ heading: string; body: string[] }> = [];
  let current: { heading: string; body: string[] } = { heading: '开头', body: [] };
  for (const line of lines) {
    const heading = line.match(/^(?:#{1,4}\s*)?(?:\d+[.)、]\s*)?(.{2,48})$/);
    const trimmed = stripMarkdown(line).trim();
    if (heading && looksLikeHeading(trimmed)) {
      if (current.body.length > 0) sections.push(current);
      current = { heading: trimmed, body: [] };
    } else {
      current.body.push(line);
    }
  }
  if (current.body.length > 0) sections.push(current);
  return sections.map((section) => ({ heading: section.heading, body: section.body.join('\n') }));
}

function looksLikeHeading(line: string): boolean {
  const normalized = line.replace(/^\d+[.)、]\s*/, '').trim();
  return /^(今日重点|为什么|Codex|用户|暂不|阻塞|重要信号|已完成|已推进|没完成|未闭环|需要您|明天|缺失|本周|下周|OKR|优先级|MIT)/.test(
    normalized,
  );
}

function extractBullets(text: string): string[] {
  const focusRows = text
    .split('\n')
    .map((line) => stripMarkdown(line).trim())
    .filter((line) => /^(?:MIT|辅助重点\s*\d*)[:：]/.test(line))
    .map((line) => completePhrase(line, 220));
  if (focusRows.length > 0) return focusRows;

  const bullets = text
    .split('\n')
    .map((line) => stripMarkdown(line).trim())
    .filter((line) => /^[-*]\s+|^\d+[.)、]\s+/.test(line))
    .map((line) => line.replace(/^[-*]\s+|^\d+[.)、]\s+/, '').trim())
    .filter((line) => line.length >= 8)
    .map((line) => completePhrase(line, 160));
  if (bullets.length > 0) return bullets;
  return text
    .split(/[。！？]\s*/)
    .map((line) => stripMarkdown(line).trim())
    .filter((line) => line.length >= 12)
    .slice(0, 2)
    .map((line) => completePhrase(line, 160));
}

function sentencePreview(content: string, max: number): string {
  const stripped = stripMarkdown(content)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ');
  const firstSentence = stripped.match(/^.{20,}?[。！？.!?]/)?.[0] || stripped;
  return completePhrase(firstSentence, max);
}

function normalize(content: string): string {
  return content.replace(/\r\n/g, '\n').trim();
}

function stripMarkdown(value: string): string {
  return value
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/^#+\s*/, '')
    .trim();
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function normalizedTextKey(value: string): string {
  return stripMarkdown(value).replace(/\s+/g, '').toLowerCase();
}

function overlapsAny(item: string, existing: string[]): boolean {
  const key = normalizedTextKey(compactItem(item));
  if (!key) return false;
  return existing.some((candidate) => {
    const other = normalizedTextKey(compactItem(candidate));
    if (!other) return false;
    if (key.includes(other.slice(0, 8)) || other.includes(key.slice(0, 8))) return true;
    return sharedChineseTokens(key, other);
  });
}

function sharedChineseTokens(left: string, right: string): boolean {
  const tokens = left.match(/[\u4e00-\u9fa5]{4,}/g) || [];
  return tokens.some((token) => {
    for (let index = 0; index <= token.length - 4; index += 1) {
      if (right.includes(token.slice(index, index + 4))) return true;
    }
    return false;
  });
}

function workflowLabel(workflow: WorkflowName): string {
  if (workflow === 'daily_plan') return '今日计划';
  if (workflow === 'daily_review') return '日复盘';
  return '周复盘';
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function trimSummary(value: string, max: number): string {
  if (value.length <= max) return value;
  const lines = value.split('\n');
  const kept: string[] = [];
  let length = 0;
  for (const line of lines) {
    if (length + line.length + 1 > max - 24) break;
    kept.push(line);
    length += line.length + 1;
  }
  return [...kept, '', '更多内容请点「看详情」。'].join('\n').trim();
}
