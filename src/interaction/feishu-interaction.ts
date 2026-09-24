import {
  Domain,
  LoggerLevel,
  createLarkChannel,
  type CardActionEvent,
  type LarkChannel,
  type NormalizedMessage,
} from '@larksuiteoapi/node-sdk';
import type { AppConfig, WorkflowName } from '../config/schema.js';
import { handleDailyOsCommand, parseDailyOsCommand } from './daily-os-command.js';
import { PendingQueue } from './pending-queue.js';
import { runWorkflow, runWorkflowDetailed } from '../workflows/run-workflow.js';
import { collectEvidence } from '../workflows/evidence.js';
import { decideFeishuAccess, decideFeishuControl, type FeishuAccessDecision } from './access-policy.js';
import { isDecisionCalibrationChat, startDecisionOnboarding } from '../decision/onboarding.js';
import { runDecisionCalibrationAgent } from '../decision/calibration-agent.js';
import { ensureFeishuSession } from './session-catalog.js';
import {
  agentModeControlEffect,
  agentWorkdir,
  startFeishuAgentModeRun,
  type FeishuAgentModeEvent,
  type FeishuAgentModeRun,
} from './agent-mode.js';
import { AgentRunCardController, parseAgentRunCardAction, type AgentRunCardStatus } from './run-card.js';
import {
  appendConfirmedProgress,
  collectProgressCandidates,
  confirmedEntriesFromCandidates,
  formatProgressCandidates,
} from '../progress/capture.js';
import { parseProgressCardAction, renderProgressBatchReviewCard, renderProgressConfirmationCard } from '../progress/card.js';
import {
  collectSyncDrift,
  filterUndecidedFindings,
  parseSyncDriftCardAction,
  recordSyncDriftDecision,
  renderSyncDriftDraft,
  type ParsedSyncDriftCardAction,
} from '../progress/sync-drift.js';
import { todayInTimezone } from '../utils/date.js';
import { appendDailyMemory, appendFeedbackLog, readLatestWorkflowOutput, readWorkflowDetailCache } from '../storage/memory.js';
import { extractDailyPlanTodos, formatLatestWorkflowDetails, formatWorkflowSummaryForFeishu, parseDailyReviewReconciliation, selectCarryOverCandidateIds } from '../workflows/summary.js';
import { recordCarryOver, recordTodoFeedback, recordTodoPresented } from '../todo/feedback.js';
import { markWorkflowRunFailed, markWorkflowRunSucceeded } from '../workflows/run-ledger.js';
import { handlePendingBackgroundSuggestionReply } from '../service/background-suggestions.js';
import { renderFeishuCalendarDraftCard, renderFeishuSkillCard, renderFeishuSkillWritebackPreviewCard, renderFeishuWorkflowCard } from '../connectors/feishu-sdk.js';
import { sendFeishuCard } from '../connectors/lark-cli.js';
import type { SkillRunResult } from '../skills/runner.js';
import { readLatestSkillRun } from '../skills/runner.js';
import { executeLifeReviewOsRetroReview, executeLifeReviewOsWriteback, formatRetroReviewOutcome, prepareLifeReviewOsWriteback } from '../skills/life-review-os.js';
import { buildOkrWritebackPreview, executeConfirmedOkrWriteback, renderOkrWritebackCard } from './okr-writeback-card.js';
import { formatWorkflowRevisionMemoryNote } from './workflow-revision.js';
import { handleTodoInboxCommand, parseTodoInboxCommand, syncTodoInboxFromPlanRow } from '../todo/inbox.js';
import type { CalendarDraft, CalendarDraftPeriod, CalendarDraftResult } from '../calendar/bridge.js';
import { writebackCalendarDraft } from '../calendar/writeback.js';
import { dbLoadCalendarDraftSnapshot, dbSaveCalendarDraftSnapshot } from '../storage/db.js';
import { isSelfOriginMessage, SelfOriginGuard, type SelfOriginContext } from './self-origin.js';

/**
 * Self-origin echo guard (LEO-202 / H3). Resolves the bot's own open_id at
 * startup and records message_ids we emit, so inbound events that originated
 * from the bot are skipped instead of re-processed. See ./self-origin.ts.
 */
let selfOriginGuard: SelfOriginGuard | undefined;

interface FeishuInteractionControls {
  stop: () => Promise<void>;
}

type ChatMode = 'p2p' | 'group' | 'topic';

interface ActiveAgentRun {
  run: FeishuAgentModeRun;
  card?: AgentRunCardController;
  scopeId: string;
}

type ConfigProvider = AppConfig | (() => AppConfig);

type WorkflowCardCommand = {
  command:
    | 'details'
    | 'progress'
    | 'chat todo'
    | 'chat review'
    | 'confirm_todo'
    | 'confirm_review'
    | 'carry_open_review'
    | 'revise_todo'
    | 'calendar week'
    | 'calendar today';
  detailId?: string;
};

type SkillCardAction = {
  action: 'confirm_writeback' | 'writeback_info' | 'prepare_writeback' | 'execute_writeback' | 'execute_review' | 'confirm_okr_writeback' | 'rerun' | 'dismiss';
  skillId: string;
  mode?: string;
  runId?: string;
  token?: string;
};

type CalendarCardAction = {
  action: 'confirm' | 'adjust' | 'skip';
  period: CalendarDraftPeriod;
  draftId?: string;
};

const CARD_ACTION_DEDUPE_MS = 30_000;

function runtimeConfigReader(config: ConfigProvider): () => AppConfig {
  return typeof config === 'function' ? config : () => config;
}

