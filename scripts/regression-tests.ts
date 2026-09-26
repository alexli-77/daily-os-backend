import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Point every test server's runtime file somewhere disposable, before anything
// that could start one is imported.
//
// Nine suites in here boot a real HTTP server. Each wrote its address and token
// to `./data/runtime/ui.json` resolved against the cwd at write time — which,
// for any write landing after a suite restores the cwd, is this repo. That
// overwrote the *live* service's runtime file with a throwaway server's
// ephemeral port, and the Mac app, which reads exactly that file to find the
// service, then dialled a dead port and reported the service down.
//
// Running the test suite must not be able to disconnect the app. Set here
// rather than in each suite so a tenth one cannot forget.
process.env.DAILY_OS_UI_RUNTIME_PATH ||= path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'daily-os-test-runtime-')),
  'ui.json',
);
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config/load-config.js';
import { coalesceChatSuggestions } from '../src/chat/context-analysis.js';
import type { ChatContextSuggestion } from '../src/chat/context-analysis.js';
import { parseDailyOsCommand, runParsedDailyOsCommand } from '../src/interaction/daily-os-command.js';
import { handlePendingBackgroundSuggestionReply } from '../src/service/background-suggestions.js';
import { renderFeishuCalendarDraftCard, renderFeishuPlanTableCard, renderFeishuSkillCard, renderFeishuSkillWritebackPreviewCard, renderFeishuWorkflowCard } from '../src/connectors/feishu-sdk.js';
import { handleFeishuFeedbackCommand, shouldTreatAsFeedbackWorkflowRevision } from '../src/feedback/feishu-feedback.js';
import { acquireSchedulerLock, releaseSchedulerLock, shouldRunScheduledWorkflow } from '../src/service/launchd.js';
import { formatRecentWorkflowRuns, listRecentWorkflowRuns } from '../src/workflows/run-ledger.js';
import { runWorkflow } from '../src/workflows/run-workflow.js';
import { feishuDocsSource } from '../src/workflows/evidence.js';
import { buildDailyPlanTable, buildWorkflowEvidenceTrace, formatLatestWorkflowDetails, formatWorkflowSummaryForFeishu } from '../src/workflows/summary.js';
import { extractWeeklyPrioritiesFromFeishuDocs, extractWeeklyPrioritiesFromXml } from '../src/workflows/weekly-priorities.js';
import { createPolicyCandidate, listPolicyCandidates } from '../src/decision/candidates.js';
import { decisionPolicyFiles } from '../src/decision/policy.js';
import { collectFeishuUserMessageRecords, isFeishuAppMessageRecord } from '../src/utils/feishu-message-records.js';
import { buildCliPrompt, normalizeAgentOutput } from '../src/agent/openai-agent.js';
import { detectTableLayout, extractWeeklyWritebackItems, targetWeekLabelForDate } from '../src/skills/weekly-review-writeback.js';
import { executeLifeReviewOsWriteback, prepareLifeReviewOsWriteback, runLifeReviewOsSkill } from '../src/skills/life-review-os.js';
import { formatWorkflowRevisionMemoryNote, parseWorkflowRevisionItems } from '../src/interaction/workflow-revision.js';
import { handleTodoInboxCommand, openTodoInboxItems, parseTodoInboxCommand, updateTodoInboxItemById } from '../src/todo/inbox.js';
import { buildCalendarDraftInput, testCalendarBridge } from '../src/calendar/bridge.js';
import { isSelfOriginMessage, SelfSentMessageCache, type SelfOriginContext } from '../src/interaction/self-origin.js';
import type { NormalizedMessage } from '@larksuiteoapi/node-sdk';
import { startUiServer } from '../src/ui/server.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-os-regression-'));
// Keep the SQLite account/artifact store (LEO-212) in the temp dir so the inline
// UI-server test never opens — or migrates — the real data/runtime store.
process.env.DAILY_OS_DB_PATH = path.join(tmp, 'daily-os.db');

