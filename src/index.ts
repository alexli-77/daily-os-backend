#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, loadDotEnv } from './config/load-config.js';
import type { WorkflowName } from './config/schema.js';
import { runWorkflow } from './workflows/run-workflow.js';
import { collectEvidence } from './workflows/evidence.js';
import { todayInTimezone } from './utils/date.js';
import { ensureMemoryFiles } from './storage/memory.js';
import { formatDoctor, runDoctor } from './cli/doctor.js';
import { appVersion } from './utils/version.js';
import { installLaunchAgent, runScheduler, uninstallLaunchAgent } from './service/launchd.js';
import { createScheduler } from './service/scheduler-port.js';
import { pollFeishuFeedback } from './feedback/feishu-feedback.js';
import { readUiRuntimeUrl, startUiServer } from './ui/server.js';
import { startFeishuInteraction } from './interaction/feishu-interaction.js';
import { startDecisionOnboarding } from './decision/onboarding.js';
import { ensureDecisionPolicyFiles } from './decision/policy.js';
import { startPreventSleep } from './service/prevent-sleep.js';
import { startChromeSnapshotService } from './service/chrome-snapshot.js';
import { captureChromeSnapshot } from './connectors/chrome-collector.js';
import {
  appendConfirmedProgress,
  collectProgressCandidates,
  confirmedEntriesFromCandidates,
  formatProgressCandidates,
} from './progress/capture.js';
import { analyzeChatContext, formatChatContextAnalysis, type ChatAnalysisMode } from './chat/context-analysis.js';
import { bundledAsset } from './utils/install-root.js';
import { BIWEEKLY_STRATEGY_FILE } from './skills/runner.js';
import { ensureWeeklyReviewSkill } from './skills/update.js';

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const { command, subcommand } = options;

  if (command === 'setup') {
    await setup();
    return;
  }
  if (command === 'help' || command === '--help' || command === '-h') usage(0);

  if (command === 'ui') {
    if (subcommand === 'open') {
      await openExistingUi();
      return;
    }
    await startUiServer({
      configPath: options.configPath,
      envPath: options.envPath,
      host: options.host,
      port: options.port,
      open: options.openUi,
    });
    return;
  }

  if (command === 'start') {
    await startAll(options);
    return;
  }

  if (command === 'admin') {
    await adminCommand(subcommand);
    return;
  }

  loadDotEnv(options.envPath);
  const config = loadConfig(options.configPath);

  switch (command) {
    case 'doctor': {
      console.log(`daily-os-feishu v${appVersion()}`);
      console.log(formatDoctor(await runDoctor(config, options.configPath)));
      break;
    }
    case 'collect': {
      console.log(JSON.stringify(await collectEvidence(config, todayInTimezone(config)), null, 2));
      break;
    }
    case 'chrome': {
      if (subcommand === 'collect') {
        console.log(JSON.stringify(await captureChromeSnapshot(config), null, 2));
      } else {
        usage(1);
      }
      break;
    }
    case 'chat': {
      if (!config.chat_analysis.enabled) {
        console.log('chat_analysis.enabled=false；聊天上下文分析已禁用。');
        break;
      }
      const date = todayInTimezone(config);
      console.log(formatChatContextAnalysis(await analyzeChatContext(config, date, parseChatAnalysisMode(subcommand, config.chat_analysis.default_mode))));
      break;
    }
    case 'progress': {
      const date = todayInTimezone(config);
      const result = await collectProgressCandidates(config, date);
      if (subcommand === 'confirm') {
        const ledgerPath = appendConfirmedProgress(config, date, confirmedEntriesFromCandidates(result.candidates));
        console.log(`Confirmed ${result.candidates.length} progress candidate(s): ${ledgerPath}`);
      } else {
        console.log(formatProgressCandidates(result));
      }
      break;
    }
    case 'plan':
      await runAndPrint(config, 'daily_plan', options.send);
      break;
    case 'review':
      await runAndPrint(config, 'daily_review', options.send);
      break;
    case 'weekly':
      await runAndPrint(config, 'weekly_review', options.send);
      break;
    case 'service':
      if (subcommand === 'install') {
        const plist = await installLaunchAgent();
        console.log(`Installed launch agent: ${plist}`);
      } else if (subcommand === 'uninstall') {
        const plist = await uninstallLaunchAgent();
        console.log(`Removed launch agent: ${plist}`);
      } else if (subcommand === 'run') {
        console.log('daily-os-feishu scheduler started');
        await runScheduler(config);
      } else {
        usage(1);
      }
      break;
    case 'feedback':
      if (subcommand === 'poll') {
        const result = await pollFeishuFeedback(config, { send: options.send });
        console.log(JSON.stringify(result, null, 2));
      } else {
        usage(1);
      }
      break;
    case 'interaction':
      if (subcommand === 'feishu') {
        const controls = await startFeishuInteraction(config);
        await waitForShutdown(async () => {
          await controls.stop();
        });
      } else {
        usage(1);
      }
      break;
    case 'onboarding':
      if (subcommand === 'start') {
        const result = await startDecisionOnboarding(config, { envPath: options.envPath });
        console.log(JSON.stringify(result, null, 2));
      } else {
        usage(1);
      }
      break;
    default:
      usage(command === 'help' ? 0 : 1);
  }
}