export async function startFeishuInteraction(configProvider: ConfigProvider): Promise<FeishuInteractionControls> {
  const getConfig = runtimeConfigReader(configProvider);
  const cfg = getConfig().interaction.feishu;
  if (!cfg.enabled) {
    throw new Error('interaction.feishu.enabled is false. Enable it in config/config.yaml before starting the Feishu interaction layer.');
  }

  const appId = process.env.LARK_APP_ID;
  const appSecret = process.env.LARK_APP_SECRET;
  if (!appId || !appSecret) throw new Error('LARK_APP_ID and LARK_APP_SECRET are required for Feishu interaction.');

  const channel = createLarkChannel({
    appId,
    appSecret,
    domain: Domain.Feishu,
    source: 'daily-os-feishu',
    loggerLevel: LoggerLevel.warn,
    includeRawEvent: true,
    safety: { chatQueue: { enabled: false } },
    policy: {
      dmMode: 'open',
      requireMention: false,
      respondToMentionAll: false,
    },
    outbound: {
      streamThrottleMs: 400,
    },
    wsConfig: {
      pingTimeout: 3,
    },
    handshakeTimeoutMs: 8_000,
  });

  const chatModes = new Map<string, ChatMode>();
  const activeAgentRuns = new Map<string, ActiveAgentRun>();
  const recentCardActions = new Map<string, number>();
  const queue = new PendingQueue<NormalizedMessage>(cfg.debounce_ms, (scope, batch) => {
    queue.block(scope);
    void runBatch({ config: getConfig(), channel, batch, scope, chatModes, activeAgentRuns })
      .catch(async (error) => {
        const last = batch[batch.length - 1];
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[interaction] ${scope} failed: ${message}`);
        if (last) await replyToMessage(channel, last, `Daily OS 执行失败：${message}`, 'text');
      })
      .finally(() => queue.unblock(scope));
  });

  channel.on({
    message: async (message) => {
      await intakeMessage({ config: getConfig(), channel, message, queue, chatModes, activeAgentRuns });
    },
    cardAction: (event) => {
      if (!claimCardAction(recentCardActions, event)) {
        console.log(`[interaction] skipped duplicate card action ${event.chatId}/${event.messageId}`);
        return;
      }
      void handleCardAction({ config: getConfig(), channel, event, queue, chatModes, activeAgentRuns }).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[interaction] card action failed ${event.chatId}/${event.messageId}: ${message}`);
        void channel
          .send(event.chatId, { text: `卡片操作执行失败：${message}` }, { replyTo: event.messageId })
          .catch((sendError) => {
            console.error(`[interaction] failed to report card action error: ${sendError instanceof Error ? sendError.message : String(sendError)}`);
          });
      });
    },
    reject: (event) => {
      console.warn(`[interaction] rejected ${event.chatId}/${event.messageId}: ${event.reason}`);
    },
    reconnecting: () => {
      console.warn('[interaction] Feishu websocket reconnecting...');
    },
    reconnected: () => {
      console.log('[interaction] Feishu websocket reconnected.');
    },
    error: (error) => {
      console.error(`[interaction] Feishu websocket error: ${error.message}`);
    },
  });

  await channel.connect();
  selfOriginGuard = new SelfOriginGuard(getConfig(), channel);
  await selfOriginGuard.resolve();
  console.log('daily-os-feishu 飞书交互层已启动。');
  if (getConfig().decision.onboarding.auto_create_on_setup) {
    try {
      const result = await startDecisionOnboarding(getConfig(), { channel });
      console.log(`[interaction] 决策校准群${result.created ? '已创建' : '已准备好'}：${result.chatId}`);
    } catch (error) {
      console.warn(`[interaction] 跳过决策校准初始化：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    stop: async () => {
      await channel.disconnect();
    },
  };
}

async function intakeMessage(input: {
  config: AppConfig;
  channel: LarkChannel;
  message: NormalizedMessage;
  queue: PendingQueue<NormalizedMessage>;
  chatModes: Map<string, ChatMode>;
  activeAgentRuns: Map<string, ActiveAgentRun>;
}): Promise<void> {
  if (!input.config.interaction.feishu.enabled) return;
  // Primary echo guard (LEO-202 / H3): drop anything that originated from the
  // bot itself before it can be queued and re-processed. Identity check first,
  // prefix heuristics only as a degradation path (see ./self-origin.ts).
  if (selfOriginGuard?.isSelfOrigin(input.message)) {
    console.log(`[interaction] skipped self-origin message ${input.message.chatId}/${input.message.messageId}`);
    return;
  }
  const mode = await resolveChatMode(input.channel, input.message.chatId, input.chatModes, input.message.chatType);
  const scope = scopeFor(input.message, mode);
  const access = decideFeishuAccess(input.config, {
    senderOpenId: input.message.senderId,
    chatId: input.message.chatId,
    chatType: input.message.chatType,
  });
  const isCalibrationChat = isDecisionCalibrationChat(input.config, input.message.chatId);
  if (isStopText(input.message.content) && input.activeAgentRuns.has(scope)) {
    if (!access.ok && !isCalibrationChat) {
      await replyToMessage(input.channel, input.message, `权限不足：${access.reason}`, input.config.interaction.feishu.reply_mode);
      return;
    }
    await stopAgentRun(input.activeAgentRuns, scope);
    await replyToMessage(input.channel, input.message, '已请求停止当前 Codex 任务。', input.config.interaction.feishu.reply_mode);
    return;
  }
  if (!access.ok && !isCalibrationChat) {
    console.warn(`[interaction] denied ${scope}; sender=${input.message.senderId.slice(-6)}; reason=${access.reason}`);
    if (input.message.chatType === 'p2p') await replyToMessage(input.channel, input.message, '当前飞书用户尚未启用 Daily OS。', 'text');
    return;
  }

  if (
    !isCalibrationChat &&
    input.message.chatType !== 'p2p' &&
    input.config.interaction.feishu.require_mention_in_groups &&
    !input.message.mentionedBot &&
    !shouldAcceptUnmentionedGroupMessage(
      input.message,
      input.config.interaction.feishu.command_prefix,
      input.config.interaction.feishu.agent_mode.enabled,
      selfOriginGuard?.context(),
    )
  ) {
    return;
  }

  const queued = input.queue.push(scope, input.message);
  console.log(`[interaction] queued ${scope}; size=${queued}`);
}

async function runBatch(input: {
  config: AppConfig;
  channel: LarkChannel;
  batch: NormalizedMessage[];
  scope: string;
  chatModes: Map<string, ChatMode>;
  activeAgentRuns: Map<string, ActiveAgentRun>;
}): Promise<void> {
  const last = input.batch[input.batch.length - 1];
  if (!last) return;

  const text = input.batch.map((message) => message.content).join('\n').trim();
  const isCalibrationChat = isDecisionCalibrationChat(input.config, last.chatId);
  const agentWorkdirPath = input.config.interaction.feishu.agent_mode.enabled ? agentWorkdir(input.config) : undefined;
  const scopeDescriptor = {
    scopeKey: input.scope,
    chatId: last.chatId,
    chatType: last.chatType,
    mode: last.threadId ? 'topic' : last.chatType,
    ...(last.threadId ? { threadId: last.threadId } : {}),
  } as const;
  const session = ensureFeishuSession(input.config, scopeDescriptor, { workdir: agentWorkdirPath });
  const commandPrefix = input.config.interaction.feishu.command_prefix;
  const commandText = isCalibrationChat && looksLikeBarePolicyCommand(text) ? `${commandPrefix} ${text}` : text;
  const command = parseDailyOsCommand(commandText, commandPrefix);
  const accessDecision = commandAccessDecision(input.config, last, isCalibrationChat);
  if (command.type === 'ignore' && isProgressConfirmationReply(text)) {
    const control = decideFeishuControl(input.config, accessDecision, { effect: 'memory_write' });
    if (!control.ok) {
      await replyToMessage(input.channel, last, `权限不足：${control.reason}`, input.config.interaction.feishu.reply_mode);
      console.log(`[interaction] denied ${input.scope}; command=progress-confirm-reply; reason=${control.reason}`);
      return;
    }
    const date = todayInTimezone(input.config);
    const progress = await collectProgressCandidates(input.config, date);
    const ledgerPath = appendConfirmedProgress(input.config, date, confirmedEntriesFromCandidates(progress.candidates));
    await replyToMessage(
      input.channel,
      last,
      progress.candidates.length > 0 ? `已确认 ${progress.candidates.length} 条今日进展，并写入：${ledgerPath}` : '没有可写入的进展候选；可能候选已经为空。',
      input.config.interaction.feishu.reply_mode,
    );
    console.log(`[interaction] handled ${input.scope}; command=progress-confirm-reply`);
    return;
  }
  if (command.type === 'ignore' && isProgressBatchConfirmationReply(text)) {
    const control = decideFeishuControl(input.config, accessDecision, { effect: 'memory_write' });
    if (!control.ok) {
      await replyToMessage(input.channel, last, `权限不足：${control.reason}`, input.config.interaction.feishu.reply_mode);
      console.log(`[interaction] denied ${input.scope}; command=progress-batch-reply; reason=${control.reason}`);
      return;
    }
    const date = todayInTimezone(input.config);
    const progress = await collectProgressCandidates(input.config, date);
    const decision = parseProgressBatchConfirmation(text, progress.candidates.length);
    const completed = decision.completed.map((index) => progress.candidates[index]).filter(Boolean);
    const carryOver = decision.carryOver.map((index) => progress.candidates[index]).filter(Boolean);
    const ignored = decision.ignored.map((index) => progress.candidates[index]).filter(Boolean);
    const ledgerPath = appendConfirmedProgress(input.config, date, confirmedEntriesFromCandidates(completed));
    if (carryOver.length > 0) {
      appendDailyMemory(
        input.config,
        'daily_review',
        date,
        [
          '用户逐条确认：以下今日进展候选不是完成项，需要明天继续未闭环任务。',
          ...carryOver.map((candidate, index) => `${index + 1}. ${candidate.title}`),
        ].join('\n'),
      );
    }
    await replyToMessage(
      input.channel,
      last,
      [
        `已处理逐条确认：完成 ${completed.length} 条，明天继续 ${carryOver.length} 条，忽略 ${ignored.length} 条。`,
        completed.length > 0 ? `完成项已写入：${ledgerPath}` : '',
        carryOver.length > 0 ? '明天继续的事项已写入今日复盘上下文，会带入下一次日计划。' : '',
      ]
        .filter(Boolean)
        .join('\n'),
      input.config.interaction.feishu.reply_mode,
    );
    console.log(`[interaction] handled ${input.scope}; command=progress-batch-reply`);
    return;
  }
  if (command.type === 'status') {
    await sendStatusCard(input.channel, last, input.config);
    console.log(`[interaction] handled ${input.scope}; command=status-card`);
    return;
  }
  if (command.type === 'progress') {
    const date = todayInTimezone(input.config);
    const progress = await collectProgressCandidates(input.config, date);
    await input.channel.send(
      last.chatId,
      { card: renderProgressConfirmationCard(input.config, progress) },
      {
        replyTo: last.messageId,
        ...(last.threadId ? { replyInThread: true } : {}),
      },
    );
    console.log(`[interaction] handled ${input.scope}; command=progress-card`);
    return;
  }
  if (command.type === 'calibrate') {
    const control = decideFeishuControl(input.config, accessDecision, { effect: 'interaction_admin' });
    if (!control.ok) {
      await replyToMessage(input.channel, last, `权限不足：${control.reason}`, input.config.interaction.feishu.reply_mode);
      console.log(`[interaction] denied ${input.scope}; command=calibrate; reason=${control.reason}`);
      return;
    }
    const result = await startDecisionOnboarding(input.config, { channel: input.channel });
    await replyToMessage(
      input.channel,
      last,
      [
        result.created ? '已创建决策校准群。' : '决策校准群已准备好。',
        '',
        `群名称：${result.chatName}`,
        `群 ID：${result.chatId}`,
        '',
        '请到这个群里继续校准决策规则，方便之后查看和确认长期规则。',
      ].join('\n'),
      input.config.interaction.feishu.reply_mode,
    );
    console.log(`[interaction] handled ${input.scope}; command=calibrate; chat=${result.chatId}`);
    return;
  }

  if (isCalibrationChat && command.type !== 'ignore') {
    const result = await handleDailyOsCommand({
      config: input.config,
      messageId: last.messageId,
      text: commandText,
      source: `feishu-decision-calibration:${input.scope}`,
      prefix: commandPrefix,
      sendWorkflowOutput: false,
      accessDecision,
      sessionScopeId: session.scope_id,
      stopAgentRun: async () => stopAgentRun(input.activeAgentRuns, input.scope),
      sendWorkflowCard: async ({ workflow, date, text, summary }) => {
        await sendWorkflowCardOutput(input.config, workflow, date, summary, `interaction:${input.scope}`, text);
      },
      sendSkillCard: async ({ result: skillResult, text: skillText }) => {
        await sendSkillCardOutput(input.config, skillText, skillResult, `interaction:${input.scope}`);
      },
      sendCalendarCard: async ({ result: calendarResult, text: calendarText }) => {
        await sendCalendarCardOutput(input.config, calendarText, calendarResult, `interaction:${input.scope}`);
      },
      reply: async (reply) => {
        await replyToMessage(input.channel, last, reply, input.config.interaction.feishu.reply_mode);
      },
    });
    if (result.handled) {
      console.log(`[interaction] handled ${input.scope}; command=${result.command.type}`);
      return;
    }
  }

  if (isCalibrationChat) {
    const reply = await runDecisionCalibrationAgent(input.config, {
      text,
      chatId: last.chatId,
      senderOpenId: last.senderId,
      messageId: last.messageId,
    });
    await replyToMessage(input.channel, last, reply, input.config.interaction.feishu.reply_mode);
    console.log(`[interaction] handled ${input.scope}; command=decision-calibration`);
    return;
  }

  const result = await handleDailyOsCommand({
    config: input.config,
    messageId: last.messageId,
    text,
    source: `feishu-interaction:${input.scope}`,
    prefix: input.config.interaction.feishu.command_prefix,
    sendWorkflowOutput: false,
    accessDecision,
    sessionScopeId: session.scope_id,
    stopAgentRun: async () => stopAgentRun(input.activeAgentRuns, input.scope),
    sendWorkflowCard: async ({ workflow, date, text, summary }) => {
      await sendWorkflowCardOutput(input.config, workflow, date, summary, `interaction:${input.scope}`, text);
    },
    sendSkillCard: async ({ result: skillResult, text: skillText }) => {
      await sendSkillCardOutput(input.config, skillText, skillResult, `interaction:${input.scope}`);
    },
    sendCalendarCard: async ({ result: calendarResult, text: calendarText }) => {
      await sendCalendarCardOutput(input.config, calendarText, calendarResult, `interaction:${input.scope}`);
    },
    reply: async (reply) => {
      await replyToMessage(input.channel, last, reply, input.config.interaction.feishu.reply_mode);
    },
  });

  if (result.handled) {
    console.log(`[interaction] handled ${input.scope}; command=${result.command.type}`);
    return;
  }

  const suggestionReply = handlePendingBackgroundSuggestionReply(input.config, text, {
    messageId: last.messageId,
    source: `feishu-interaction:${input.scope}`,
  });
  if (suggestionReply.handled) {
    if (suggestionReply.reply) await replyToMessage(input.channel, last, suggestionReply.reply, input.config.interaction.feishu.reply_mode);
    console.log(`[interaction] handled ${input.scope}; command=background-suggestion-reply`);
    return;
  }

  const todoInboxCommand = parseTodoInboxCommand(text);
  if (todoInboxCommand) {
    const control = decideFeishuControl(input.config, accessDecision, { effect: 'memory_write' });
    if (!control.ok) {
      await replyToMessage(input.channel, last, `权限不足：${control.reason}`, input.config.interaction.feishu.reply_mode);
      console.log(`[interaction] denied ${input.scope}; command=todo-inbox; reason=${control.reason}`);
      return;
    }
    const result = handleTodoInboxCommand(input.config, todoInboxCommand, {
      messageId: last.messageId,
      source: `feishu-interaction:${input.scope}`,
    });
    if (result.reply) await replyToMessage(input.channel, last, result.reply, input.config.interaction.feishu.reply_mode);
    console.log(`[interaction] handled ${input.scope}; command=todo-inbox`);
    return;
  }

  if (isWorkflowRevisionFollowUp(input.config, last, text, selfOriginGuard?.context())) {
    const control = decideFeishuControl(input.config, accessDecision, { effect: 'memory_write' });
    if (!control.ok) {
      await replyToMessage(input.channel, last, `权限不足：${control.reason}`, input.config.interaction.feishu.reply_mode);
      console.log(`[interaction] denied ${input.scope}; command=workflow-revision-follow-up; reason=${control.reason}`);
      return;
    }
    const workflow = revisionWorkflowForText(text);
    const date = todayInTimezone(input.config);
    appendDailyMemory(input.config, workflow, date, formatWorkflowRevisionMemoryNote(text));
    appendFeedbackLog(input.config, text, {
      message_id: last.messageId,
      source: `feishu-interaction:${input.scope}`,
      workflow,
    });
    const nextCommand = workflow === 'daily_plan' ? 'plan' : workflow === 'daily_review' ? 'review' : 'weekly';
    await replyToMessage(
      input.channel,
      last,
      `收到，我已把这条修改意见写入${revisionWorkflowLabel(workflow)}上下文。请点卡片里的「重新生成」，或发送 ${input.config.interaction.feishu.command_prefix} ${nextCommand}，我会按这条意见重新整理。`,
      input.config.interaction.feishu.reply_mode,
    );
    console.log(`[interaction] handled ${input.scope}; command=workflow-revision-follow-up`);
    return;
  }

  if (input.config.interaction.feishu.agent_mode.enabled) {
    const control = decideFeishuControl(input.config, accessDecision, {
      effect: agentModeControlEffect(input.config),
      workspacePath: agentWorkdir(input.config),
    });
    if (!control.ok) {
      await replyToMessage(input.channel, last, `权限不足：${control.reason}`, input.config.interaction.feishu.reply_mode);
      console.log(`[interaction] denied ${input.scope}; command=agent-mode; reason=${control.reason}`);
      return;
    }
    const pendingEvents: FeishuAgentModeEvent[] = [];
    let card: AgentRunCardController | undefined;
    const run = await startFeishuAgentModeRun({
      config: input.config,
      text,
      access: accessDecision,
      session,
      onEvent: (event) => {
        if (card) card.record(toCardEvent(event));
        else pendingEvents.push(event);
      },
      bridge: {
        chatId: last.chatId,
        chatType: last.chatType,
        senderId: last.senderId,
        ...(last.threadId ? { threadId: last.threadId } : {}),
        messageIds: input.batch.map((message) => message.messageId),
        scopeId: session.scope_id,
        scopeHash: session.scope_hash,
        source: 'feishu',
      },
    });
    card = new AgentRunCardController({
      config: input.config,
      channel: input.channel,
      message: last,
      runId: run.runId,
      scopeId: session.scope_id,
      title: 'Codex 正在处理飞书请求',
    });
    input.activeAgentRuns.set(input.scope, { run, card, scopeId: session.scope_id });
    await card.send();
    for (const event of pendingEvents) card.record(toCardEvent(event));
    await card.flushPending();
    try {
      const output = await run.done;
      if (output.threadId) {
        ensureFeishuSession(input.config, scopeDescriptor, {
          workdir: agentWorkdir(input.config),
          codexSessionId: output.threadId,
        });
      }
      await card.finalize(finalStatusForReply(output.reply), output.reply);
      console.log(`[interaction] handled ${input.scope}; command=agent-mode; run=${run.runId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await card.finalize('failed', message);
      console.error(`[interaction] ${input.scope} agent-mode failed: ${message}`);
    } finally {
      input.activeAgentRuns.delete(input.scope);
    }
  }
}

function looksLikeBarePolicyCommand(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return /^(?:候选规则|待确认规则|保存规则|确认规则|确认保存|保存|拒绝规则|放弃规则)(?:\s|[:：]|$)/.test(normalized);
}

function commandAccessDecision(config: AppConfig, message: NormalizedMessage, isCalibrationChat: boolean): FeishuAccessDecision {
  const decision = decideFeishuAccess(config, {
    senderOpenId: message.senderId,
    chatId: message.chatId,
    chatType: message.chatType,
  });
  if (decision.ok || !isCalibrationChat) return decision;
  return { ok: true, role: 'allowed_chat' };
}

function isStopText(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase();
  return normalized === '/stop' || normalized === 'stop' || normalized === 'daily-os stop' || normalized === '停止' || normalized === '停止当前任务';
}

function shouldAcceptUnmentionedGroupMessage(
  message: NormalizedMessage,
  prefix: string,
  allowFreeformReplies: boolean,
  selfOriginCtx: SelfOriginContext | undefined,
): boolean {
  const normalized = message.content.replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  if (selfOriginCtx && isSelfOriginMessage(message, selfOriginCtx)) return false;
  if (normalized.toLowerCase().startsWith(`${prefix.toLowerCase()} `) || normalized.toLowerCase() === prefix.toLowerCase()) return true;
  if (!message.replyToMessageId && !message.threadId) return false;
  if (allowFreeformReplies) return true;
  return isProgressConfirmationReply(normalized) || isProgressBatchConfirmationReply(normalized) || isDetailReply(normalized) || isLikelyWorkflowRevisionText(normalized);
}

function isProgressConfirmationReply(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase();
  return ['确认', '确认全部', '通过', '可以', '写入', '记账', 'ok', 'okay', 'yes', 'y'].includes(normalized);
}

function isProgressBatchConfirmationReply(text: string): boolean {
  const normalized = normalizeProgressBatchText(text);
  if (!normalized) return false;
  if (/^全部(完成|done|推进|明天继续|继续|忽略|不写入)$/.test(normalized)) return true;
  return /\d+\s*(完成|done|推进|明天继续|继续|忽略|不写入|跳过)/i.test(normalized);
}

function parseProgressBatchConfirmation(text: string, count: number): { completed: number[]; carryOver: number[]; ignored: number[] } {
  const normalized = normalizeProgressBatchText(text);
  const all = Array.from({ length: count }, (_, index) => index);
  if (/^全部(完成|done|推进)$/.test(normalized)) return { completed: all, carryOver: [], ignored: [] };
  if (/^全部(明天继续|继续)$/.test(normalized)) return { completed: [], carryOver: all, ignored: [] };
  if (/^全部(忽略|不写入)$/.test(normalized)) return { completed: [], carryOver: [], ignored: all };

  const completed = new Set<number>();
  const carryOver = new Set<number>();
  const ignored = new Set<number>();
  for (const match of normalized.matchAll(/(\d+)\s*(完成|done|推进|明天继续|继续|忽略|不写入|跳过)/gi)) {
    const index = Number(match[1]) - 1;
    if (index < 0 || index >= count) continue;
    const action = match[2].toLowerCase();
    if (action === '完成' || action === 'done' || action === '推进') completed.add(index);
    else if (action === '明天继续' || action === '继续') carryOver.add(index);
    else ignored.add(index);
  }

  return {
    completed: [...completed].filter((index) => !carryOver.has(index) && !ignored.has(index)),
    carryOver: [...carryOver].filter((index) => !ignored.has(index)),
    ignored: [...ignored],
  };
}

function normalizeProgressBatchText(text: string): string {
  return text
    .replace(/[，、；;。\n\r]+/g, ',')
    .replace(/\s+/g, '')
    .trim()
    .toLowerCase();
}

function isDetailReply(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase();
  return ['详情', '查看详情', '全文', '完整内容', 'details', 'detail'].includes(normalized);
}

function isWorkflowRevisionFollowUp(
  config: AppConfig,
  message: NormalizedMessage,
  text: string,
  selfOriginCtx: SelfOriginContext | undefined,
): boolean {
  const selfOrigin = selfOriginCtx ? isSelfOriginMessage(message, selfOriginCtx) : false;
  return Boolean(
    (message.replyToMessageId || message.threadId) &&
      !selfOrigin &&
      !isDailyOsCommandText(text, config.interaction.feishu.command_prefix) &&
      isLikelyWorkflowRevisionText(text),
  );
}

function isDailyOsCommandText(text: string, prefix: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase();
  const commandPrefix = prefix.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!normalized || !commandPrefix) return false;
  return [commandPrefix, `/${commandPrefix}`].some(
    (candidate) =>
      normalized === candidate ||
      normalized.startsWith(`${candidate} `) ||
      normalized.startsWith(`${candidate}:`) ||
      normalized.startsWith(`${candidate}：`),
  );
}