try {
  testFeishuUserMessageFiltering();
  testSelfOriginMessageSkipsSelfAndProcessesUsers();
  testSelfOriginMessageDualIdentityCacheFallback();
  testSelfOriginMessageDegradesWhenIdentityUnavailable();
  testChatSuggestionCoalescing();
  testUnifiedProviderPromptContract();
  testAgentOutputNormalization();
  testDailyOsCommandParsing();
  testCalendarDraftInputUsesWeeklyAndTodoSources();
  await testCalendarBridgeReportsMissingEngine();
  await testCalendarBridgeUsesBuiltinDraftEngine();
  await testSkillRunCommandUsesConfiguredRunner();
  testEveryFeishuInteractionWorkflowCommandHasCardSender();
  testEveryFeishuInteractionCommandHasSkillCardSender();
  await testWorkflowCommandUsesCardCallback();
  await testSkillRunCommandUsesCardCallback();
  await testWeeklyWorkflowCommandPassesEvidenceToCardSummary();
  await testFeedbackPollWorkflowCommandUsesCardSender();
  testFeedbackRevisionIgnoresDailyOsCommands();
  await testWorkflowRevisionStoresStructuredSupplementItems();
  testTodoInboxCommandsAndVaultNote();
  testDailyPlanSummaryShowsOpenLoopEvidence();
  testDailyPlanSummaryKeepsReadableRowsAndUrgentQuestion();
  testDailyPlanSummaryKeepsGithubTaskTitles();
  testDailyPlanSummaryStyle2RemovesGroupsAndMarksAi();
  testFeishuPlanUsesLinearEvidenceUrlWithoutWorkspaceConfig();
  testWorkflowSummaryQuotesLinearMetadata();
  testWorkflowDetailsShowEvidenceTrace();
  testSchedulerSkipsDailyReviewOnWeeklyReviewDay();
  testSchedulerReclaimsStaleLock();
  // Requires a logged-in local Claude/Codex CLI; skipped in CI/sandbox via env flag.
  if (!process.env.DAILY_OS_SKIP_AGENT_TESTS) {
    await testWorkflowRunLedgerRecordsSendFailure();
  } else {
    console.log('  (skipped testWorkflowRunLedgerRecordsSendFailure: DAILY_OS_SKIP_AGENT_TESTS set)');
  }
  testWeeklyReviewSummaryPrioritizesReviewEvidence();
  testWeeklyReviewSummaryShowsStructuredPriorityItems();
  testWeeklyPrioritiesExtractPortfolioReviewItem();
  testWeeklyPrioritiesUseProfileDocsSource();
  testWeeklyPrioritiesResolveBiweeklyColumnHeader();
  testWeeklyPrioritiesResolveYearWrappingLabel();
  await testConfirmLatestPolicyCandidateWithoutId();
  testBackgroundSuggestionDismissAllFromAmbiguousDismiss();
  testWorkflowCardRendering();
  testCalendarDraftCardRendering();
  testSkillCardRendering();
  testSkillWritebackPreviewCardRendering();
  testWeeklyReviewWritebackParsing();
  await testLifeReviewOsBridgeUsesExternalCli();
  await testUiServerEnforcesAuthTokenAndOrigin();
  // Integrated MVP suites (LEO-207/208/209/210) + LEO-211 adversarial suite.
  // Each is a standalone tsx runner; run as an isolated subprocess so their
  // process.chdir / global.fetch / server side effects never leak into the
  // in-process regression tests above. A non-zero exit fails the whole run.
  runIntegratedSuites([
    'scripts/tests/billing.test.ts',
    'scripts/tests/okr.test.ts',
    'scripts/tests/todo-scorer.test.ts',
    'scripts/tests/todo-inbox-history.test.ts',
    // 记下 capture must not silently drop a todo that starts with a command word
    // (完成/删除/…): honour the command only when its target names an open todo.
    'scripts/tests/todo-capture.test.ts',
    // Console model picker, driven against a DOM stub. A datalist-backed
    // version type-checked, rendered and parsed cleanly, yet never opened a
    // menu — only exercising the shipped script catches that class of defect.
    'scripts/tests/console-model-picker.test.ts',
    'scripts/tests/daily-review-reconcile.test.ts',
    'scripts/tests/platform-ui.test.ts',
    'scripts/tests/adversarial.test.ts',
    // LEO-109 / LEO-212 / LEO-120 feature suites (incl. adversarial cases).
    'scripts/tests/okr-writeback-flow.test.ts',
    'scripts/tests/scheduler-port.test.ts',
    'scripts/tests/sync-drift.test.ts',
    'scripts/tests/sqlite-store.test.ts',
    // LEO-235 first-customer delivery: onboarding wizard pure logic.
    'scripts/tests/setup-wizard.test.ts',
    // LEO-205 OKR editor: free-form -> loader-format normalizer.
    'scripts/tests/okr-normalize.test.ts',
    // LEO-247 channel-neutral write-back commands (preview / confirm).
    'scripts/tests/writeback-command.test.ts',
    // LEO-248 write-back guardrails: evidence back-check + big-jump gating.
    'scripts/tests/okr-writeback-guardrails.test.ts',
    // Web-chat bare keywords / aliases incl. trailing text (regressed once).
    'scripts/tests/keyword-commands.test.ts',
    // LEO-266 calendar write-back: idempotency (by-day), move, undo, dry-run, tz.
    'scripts/tests/calendar-writeback.test.ts',
    // LEO-268 calendar adjust feed-back loop: parse + apply (move/drop/resize).
    'scripts/tests/calendar-adjust.test.ts',
    // Linear description/comments reach the planner; snapshot columns unchanged.
    'scripts/tests/linear-notes.test.ts',
    // Console-editable review strategy: allowlist, cross-repo write, fallback.
    'scripts/tests/review-strategy.test.ts',
    // A SIGTERMed child must report the timeout, not two empty streams.
    'scripts/tests/command-timeout.test.ts',
    // Retro review reaches Feishu, and its failure never fails the write-back.
    'scripts/tests/retro-review-writeback.test.ts',
    // Priorities and retro review are confirmed separately, on both channels.
    'scripts/tests/split-confirm.test.ts',
    // LEO-276 cycle files: round-trip fidelity, per-section ownership, atomicity.
    'scripts/tests/cycle-file.test.ts',
    // LEO-277 Cycles console page: listing, per-section save, write guardrails.
    'scripts/tests/cycles-page.test.ts',
    // LEO-286 Cycles as its own platform page: routing + nav, the console no
    // longer carrying it, and the shipped script's cards, ordering, drafts and
    // zoom dialog driven against a DOM stub.
    'scripts/tests/cycles-standalone-page.test.ts',
    // Creating the next cycle from a client: the 沿用上一期 dates, and a created
    // file the planner can still write into.
    'scripts/tests/cycle-create.test.ts',
    // Dragging today's plan into your own order: the ledger overlay, and what
    // happens when the plan changes underneath a recorded order.
    'scripts/tests/plan-order.test.ts',
    // Shipped templates and prompts found from a working directory that is not
    // the checkout — the split the bundled Mac app introduced.
    'scripts/tests/install-root.test.ts',
    // LEO-280 history migration: run selection, both table layouts, idempotency.
    'scripts/tests/cycle-migration.test.ts',
    // LEO-278 run -> cycle files: 要务 to the planned cycle, review to the
    // reviewed one, user edits never clobbered, and the retro scaffold.
    'scripts/tests/cycle-writeback.test.ts',
    // LEO-279 cycle files -> next run: the hand-written retro reaches the
    // planner, inside the 20k of the input pack life-review-os actually reads.
    'scripts/tests/cycle-retro-context.test.ts',
    'scripts/tests/plan-candidate-pool.test.ts',
    'scripts/tests/day-history.test.ts',
    // cycle_context: local 20_CYCLES + 10_OKR replace life-review-os reading the
    // Feishu weekly table — 要务 markdown parses back to per-OKR rows, and the
    // previous/target cycle are assembled from local files (null → Feishu fallback).
    'scripts/tests/cycle-context.test.ts',
    // Updating the weekly-review skill from the console: fast-forward only, and
    // refused on a dirty tree or a diverged branch.
    'scripts/tests/skill-update.test.ts',
    // LEO-287 installing the skill (git clone) from the console: git-missing,
    // non-empty target, clone failure, and the config.yaml seed + registration.
    'scripts/tests/skill-install.test.ts',
    'scripts/tests/life-review-os-config.test.ts',
    // Startup self-provisioning policy: clone when missing, fast-forward a clean
    // default-branch checkout, and never touch a developer's feature branch / dirty tree.
    'scripts/tests/skill-auto-provision.test.ts',
    // Sign-up, the signed-out welcome page, and the topbar identity. The public
    // root must stay free of the owner's data now that it is reachable.
    'scripts/tests/auth-register.test.ts',
    // Read/edit modes on /cycles, and the AI review entry point. The property
    // that matters is that no input line is ever dropped by the renderer.
    'scripts/tests/cycle-read-mode.test.ts',
    // Standalone /okr page: two columns, every empty/malformed state, and the
    // Config-side OKR / strategy / decision-policy editors it was split from.
    'scripts/tests/okr-page.test.ts',
    // LEO-282/283 Supabase auth + team: offline-first degradation, token refresh,
    // invite-code rejection, no team hopping, role gate.
    'scripts/tests/team-auth.test.ts',
    // LEO-284/285 cycle sync + read-only teammate view: degradation when the
    // remote is unreachable, the cheap poll, cache layout, and the two layers
    // that keep a teammate's cycle out of the local vault.
    'scripts/tests/team-sync.test.ts',
    // daily-os-macos #3: doctor warns when the vault path exists but is the
    // empty template (no 10_OKR/), instead of silently reporting ok.
    'scripts/tests/doctor-vault.test.ts',
    // daily-os #199: a subscription CLI under launchd is refused up front with a
    // clear reminder (no doomed hang); the timeout message names provider/model/
    // prompt; doctor warns on the combo instead of reporting "not logged in".
    // P0 (2026-09-11): the CLI gate must probe the configured CLI, never
    // refuse by provider name — the first version blocked codex, which was
    // the only provider that had ever worked on the reporting machine.
    'scripts/tests/cli-provider-gate.test.ts',
    // Fail fast + retry: a hung CLI attempt (short timeout) is retried up to
    // llm.max_attempts, and only a timeout is retried — a real error is not.
    'scripts/tests/agent-retry.test.ts',
    // The prompt has a size budget now: the GitHub projection, the per-workflow
    // drops, and the degradation order that replaced a hard 180s timeout.
    'scripts/tests/evidence-budget.test.ts',
    // The planner knows what day of the week it is. Before this, `# Date` was a
    // bare `2026-09-12` and the scorer had no calendar-week dimension at all, so
    // Saturday got the same seven-item work plan as Tuesday and there was no
    // setting to change that.
    'scripts/tests/rhythm.test.ts',
    // `partial` — "worked on it, not finished". The four filters that each
    // enumerate events by name and would otherwise drop it silently, plus the
    // carry-over guard that used to be open-only.
    'scripts/tests/partial-progress.test.ts',
  ]);
  console.log('Regression tests passed.');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

function runIntegratedSuites(files: string[]): void {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const tsxBin = path.join(repoRoot, 'node_modules', '.bin', 'tsx');
  // Each integrated suite isolates its own runtime (platform-ui via chdir,
  // sqlite-store via its own DAILY_OS_DB_PATH), so strip this process's DB
  // override rather than leaking it into every child.
  const childEnv = { ...process.env };
  delete childEnv.DAILY_OS_DB_PATH;
  for (const file of files) {
    console.log(`\n--- integrated suite: ${file} ---`);
    const result = spawnSync(tsxBin, [file], {
      cwd: repoRoot,
      stdio: 'inherit',
      env: childEnv,
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `integrated suite failed: ${file} (exit ${result.status})`);
  }
}

function testUnifiedProviderPromptContract(): void {
  const prompt = buildCliPrompt({
    config: testConfig(),
    workflow: 'daily_review',
    date: '2026-06-17',
    evidence: {
      generated_at: '2026-06-17T21:30:00.000Z',
      date: '2026-06-17',
      sources: {},
    },
    memory: {
      repositoryPath: tmp,
      repository: [],
      longTerm: '',
      recentDaily: [],
    },
  });

  assert.match(prompt, /你是 Daily OS Feishu/);
  assert.match(prompt, /Daily OS 输出契约/);
  assert.match(prompt, /provider 只能影响调用方式/);
  assert.match(prompt, /复盘今天/);
  assert.match(prompt, /只返回最终可直接发送到飞书的消息/);
}

function testAgentOutputNormalization(): void {
  const normalized = normalizeAgentOutput(
    [
      '```markdown',
      '老板，我帮您整理了今天的进展。',
      '',
      '---',
      '',
      '**1. 已完成 / 已推进**',
      '- LEO-7 邮件已经进入发送前检查。',
      '',
      '2. 没完成 / 未闭环',
      '- LEO-10 还没有看到完成证据。',
      '```',
    ].join('\n'),
  );

  assert.doesNotMatch(normalized, /```/);
  assert.doesNotMatch(normalized, /^---$/m);
  assert.doesNotMatch(normalized, /\*\*1\./);
  assert.match(normalized, /\*\*已完成 \/ 已推进\*\*/);
  assert.match(normalized, /^没完成 \/ 未闭环$/m);
}

function testFeishuUserMessageFiltering(): void {
  const appMessage = {
    message_id: 'app-1',
    content: '<card title="Daily OS"># 后台工作建议\n请确认</card>',
    create_time: '2026-06-14 10:00',
    sender: { sender_type: 'app' },
  };
  const userMessage = {
    message_id: 'user-1',
    content: 'LEO-7 邮件已经完成，待周一发布',
    create_time: '2026-06-14 10:01',
    sender: { sender_type: 'user' },
  };

  assert.equal(isFeishuAppMessageRecord(appMessage), true);
  assert.equal(isFeishuAppMessageRecord(userMessage), false);

  const records = collectFeishuUserMessageRecords({ data: { items: [appMessage, userMessage] } });
  assert.equal(records.length, 1);
  assert.equal(records[0]?.id, 'user-1');
  assert.equal(records[0]?.text, 'LEO-7 邮件已经完成，待周一发布');
  assert.ok(records[0]?.createdAt instanceof Date);
}

function selfOriginTestMessage(overrides: Partial<NormalizedMessage>): NormalizedMessage {
  return {
    messageId: 'om_default',
    chatId: 'oc_chat',
    chatType: 'group',
    senderId: 'ou_owner',
    senderName: 'Owner',
    content: '',
    rawContentType: 'text',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: Date.now(),
    ...overrides,
  };
}

function testSelfOriginMessageSkipsSelfAndProcessesUsers(): void {
  const botOpenId = 'ou_bot_self';
  const ctx: SelfOriginContext = {
    botOpenIds: new Set([botOpenId]),
    selfSentMessageIds: { has: () => false },
    identityAvailable: true,
  };

  // senderId === bot self → treated as self-origin and skipped, even though its
  // content looks like an ordinary user message.
  const selfMessage = selfOriginTestMessage({ messageId: 'om_self', senderId: botOpenId, content: 'LEO-7 邮件已经完成' });
  assert.equal(isSelfOriginMessage(selfMessage, ctx), true);

  // senderId === real user → processed normally, even when the content happens to
  // look like generated Daily OS copy (identity beats the legacy prefix regex).
  const userMessage = selfOriginTestMessage({ messageId: 'om_user', senderId: 'ou_owner', content: '老板，我帮您整理了今天的安排。' });
  assert.equal(isSelfOriginMessage(userMessage, ctx), false);
}

function testSelfOriginMessageDualIdentityCacheFallback(): void {
  // lark-cli `--as user` path: the echo comes back with the human owner's
  // open_id (not the bot), so identity alone cannot flag it. The short-TTL
  // self-sent message_id cache is the minimal fallback that catches it.
  const cache = new SelfSentMessageCache();
  cache.record('om_echo');
  const ctx: SelfOriginContext = {
    botOpenIds: new Set(['ou_bot_self']),
    selfSentMessageIds: cache,
    identityAvailable: true,
  };
  const echo = selfOriginTestMessage({ messageId: 'om_echo', senderId: 'ou_owner', content: '任意出站文案' });
  assert.equal(isSelfOriginMessage(echo, ctx), true);

  const freshUserMessage = selfOriginTestMessage({ messageId: 'om_fresh', senderId: 'ou_owner', content: '任意出站文案' });
  assert.equal(isSelfOriginMessage(freshUserMessage, ctx), false);
}

function testSelfOriginMessageDegradesWhenIdentityUnavailable(): void {
  // When the bot identity could not be resolved, fall back to the legacy
  // outbound-copy prefix heuristics.
  const ctx: SelfOriginContext = {
    botOpenIds: new Set<string>(),
    selfSentMessageIds: { has: () => false },
    identityAvailable: false,
  };
  const generated = selfOriginTestMessage({ messageId: 'om_gen', content: '老板，我帮您整理了今天的安排。' });
  assert.equal(isSelfOriginMessage(generated, ctx), true);

  const genuine = selfOriginTestMessage({ messageId: 'om_real', content: '帮我把 LEO-12 降级，明天再跟进' });
  assert.equal(isSelfOriginMessage(genuine, ctx), false);
}

function testChatSuggestionCoalescing(): void {
  const suggestions: ChatContextSuggestion[] = [
    {
      id: 'weekly-1',
      kind: 'new_task',
      title: '今天是周日，需要对本周的 weekly 进行复盘。',
      summary: '建议新增为待办。',
      targets: ['todo', 'memory'],
      confidence: 'medium',
      due: '今天',
      evidence: '今天是周日，需要对本周的 weekly 进行复盘。',
      why: '聊天里出现待办、请求或下一步信号。',
    },
    {
      id: 'weekly-2',
      kind: 'document_update',
      title: '根据 feishu weekly 文档里的本周要务核对任务进度。',
      summary: '建议检查是否需要更新飞书文档。',
      targets: ['document', 'linear', 'memory'],
      confidence: 'medium',
      due: '今天',
      evidence: '你要根据我的 feishu weekly 文档里的本周要务，对今天的任务做安排。',
      why: '聊天里出现文档、方案或记录更新信号。',
    },
    {
      id: 'leo-7',
      kind: 'completion',
      title: 'LEO-7 邮件已经完成，待周一发布',
      summary: '建议确认是否标记完成。',
      targets: ['daily_plan', 'review'],
      confidence: 'high',
      due: '周一',
      evidence: 'LEO-7 邮件已经完成，待周一发布',
      why: '聊天里出现完成、合并、发布或搞定信号。',
    },
  ];

  const coalesced = coalesceChatSuggestions(suggestions);
  assert.equal(coalesced.length, 2);
  const weekly = coalesced.find((suggestion) => suggestion.id === 'weekly-2' || suggestion.id === 'weekly-1');
  assert.ok(weekly);
  assert.deepEqual(new Set(weekly.targets), new Set(['todo', 'document', 'linear', 'memory']));
}

function testEveryFeishuInteractionWorkflowCommandHasCardSender(): void {
  const source = fs.readFileSync(path.resolve('src/interaction/feishu-interaction.ts'), 'utf8');
  const commandHandlerCount = source.match(/handleDailyOsCommand\(\{/g)?.length || 0;
  const workflowCardSenderCount = source.match(/sendWorkflowCard:/g)?.length || 0;
  assert.ok(commandHandlerCount >= 3, 'expected Feishu interaction command handlers to be discoverable');
  assert.equal(workflowCardSenderCount, commandHandlerCount, 'every Feishu command handler must pass sendWorkflowCard');
}

function testEveryFeishuInteractionCommandHasSkillCardSender(): void {
  const source = fs.readFileSync(path.resolve('src/interaction/feishu-interaction.ts'), 'utf8');
  const commandHandlerCount = source.match(/handleDailyOsCommand\(\{/g)?.length || 0;
  const skillCardSenderCount = source.match(/sendSkillCard:/g)?.length || 0;
  assert.ok(commandHandlerCount >= 3, 'expected Feishu interaction command handlers to be discoverable');
  assert.equal(skillCardSenderCount, commandHandlerCount, 'every Feishu command handler must pass sendSkillCard');
}

function testDailyOsCommandParsing(): void {
  assert.deepEqual(parseDailyOsCommand('daily-os plan', 'daily-os'), { type: 'workflow', workflow: 'daily_plan' });
  assert.deepEqual(parseDailyOsCommand('daily-os review', 'daily-os'), { type: 'workflow', workflow: 'daily_review' });
  assert.deepEqual(parseDailyOsCommand('daily-os weekly', 'daily-os'), { type: 'workflow', workflow: 'weekly_review' });
  assert.deepEqual(parseDailyOsCommand('daily-os skill list', 'daily-os'), { type: 'skill_list' });
  assert.deepEqual(parseDailyOsCommand('daily-os skill run weekly-review: 本周卡在 portfolio review', 'daily-os'), {
    type: 'skill_run',
    skillId: 'weekly-review',
    text: '本周卡在 portfolio review',
  });
  assert.deepEqual(parseDailyOsCommand('daily-os weekly deep', 'daily-os'), { type: 'skill_run', skillId: 'weekly-review', mode: 'weekly' });
  assert.deepEqual(parseDailyOsCommand('daily-os calendar week', 'daily-os'), { type: 'calendar_draft', period: 'week' });
  assert.deepEqual(parseDailyOsCommand('daily-os calendar today', 'daily-os'), { type: 'calendar_draft', period: 'today' });
  const todoCommand = parseDailyOsCommand('daily-os 记到 todo：线上报销诊所医疗费用', 'daily-os');
  assert.equal(todoCommand.type, 'todo_inbox');
  assert.deepEqual(parseDailyOsCommand('daily-os 保存规则', 'daily-os'), { type: 'confirm_policy_candidate' });
  assert.deepEqual(parseDailyOsCommand('daily-os 确认保存', 'daily-os'), { type: 'confirm_policy_candidate' });
  assert.deepEqual(parseDailyOsCommand('daily-os 确认保存：daily-os 保存规则 pol-20260605202553-801f4cf6', 'daily-os'), {
    type: 'confirm_policy_candidate',
    id: 'pol-20260605202553-801f4cf6',
  });

  const revision = parseDailyOsCommand('daily-os 修改今日安排：把 LEO-12 降级，今天先处理导师邮件', 'daily-os');
  assert.equal(revision.type, 'revision_request');
  if (revision.type === 'revision_request') {
    assert.equal(revision.workflow, 'daily_plan');
    assert.match(revision.text, /LEO-12/);
  }
}

function testCalendarDraftInputUsesWeeklyAndTodoSources(): void {
  const config = testConfig();
  config.todo_inbox.ledger_path = path.join(tmp, 'calendar-todo-inbox.jsonl');
  config.todo_inbox.vault_path = path.join(tmp, 'calendar-vault', 'todo.md');
  handleTodoInboxCommand(config, { type: 'capture', text: '今晚 7:30 省庆活动；线上报销诊所医疗费用' }, { source: 'regression-test' });

  const input = buildCalendarDraftInput(
    config,
    {
      generated_at: '2026-07-02T12:00:00.000Z',
      date: '2026-07-02',
      sources: {
        weekly_priorities: {
          state: 'available',
          data: {
            week: '6.29-7.5',
            items: [{ okr: '工作-技术专家', item: '完成 calendar bridge 草稿卡片' }],
          },
        },
        feishu_calendar: {
          state: 'available',
          data: [{ title: 'Existing meeting', start: '2026-07-02T13:00:00-04:00', end: '2026-07-02T14:00:00-04:00' }],
        },
      },
    },
    'today',
    '2026-07-02',
  );

  assert.equal(input.period, 'day');
  assert.equal(input.constraints.startDate, '2026-07-02');
  assert.ok(input.tasks.some((task) => task.source === 'feishu-weekly' && /calendar bridge/.test(task.title)));
  assert.ok(input.tasks.some((task) => task.source === 'todo-inbox' && /省庆活动/.test(task.title)));
  assert.ok(input.tasks.some((task) => task.source === 'todo-inbox' && /医疗费用/.test(task.title)));
  assert.equal(input.existingEvents[0]?.title, 'Existing meeting');
}

async function testCalendarBridgeReportsMissingEngine(): Promise<void> {
  const config = testConfig();
  config.calendar.engine.mode = 'external';
  config.calendar.engine.workdir = path.join(tmp, 'missing-calendar-planning-os');
  config.calendar.engine.cli_path = 'bin/calendar-planning-os.mjs';
  config.calendar.engine.input_path = path.join(tmp, 'calendar-smoke-input.json');
  const result = await testCalendarBridge(config);
  assert.equal(result.ok, false);
  assert.match(result.message, /workdir not found/);
}

async function testCalendarBridgeUsesBuiltinDraftEngine(): Promise<void> {
  const config = testConfig();
  config.calendar.engine.mode = 'builtin';
  config.calendar.engine.workdir = path.join(tmp, 'missing-calendar-planning-os');
  config.calendar.engine.cli_path = 'bin/calendar-planning-os.mjs';
  config.calendar.engine.input_path = path.join(tmp, 'calendar-builtin-input.json');
  const result = await testCalendarBridge(config);
  assert.equal(result.ok, true);
  assert.equal(result.engine, 'builtin');
  assert.match(result.message, /Built-in calendar draft engine OK/);
  assert.match(result.stdoutPreview || '', /Smoke test deep work block/);
  assert.match(result.stdoutPreview || '', /supported": false/);
}

async function testSkillRunCommandUsesConfiguredRunner(): Promise<void> {
  const config = testConfig();
  config.skills.enabled = true;
  config.skills.registry = [
    {
      id: 'weekly-review',
      provider: 'auto',
      path: '/tmp/weekly-review/SKILL.md',
      workdir: '/tmp/weekly-review',
      default_mode: 'weekly',
      effects: ['read', 'draft', 'feishu_write'],
      require_confirmation_for: ['feishu_write'],
    },
  ];
  const replies: string[] = [];
  await runParsedDailyOsCommand(
    {
      config,
      messageId: 'message-1',
      text: 'daily-os skill run weekly-review: 本周重点是对齐 Weekly',
      source: 'regression-test',
      prefix: 'daily-os',
      reply: async (text) => {
        replies.push(text);
      },
      runSkillForCommand: async (input) => {
        assert.equal(input.skillId, 'weekly-review');
        assert.equal(input.userText, '本周重点是对齐 Weekly');
        return {
          skillId: input.skillId,
          provider: 'codex',
          mode: input.mode || 'weekly',
          inputPackPath: '/tmp/daily-os/weekly-review.md',
          output: '## 本周执行对比\n\n**完成** ✅\n- 已整理 Daily OS input pack',
          draftOnly: true,
        };
      },
    },
    { type: 'skill_run', skillId: 'weekly-review', text: '本周重点是对齐 Weekly' },
  );

  assert.match(replies[0] || '', /Running skill weekly-review/);
  assert.match(replies[1] || '', /Skill: weekly-review/);
  assert.match(replies[1] || '', /Write-back: not performed/);
  assert.match(replies[1] || '', /本周执行对比/);
}

async function testSkillRunCommandUsesCardCallback(): Promise<void> {
  const config = testConfig();
  config.skills.enabled = true;
  const replies: string[] = [];
  const cards: Array<{ result: { skillId: string }; text: string }> = [];
  await runParsedDailyOsCommand(
    {
      config,
      messageId: 'message-1',
      text: 'daily-os weekly deep',
      source: 'regression-test',
      prefix: 'daily-os',
      reply: async (text) => {
        replies.push(text);
      },
      sendSkillCard: async (input) => {
        cards.push(input);
      },
      runSkillForCommand: async (input) => ({
        skillId: input.skillId,
        provider: 'codex',
        mode: input.mode || 'weekly',
        inputPackPath: '/tmp/daily-os/weekly-review.md',
        output: '## 本周执行对比\n\n**完成** ✅\n- 已整理 Daily OS input pack',
        draftOnly: true,
      }),
    },
    { type: 'skill_run', skillId: 'weekly-review', mode: 'weekly' },
  );

  assert.deepEqual(replies, ['Running skill weekly-review (weekly)...']);
  assert.equal(cards.length, 1);
  assert.equal(cards[0]?.result.skillId, 'weekly-review');
  assert.match(cards[0]?.text || '', /Write-back: not performed/);
}

async function testWorkflowCommandUsesCardCallback(): Promise<void> {
  const replies: string[] = [];
  const cards: Array<{ workflow: string; summary: string }> = [];
  await runParsedDailyOsCommand(
    {
      config: testConfig(),
      messageId: 'message-1',
      text: 'daily-os plan',
      source: 'regression-test',
      prefix: 'daily-os',
      sendWorkflowOutput: false,
      reply: async (text) => {
        replies.push(text);
      },
      sendWorkflowCard: async ({ workflow, summary }) => {
        cards.push({ workflow, summary });
      },
      runWorkflowForCommand: async (_config, workflow, options) => {
        assert.equal(workflow, 'daily_plan');
        assert.deepEqual(options, { send: false });
        return '老板，今天先看这几件事。\n\n## 今日重点\n- LEO-7 邮件复核';
      },
    },
    { type: 'workflow', workflow: 'daily_plan' },
  );

  assert.deepEqual(replies, ['Running daily plan...']);
  assert.equal(cards.length, 1);
  assert.equal(cards[0]?.workflow, 'daily_plan');
  assert.match(cards[0]?.summary || '', /LEO-7/);
}

async function testWeeklyWorkflowCommandPassesEvidenceToCardSummary(): Promise<void> {
  const replies: string[] = [];
  const cards: Array<{ workflow: string; summary: string }> = [];
  await runParsedDailyOsCommand(
    {
      config: testConfig(),
      messageId: 'message-1',
      text: 'daily-os weekly',
      source: 'regression-test',
      prefix: 'daily-os',
      sendWorkflowOutput: false,
      reply: async (text) => {
        replies.push(text);
      },
      sendWorkflowCard: async ({ workflow, summary }) => {
        cards.push({ workflow, summary });
      },
      runWorkflowForCommand: async (_config, workflow, options) => {
        assert.equal(workflow, 'weekly_review');
        assert.deepEqual(options, { send: false });
        return [
          '老板，我帮您整理了本周总结和下周安排。',
          '',
          '**1. 本周已经完成 / 已推进**',
          '确认的：`LEO-7 Heng Li 意向邮件` 已推进到发送前审核。',
          '',
          '**2. 本周没做完 / 需要继续盯**',
          '逐条核对 🐶 本周要务：导师联系被 Weekly 标为 `MIT ✅`，但 Linear 仍显示待周一发送。',
        ].join('\n');
      },
      collectEvidenceForSummary: async () => ({
        generated_at: '2026-06-14T00:00:00.000Z',
        date: '2026-06-14',
        sources: {
          weekly_priorities: {
            state: 'available',
            data: {
              week: '6.8-6.14',
              items: [{ scope: '🐶', item: '个人 portfolio：把首版页面发给小企鹅 review，并按反馈改 1 轮（延续上周⭕️）' }],
            },
          },
        },
      }),
    },
    { type: 'workflow', workflow: 'weekly_review' },
  );

  assert.deepEqual(replies, ['Running weekly review...']);
  assert.equal(cards.length, 1);
  assert.equal(cards[0]?.workflow, 'weekly_review');
  assert.match(cards[0]?.summary || '', /个人 portfolio/);
}

async function testFeedbackPollWorkflowCommandUsesCardSender(): Promise<void> {
  const replies: string[] = [];
  const cards: Array<{ workflow: string; summary: string }> = [];
  const config = testConfig();
  await handleFeishuFeedbackCommand(
    config,
    { id: 'message-1', text: 'daily-os plan', raw: { sender: { sender_type: 'user' } } },
    true,
    async ({ workflow, summary }) => {
      cards.push({ workflow, summary });
    },
    async (_config, workflow, options) => {
      assert.equal(workflow, 'daily_plan');
      assert.deepEqual(options, { send: false });
      return '老板，今天先看这几件事。\n\n## 今日重点\n- LEO-7 邮件复核';
    },
    async (text) => {
      replies.push(text);
    },
  );

  assert.deepEqual(replies, ['Running daily plan...']);
  assert.equal(cards.length, 1);
  assert.equal(cards[0]?.workflow, 'daily_plan');
  assert.match(cards[0]?.summary || '', /LEO-7/);
}

function testFeedbackRevisionIgnoresDailyOsCommands(): void {
  const config = testConfig();
  assert.equal(shouldTreatAsFeedbackWorkflowRevision(config, 'daily-os weekly deep'), false);
  assert.equal(shouldTreatAsFeedbackWorkflowRevision(config, 'daily-os skill run weekly-review: 本周重点'), false);
  assert.equal(shouldTreatAsFeedbackWorkflowRevision(config, '/daily-os weekly deep'), false);
  assert.equal(shouldTreatAsFeedbackWorkflowRevision(config, '把 LEO-12 降级，明天再跟进'), true);
}

async function testWorkflowRevisionStoresStructuredSupplementItems(): Promise<void> {
  const text = '帮我补充，1. 今天晚上7:30，有魁北克省省庆活动。室外音乐会。2. 线上报销诊所医疗费用';
  const items = parseWorkflowRevisionItems(text);
  assert.deepEqual(items, [
    { type: 'time_boundary', text: '今天晚上7:30，有魁北克省省庆活动。室外音乐会' },
    { type: 'todo', text: '线上报销诊所医疗费用' },
  ]);

  const note = formatWorkflowRevisionMemoryNote(text);
  assert.match(note, /结构化补充事项/);
  assert.match(note, /\[time_boundary\] 今天晚上7:30，有魁北克省省庆活动。室外音乐会/);
  assert.match(note, /\[todo\] 线上报销诊所医疗费用/);

  const config = testConfig();
  config.memory.daily_dir = path.join(tmp, 'structured-daily');
  const replies: string[] = [];
  await runParsedDailyOsCommand(
    {
      config,
      messageId: 'message-structured-supplement',
      text: `daily-os 修改今日安排：${text}`,
      source: 'regression-test',
      prefix: 'daily-os',
      reply: async (reply) => {
        replies.push(reply);
      },
    },
    { type: 'revision_request', workflow: 'daily_plan', text },
  );

  const dailyFiles = fs.readdirSync(config.memory.daily_dir).filter((name) => name.endsWith('.md'));
  assert.equal(dailyFiles.length, 1);
  const daily = fs.readFileSync(path.join(config.memory.daily_dir, dailyFiles[0] || ''), 'utf8');
  assert.match(daily, /结构化补充事项/);
  assert.match(daily, /\[time_boundary\] 今天晚上7:30，有魁北克省省庆活动。室外音乐会/);
  assert.match(daily, /\[todo\] 线上报销诊所医疗费用/);
  assert.match(replies.join('\n'), /已记录这条修改意见/);
}

function testTodoInboxCommandsAndVaultNote(): void {
  const config = testConfig();
  config.todo_inbox.ledger_path = path.join(tmp, 'todo-inbox.jsonl');
  config.todo_inbox.vault_path = path.join(tmp, 'vault', '99_Meta', 'daily-os-todo.md');

  const parsed = parseTodoInboxCommand('帮我记一下：1. 今晚 7:30 省庆活动。2. 线上报销诊所医疗费用');
  assert.deepEqual(parsed, { type: 'capture', text: '1. 今晚 7:30 省庆活动。2. 线上报销诊所医疗费用' });
  const capture = handleTodoInboxCommand(config, parsed!, { source: 'regression-test', messageId: 'todo-1' });
  assert.equal(capture.items?.length, 2);
  assert.match(capture.reply || '', /已写入 Todo Inbox：2 条/);

  const open = openTodoInboxItems(config);
  assert.equal(open.length, 2);
  assert.equal(open[0]?.type, 'time_boundary');
  assert.equal(open[1]?.type, 'todo');

  const renameById = updateTodoInboxItemById(config, open[1]!.id, { text: '线上报销诊所医疗费用，补充保险入口', type: 'reminder' });
  assert.match(renameById.reply || '', /Todo 已更新/);
  const renamed = openTodoInboxItems(config);
  assert.equal(renamed[1]?.text, '线上报销诊所医疗费用，补充保险入口');
  assert.equal(renamed[1]?.type, 'reminder');

  const vault = fs.readFileSync(config.todo_inbox.vault_path, 'utf8');
  assert.match(vault, /Daily OS Todo Inbox/);
  assert.match(vault, /时间边界：今晚 7:30 省庆活动/);
  assert.match(vault, /提醒：线上报销诊所医疗费用，补充保险入口/);

  const done = parseTodoInboxCommand('完成 todo：线上报销诊所医疗费用，补充保险入口');
  assert.deepEqual(done, { type: 'update', action: 'done', target: '线上报销诊所医疗费用', note: '补充保险入口' });
  const update = handleTodoInboxCommand(config, done!, { source: 'regression-test' });
  assert.match(update.reply || '', /已完成 todo/);
  assert.equal(openTodoInboxItems(config).length, 1);
  assert.match(fs.readFileSync(config.todo_inbox.vault_path, 'utf8'), /- \[x\].*提醒：线上报销诊所医疗费用，补充保险入口/);

  const reminder = parseTodoInboxCommand('提醒我：明天下午 3 点联系导师');
  assert.deepEqual(reminder, { type: 'capture', text: '明天下午 3 点联系导师', itemType: 'reminder' });
}

async function testConfirmLatestPolicyCandidateWithoutId(): Promise<void> {
  const config = testConfig();
  createPolicyCandidate(config, {
    chatId: 'chat-1',
    messageId: 'message-1',
    senderOpenId: 'sender-1',
    rawUserText: '每周日按 weekly 复盘。',
    assistantReply: '已记录候选规则。',
    rule: {
      id: 'sunday-weekly-review',
      description: '每周日必须参考 weekly 文档复盘本周要务。',
      applies_to: ['daily_plan', 'weekly_review'],
    },
  });

  const replies: string[] = [];
  await runParsedDailyOsCommand(
    {
      config,
      messageId: 'message-2',
      text: 'daily-os 保存规则',
      source: 'regression-test',
      prefix: 'daily-os',
      reply: async (text) => {
        replies.push(text);
      },
    },
    { type: 'confirm_policy_candidate' },
  );

  assert.equal(listPolicyCandidates(config, 'pending').length, 0);
  assert.match(replies.join('\n'), /已保存长期决策规则：sunday-weekly-review/);
  assert.match(fs.readFileSync(decisionPolicyFiles(config).policyPath, 'utf8'), /每周日必须参考 weekly 文档复盘本周要务/);
}

function testDailyPlanSummaryShowsOpenLoopEvidence(): void {
  const content = [
    '老板您好，我帮您整理了今天的安排。',
    '',
    '**1. 今日重点**',
    'MIT：',
    '- `Weekly2026 🐶 本周要务复盘` 今天最重要的是核对 6.8-6.14 本周要务还有哪些没有真实闭环，完成标准是四栏表。',
    '',
    '**2. 为什么是这些**',
    '最高校准源是 Feishu Docs `Weekly2026`。',
    '今日需要补进 todo 的未闭环项是：`LEO-7` 邮件还没看到真实发送记录和 follow-up 日期；`未来 4 周唯一主线` 需要周日确认是否最终闭环；飞书文档、方案、会议记录需要检查是否和真实进展一致。',
    '',
    '**4. Codex 可以做**',
    '- `Weekly2026 🐶 对账` Codex 可以整理本周要务核对表，预期产物是四栏表。',
  ].join('\n');
  const summary = formatWorkflowSummaryForFeishu('daily_plan', '2026-06-14', content, undefined, testConfig());
  assert.match(summary, /未闭环依据/);
  assert.match(summary, /LEO-7/);
  assert.match(summary, /未来 4 周唯一主线/);
  assert.match(summary, /飞书文档/);
}

function testDailyPlanSummaryKeepsReadableRowsAndUrgentQuestion(): void {
  const content = [
    '老板您好，我帮您整理了今天的安排。',
    '',
    '**今日重点**',
    '- CUTTO-355「script 滚动及 frame 大小 Verify」今天必须闭环，因为 Linear 显示今天到期，完成标准是您给出通过、修改点或延期原因。',
    '- PR8 / PR42 / open PR 对账表：预期产物是一张按仓库、PR 编号、open/merged、是否可 merge、风险点拆好的检查表。',
    '',
    '**Codex 可以做**',
    '- AI 解释对比材料：预期产物是一版用 Claude Code 解释李传彬分支 demo 和您理解的 demo 的区别。',
  ].join('\n');
  const config = testConfig();
  config.output.feishu.summary_style = 'style1';
  const summary = formatWorkflowSummaryForFeishu('daily_plan', '2026-06-18', content, undefined, config);
  assert.match(summary, /CUTTO-355「script 滚动及 frame 大小 Verify」/);
  assert.match(summary, /PR8 \/ PR42 \/ open PR 对账表/);
  assert.doesNotMatch(summary, /\*\*P1｜Codex\*\*：\s*PR\s*\n/);
  assert.doesNotMatch(summary, /Ver\s*\n/);
  assert.match(summary, /额外紧急事项/);
}

function testDailyPlanSummaryKeepsGithubTaskTitles(): void {
  const content = [
    '老板您好，我帮您整理了今天的安排。',
    '',
    '**今日重点**',
    '- `Heng Li 面试结果复盘` 今天仍然要放第一位，因为 Feishu Weekly 🐶 6.22-6.28 明确标为 MIT。',
    '',
    '**Codex 可以做**',
    '- `GitHub guide 网页修改`：产物是需求确认清单、改动方案和可验收页面版本。',
  ].join('\n');
  const config = testConfig();
  config.output.feishu.summary_style = 'style1';
  const summary = formatWorkflowSummaryForFeishu('daily_plan', '2026-06-26', content, undefined, config);
  assert.match(summary, /GitHub guide 网页修改/);
  assert.doesNotMatch(summary, /需要确认这一项/);
}

function testDailyPlanSummaryStyle2RemovesGroupsAndMarksAi(): void {
  const content = [
    '老板您好，我帮您整理了今天的安排。',
    '',
    '**今日重点**',
    'MIT：CUTTO-355「script 滚动及 frame 大小 Verify」今天必须闭环，因为 Linear 显示今天到期，完成标准是您给出通过、修改点或延期原因。',
    '辅助重点 1：今天进度日会后产出的 copilot 组件库修改，包括去掉 skip、卡片改 fit；完成标准是修改 demo 并更新 PR。',
    '',
    '**Codex 可以做**',
    '- AI 解释对比材料：预期产物是一版用 Claude Code 解释李传彬分支 demo 和您理解的 demo 的区别。',
    '',
    '**暂不处理 / 阻塞**',
    '- CUTTO-357「拉片 Verify」今天不进 MIT，因为它明天到期。',
  ].join('\n');
  const config = testConfig();
  config.output.feishu.summary_style = 'style2';
  const summary = formatWorkflowSummaryForFeishu('daily_plan', '2026-06-18', content, undefined, config);
  assert.doesNotMatch(summary, /确认的|新增的|暂缓的/);
  assert.doesNotMatch(summary, /P[0-2]\s*[｜|]/);
  assert.doesNotMatch(summary, /目标：/);
  assert.match(summary, /copilot 组件库修改.*（AI）/);
  assert.match(summary, /AI 解释对比材料.*（AI）/);
  assert.match(summary, /CUTTO-355「script 滚动及 frame 大小 Verify」/);
  assert.match(summary, /额外紧急事项/);
}

function testFeishuPlanUsesLinearEvidenceUrlWithoutWorkspaceConfig(): void {
  const config = testConfig();
  config.sources.linear.workspace = '';
  const table = buildDailyPlanTable(
    '{"todos":[{"rank":1,"text":"录完官网 Demo","candidateId":"linear:CUTTO-301"}]}',
    '2026-07-31',
    {
      generated_at: '2026-07-31T12:00:00.000Z',
      date: '2026-07-31',
      sources: {
        linear: {
          state: 'available',
          data: {
            items: [{ identifier: 'CUTTO-301', title: '视频制作', url: 'https://linear.app/cutto/issue/CUTTO-301/video-production' }],
          },
        },
      },
    },
    config,
  );

  assert.ok(table);
  assert.match(table.rows[0]?.taskMd || '', /\[CUTTO-301\]\(https:\/\/linear\.app\/cutto\/issue\/CUTTO-301\/video-production\)/);
  assert.match(JSON.stringify(renderFeishuPlanTableCard(table)), /https:\/\/linear\.app\/cutto\/issue\/CUTTO-301/);
}

function testWorkflowSummaryQuotesLinearMetadata(): void {
  const content = [
    '老板您好，我帮您整理了今天的安排。',
    '',
    '**1. 今日重点**',
    '- `LEO-7 Heng Li 意向邮件` 今天先做最终发送审核。',
  ].join('\n');
  const summary = formatWorkflowSummaryForFeishu(
    'daily_plan',
    '2026-06-14',
    content,
    {
      generated_at: '2026-06-14T00:00:00.000Z',
      date: '2026-06-14',
      sources: {
        linear: {
          state: 'available',
          data: {
            items: [
              {
                identifier: 'LEO-7',
                title: '[P0][6/15][Draft ready] Heng Li 意向邮件',
                project: { name: 'Job or PhD?' },
                dueDate: '2026-06-15',
              },
            ],
          },
        },
      },
    },
    testConfig(),
  );
  assert.match(summary, /> Linear：Job or PhD\? · Due 2026-06-15 · P0/);
  assert.doesNotMatch(summary, /\n\s+Linear：Project/);
}

function testWorkflowDetailsShowEvidenceTrace(): void {
  const evidenceTrace = buildWorkflowEvidenceTrace({
    evidence: {
      generated_at: '2026-06-15T10:00:00.000Z',
      date: '2026-06-15',
      sources: {
        weekly_priorities: {
          state: 'available',
          detail: 'Extracted 2 weekly priority items for 6.15-6.21',
          data: {
            week: '6.15-6.21',
            items: [
              {
                source: 'Weekly2026',
                scope: '🐶',
                week: '6.15-6.21',
                okr: 'P0 O1',
                item: '个人 portfolio：把首版页面发给小企鹅 review，并按反馈改 1 轮',
              },
            ],
          },
        },
        linear: {
          state: 'available',
          data: {
            items: [{ identifier: 'LEO-66', title: 'Show Daily OS evidence trace for plan and weekly review cards' }],
          },
        },
        feishu_calendar: { state: 'empty', detail: 'No events today' },
      },
    },
    memory: {
      repositoryPath: '/tmp/daily-os-memory',
      repository: [
        { path: 'decision-policy.yaml', content: 'rules: []' },
        { path: 'decision-policy.md', content: '# 决策规则' },
      ],
      longTerm: '',
      recentDaily: [],
    },
  });

  const details = formatLatestWorkflowDetails({
    workflow: 'weekly_review',
    date: '2026-06-15',
    generated_at: '2026-06-15T10:05:00.000Z',
    content: '完整复盘正文',
    evidence_trace: evidenceTrace,
  });

  assert.match(details, /这次用了这些依据/);
  assert.match(details, /decision-policy\.yaml：已读/);
  assert.match(details, /decision-policy\.md：已读/);
  assert.match(details, /weekly_priorities：available/);
  assert.match(details, /个人 portfolio/);
  assert.match(details, /LEO-66/);
}

function testSchedulerSkipsDailyReviewOnWeeklyReviewDay(): void {
  const config = testConfig();
  config.workflows.weekly_review.enabled = true;
  config.workflows.weekly_review.weekday = 'SUN';
  config.workflows.weekly_review.time = '20:00';
  config.workflows.daily_review.enabled = true;
  config.workflows.daily_review.time = '21:30';
  config.workflows.daily_review.skip_on_weekly_review_day = true;

  assert.equal(
    shouldRunScheduledWorkflow(config, {
      workflow: 'daily_review',
      currentTime: '21:30',
      currentWeekday: 'SUN',
      scheduledTime: '21:30',
    }),
    false,
    'automatic daily review should be skipped on the configured weekly review day',
  );

  assert.equal(
    shouldRunScheduledWorkflow(config, {
      workflow: 'daily_review',
      currentTime: '21:30',
      currentWeekday: 'MON',
      scheduledTime: '21:30',
    }),
    true,
    'daily review should still run on non-weekly-review days',
  );

  config.workflows.daily_review.skip_on_weekly_review_day = false;
  assert.equal(
    shouldRunScheduledWorkflow(config, {
      workflow: 'daily_review',
      currentTime: '21:30',
      currentWeekday: 'SUN',
      scheduledTime: '21:30',
    }),
    true,
    'the skip behavior should be configurable',
  );
}

function testSchedulerReclaimsStaleLock(): void {
  const lockDir = path.join(tmp, 'scheduler-locks');
  const key = '2026-07-16:daily_plan';

  const firstLock = acquireSchedulerLock(key, lockDir);
  assert.ok(firstLock, 'first acquire should succeed');

  // A fresh lock (as if another process is still holding it) must block re-acquire.
  assert.equal(acquireSchedulerLock(key, lockDir), null, 'a fresh lock must block re-acquire');

  // Simulate a lock left behind by a crashed process by aging its mtime past the TTL.
  const staleSeconds = (Date.now() - 31 * 60 * 1000) / 1000;
  fs.utimesSync(firstLock!, staleSeconds, staleSeconds);

  // The next acquire should self-heal: clear the stale lock and re-acquire.
  const reclaimed = acquireSchedulerLock(key, lockDir);
  assert.ok(reclaimed, 'a stale lock should be cleared and re-acquired');

  releaseSchedulerLock(reclaimed!);
  assert.equal(fs.existsSync(reclaimed!), false, 'releasing the lock should remove the file');
}

async function testWorkflowRunLedgerRecordsSendFailure(): Promise<void> {
  const config = testConfig();
  config.sources.vault.enabled = false;
  config.sources.chrome_snapshot.enabled = false;
  config.sources.apple_calendar_snapshot.enabled = false;
  config.sources.feishu.enabled = false;
  config.sources.github.enabled = false;
  config.sources.linear.enabled = false;
  config.progress.enabled = false;
  config.output.feishu.enabled = true;
  config.output.feishu.provider = 'lark_cli';
  config.output.feishu.chat_id_env = 'MISSING_TEST_FEISHU_CHAT_ID';
  // testConfig() inherits the operator's live config/config.yaml, so the provider
  // is whatever this machine happens to run. This test stubs the codex binary
  // below to get past the agent stage and reach the send failure it is actually
  // asserting on — pin the provider to match the stub, or an operator on
  // claude/anthropic fails here on their own provider instead of on the chat id.
  config.llm.provider = 'codex';

  const fakeCodex = path.join(tmp, 'fake-codex');
  fs.writeFileSync(
    fakeCodex,
    [
      '#!/usr/bin/env node',
      "const fs = require('fs');",
      "const args = process.argv.slice(2);",
      "const outputPath = args[args.indexOf('--output-last-message') + 1];",
      "fs.writeFileSync(outputPath, '老板，今天先处理 LEO-65。');",
    ].join('\n'),
    'utf8',
  );
  fs.chmodSync(fakeCodex, 0o755);

  const previousCodexBin = process.env.CODEX_BIN;
  process.env.CODEX_BIN = fakeCodex;
  try {
    await assert.rejects(
      () => runWorkflow(config, 'daily_plan', { send: true, trigger: 'scheduler', source: 'regression-test' }),
      /MISSING_TEST_FEISHU_CHAT_ID/,
    );
  } finally {
    if (previousCodexBin === undefined) {
      delete process.env.CODEX_BIN;
    } else {
      process.env.CODEX_BIN = previousCodexBin;
    }
  }

  const runs = listRecentWorkflowRuns(config, 1);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.workflow, 'daily_plan');
  assert.equal(runs[0]?.trigger, 'scheduler');
  assert.equal(runs[0]?.status, 'failed');
  assert.equal(runs[0]?.send.status, 'failed');
  assert.match(runs[0]?.error || '', /MISSING_TEST_FEISHU_CHAT_ID/);
  assert.match(formatRecentWorkflowRuns(runs), /daily_plan/);
  assert.match(formatRecentWorkflowRuns(runs), /failed/);
}

function testWeeklyReviewSummaryPrioritizesReviewEvidence(): void {
  const content = [
    '老板，我帮您整理了本周总结和下周安排。',
    '',
    '**1. 本周已经完成 / 已推进**',
    '',
    '确认的：本周主线已经从泛泛的 PhD / Job 选择，收口到 Poly / MOOSE / Heng Li 申请链路。证据来源是 Feishu Weekly2026 🐶 6.8-6.14 本周要务。',
    '确认的：`LEO-7 Heng Li 意向邮件` 已推进到发送前审核状态。证据来源是 Linear：`LEO-7 [P0][6/15][Draft ready][待周一发送]`。',
    '',
    '**2. 本周没做完 / 需要继续盯**',
    '',
    '未闭环：`LEO-7` 邮件是否真实发出。原因是 Weekly2026 把导师联系标成 `MIT ✅`，但 Linear 到 2026-06-14 仍显示 `In Review / Draft ready / 待周一发送`。',
    '未闭环：follow-up 日期没有证据。Weekly 要务明确要求记录 follow-up 日期，但当前证据里没有看到 follow-up 记录。',
    '',
    '**3. OKR / 优先级对齐**',
    '',
    '已确认决策规则影响排序：周日必须 review Feishu Weekly 🐶；博士 / 工作重大选择优先保护；Codex 可以先做草稿、检查表和方案拆解，最终判断、验收、对外发送由您本人完成。',
    '',
    '**4. 下周 MIT**',
    '',
    '下周唯一 MIT：`2026-06-15 发送 LEO-7 Heng Li 意向邮件，并记录收件人、附件、发送时间、follow-up 日期`。',
  ].join('\n');
  const summary = formatWorkflowSummaryForFeishu('weekly_review', '2026-06-14', content, undefined, testConfig());
  assert.match(summary, /先复盘本周/);
  assert.match(summary, /本周未闭环/);
  assert.match(summary, /LEO-7/);
  assert.match(summary, /follow-up/);
  assert.match(summary, /决策依据/);
  assert.doesNotMatch(summary, /\*\*下周先这样安排\*\*/);
}

function testWeeklyReviewSummaryShowsStructuredPriorityItems(): void {
  const content = [
    '老板，我帮您整理了本周总结和下周安排。',
    '',
    '**1. 本周已经完成 / 已推进**',
    '确认的：`LEO-7 Heng Li 意向邮件` 已推进到发送前审核状态。',
    '',
    '**2. 本周没做完 / 需要继续盯**',
    '逐条核对 🐶 本周要务：导师联系被 Weekly 标为 `MIT ✅`，但 Linear 仍显示待周一发送。',
    '',
    '**3. OKR / 优先级对齐**',
    '已确认决策规则影响排序：周日必须 review Feishu Weekly 🐶。',
  ].join('\n');
  const summary = formatWorkflowSummaryForFeishu(
    'weekly_review',
    '2026-06-14',
    content,
    {
      generated_at: '2026-06-14T00:00:00.000Z',
      date: '2026-06-14',
      sources: {
        weekly_priorities: {
          state: 'available',
          data: {
            week: '6.8-6.14',
            items: [
              { scope: '🐶', item: '完成 2026 年度 OKR 方向 review 收尾：明确未来 4 周唯一主线（延续上周⭕️）' },
              { scope: '🐶', item: 'Leon 学长强制令工具：完成 1 个付费文档上架（延续上周⭕️）' },
              { scope: '🐶', item: '个人 portfolio：把首版页面发给小企鹅 review，并按反馈改 1 轮（延续上周⭕️）' },
            ],
          },
        },
      },
    },
    testConfig(),
  );
  assert.match(summary, /Weekly 🐶 未完成/);
  assert.match(summary, /个人 portfolio/);
  assert.match(summary, /小企鹅 review/);
}

function testWeeklyPrioritiesExtractPortfolioReviewItem(): void {
  const xml = [
    '<title>Weekly2026</title>',
    '<table>',
    '<tbody>',
    '<tr><td><p>🐶 重点OKR</p></td><td><p>6.8-6.14 要务</p></td><td><p>retro</p></td></tr>',
    '<tr>',
    '<td><p>名利-Leon学长</p></td>',
    '<td><ol>',
    '<li>Leon 学长强制令工具：完成 1 个付费文档上架（延续上周⭕️）</li>',
    '<li>个人 portfolio：把首版页面发给小企鹅 review，并按反馈改 1 轮（延续上周⭕️）</li>',
    '<li>发布 2 条 build in public 内容：换导师 / AI 研究方向 / 读博选择</li>',
    '</ol></td>',
    '<td><p></p></td>',
    '</tr>',
    '</tbody>',
    '</table>',
  ].join('');
  const items = extractWeeklyPrioritiesFromXml(xml, '6.8-6.14', 'Weekly2026');
  assert.ok(
    items.some((item) => item.scope === '🐶' && /个人 portfolio/.test(item.item) && /小企鹅 review/.test(item.item)),
    'weekly priorities must preserve the portfolio review item as its own row',
  );
}

function testWeeklyPrioritiesUseProfileDocsSource(): void {
  const xml = [
    '<table>',
    '<tbody>',
    '<tr><td><p>🐶 重点OKR</p></td><td><p>6.15-6.21 要务</p></td></tr>',
    '<tr>',
    '<td><p>Cutto</p></td>',
    '<td><ul><li>CUTTO-318 收成可 review / handoff 状态</li></ul></td>',
    '</tr>',
    '</tbody>',
    '</table>',
  ].join('');
  const source = feishuDocsSource({
    feishu_work_docs: {
      state: 'available',
      data: {
        Weekly2026: {
          state: 'available',
          data: xml,
        },
      },
    },
  });
  const weekly = extractWeeklyPrioritiesFromFeishuDocs(source, '2026-06-16');
  assert.equal(weekly.state, 'available');
  assert.match(JSON.stringify(weekly.data), /CUTTO-318/);
}

/**
 * The Feishu doc switched to a 14-day cadence on 2026-06-29. A locally computed
 * Monday–Sunday label ("8.10-8.16") no longer matched the real header
 * ("8.10-8.23"), so weekly_priorities silently reported empty for every run
 * after that date and the daily plan lost its strategy anchor.
 */
function testWeeklyPrioritiesResolveBiweeklyColumnHeader(): void {
  const xml = [
    '<table>',
    '<tbody>',
    '<tr>',
    '<td><p>🐧 重点OKR</p></td>',
    '<td><p>retro</p></td>',
    '<td><p>8.10-8.23 要务 · 重写稿</p></td>',
    '<td><p>8.10-8.23 要务</p></td>',
    '<td><p>7.27-8.9 要务</p></td>',
    '</tr>',
    '<tr>',
    '<td><p>Cutto</p></td>',
    '<td><p></p></td>',
    '<td><ul><li>手写重写稿条目</li></ul></td>',
    '<td><ul><li>跟进中文官网 PR 审核（CUTTO-919）</li></ul></td>',
    '<td><ul><li>上期已完成条目</li></ul></td>',
    '</tr>',
    '</tbody>',
    '</table>',
  ].join('');
  const source = feishuDocsSource({
    feishu_work_docs: { state: 'available', data: { Weekly2026: { state: 'available', data: xml } } },
  });

  // 2026-08-16 is a Sunday: the old code asked for "8.10-8.16 要务" and found nothing.
  const weekly = extractWeeklyPrioritiesFromFeishuDocs(source, '2026-08-16');
  assert.equal(weekly.state, 'available', 'the biweekly column must be found for a mid-range date');
  const data = weekly.data as { week: string; items: Array<{ item: string }> };
  assert.equal(data.week, '8.10-8.23', 'the label comes from the document, not from a Monday–Sunday computation');
  assert.match(JSON.stringify(data.items), /CUTTO-919/);
  assert.doesNotMatch(
    JSON.stringify(data.items),
    /重写稿条目/,
    'the exact "8.10-8.23 要务" column wins over a hand-added "· 重写稿" sibling',
  );

  // A date outside every column falls back rather than grabbing a stale range.
  const outside = extractWeeklyPrioritiesFromFeishuDocs(source, '2026-09-20');
  assert.equal(outside.state, 'empty');
  assert.equal((outside.data as { week: string }).week, '9.14-9.20');
}

/** Wrap-around ranges ("12.29-1.4") carry no year, so a January date must still resolve. */
function testWeeklyPrioritiesResolveYearWrappingLabel(): void {
  const xml = [
    '<table>',
    '<tbody>',
    '<tr><td><p>🐶 重点OKR</p></td><td><p>12.29-1.4 要务</p></td></tr>',
    '<tr><td><p>Cutto</p></td><td><ul><li>跨年周条目</li></ul></td></tr>',
    '</tbody>',
    '</table>',
  ].join('');
  const source = feishuDocsSource({
    feishu_work_docs: { state: 'available', data: { Weekly2026: { state: 'available', data: xml } } },
  });
  const weekly = extractWeeklyPrioritiesFromFeishuDocs(source, '2026-01-02');
  assert.equal(weekly.state, 'available');
  assert.equal((weekly.data as { week: string }).week, '12.29-1.4');
}

function testBackgroundSuggestionDismissAllFromAmbiguousDismiss(): void {
  const config = testConfig();
  const pendingPath = config.background_suggestions.pending_path;
  fs.mkdirSync(path.dirname(pendingPath), { recursive: true });
  fs.writeFileSync(
    pendingPath,
    JSON.stringify(
      {
        created_at: '2026-06-14T10:00:00.000Z',
        expires_at: '2099-01-01T00:00:00.000Z',
        date: '2026-06-14',
        mode: 'review',
        window_label: 'test',
        suggestions: [
          {
            index: 1,
            id: 's1',
            kind: 'new_task',
            title: '第一条建议',
            summary: 'summary',
            targets: ['todo'],
            confidence: 'medium',
          },
          {
            index: 2,
            id: 's2',
            kind: 'reschedule',
            title: '第二条建议',
            summary: 'summary',
            targets: ['daily_plan'],
            confidence: 'medium',
          },
        ],
      },
      null,
      2,
    ),
    'utf8',
  );

  const result = handlePendingBackgroundSuggestionReply(config, '不采纳这个建议。', {
    messageId: 'msg-1',
    source: 'regression-test',
    now: new Date('2026-06-14T10:02:00.000Z'),
  });

  assert.equal(result.handled, true);
  assert.match(result.reply || '', /已忽略第 1、2 条建议/);
  assert.equal(fs.existsSync(pendingPath), false);
  assert.match(fs.readFileSync(config.feedback.feishu.log_path, 'utf8'), /dismiss_background_suggestion/);
}

function testWorkflowCardRendering(): void {
  const card = renderFeishuWorkflowCard('老板，今天先这样安排。', {
    workflow: 'daily_plan',
    date: '2026-06-14',
    detailId: 'detail-1',
  }) as { elements?: unknown[] };
  const serialized = JSON.stringify(card);
  assert.match(serialized, /今日安排/);
  assert.match(serialized, /重排一次/);
  assert.match(serialized, /daily_plan/);
}

function testCalendarDraftCardRendering(): void {
  const card = renderFeishuCalendarDraftCard('# 本周日历草稿\n\n- 07-02 09:30 Deep Work', {
    period: 'week',
    date: '2026-07-02',
    eventCount: 3,
    taskCount: 2,
    engine: 'builtin',
    writebackSupported: false,
  });
  const serialized = JSON.stringify(card);
  assert.match(serialized, /本周日历草稿/);
  assert.match(serialized, /确认草稿/);
  assert.match(serialized, /我要调整/);
  assert.match(serialized, /先不排/);
  assert.match(serialized, /daily_os_calendar_action/);
  assert.match(serialized, /builtin engine/);
  assert.match(serialized, /不会修改任何日历/);
}

function testSkillCardRendering(): void {
  const card = renderFeishuSkillCard('## 本周执行对比\n\n**完成** ✅\n- 已整理 input pack', {
    skillId: 'weekly-review',
    mode: 'weekly',
    provider: 'codex',
    inputPackPath: '/tmp/daily-os/weekly-review.md',
    draftOnly: true,
  }) as { elements?: unknown[] };
  const serialized = JSON.stringify(card);
  assert.match(serialized, /Skill: weekly-review/);
  assert.match(serialized, /草稿预览/);
  assert.match(serialized, /准备写回/);
  assert.match(serialized, /重新生成/);
  assert.match(serialized, /先不写回/);
  assert.match(serialized, /prepare_writeback/);
  assert.doesNotMatch(serialized, /确认写回/);
  assert.doesNotMatch(serialized, /confirm_writeback/);
}

function testSkillWritebackPreviewCardRendering(): void {
  const card = renderFeishuSkillWritebackPreviewCard({
    token: 'confirm-token',
    skillId: 'weekly-review',
    mode: 'weekly',
    docLabel: 'Weekly 2026',
    weekLabel: '6.22-6.28',
    taskHeader: '6.22-6.28 要务',
    action: 'insert_columns',
    items: [{ text: 'MIT 🔴: LEO-7 发送前最终检查', targetRowLabel: 'KR1 完成博士研究方向提案', isMit: true }],
  });
  const serialized = JSON.stringify(card);
  assert.match(serialized, /确认写回 Feishu/);
  assert.match(serialized, /6.22-6.28 要务/);
  assert.match(serialized, /execute_writeback/);
  assert.match(serialized, /confirm-token/);
}

function testWeeklyReviewWritebackParsing(): void {
  const output = [
    '## 📋 下周计划（6.22-6.28）',
    '',
    '**MIT 🔴**：LEO-7 Heng Li 意向邮件发送前最终检查',
    '',
    '1. P0 | 您：LEO-7 Heng Li 意向邮件',
    '目标：下周唯一主线',
    '2. P1 | Codex：Feishu 文档 / 方案 / 会议记录更新检查',
    '目标：让 Weekly 的 MIT、Linear 状态、真实发出一致',
    '',
    '如果本周结论或下周带走项要改，直接回复：daily-os 修改周计划：……',
  ].join('\n');
  assert.deepEqual(extractWeeklyWritebackItems(output), [
    'MIT 🔴: LEO-7 Heng Li 意向邮件发送前最终检查',
    'P0 | 您：LEO-7 Heng Li 意向邮件；目标：下周唯一主线',
    'P1 | Codex：Feishu 文档 / 方案 / 会议记录更新检查；目标：让 Weekly 的 MIT、Linear 状态、真实发出一致',
  ]);
  assert.equal(targetWeekLabelForDate('2026-06-22'), '6.22-6.28');
  assert.equal(detectTableLayout(['🐶 重点OKR', 'retro', '6.15-6.21 要务'], 'retro', '要务'), 'retro_before_task');

  const blockedThenPlan = [
    '🐶 重点OKR 章节可读取，下周计划据此生成。',
    '',
    '---',
    '',
    '## 📋 下周计划（6.22-6.28）',
    '',
    '> 基于 🐶 重点OKR：P0 O1',
    '',
    '**MIT 🔴**：今天上班时间发出 BEI 学签/注册中断核实邮件（LEO-71）',
    '- 完成标准：邮件发出并留底',
    '',
    '---',
    '',
    '**KR：身份合法性（BEI 核实线）**',
    '1. MIT 🔴 发出 BEI 核实邮件，问清学签中断对注册的影响',
    '2. 记录 BEI 预期回复时限，设置 follow-up 日期',
    '',
    '[如有余力]',
    '- Apple Watch 线下退货',
  ].join('\n');
  assert.deepEqual(extractWeeklyWritebackItems(blockedThenPlan), [
    'MIT 🔴: 今天上班时间发出 BEI 学签/注册中断核实邮件（LEO-71）',
    'MIT 🔴 发出 BEI 核实邮件，问清学签中断对注册的影响',
    '记录 BEI 预期回复时限，设置 follow-up 日期',
  ]);
}

async function testLifeReviewOsBridgeUsesExternalCli(): Promise<void> {
  const root = path.join(tmp, 'fake-life-review-os');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const cli = path.join(bin, 'life-review-os.mjs');
  fs.writeFileSync(
    cli,
    [
      '#!/usr/bin/env node',
      'const args = process.argv.slice(2);',
      'if (args[0] === "run") {',
      '  console.log(JSON.stringify({ ok: true, run_id: "11111111-1111-4111-8111-111111111111", draft: "## 复盘\\n内容\\n\\n```json\\n{\\\"writeback_plan\\\":[{\\\"row_index\\\":3,\\\"text\\\":\\\"Portfolio review\\\"}]}\\n```", writeback: { ready: true } }));',
      '} else if (args[0] === "preview") {',
      '  console.log(JSON.stringify({ ok: true, run_id: "11111111-1111-4111-8111-111111111111", mode: "weekly", writeback: { ready: true, doc_label: "Weekly 2026", target_week: "6.22-6.28", task_header: "6.22-6.28 要务", action: "append_to_existing_empty_column", items: [{ text: "Portfolio review", target_row: 3, target_row_label: "KR2 协助 portfolio", is_mit: false }] } }));',
      '} else if (args[0] === "writeback") {',
      '  console.log(JSON.stringify({ ok: true, task_header: "6.22-6.28 要务", item_count: 1, inserted_columns: false }));',
      '}',
    ].join('\n'),
    'utf8',
  );
  const entry = {
    id: 'weekly-review',
    provider: 'claude' as const,
    path: path.join(root, 'SKILL.md'),
    workdir: root,
    default_mode: 'weekly',
    effects: ['read' as const, 'draft' as const, 'feishu_write' as const],
    require_confirmation_for: ['feishu_write' as const],
  };
  fs.writeFileSync(entry.path, '# fake skill\n', 'utf8');

  const run = await runLifeReviewOsSkill({
    entry,
    mode: 'weekly',
    provider: 'claude',
    userText: '',
    inputPackPath: path.join(tmp, 'input.md'),
  });
  assert.equal(run.runId, '11111111-1111-4111-8111-111111111111');
  assert.match(run.draft, /## 复盘/);
  assert.doesNotMatch(run.draft, /writeback_plan/);

  const config = testConfig();
  config.skills.enabled = true;
  config.skills.inputs_dir = path.join(tmp, 'skill-inputs');
  config.skills.registry = [entry];
  fs.mkdirSync(config.skills.inputs_dir, { recursive: true });
  fs.writeFileSync(
    path.join(config.skills.inputs_dir, '_skill-runs.json'),
    JSON.stringify([{ runId: run.runId, skillId: 'weekly-review', mode: 'weekly', output: run.draft, createdAt: new Date().toISOString() }]),
    'utf8',
  );

  // Feishu write-back defaults off: the gate refuses before any CLI call. Assert
  // that, then opt in for the rest of this bridge test.
  config.skills.feishu_writeback = false;
  await assert.rejects(
    () => prepareLifeReviewOsWriteback({ config, skillId: 'weekly-review', mode: 'weekly' }),
    /feishu_writeback/,
    'Feishu write-back must refuse when skills.feishu_writeback is off',
  );
  config.skills.feishu_writeback = true;

  const preview = await prepareLifeReviewOsWriteback({ config, skillId: 'weekly-review', mode: 'weekly' });
  assert.equal(preview.token, run.runId);
  assert.equal(preview.items[0]?.targetRowLabel, 'KR2 协助 portfolio');

  const written = await executeLifeReviewOsWriteback(config, 'weekly-review', preview.token);
  assert.equal(written.taskHeader, '6.22-6.28 要务');
  assert.equal(written.itemCount, 1);
}

