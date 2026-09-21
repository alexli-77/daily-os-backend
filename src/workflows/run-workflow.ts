import type { AppConfig, WorkflowName } from '../config/schema.js';
import { runAgent } from '../agent/index.js';
import { collectEvidence } from './evidence.js';
import { todayInTimezone } from '../utils/date.js';
import { appendDailyMemory, loadMemory, readDailyPlanOutput, writeLatestWorkflowOutput, writeWorkflowDetailCache } from '../storage/memory.js';
import { sendFeishuCard, sendFeishuMessage } from '../connectors/lark-cli.js';
import { collectSyncDrift, filterUndecidedFindings, renderSyncDriftCard } from '../progress/sync-drift.js';
import { buildDailyPlanTable, buildWorkflowEvidenceTrace, extractDailyPlanTodos, formatWorkflowSummaryForFeishu, parseDailyPlanTodoPlan } from './summary.js';
import { buildScoredTodos } from '../todo/scorer.js';
import { listTodoFeedback, recordTodoPresented } from '../todo/feedback.js';
import {
  markWorkflowRunFailed,
  markWorkflowRunGenerated,
  markWorkflowRunSucceeded,
  startWorkflowRun,
  type WorkflowRunRecord,
  type WorkflowRunTrigger,
} from './run-ledger.js';
import { runManager } from '../service/run-manager.js';

export interface WorkflowRunResult {
  text: string;
  date: string;
  detailId: string;
  run: WorkflowRunRecord;
}

export async function runWorkflow(
  config: AppConfig,
  workflow: WorkflowName,
  options: { send?: boolean; trigger?: WorkflowRunTrigger; source?: string } = {},
): Promise<string> {
  return (await runWorkflowDetailed(config, workflow, options)).text;
}