function isLikelyWorkflowRevisionText(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase();
  if (normalized.length < 4) return false;
  if (/^daily-os\s+(plan|review|weekly|details|progress|status)\b/i.test(normalized)) return false;
  return /修改|调整|改成|降级|优先|不做|先做|安排|计划|复盘|review|weekly|周报|周复盘|本周|今天|明天|leo-\d+/i.test(normalized);
}

function revisionWorkflowForText(text: string): WorkflowName {
  const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase();
  if (/weekly|周报|周复盘|本周/.test(normalized)) return 'weekly_review';
  if (/复盘|review/.test(normalized)) return 'daily_review';
  return 'daily_plan';
}

function revisionWorkflowLabel(workflow: WorkflowName): string {
  if (workflow === 'weekly_review') return '本周复盘';
  if (workflow === 'daily_review') return '今日复盘';
  return '今日安排';
}

async function stopAgentRun(activeRuns: Map<string, ActiveAgentRun>, scope: string): Promise<boolean> {
  const active = activeRuns.get(scope);
  if (!active) return false;
  await active.card?.markStopping();
  await active.run.stop();
  return true;
}

async function stopAgentRunByScopeOrId(
  activeRuns: Map<string, ActiveAgentRun>,
  scope: string,
  scopeId: string,
  runId: string,
): Promise<boolean> {
  const active = activeRuns.get(scope) || [...activeRuns.values()].find((candidate) => candidate.scopeId === scopeId && candidate.run.runId === runId);
  if (!active) return false;
  await active.card?.markStopping();
  await active.run.stop();
  return true;
}