/**
 * `admin reset-password` — set (or create) the console admin account with a fresh
 * generated password. Only touches the account store (SQLite), never config/.env,
 * so it is safe to run without disturbing the LLM provider (unlike the setup
 * wizard). Recovery path when the first-run admin password was lost. (LEO-242)
 */
async function adminCommand(subcommand: string | undefined): Promise<void> {
  if (subcommand !== 'reset-password') usage(1);
  const crypto = await import('node:crypto');
  const { findUser, addUser, setPassword } = await import('./ui/auth.js');
  const password = crypto.randomBytes(12).toString('base64url');
  if (findUser('admin')) {
    setPassword('admin', password);
    console.log('Reset password for the existing admin account.');
  } else {
    addUser('admin', password, 'admin');
    console.log('Created a new admin account.');
  }
  console.log('');
  console.log('  username: admin');
  console.log(`  password: ${password}`);
  console.log('');
  console.log('Sign in at the console /login and change it. This only updates the');
  console.log('account store — config and .env (including your LLM provider) are untouched.');
}

async function openExistingUi(): Promise<void> {
  const url = readUiRuntimeUrl() || `http://${process.env.DAILY_OS_UI_HOST || '127.0.0.1'}:${process.env.DAILY_OS_UI_PORT || '14573'}`;
  const opened = await import('./utils/command.js').then(({ runCommand }) => runCommand('open', [url], { timeoutMs: 5000 }));
  if (!opened.ok) throw new Error(`Could not open Daily OS UI at ${url}: ${opened.stderr || opened.stdout}`);
  console.log(`Opened Daily OS UI: ${url}`);
}