async function testUiServerEnforcesAuthTokenAndOrigin(): Promise<void> {
  const controls = await startUiServer({
    configPath: path.join(tmp, 'ui-config.yaml'),
    envPath: path.join(tmp, 'ui.env'),
    host: '127.0.0.1',
    port: 0,
    open: false,
  });

  try {
    const base = controls.url;

    // No token -> 401
    const noToken = await fetch(`${base}/api/logs`);
    assert.equal(noToken.status, 401, 'requests without a token must be rejected with 401');

    // Wrong token -> 401
    const wrongToken = await fetch(`${base}/api/logs`, { headers: { Authorization: 'Bearer not-the-token' } });
    assert.equal(wrongToken.status, 401, 'requests with an incorrect token must be rejected with 401');

    // Valid token via Authorization header -> 200
    const withToken = await fetch(`${base}/api/logs`, { headers: { Authorization: `Bearer ${controls.token}` } });
    assert.equal(withToken.status, 200, 'requests carrying the runtime token must succeed');
    const okBody = (await withToken.json()) as { ok?: boolean };
    assert.equal(okBody.ok, true);

    // Valid token via query string -> 200 (browser bootstrap path)
    const withQueryToken = await fetch(`${base}/api/logs?token=${controls.token}`);
    assert.equal(withQueryToken.status, 200, 'a query-string token must also authenticate');

    // Forged cross-site Origin -> 403 (CSRF defence), even with a valid token
    const forgedOrigin = await fetch(`${base}/api/logs?token=${controls.token}`, {
      headers: { Origin: 'http://evil.example.com' },
    });
    assert.equal(forgedOrigin.status, 403, 'a forged cross-site Origin must be rejected with 403');

    // env-secret must not leak the plaintext value by default (no reveal flag)
    const secret = (await fetch(`${base}/api/env-secret?key=OPENAI_API_KEY&token=${controls.token}`).then((response) =>
      response.json(),
    )) as { ok?: boolean; value?: unknown };
    assert.equal(secret.ok, true);
    assert.equal(secret.value, undefined, 'env-secret must not return a plaintext secret without an explicit local reveal');
  } finally {
    await controls.stop();
  }
}

function testConfig(): ReturnType<typeof loadConfig> {
  const config = loadConfig();
  config.background_suggestions.pending_path = path.join(tmp, 'pending.json');
  config.background_suggestions.state_path = path.join(tmp, 'background-state.json');
  config.feedback.feishu.log_path = path.join(tmp, 'feedback.md');
  config.feedback.feishu.state_path = path.join(tmp, 'feedback-state.json');
  config.memory.daily_dir = path.join(tmp, 'daily');
  config.memory.long_term_path = path.join(tmp, 'long-term.md');
  config.memory.repository_path = path.join(tmp, 'repository');
  config.memory.workflow_runs_dir = path.join(tmp, 'workflow-runs');
  config.decision.candidates_path = path.join(tmp, 'decision-policy-candidates.md');
  return config;
}