function toCardEvent(event: FeishuAgentModeEvent): { type: 'started' | 'thread' | 'progress' | 'stderr' | 'final'; message: string } {
  if (event.type === 'started' || event.type === 'thread' || event.type === 'stderr') return { type: event.type, message: event.message };
  if (event.type === 'completed' || event.type === 'failed' || event.type === 'stopped' || event.type === 'timeout') {
    return { type: 'final', message: event.message };
  }
  return { type: 'progress', message: event.message };
}

function finalStatusForReply(reply: string): Exclude<AgentRunCardStatus, 'running' | 'stopping'> {
  if (/超时|timeout/i.test(reply)) return 'timeout';
  if (/停止|stopped|stop/i.test(reply)) return 'stopped';
  return 'success';
}

async function handleCardAction(input: {
  config: AppConfig;
  channel: LarkChannel;
  event: CardActionEvent;
  queue: PendingQueue<NormalizedMessage>;
  chatModes: Map<string, ChatMode>;
  activeAgentRuns: Map<string, ActiveAgentRun>;
}): Promise<void> {
  if (!input.config.interaction.feishu.enabled) return;
  const progressAction = parseProgressCardAction(input.event.action.value, input.config);
  if (progressAction) {
    await handleProgressCardAction({ ...input, action: progressAction });
    return;
  }
  const syncDriftAction = parseSyncDriftCardAction(input.event.action.value, input.config);
  if (syncDriftAction) {
    await handleSyncDriftCardAction({ ...input, action: syncDriftAction });
    return;
  }
  const agentAction = parseAgentRunCardAction(input.event.action.value, input.config);
  if (agentAction) {
    await handleAgentRunCardAction({ ...input, action: agentAction });
    return;
  }
  const skillAction = parseSkillCardAction(input.event.action.value);
  if (skillAction) {
    await handleSkillCardAction({ ...input, action: skillAction });
    return;
  }
  const calendarAction = parseCalendarCardAction(input.event.action.value);
  if (calendarAction) {
    await handleCalendarCardAction({ ...input, action: calendarAction });
    return;
  }
  const commandAction = parseWorkflowCardCommand(input.event.action.value);
  if (commandAction) {
    await handleWorkflowCardCommand({ ...input, command: commandAction });
    return;
  }
  const todoAction = parseTodoCardAction(input.event.action.value);
  if (todoAction) {
    await handleTodoCardAction({ ...input, action: todoAction });
    return;
  }
  const action = parseCardAction(input.event.action.value);
  if (!action) return;
  const access = decideFeishuAccess(input.config, {
    senderOpenId: input.event.operator.openId,
    chatId: input.event.chatId,
    chatType: 'group',
  });
  if (!access.ok) {
    console.warn(`[interaction] denied card action ${input.event.chatId}; operator=${input.event.operator.openId.slice(-6)}; reason=${access.reason}`);
    return;
  }
  const control = decideFeishuControl(input.config, access, { effect: 'workflow_trigger' });
  if (!control.ok) {
    await input.channel.send(input.event.chatId, { text: `权限不足：${control.reason}` }, { replyTo: input.event.messageId });
    return;
  }

  const label = action.replaceAll('_', ' ');
  await input.channel.send(input.event.chatId, { text: `正在运行 ${label}...` }, { replyTo: input.event.messageId });
  console.log(`[interaction] started ${input.event.chatId}; card-action=${action}`);
  const progressTimer = setTimeout(() => {
    void input.channel
      .send(
        input.event.chatId,
        { text: `${label} 还在运行，通常需要 1-3 分钟。完成后我会发一张新的 Daily OS 卡片。` },
        { replyTo: input.event.messageId },
      )
      .catch((error: unknown) => console.warn(`[interaction] failed to send card-action progress notice: ${error instanceof Error ? error.message : String(error)}`));
  }, 60_000);
  try {
    const result = await runWorkflowDetailed(input.config, action, { send: false, trigger: 'card_action', source: `card-action:${input.event.chatId}` });
    const output = result.text;
    const date = todayInTimezone(input.config);
    const evidence = action === 'weekly_review' ? await collectEvidence(input.config, date) : undefined;
    const summary = formatWorkflowSummaryForFeishu(action, date, output, evidence, input.config);
    const todos = action === 'daily_plan' ? extractDailyPlanTodos(output) : [];
    try {
      await input.channel.send(
        input.event.chatId,
        { card: renderFeishuWorkflowCard(summary, { workflow: action, date, ...(todos.length ? { todos } : {}) }) },
        { replyTo: input.event.messageId },
      );
      if (todos.length) recordTodoPresented(input.config, date, todos.map((todo) => ({ candidateId: todo.candidateId, rank: todo.rank })));
      markWorkflowRunSucceeded(input.config, result.run, { enabled: true, provider: 'feishu_interaction', mode: 'card', status: 'succeeded' });
    } catch (error) {
      markWorkflowRunFailed(input.config, result.run, error, { sendFailed: true });
      throw error;
    }
    console.log(`[interaction] handled ${input.event.chatId}; card-action=${action}`);
  } finally {
    clearTimeout(progressTimer);
  }
}