async function startAll(options: CliOptions): Promise<void> {
  ensureLocalSetup(options.configPath, options.envPath);
  loadDotEnv(options.envPath);
  const config = loadConfig(options.configPath);
  let currentConfig = config;
  const getConfig = (): typeof config => {
    try {
      currentConfig = loadConfig(options.configPath);
    } catch (error) {
      console.warn(`[config] keeping last valid config: ${error instanceof Error ? error.message : String(error)}`);
    }
    return currentConfig;
  };
  ensureMemoryFiles(config);
  ensureDecisionPolicyFiles(config);

  console.log('daily-os-feishu 正在启动全部本地功能...');
  const ui = await startUiServer({
    configPath: options.configPath,
    envPath: options.envPath,
    host: options.host,
    port: options.port,
    open: options.openUi,
  });

  const scheduler = createScheduler(getConfig);
  await scheduler.start();
  console.log(`daily-os-feishu scheduler 已启动（${scheduler.driver} 驱动）。`);

  // Keep the weekly-review skill (life-review-os) current on its own: clone it if
  // missing, else fast-forward a clean default-branch checkout. Fire-and-forget
  // so a slow or offline network never delays boot; the skill is only needed at
  // the scheduled weekly-review time, not at startup. Non-fatal by contract.
  void ensureWeeklyReviewSkill(options.configPath)
    .then((result) => console.log(`[skill] weekly-review ${result.action}：${result.message}`))
    .catch((error) => console.warn(`[skill] weekly-review 自动检查失败：${error instanceof Error ? error.message : String(error)}`));

  const sleepControls = startPreventSleep(config.service.prevent_sleep.enabled);
  const chromeControls = startChromeSnapshotService(config);

  let interactionControls: Awaited<ReturnType<typeof startFeishuInteraction>> | null = null;
  if (config.interaction.feishu.enabled) {
    interactionControls = await startFeishuInteraction(getConfig);
    console.log('daily-os-feishu 飞书实时交互已启动。');
  } else {
    console.warn('interaction.feishu.enabled=false；飞书实时对话未启动。可在 UI 中启用并重启 `npm run start`。');
  }

  console.log(`全部功能入口已启动：${ui.url}`);
  console.log('保持这个终端窗口运行。按 Ctrl+C 停止。');

  await waitForShutdown(async () => {
    if (interactionControls) await interactionControls.stop();
    await chromeControls.stop();
    await sleepControls.stop();
    await scheduler.stop();
    await ui.stop();
  });
}

interface CliOptions {
  command: string;
  subcommand?: string;
  configPath: string;
  envPath: string;
  send: boolean;
  host: string;
  port: number;
  openUi: boolean;
  noWizard: boolean;
}