export async function runWorkflowDetailed(
  config: AppConfig,
  workflow: WorkflowName,
  options: { send?: boolean; trigger?: WorkflowRunTrigger; source?: string } = {},
): Promise<WorkflowRunResult> {
  const date = todayInTimezone(config);
  const sendRequested = options.send ?? true;
  const sendEnabled = sendRequested && config.output.feishu.enabled;
  let run = startWorkflowRun(config, {
    workflow,
    date,
    trigger: options.trigger,
    source: options.source,
    sendEnabled,
    provider: config.output.feishu.provider,
    mode: config.output.feishu.send_mode,
  });
  // Minimal RunManager wiring: register this run so the console /runs page can
  // show it as in-flight and operators can request a cancel. The workflow runs
  // in-process (no killable child pid), so cancellation writes the ledger back
  // to failed via onCancel rather than signalling the server's own process.
  let cancelled = false;
  runManager.register(run.id, {}, {
    workflow,
    onCancel: () => {
      cancelled = true;
      run = markWorkflowRunFailed(config, run, 'Cancelled by operator from console.');
    },
  });
  try {
    const evidence = await collectEvidence(config, date);
    if (workflow === 'daily_plan') {
      // LEO-209: programmatically score the four todo sources and hand the LLM a
      // ranked top-N (with breakdown) instead of an unscored blob.
      evidence.sources.todo_scored = { state: 'available', data: buildScoredTodos(config, evidence, date) };
    }
    if (workflow === 'daily_review') {
      // LEO-232: reconcile the review against the morning todo. Inject (1) today's
      // daily_plan todos (candidateId/text/rank) and (2) today's todo-feedback
      // (which items the user already ticked done / deferred), so the LLM can go
      // line by line instead of writing a fresh long-form review. When no plan ran
      // today, both are marked so the summary degrades to the legacy render.
      const planTodos = loadTodayPlanTodos(config, date);
      // `partial` belongs here for the same reason the other two do: it is a
      // statement the user made about today's plan. Leaving it out of the
      // evidence would make a row the user explicitly marked "worked on it,
      // not done" arrive at the review looking untouched — the reconciliation
      // would then have to guess at exactly the fact it was just told.
      const feedbackToday = listTodoFeedback(config).filter(
        (entry) =>
          entry.date === date &&
          (entry.event === 'complete' || entry.event === 'partial' || entry.event === 'defer'),
      );
      evidence.sources.daily_plan_todos = planTodos
        ? { state: 'available', data: { date, todos: planTodos } }
        : { state: 'missing', detail: '今天没有运行今日安排（daily_plan），无法逐条对账。' };
      evidence.sources.todo_feedback = {
        state: feedbackToday.length > 0 ? 'available' : 'empty',
        data: { date, entries: feedbackToday },
      };
    }
    const memory = loadMemory(config);
    const text = await runAgentWithNonEmptyOutput({ config, workflow, date, evidence, memory, runId: run.id });
    const evidenceTrace = buildWorkflowEvidenceTrace({ evidence, memory });

    appendDailyMemory(config, workflow, date, text);
    writeLatestWorkflowOutput(config, workflow, date, text, evidenceTrace);
    const detail = writeWorkflowDetailCache(config, workflow, date, text, evidenceTrace);
    run = markWorkflowRunGenerated(config, run, { outputChars: text.length, detailId: detail.id });
    if (sendEnabled) {
      try {
        const todos = workflow === 'daily_plan' ? extractDailyPlanTodos(text) : [];
        const planTable = workflow === 'daily_plan' ? buildDailyPlanTable(text, date, evidence, config) : null;
        await sendFeishuMessage(config, formatWorkflowSummaryForFeishu(workflow, date, text, evidence, config), {
          workflow,
          date,
          detailId: detail.id,
          ...(todos.length ? { todos } : {}),
          ...(planTable ? { planTable } : {}),
        });
        if (todos.length) {
          recordTodoPresented(config, date, todos.map((todo) => ({ candidateId: todo.candidateId, rank: todo.rank })));
        }
      } catch (error) {
        run = markWorkflowRunFailed(config, run, error, { sendFailed: true });
        throw error;
      }
      // LEO-120: companion "possible sync drift" card with ignore / mark-handled /
      // draft buttons. Only sent for daily_review when the optional check is on
      // and there are undecided findings. A failure here never fails the run.
      if (workflow === 'daily_review' && config.progress_sync_check.enabled) {
        try {
          const findings = filterUndecidedFindings(collectSyncDrift(evidence, config).findings, date);
          if (findings.length > 0) {
            await sendFeishuCard(config, renderSyncDriftCard(config, date, findings), '有今天的进展可能还没同步到 GitHub / Linear。');
          }
        } catch (error) {
          console.warn(`[workflow] sync-drift companion card skipped: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      run = markWorkflowRunSucceeded(config, run, { status: 'succeeded' });
    } else {
      run = markWorkflowRunSucceeded(config, run, { status: 'skipped' });
    }
    return { text, date, detailId: detail.id, run };
  } catch (error) {
    if (!cancelled) markWorkflowRunFailed(config, run, error);
    throw error;
  } finally {
    runManager.unregister(run.id);
  }
}

/**
 * LEO-232 — recover today's daily_plan todos (with candidateId/text/rank) from
 * the persisted workflow output. Returns null when that date ran no daily_plan
 * or its output is not the LEO-209 todo JSON.
 *
 * LEO-309: the lookup is by date through `readDailyPlanOutput`, not "is the
 * latest output a plan?". A rerun of the review — or any workflow the user
 * triggered between the two — would otherwise have moved the pointer off the
 * plan, and the review that exists to reconcile against the morning list would
 * report there was no list to reconcile against.
 */
function loadTodayPlanTodos(config: AppConfig, date: string): Array<{ rank: number; text: string; candidateId: string }> | null {
  const latest = readDailyPlanOutput(config, date);
  if (!latest) return null;
  const plan = parseDailyPlanTodoPlan(latest.content);
  return plan && plan.todos.length > 0 ? plan.todos : null;
}

async function runAgentWithNonEmptyOutput(input: Parameters<typeof runAgent>[0]): Promise<string> {
  const attempts = 2;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const text = (await runAgent(input)).trim();
    if (text.length > 0) return text;
    console.warn(`[workflow] ${input.workflow} returned empty output on attempt ${attempt}/${attempts}.`);
  }
  throw new Error(`${input.workflow} generated empty output after ${attempts} attempts; refusing to save or send an empty workflow card.`);
}