async function handleWorkflowCardCommand(input: {
  config: AppConfig;
  channel: LarkChannel;
  event: CardActionEvent;
  activeAgentRuns: Map<string, ActiveAgentRun>;
  command: WorkflowCardCommand;
}): Promise<void> {
  const access = decideFeishuAccess(input.config, {
    senderOpenId: input.event.operator.openId,
    chatId: input.event.chatId,
    chatType: 'group',
  });
  if (!access.ok) {
    console.warn(`[interaction] denied card command ${input.event.chatId}; operator=${input.event.operator.openId.slice(-6)}; reason=${access.reason}`);
    return;
  }
  if (input.command.command === 'details') {
    const detail = input.command.detailId ? readWorkflowDetailCache(input.config, input.command.detailId) : readLatestWorkflowOutput(input.config);
    await input.channel.send(
      input.event.chatId,
      toSendInput(detail ? formatLatestWorkflowDetails(detail) : '老板，目前还没有可展开的最近一次计划/复盘详情。', input.config.interaction.feishu.reply_mode),
      { replyTo: input.event.messageId },
    );
    console.log(`[interaction] handled ${input.event.chatId}; card-command=details; cached=${Boolean(input.command.detailId)}`);
    return;
  }
  if (input.command.command === 'confirm_todo') {
    const date = todayInTimezone(input.config);
    appendDailyMemory(input.config, 'daily_plan', date, '用户已确认今日安排。日复盘时需要用最近一次今日计划作为对照依据。');
    await input.channel.send(input.event.chatId, { text: '收到，今日安排已确认。我会在今日复盘时按这张计划对照完成情况。' }, { replyTo: input.event.messageId });
    console.log(`[interaction] handled ${input.event.chatId}; card-command=confirm_todo`);
    return;
  }
  if (input.command.command === 'confirm_review') {
    const date = todayInTimezone(input.config);
    appendDailyMemory(input.config, 'daily_review', date, '用户确认今日复盘无异议。今天的完成项、暂缓项和后续动作可以按这版记录。');
    const carried = persistDailyReviewCarryOver(input.config, date);
    await input.channel.send(
      input.event.chatId,
      { text: carried > 0 ? `收到，今日复盘已确认无异议。${carried} 项未闭环任务会带入明天安排。` : '收到，今日复盘已确认无异议。我会按这版记录今天的进展和未闭环事项。' },
      { replyTo: input.event.messageId },
    );
    console.log(`[interaction] handled ${input.event.chatId}; card-command=confirm_review; carry_over=${carried}`);
    return;
  }
  if (input.command.command === 'carry_open_review') {
    const date = todayInTimezone(input.config);
    appendDailyMemory(input.config, 'daily_review', date, '用户确认：明天继续未闭环任务。下一次今日安排需要优先带入今日复盘中的未闭环事项。');
    const carried = persistDailyReviewCarryOver(input.config, date);
    await input.channel.send(
      input.event.chatId,
      { text: carried > 0 ? `收到，今日复盘里的 ${carried} 项未闭环任务会带入明天安排。` : '收到，今日复盘里的未闭环任务会带入明天安排。' },
      { replyTo: input.event.messageId },
    );
    console.log(`[interaction] handled ${input.event.chatId}; card-command=carry_open_review; carry_over=${carried}`);
    return;
  }
  if (input.command.command === 'revise_todo') {
    await input.channel.send(
      input.event.chatId,
      {
        text: [
          '可以，直接告诉我你想怎么改。',
          '',
          '例如：',
          '今天先不做 LEO-12，改成优先处理导师邮件。',
          '或者：把 LEO-12 降级，明天再跟进。',
          '',
          '我收到后会先回你确认，并把修改意见写入今天的上下文。之后点「重新生成」或发送 daily-os plan，我会按新意见重排。',
        ].join('\n'),
      },
      { replyTo: input.event.messageId },
    );
    console.log(`[interaction] handled ${input.event.chatId}; card-command=revise_todo`);
    return;
  }
  if (input.command.command === 'progress') {
    const date = todayInTimezone(input.config);
    const progress = await collectProgressCandidates(input.config, date);
    await input.channel.send(input.event.chatId, { card: renderProgressConfirmationCard(input.config, progress) }, { replyTo: input.event.messageId });
    console.log(`[interaction] handled ${input.event.chatId}; card-command=progress-card`);
    return;
  }
  const result = await handleDailyOsCommand({
    config: input.config,
    messageId: input.event.messageId,
    text: `${input.config.interaction.feishu.command_prefix} ${input.command.command}`,
    source: `feishu-card:${input.event.chatId}`,
    prefix: input.config.interaction.feishu.command_prefix,
    sendWorkflowOutput: false,
    accessDecision: access,
    sessionScopeId: input.event.chatId,
    stopAgentRun: async () => stopAgentRun(input.activeAgentRuns, input.event.chatId),
    sendWorkflowCard: async ({ workflow, date, text, summary }) => {
      await sendWorkflowCardOutput(input.config, workflow, date, summary, `card-command:${input.event.chatId}`, text);
    },
    sendSkillCard: async ({ result: skillResult, text: skillText }) => {
      await sendSkillCardOutput(input.config, skillText, skillResult, `card-command:${input.event.chatId}`);
    },
    sendCalendarCard: async ({ result: calendarResult, text: calendarText }) => {
      await sendCalendarCardOutput(input.config, calendarText, calendarResult, `card-command:${input.event.chatId}`);
    },
    reply: async (reply) => {
      await input.channel.send(input.event.chatId, toSendInput(reply, input.config.interaction.feishu.reply_mode), {
        replyTo: input.event.messageId,
      });
    },
  });
  if (result.handled) console.log(`[interaction] handled ${input.event.chatId}; card-command=${result.command.type}`);
}

async function handleProgressCardAction(input: {
  config: AppConfig;
  channel: LarkChannel;
  event: CardActionEvent;
  action: { action: 'confirm_all' | 'ignore_all' | 'details' | 'review'; date: string; candidateIds: string[] };
}): Promise<void> {
  const access = decideFeishuAccess(input.config, {
    senderOpenId: input.event.operator.openId,
    chatId: input.event.chatId,
    chatType: 'group',
  });
  if (!access.ok) {
    console.warn(`[interaction] denied progress card action ${input.event.chatId}; operator=${input.event.operator.openId.slice(-6)}; reason=${access.reason}`);
    return;
  }
  const control = decideFeishuControl(input.config, access, { effect: 'memory_write' });
  if (!control.ok) {
    await input.channel.send(input.event.chatId, { text: `权限不足：${control.reason}` }, { replyTo: input.event.messageId });
    return;
  }

  const result = await collectProgressCandidates(input.config, input.action.date);
  const selected = result.candidates.filter((candidate) => input.action.candidateIds.includes(candidate.id));
  if (input.action.action === 'confirm_all') {
    const ledgerPath = appendConfirmedProgress(input.config, input.action.date, confirmedEntriesFromCandidates(selected));
    await input.channel.send(
      input.event.chatId,
      {
        text:
          selected.length > 0
            ? `已确认 ${selected.length} 条今日进展，并写入：${ledgerPath}`
            : '没有可写入的进展候选；可能候选已经变化或为空。',
      },
      { replyTo: input.event.messageId },
    );
    return;
  }
  if (input.action.action === 'review') {
    await input.channel.send(input.event.chatId, { card: renderProgressBatchReviewCard(input.config, result) }, { replyTo: input.event.messageId });
    return;
  }
  if (input.action.action === 'details') {
    await input.channel.send(input.event.chatId, toSendInput(formatProgressCandidates(result), input.config.interaction.feishu.reply_mode), {
      replyTo: input.event.messageId,
    });
    return;
  }
  await input.channel.send(input.event.chatId, { text: '好的，这次不写入今日进展账本。' }, { replyTo: input.event.messageId });
}

async function handleSyncDriftCardAction(input: {
  config: AppConfig;
  channel: LarkChannel;
  event: CardActionEvent;
  action: ParsedSyncDriftCardAction;
}): Promise<void> {
  const access = decideFeishuAccess(input.config, {
    senderOpenId: input.event.operator.openId,
    chatId: input.event.chatId,
    chatType: 'group',
  });
  if (!access.ok) {
    console.warn(`[interaction] denied sync-drift card action ${input.event.chatId}; operator=${input.event.operator.openId.slice(-6)}; reason=${access.reason}`);
    return;
  }
  // "起草更新" only produces suggestion text (read effect); ignore / mark-handled
  // record a local decision so the same finding+date is not re-prompted.
  const control = decideFeishuControl(input.config, access, {
    effect: input.action.action === 'draft' ? 'read' : 'memory_write',
  });
  if (!control.ok) {
    await input.channel.send(input.event.chatId, { text: `权限不足：${control.reason}` }, { replyTo: input.event.messageId });
    return;
  }

  if (input.action.action === 'draft') {
    const evidence = await collectEvidence(input.config, input.action.date);
    const findings = filterUndecidedFindings(collectSyncDrift(evidence, input.config).findings, input.action.date);
    await input.channel.send(
      input.event.chatId,
      toSendInput(renderSyncDriftDraft(findings), input.config.interaction.feishu.reply_mode),
      { replyTo: input.event.messageId },
    );
    return;
  }

  for (const key of input.action.keys) {
    recordSyncDriftDecision({ key, date: input.action.date, decision: input.action.action });
  }
  const label = input.action.action === 'ignore' ? '忽略' : '标记已处理';
  await input.channel.send(
    input.event.chatId,
    { text: `好的，已${label}这些同步提醒，今天不会再重复提示。GitHub / Linear 不会被自动修改。` },
    { replyTo: input.event.messageId },
  );
}