function parseArgs(args: string[]): CliOptions {
  const positional: string[] = [];
  let configPath = process.env.DAILY_OS_CONFIG || 'config/config.yaml';
  let envPath = process.env.DAILY_OS_ENV || '.env';
  let send = true;
  let host = process.env.DAILY_OS_UI_HOST || '127.0.0.1';
  let port = Number(process.env.DAILY_OS_UI_PORT || 14573);
  let openUi = true;
  let noWizard = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--no-send') {
      send = false;
    } else if (arg === '--no-open') {
      openUi = false;
    } else if (arg === '--no-wizard') {
      noWizard = true;
    } else if (arg === '--host') {
      host = requireValue(args, ++index, '--host');
    } else if (arg.startsWith('--host=')) {
      host = arg.slice('--host='.length);
    } else if (arg === '--port') {
      port = Number(requireValue(args, ++index, '--port'));
    } else if (arg.startsWith('--port=')) {
      port = Number(arg.slice('--port='.length));
    } else if (arg === '--config') {
      configPath = requireValue(args, ++index, '--config');
    } else if (arg.startsWith('--config=')) {
      configPath = arg.slice('--config='.length);
    } else if (arg === '--env') {
      envPath = requireValue(args, ++index, '--env');
    } else if (arg.startsWith('--env=')) {
      envPath = arg.slice('--env='.length);
    } else {
      positional.push(arg);
    }
  }

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid --port value: ${port}`);
  }

  return {
    command: positional[0] || 'help',
    subcommand: positional[1],
    configPath,
    envPath,
    send,
    host,
    port,
    openUi,
    noWizard,
  };
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function parseChatAnalysisMode(value: string | undefined, fallback: ChatAnalysisMode): ChatAnalysisMode {
  if (!value) return fallback;
  if (value === 'manual' || value === 'todo' || value === 'review') return value;
  throw new Error(`Invalid chat analysis mode: ${value}. Use manual, todo, or review.`);
}

async function runAndPrint(config: ReturnType<typeof loadConfig>, workflow: WorkflowName, send: boolean): Promise<void> {
  const text = await runWorkflow(config, workflow, { send, trigger: 'cli', source: process.argv.slice(2).join(' ') });
  console.log(text);
}

async function waitForShutdown(stop: () => Promise<void>): Promise<void> {
  await new Promise<void>((resolve) => {
    const done = (): void => resolve();
    process.once('SIGINT', done);
    process.once('SIGTERM', done);
  });
  await stop();
}

async function setup(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  ensureLocalSetup(options.configPath, options.envPath);
  const { isInteractive, runSetupWizard } = await import('./cli/setup-wizard.js');
  if (options.noWizard || !isInteractive()) {
    console.log('已创建本地 .env、config/config.yaml 和 data 目录。请先编辑配置，再运行 doctor。');
    console.log('（在交互式终端里运行 `npm run setup` 可进入首次配置向导。）');
    return;
  }
  await runSetupWizard({ configPath: options.configPath, envPath: options.envPath });
}

function ensureLocalSetup(configPath = 'config/config.yaml', envPath = '.env'): void {
  // Templates come from where the *code* is, the copies go where the *data*
  // is. They were the same directory for as long as this only ever ran from a
  // checkout; run it with the working directory somewhere else — which is what
  // the Mac app does, because a read-only app bundle is no place to write
  // config — and the copy failed with a bare ENOENT on `.env.example`.
  copyIfMissing(bundledAsset('.env.example'), envPath);
  copyIfMissing(bundledAsset('config', 'config.example.yaml'), configPath);
  // The one prompt the console can edit, so it needs a writable home next to
  // the data. Without this the console would show an empty editor and save to a
  // file nothing reads, while the rules actually in force came from the bundle.
  copyIfMissing(bundledAsset('prompts', 'biweekly_strategy.md'), BIWEEKLY_STRATEGY_FILE);
  const config = loadConfig(configPath);
  ensureMemoryFiles(config);
  ensureDecisionPolicyFiles(config);
  fs.mkdirSync(path.resolve('data/snapshots/chrome'), { recursive: true });
  fs.mkdirSync(path.resolve('data/snapshots/calendar'), { recursive: true });
}

function copyIfMissing(from: string, to: string): void {
  if (fs.existsSync(to)) return;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function usage(code: number): never {
  console.log(`daily-os-feishu

Commands:
  start              Start UI, scheduler, and Feishu interaction if enabled
  setup              First-run wizard (admin password, LLM BYOK, optional Feishu). Seeds files only with --no-wizard or no TTY.
  doctor             Check local dependencies and required env vars
  collect            Print collected evidence as JSON
  chrome collect     Refresh local Chrome tab/status snapshots
  chat [mode]        Analyze Feishu chat context. mode: manual | todo | review
  progress           Print today's progress candidates
  progress confirm   Confirm all current progress candidates into the daily ledger
  ui                 Start a local setup and trigger dashboard
  ui open            Open the running Daily OS UI from the saved runtime URL
  plan [--no-send]   Run daily planning workflow now
  review [--no-send] Run daily review workflow now
  weekly [--no-send] Run weekly review workflow now
  service install    Install full macOS launchd background service
  service uninstall  Remove macOS launchd background service
  service run        Run scheduler-only compatibility mode in the foreground
  feedback poll      Poll Feishu for daily-os commands and feedback
  interaction feishu Run the Feishu websocket interaction layer
  onboarding start   Create or reuse the Feishu decision calibration chat
  admin reset-password  Set a new console admin password (account store only)

Options:
  --config <path>    Use a config file other than config/config.yaml
  --env <path>       Load env vars from a file other than .env
  --host <host>      Host for the local UI, default 127.0.0.1
  --port <port>      Port for the local UI, default 14573
  --no-open          Start the local UI without opening a browser
  --no-wizard        Run setup as file-seeding only, skipping the interactive wizard
  --no-send          Generate workflow output without sending to Feishu
`);
  process.exit(code);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