async function handleCalendarCardAction(input: {
  config: AppConfig;
  channel: LarkChannel;
  event: CardActionEvent;
  action: CalendarCardAction;
}): Promise<void> {
  const access = decideFeishuAccess(input.config, {
    senderOpenId: input.event.operator.openId,
    chatId: input.event.chatId,
    chatType: 'group',
  });
  if (!access.ok) {
    console.warn(`[interaction] denied calendar card action ${input.event.chatId}; operator=${input.event.operator.openId.slice(-6)}; reason=${access.reason}`);
    return;
  }
  const control = decideFeishuControl(input.config, access, {
    effect: input.action.action === 'confirm' ? 'memory_write' : 'read',
  });
  if (!control.ok) {
    await input.channel.send(input.event.chatId, { text: `权限不足：${control.reason}` }, { replyTo: input.event.messageId });
    return;
  }

  const label = input.action.period === 'week' ? '本周日历草稿' : '今日日历草稿';
  if (input.action.action === 'confirm') {
    // Default (writeback off): keep the draft-only behavior — record a note only.
    if (!input.config.calendar.writeback.enabled) {
      appendDailyMemory(input.config, 'daily_plan', todayInTimezone(input.config), `用户确认${label}可作为排程参考；尚未写入任何外部日历。`);
      await input.channel.send(input.event.chatId, { text: `收到，${label}已确认。我只记录为排程参考，没有修改 Feishu / Apple / Google Calendar。` }, { replyTo: input.event.messageId });
      return;
    }
    const snapshot = input.action.draftId ? dbLoadCalendarDraftSnapshot(input.action.draftId) : undefined;
    const draft = snapshot ? parseCalendarDraftSnapshot(snapshot) : undefined;
    if (!draft) {
      await input.channel.send(input.event.chatId, { text: `这版${label}已过期，请重新发送 daily-os calendar ${input.action.period === 'week' ? 'week' : 'today'} 生成后再确认。` }, { replyTo: input.event.messageId });
      return;
    }
    const summary = await writebackCalendarDraft(input.config, draft);
    const parts = [`新建 ${summary.created}`, `更新 ${summary.updated}`, `跳过 ${summary.skipped}`];
    if (summary.blocked > 0) parts.push(`冲突跳过 ${summary.blocked}`);
    if (summary.failed > 0) parts.push(`失败 ${summary.failed}`);
    appendDailyMemory(input.config, 'daily_plan', todayInTimezone(input.config), `用户确认${label}并写入 Feishu 日历（${parts.join('，')}；batch=${summary.batchId ?? '-'}）。`);
    const warnLine = summary.conflicts > summary.blocked ? `\n⚠️ 有 ${summary.conflicts - summary.blocked} 个时间块与已有日程重叠（已按 warn 策略写入）。` : '';
    const undoHint = summary.batchId ? '\n如需撤销，发送 daily-os calendar undo。' : '';
    await input.channel.send(input.event.chatId, { text: `已把${label}写入 Feishu 日历：${parts.join('，')}。${warnLine}${undoHint}` }, { replyTo: input.event.messageId });
    return;
  }
  if (input.action.action === 'adjust') {
    const p = input.action.period === 'week' ? 'week' : 'today';
    await input.channel.send(
      input.event.chatId,
      {
        text: [
          '可以，把调整用一条命令发给我，我会记录并在下次生成草稿时应用（可多次累积）：',
          '',
          `daily-os calendar ${p} adjust: 把 深度工作 挪到 上午，删掉 报销`,
          '',
          '支持：删除 / 改时段（上午·14:00）/ 改日期（周四）/ 改时长（缩到 60 分钟）。',
          `记录后发送 daily-os calendar ${p} 查看应用后的草稿；daily-os calendar ${p} adjust: clear 可清空。`,
        ].join('\n'),
      },
      { replyTo: input.event.messageId },
    );
    return;
  }
  await input.channel.send(input.event.chatId, { text: `收到，本次先不采用${label}。` }, { replyTo: input.event.messageId });
}

async function handleAgentRunCardAction(input: {
  config: AppConfig;
  channel: LarkChannel;
  event: CardActionEvent;
  queue: PendingQueue<NormalizedMessage>;
  chatModes: Map<string, ChatMode>;
  activeAgentRuns: Map<string, ActiveAgentRun>;
  action: { action: 'stop' | 'followup'; runId: string; scopeId: string; text?: string };
}): Promise<void> {
  const mode = await resolveChatMode(input.channel, input.event.chatId, input.chatModes, 'group');
  const threadId = mode === 'topic' ? await lookupMessageThreadId(input.channel, input.event.messageId) : undefined;
  const scope = mode === 'topic' && threadId ? `${input.event.chatId}:${threadId}` : input.event.chatId;
  const access = decideFeishuAccess(input.config, {
    senderOpenId: input.event.operator.openId,
    chatId: input.event.chatId,
    chatType: mode === 'p2p' ? 'p2p' : 'group',
  });
  if (!access.ok) {
    console.warn(`[interaction] denied agent card action ${input.event.chatId}; operator=${input.event.operator.openId.slice(-6)}; reason=${access.reason}`);
    return;
  }
  if (input.action.action === 'stop') {
    const stopped = await stopAgentRunByScopeOrId(input.activeAgentRuns, scope, input.action.scopeId, input.action.runId);
    await input.channel.send(input.event.chatId, { text: stopped ? '已请求停止当前 Codex 任务。' : '当前没有可停止的 Codex 任务。' }, { replyTo: input.event.messageId });
    return;
  }

  const synthetic: NormalizedMessage = {
    messageId: input.event.messageId,
    chatId: input.event.chatId,
    chatType: mode === 'p2p' ? 'p2p' : 'group',
    senderId: input.event.operator.openId,
    senderName: input.event.operator.name,
    content: `[card-callback] ${JSON.stringify({ action: input.action.action, run_id: input.action.runId, text: input.action.text || '继续讨论' })}`,
    rawContentType: 'card_action',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: true,
    createTime: Date.now(),
    ...(threadId ? { threadId } : {}),
  };
  console.log(`[interaction] queued ${scope}; source=agent-card-callback`);
  const queued = input.queue.push(scope, synthetic);
  await input.channel.send(input.event.chatId, { text: `已加入后续消息队列（${queued}）。` }, { replyTo: input.event.messageId });
}

async function handleSkillCardAction(input: {
  config: AppConfig;
  channel: LarkChannel;
  event: CardActionEvent;
  activeAgentRuns: Map<string, ActiveAgentRun>;
  action: SkillCardAction;
}): Promise<void> {
  const access = decideFeishuAccess(input.config, {
    senderOpenId: input.event.operator.openId,
    chatId: input.event.chatId,
    chatType: 'group',
  });
  if (!access.ok) {
    console.warn(`[interaction] denied skill card action ${input.event.chatId}; operator=${input.event.operator.openId.slice(-6)}; reason=${access.reason}`);
    return;
  }
  if (input.action.action === 'dismiss') {
    await input.channel.send(input.event.chatId, { text: '好的，这次不写回 Feishu 文档。' }, { replyTo: input.event.messageId });
    return;
  }
  if (input.action.action === 'prepare_writeback' || input.action.action === 'confirm_writeback') {
    const control = decideFeishuControl(input.config, access, { effect: 'memory_write' });
    if (!control.ok) {
      await input.channel.send(input.event.chatId, { text: `权限不足：${control.reason}` }, { replyTo: input.event.messageId });
      return;
    }
    try {
      const plan = await prepareLifeReviewOsWriteback({
        config: input.config,
        skillId: input.action.skillId,
        ...(input.action.mode ? { mode: input.action.mode } : {}),
        ...(input.action.runId ? { runId: input.action.runId } : {}),
      });
      await input.channel.send(
        input.event.chatId,
        {
          card: renderFeishuSkillWritebackPreviewCard({
            token: plan.token,
            skillId: plan.skillId,
            mode: plan.mode,
            docLabel: plan.target.docLabel,
            weekLabel: plan.target.weekLabel,
            taskHeader: plan.target.taskHeader,
            action: plan.target.action,
            items: plan.items,
            ...(plan.review ? { review: plan.review } : {}),
          }),
        },
        { replyTo: input.event.messageId },
      );
    } catch (error) {
      await input.channel.send(input.event.chatId, { text: `写回预检失败：${error instanceof Error ? error.message : String(error)}` }, { replyTo: input.event.messageId });
    }
    return;
  }
  if (input.action.action === 'execute_review') {
    const control = decideFeishuControl(input.config, access, { effect: 'memory_write' });
    if (!control.ok) {
      await input.channel.send(input.event.chatId, { text: `权限不足：${control.reason}` }, { replyTo: input.event.messageId });
      return;
    }
    if (!input.action.token) {
      await input.channel.send(input.event.chatId, { text: '缺少确认 token，请重新点「准备写回」。' }, { replyTo: input.event.messageId });
      return;
    }
    const review = await executeLifeReviewOsRetroReview(input.config, input.action.skillId, input.action.token);
    await input.channel.send(input.event.chatId, { text: formatRetroReviewOutcome(review) || 'retro review 未写入' }, { replyTo: input.event.messageId });
    return;
  }
  if (input.action.action === 'execute_writeback') {
    const control = decideFeishuControl(input.config, access, { effect: 'memory_write' });
    if (!control.ok) {
      await input.channel.send(input.event.chatId, { text: `权限不足：${control.reason}` }, { replyTo: input.event.messageId });
      return;
    }
    if (!input.action.token) {
      await input.channel.send(input.event.chatId, { text: '缺少写回确认 token，请重新点「准备写回」。' }, { replyTo: input.event.messageId });
      return;
    }
    try {
      await input.channel.send(input.event.chatId, { text: '正在写回 Feishu Weekly；我会先校验目标列，不会覆盖已有不同内容。' }, { replyTo: input.event.messageId });
      const result = await executeLifeReviewOsWriteback(input.config, input.action.skillId, input.action.token);
      await input.channel.send(
        input.event.chatId,
        {
          text: [
            result.alreadyWritten ? 'Feishu Weekly 已经有这次写回内容；我没有重复写入。' : '已写回 Feishu Weekly。',
            '',
            `周列：${result.taskHeader}`,
            `本次新写入：${result.itemCount} 条要务`,
            result.skippedCount ? `已存在并跳过：${result.skippedCount} 条要务` : '',
            result.insertedColumns ? '操作：已插入新周列' : '操作：写入已有空周列',
            '',
            'retro review 未写入——它是单独一次确认，点卡片上的「写入 review」。',
          ]
            .filter(Boolean)
            .join('\n'),
        },
        { replyTo: input.event.messageId },
      );
    } catch (error) {
      await input.channel.send(input.event.chatId, { text: `写回失败：${error instanceof Error ? error.message : String(error)}` }, { replyTo: input.event.messageId });
    }
    return;
  }
  if (input.action.action === 'confirm_okr_writeback') {
    const control = decideFeishuControl(input.config, access, { effect: 'memory_write' });
    if (!control.ok) {
      await input.channel.send(input.event.chatId, { text: `权限不足：${control.reason}` }, { replyTo: input.event.messageId });
      return;
    }
    const run = readLatestSkillRun(input.config, input.action.skillId, input.action.mode || 'biweekly', input.action.runId);
    if (!run) {
      await input.channel.send(input.event.chatId, { text: '找不到对应的双周复盘草稿，请先重新运行 biweekly。' }, { replyTo: input.event.messageId });
      return;
    }
    try {
      const date = todayInTimezone(input.config);
      const { outcome, incrementLines, flaggedLines } = executeConfirmedOkrWriteback({
        config: input.config,
        draft: run.output,
        date,
        inputPackPath: run.inputPackPath,
      });
      const failedLines = outcome.results.filter((entry) => !entry.ok).map((entry) => `- ${entry.krId}：${entry.reason || '写回失败'}`);
      await input.channel.send(
        input.event.chatId,
        {
          text: [
            `已写回本地 OKR：成功 ${outcome.succeeded} 条，失败 ${outcome.failed} 条。`,
            outcome.historyAppended ? `滚动历史新增 ${outcome.historyAppended} 行。` : '',
            incrementLines.length ? ['', '进度增量：', ...incrementLines.map((line) => `- ${line}`)].join('\n') : '',
            flaggedLines.length ? ['', '⚠️ 以下 KR 未写回（证据未通过校验，需人工确认）：', ...flaggedLines.map((line) => `- ${line}`)].join('\n') : '',
            failedLines.length ? ['', '失败明细：', ...failedLines].join('\n') : '',
          ]
            .filter(Boolean)
            .join('\n'),
        },
        { replyTo: input.event.messageId },
      );
    } catch (error) {
      await input.channel.send(input.event.chatId, { text: `本地 OKR 写回失败：${error instanceof Error ? error.message : String(error)}` }, { replyTo: input.event.messageId });
    }
    return;
  }
  if (input.action.action === 'writeback_info') {
    await input.channel.send(
      input.event.chatId,
      {
        text: [
          '这张卡片是 skill 草稿预览。',
          '',
          '点「准备写回」会先生成二次确认卡，列出目标 Weekly、周列和要写入的要务。',
          '只有在二次确认卡里点「确认写回」后，才会修改 Feishu Doc。',
        ].join('\n'),
      },
      { replyTo: input.event.messageId },
    );
    return;
  }

  const commandText = `${input.config.interaction.feishu.command_prefix} skill run ${input.action.skillId}${input.action.mode ? ` ${input.action.mode}` : ''}`;
  const result = await handleDailyOsCommand({
    config: input.config,
    messageId: input.event.messageId,
    text: commandText,
    source: `skill-card:${input.event.chatId}`,
    prefix: input.config.interaction.feishu.command_prefix,
    sendWorkflowOutput: false,
    accessDecision: access,
    sessionScopeId: input.event.chatId,
    stopAgentRun: async () => stopAgentRun(input.activeAgentRuns, input.event.chatId),
    sendWorkflowCard: async ({ workflow, date, text, summary }) => {
      await sendWorkflowCardOutput(input.config, workflow, date, summary, `skill-card:${input.event.chatId}`, text);
    },
    sendSkillCard: async ({ result: skillResult, text: skillText }) => {
      await sendSkillCardOutput(input.config, skillText, skillResult, `skill-card:${input.event.chatId}`);
    },
    sendCalendarCard: async ({ result: calendarResult, text: calendarText }) => {
      await sendCalendarCardOutput(input.config, calendarText, calendarResult, `skill-card:${input.event.chatId}`);
    },
    reply: async (reply) => {
      await input.channel.send(input.event.chatId, toSendInput(reply, input.config.interaction.feishu.reply_mode), {
        replyTo: input.event.messageId,
      });
    },
  });
  if (result.handled) console.log(`[interaction] handled ${input.event.chatId}; skill-card=${input.action.action}`);
}

async function lookupMessageThreadId(channel: LarkChannel, messageId: string): Promise<string | undefined> {
  try {
    const response = (await channel.rawClient.im.v1.message.get({
      path: { message_id: messageId },
    })) as { data?: { items?: { thread_id?: string }[] } };
    return response.data?.items?.[0]?.thread_id;
  } catch (error) {
    console.warn(`[interaction] failed to resolve card thread: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

async function sendStatusCard(channel: LarkChannel, message: NormalizedMessage, config: AppConfig): Promise<void> {
  await channel.send(
    message.chatId,
    {
      card: {
        config: { wide_screen_mode: true },
        header: {
          template: 'green',
          title: { tag: 'plain_text', content: 'Daily OS' },
        },
        elements: [
          {
            tag: 'markdown',
            content: [
              '**Daily OS 飞书交互层正在运行。**',
              '',
              `命令前缀：\`${config.interaction.feishu.command_prefix}\``,
              '你可以点击下面按钮，或直接在这个聊天里发送命令。',
            ].join('\n'),
          },
          {
            tag: 'action',
            actions: [
              cardButton('Plan', 'daily_plan', 'primary'),
              cardButton('Review', 'daily_review', 'default'),
              cardButton('Weekly', 'weekly_review', 'default'),
              commandButton('Calendar Week', 'calendar week', 'default'),
              commandButton('Calendar Today', 'calendar today', 'default'),
            ],
          },
        ],
      },
    },
    {
      replyTo: message.messageId,
      ...(message.threadId ? { replyInThread: true } : {}),
    },
  );
}

function cardButton(label: string, action: WorkflowName, type: 'primary' | 'default'): object {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: label },
    type,
    value: { daily_os_action: action },
  };
}

function commandButton(label: string, command: WorkflowCardCommand['command'], type: 'primary' | 'default'): object {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: label },
    type,
    value: { daily_os_command: command },
  };
}

function parseCardAction(value: unknown): WorkflowName | null {
  if (!value || typeof value !== 'object') return null;
  const raw = (value as { daily_os_action?: unknown }).daily_os_action;
  if (raw === 'daily_plan' || raw === 'daily_review' || raw === 'weekly_review') return raw;
  return null;
}

function parseWorkflowCardCommand(value: unknown): WorkflowCardCommand | null {
  if (!value || typeof value !== 'object') return null;
  const raw = (value as { daily_os_command?: unknown }).daily_os_command;
  if (
    raw === 'details' ||
    raw === 'progress' ||
    raw === 'chat todo' ||
    raw === 'chat review' ||
    raw === 'confirm_todo' ||
    raw === 'confirm_review' ||
    raw === 'carry_open_review' ||
    raw === 'revise_todo' ||
    raw === 'calendar week' ||
    raw === 'calendar today'
  ) {
    const detailId = (value as { detail_id?: unknown }).detail_id;
    return { command: raw, ...(typeof detailId === 'string' && detailId ? { detailId } : {}) };
  }
  return null;
}

interface TodoCardAction {
  action: 'complete' | 'defer';
  candidateId: string;
  rank: number;
}

function parseTodoCardAction(value: unknown): TodoCardAction | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as { daily_os_todo_action?: unknown; candidate_id?: unknown; rank?: unknown };
  const action = raw.daily_os_todo_action;
  if (action !== 'complete' && action !== 'defer') return null;
  const candidateId = typeof raw.candidate_id === 'string' ? raw.candidate_id : '';
  const rank = typeof raw.rank === 'string' ? Number.parseInt(raw.rank, 10) : typeof raw.rank === 'number' ? raw.rank : 0;
  return { action, candidateId, rank: Number.isFinite(rank) ? rank : 0 };
}

async function handleTodoCardAction(input: {
  config: AppConfig;
  channel: LarkChannel;
  event: CardActionEvent;
  activeAgentRuns: Map<string, ActiveAgentRun>;
  action: TodoCardAction;
}): Promise<void> {
  const access = decideFeishuAccess(input.config, {
    senderOpenId: input.event.operator.openId,
    chatId: input.event.chatId,
    chatType: 'group',
  });
  if (!access.ok) {
    console.warn(`[interaction] denied todo card action ${input.event.chatId}; operator=${input.event.operator.openId.slice(-6)}; reason=${access.reason}`);
    return;
  }
  const date = todayInTimezone(input.config);
  recordTodoFeedback(input.config, {
    date,
    event: input.action.action,
    candidateId: input.action.candidateId,
    rank: input.action.rank,
    source: `card-action:${input.event.chatId}`,
  });
  syncTodoInboxFromPlanRow(input.config, input.action.candidateId, input.action.action);
  const label = input.action.action === 'complete' ? '完成' : '推迟';
  await input.channel.send(
    input.event.chatId,
    { text: `收到，已记录第 ${input.action.rank} 条为「${label}」。我会用它来校准明天的 todo 排序。` },
    { replyTo: input.event.messageId },
  );
  console.log(`[interaction] handled ${input.event.chatId}; todo-action=${input.action.action}; rank=${input.action.rank}`);
}

/**
 * LEO-232 — on daily-review confirmation, recover the reconciliation from the
 * latest persisted review output and persist its `carry_over` candidateIds to
 * the todo feedback ledger so the scorer can build a carry-over streak. No-op
 * (returns 0) when the latest output is not today's reconciliation JSON.
 */
function persistDailyReviewCarryOver(config: AppConfig, date: string): number {
  const latest = readLatestWorkflowOutput(config);
  if (!latest || latest.workflow !== 'daily_review' || latest.date !== date) return 0;
  const recon = parseDailyReviewReconciliation(latest.content);
  if (!recon) return 0;
  const carryIds = selectCarryOverCandidateIds(recon);
  if (carryIds.length === 0) return 0;
  recordCarryOver(config, date, carryIds);
  return carryIds.length;
}

function parseCalendarCardAction(value: unknown): CalendarCardAction | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as { daily_os_calendar_action?: unknown; period?: unknown; draftId?: unknown };
  const action = raw.daily_os_calendar_action;
  const period = raw.period;
  if ((action !== 'confirm' && action !== 'adjust' && action !== 'skip') || (period !== 'week' && period !== 'today')) return null;
  return { action, period, draftId: typeof raw.draftId === 'string' ? raw.draftId : undefined };
}

function parseSkillCardAction(value: unknown): SkillCardAction | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as { daily_os_skill_action?: unknown; skill_id?: unknown; mode?: unknown; run_id?: unknown; token?: unknown };
  const action = raw.daily_os_skill_action;
  const skillId = raw.skill_id;
  if (
    (action !== 'confirm_writeback' &&
      action !== 'writeback_info' &&
      action !== 'prepare_writeback' &&
      action !== 'execute_writeback' &&
      action !== 'execute_review' &&
      action !== 'confirm_okr_writeback' &&
      action !== 'rerun' &&
      action !== 'dismiss') ||
    typeof skillId !== 'string' ||
    !skillId
  ) {
    return null;
  }
  return {
    action,
    skillId,
    ...(typeof raw.mode === 'string' && raw.mode ? { mode: raw.mode } : {}),
    ...(typeof raw.run_id === 'string' && raw.run_id ? { runId: raw.run_id } : {}),
    ...(typeof raw.token === 'string' && raw.token ? { token: raw.token } : {}),
  };
}

function claimCardAction(recent: Map<string, number>, event: CardActionEvent): boolean {
  const now = Date.now();
  for (const [key, expiresAt] of recent) {
    if (expiresAt <= now) recent.delete(key);
  }
  const key = cardActionKey(event);
  if (recent.has(key)) return false;
  recent.set(key, now + CARD_ACTION_DEDUPE_MS);
  return true;
}

function cardActionKey(event: CardActionEvent): string {
  return [event.chatId, event.messageId, event.operator.openId, stableStringify(event.action.value)].join(':');
}

function stableStringify(value: unknown): string {
  if (!value || typeof value !== 'object') return String(value);
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify(Object.fromEntries(entries));
}

async function replyToMessage(channel: LarkChannel, message: NormalizedMessage, text: string, mode: 'markdown' | 'text'): Promise<void> {
  const chatMode = message.threadId ? 'topic' : message.chatType;
  const result = await channel.send(message.chatId, toSendInput(text, mode), {
    replyTo: message.messageId,
    ...(chatMode === 'topic' ? { replyInThread: true } : {}),
  });
  // Record our own outbound message_id so the dual-identity fallback in the
  // self-origin guard can recognize this reply if it ever echoes back (see
  // ./self-origin.ts — SelfSentMessageCache).
  selfOriginGuard?.recordSelfSent(result.messageId);
}

async function sendWorkflowCardOutput(
  config: AppConfig,
  workflow: WorkflowName,
  date: string,
  summary: string,
  source: string,
  rawText?: string,
): Promise<void> {
  console.log(`[interaction] sending workflow-card source=${source}; workflow=${workflow}; bytes=${Buffer.byteLength(summary, 'utf8')}`);
  const todos = workflow === 'daily_plan' && rawText ? extractDailyPlanTodos(rawText) : [];
  await sendFeishuCard(config, renderFeishuWorkflowCard(summary, { workflow, date, ...(todos.length ? { todos } : {}) }), summary);
  if (todos.length) recordTodoPresented(config, date, todos.map((todo) => ({ candidateId: todo.candidateId, rank: todo.rank })));
  console.log(`[interaction] sent workflow-card source=${source}; workflow=${workflow}`);
}

async function sendSkillCardOutput(config: AppConfig, text: string, result: SkillRunResult, source: string): Promise<void> {
  console.log(`[interaction] sending skill-card source=${source}; skill=${result.skillId}; bytes=${Buffer.byteLength(text, 'utf8')}`);
  await sendFeishuCard(
    config,
    renderFeishuSkillCard(result.output, {
      skillId: result.skillId,
      mode: result.mode,
      provider: result.provider,
      inputPackPath: result.inputPackPath,
      draftOnly: result.draftOnly,
      ...(result.runId ? { runId: result.runId } : {}),
    }),
    text,
  );
  console.log(`[interaction] sent skill-card source=${source}; skill=${result.skillId}`);
  await maybeSendOkrWritebackCard(config, result, source);
}

/**
 * For biweekly review drafts that carry a parseable KR-progress block, follow the
 * skill card with a local-OKR write-back confirm card (LEO-109). Degrades
 * silently to narrative-only when nothing parses or no KR matches.
 */
async function maybeSendOkrWritebackCard(config: AppConfig, result: SkillRunResult, source: string): Promise<void> {
  if (result.mode !== 'biweekly') return;
  try {
    const preview = buildOkrWritebackPreview({ config, draft: result.output, inputPackPath: result.inputPackPath });
    if (!preview.hasProgress) return;
    await sendFeishuCard(
      config,
      renderOkrWritebackCard({
        skillId: result.skillId,
        mode: result.mode,
        ...(result.runId ? { runId: result.runId } : {}),
        preview,
      }),
      [...preview.incrementLines, ...preview.flaggedLines.map((line) => `⚠️ ${line}`)].join('\n'),
    );
    console.log(`[interaction] sent okr-writeback-card source=${source}; skill=${result.skillId}; krs=${preview.matched.length}; flagged=${preview.flagged.length}`);
  } catch (error) {
    console.warn(`[interaction] okr-writeback-card skipped: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseCalendarDraftSnapshot(payload: string): CalendarDraft | undefined {
  try {
    const parsed = JSON.parse(payload) as CalendarDraft;
    return Array.isArray(parsed?.events) && typeof parsed.draftId === 'string' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function sendCalendarCardOutput(config: AppConfig, text: string, result: CalendarDraftResult, source: string): Promise<void> {
  const eventCount = result.draft?.events?.length || 0;
  const writebackSupported = Boolean(result.draft?.writeback?.supported);
  const writebackEnabled = config.calendar.writeback.enabled;
  // Persist the exact draft so the confirm card action writes back what was shown.
  if (result.draft) {
    dbSaveCalendarDraftSnapshot(result.draft.draftId, result.draft.period, JSON.stringify(result.draft), new Date().toISOString());
  }
  console.log(`[interaction] sending calendar-card source=${source}; period=${result.period}; events=${eventCount}; bytes=${Buffer.byteLength(text, 'utf8')}`);
  await sendFeishuCard(
    config,
    renderFeishuCalendarDraftCard(text, {
      period: result.period,
      date: result.date,
      eventCount,
      taskCount: result.taskCount,
      engine: result.engine,
      writebackSupported,
      draftId: result.draft?.draftId,
      writebackEnabled,
    }),
    text,
  );
  console.log(`[interaction] sent calendar-card source=${source}; period=${result.period}`);
}

function toSendInput(text: string, mode: 'markdown' | 'text'): { markdown: string } | { text: string } {
  return mode === 'markdown' ? { markdown: text } : { text };
}

async function resolveChatMode(channel: LarkChannel, chatId: string, cache: Map<string, ChatMode>, fallback: 'p2p' | 'group'): Promise<ChatMode> {
  const cached = cache.get(chatId);
  if (cached) return cached;
  try {
    const mode = await channel.getChatMode(chatId);
    cache.set(chatId, mode);
    return mode;
  } catch {
    cache.set(chatId, fallback);
    return fallback;
  }
}

function scopeFor(message: NormalizedMessage, mode: ChatMode): string {
  return mode === 'topic' && message.threadId ? `${message.chatId}:${message.threadId}` : message.chatId;
}
