import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../config/schema.js';
import { commandExists, runCommand } from '../utils/command.js';
import { checkLarkCli } from '../connectors/lark-cli.js';
import { feishuSdkStatus } from '../connectors/feishu-sdk.js';
import { defaultMemoryRepositoryPath, resolveMemoryRepositoryPath } from '../storage/memory.js';
import { feishuSafetyWarnings, hasAnyAccessRule, summarizeFeishuAccess } from '../interaction/access-policy.js';
import { decisionPolicyFiles } from '../decision/policy.js';
import { feishuSessionCatalogPath } from '../interaction/session-catalog.js';
import { cliUnavailableMessage, isCliProvider, isHeadlessLaunchd, probeCliProvider } from '../agent/runtime-env.js';

export interface DoctorCheck {
  name: string;
  ok: boolean;
  level?: 'ok' | 'warning' | 'missing';
  detail?: string;
}

export async function runDoctor(config: AppConfig, configPath = 'config/config.yaml'): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];

  checks.push({ name: '配置文件', ok: fs.existsSync(configPath), detail: configPath });
  const needsLarkCli = usesLarkCliFeishu(config);
  if (needsLarkCli) {
    checks.push({ name: 'lark-cli 命令行', ...(await toCheck('lark-cli', checkLarkCli())) });
  } else {
    checks.push({
      name: 'lark-cli 命令行',
      ok: true,
      level: 'warning',
      detail: 'not required for the currently enabled Feishu SDK-only features',
    });
  }

  // daily-os #199: under launchd some CLI providers answer and some hang, and the
  // login check below cannot tell the difference — `claude auth status` returns
  // `loggedIn: true` in 5s on a machine where `claude -p` never returns at all.
  // So report what a real one-line prompt does, rather than asserting from the
  // provider's name. The first version of this check warned about every CLI under
  // launchd, which was wrong about codex and would have pushed operators off the
  // only provider that worked for them.
  if (isCliProvider(config.llm.provider) && isHeadlessLaunchd()) {
    const bin = config.llm.provider === 'claude' ? process.env.CLAUDE_BIN || 'claude' : process.env.CODEX_BIN || 'codex';
    const probe = await probeCliProvider(config.llm.provider, bin);
    checks.push({
      name: `后台 ${config.llm.provider === 'claude' ? 'Claude' : 'Codex'} 可用性`,
      ok: probe.ok,
      level: probe.ok ? 'ok' : 'missing',
      detail: probe.ok
        ? `在 launchd 环境下用一句话提示实测通过（${Math.round(probe.elapsedMs / 1000)}s）`
        : cliUnavailableMessage(config.llm.provider, bin, probe),
    });
  }

  if (config.llm.provider === 'codex') {
    const codexBin = process.env.CODEX_BIN || 'codex';
    const codexEnv = codexProcessEnv();
    const exists = await commandExists(codexBin, codexEnv);
    checks.push({
      name: 'Codex 命令行',
      ok: exists,
      detail: exists ? `${codexBin} · ${codexHomeDetail()}` : 'Set CODEX_BIN to the Codex CLI path, or install Codex CLI and make it available in PATH.',
    });
    if (exists) checks.push(await codexLoginCheck(codexBin, codexEnv));
  } else if (config.llm.provider === 'claude') {
    const claudeBin = process.env.CLAUDE_BIN || 'claude';
    const exists = await commandExists(claudeBin);
    checks.push({
      name: 'Claude Code 命令行',
      ok: exists,
      detail: exists ? claudeBin : 'Set CLAUDE_BIN to the Claude Code CLI path, or install Claude Code and make it available in PATH.',
    });
    if (exists) checks.push(await claudeAuthCheck(claudeBin));
  } else {
    checks.push({ name: 'OpenAI API Key', ok: Boolean(process.env.OPENAI_API_KEY), detail: 'OPENAI_API_KEY' });
  }

  if (needsLarkCli) {
    checks.push(await larkCliAuthCheck());
  }

  if (config.interaction.feishu.enabled) {
    checks.push({ name: '飞书 App ID', ok: Boolean(process.env.LARK_APP_ID), detail: 'LARK_APP_ID · 仅飞书 websocket 交互需要' });
    checks.push({ name: '飞书 App Secret', ok: Boolean(process.env.LARK_APP_SECRET), detail: 'LARK_APP_SECRET · 仅飞书 websocket 交互需要' });
  }

  if (config.interaction.feishu.enabled) {
    checks.push({
      name: '飞书交互层',
      ok: true,
      detail: `prefix=${config.interaction.feishu.command_prefix}, debounce=${config.interaction.feishu.debounce_ms}ms`,
    });
    checks.push({
      name: '飞书会话目录',
      ok: true,
      detail: feishuSessionCatalogPath(config),
    });
    checks.push(
      hasAnyAccessRule(config)
        ? {
            name: '飞书权限策略',
            ok: true,
            level: config.interaction.feishu.security.access_level === 'full' ? 'warning' : 'ok',
            detail:
              config.interaction.feishu.security.access_level === 'full'
                ? `${summarizeFeishuAccess(config)}; full access should only be used for trusted private deployments`
                : summarizeFeishuAccess(config),
          }
        : {
            name: '飞书权限策略',
            ok: false,
            level: 'missing',
            detail: `configure ${config.interaction.feishu.security.owner_open_id_env}, allowed_user_open_ids, or allowed_chat_ids before remote control will process messages`,
          },
    );
    for (const warning of feishuSafetyWarnings(config)) {
      checks.push({
        name: '飞书安全提醒',
        ok: true,
        level: 'warning',
        detail: warning,
      });
    }
  }

  if (config.output.feishu.enabled) {
    checks.push({ name: '飞书会话 ID', ok: Boolean(process.env[config.output.feishu.chat_id_env]), detail: config.output.feishu.chat_id_env });
    if (config.output.feishu.provider === 'sdk' || config.output.feishu.provider === 'auto') {
      const status = feishuSdkStatus();
      checks.push({
        name: '飞书 SDK 发送',
        ok: status.ok || config.output.feishu.provider === 'auto',
        level: status.ok ? 'ok' : config.output.feishu.provider === 'auto' ? 'warning' : 'missing',
        detail: status.ok ? 'will send through official Feishu SDK' : `${status.detail}; ${config.output.feishu.provider === 'auto' ? 'will fall back to lark-cli' : 'required by output.feishu.provider=sdk'}`,
      });
    }
  }

  const memoryRepositoryPath = resolveMemoryRepositoryPath(config);
  const usingDefault = !config.memory.repository_path.trim();
  const vaultExists = fs.existsSync(memoryRepositoryPath);
  // daily-os-macos #3: a path that exists but has no 10_OKR/ is the empty
  // template, not your data — the exact silent-loss case. Say so instead of
  // reporting ok. A real vault has 10_OKR/ (and usually 20_CYCLES/).
  const looksSeeded = vaultExists && fs.existsSync(path.join(memoryRepositoryPath, '10_OKR'));
  checks.push({
    name: usingDefault ? '记忆仓库路径（默认）' : '记忆仓库路径',
    ok: vaultExists && looksSeeded,
    level: !vaultExists ? 'missing' : looksSeeded ? 'ok' : 'warning',
    detail: !vaultExists
      ? `找不到 vault：${memoryRepositoryPath}${usingDefault ? '（用的是内置模板路径）' : ''}`
      : looksSeeded
        ? memoryRepositoryPath
        : `vault 存在但缺 10_OKR/，看起来是空模板而非你的数据：${memoryRepositoryPath}。若刚从 checkout 迁移，检查 memory-vault 是否搬到了托管目录。`,
  });

  if (config.decision.enabled) {
    const policy = decisionPolicyFiles(config);
    checks.push({
      name: '决策规则文件',
      ok: fs.existsSync(policy.policyPath) && fs.existsSync(policy.notesPath),
      level: fs.existsSync(policy.policyPath) && fs.existsSync(policy.notesPath) ? 'ok' : 'warning',
      detail: `policy=${policy.policyPath}, notes=${policy.notesPath}`,
    });
    if (config.decision.onboarding.enabled) {
      const statePath = config.decision.onboarding.state_path;
      const hasDecisionChat = Boolean(process.env[config.decision.onboarding.chat_id_env]) || fs.existsSync(statePath);
      checks.push({
        name: '决策群会话 ID',
        ok: hasDecisionChat,
        level: hasDecisionChat ? 'ok' : 'warning',
        detail: `${config.decision.onboarding.chat_id_env} · 开始决策校准前不是必填项`,
      });
      if (!hasDecisionChat && !feishuSdkStatus().ok) {
        checks.push({
          name: '决策群创建通道',
          ok: true,
          level: 'warning',
          detail: 'configure LARK_APP_ID/LARK_APP_SECRET for SDK group creation, or keep lark-cli available for the fallback path',
        });
      }
    }
  }

  if (config.sources.vault.enabled) {
    if (config.sources.vault.provider === 'remote') {
      const remote = config.sources.vault.remote;
      checks.push({ name: '知识库网关地址', ok: Boolean(process.env[remote.base_url_env]), detail: remote.base_url_env });
      checks.push({ name: '知识库网关令牌', ok: Boolean(process.env[remote.token_env]), detail: remote.token_env });
    } else {
      checks.push({ name: '知识库路径', ok: fs.existsSync(config.sources.vault.local_path), detail: config.sources.vault.local_path });
    }
  }

  if (config.sources.feishu.enabled) {
    const profiles = config.sources.feishu.profiles;
    if (profiles.length > 0) {
      for (const profile of profiles) {
        if (profile.enabled && profile.im_history.enabled) {
          checks.push({
            name: `采集会话 ID（${profile.id}）`,
            ok: Boolean(process.env[profile.im_history.chat_id_env]),
            detail: `${profile.id}.im_history.${profile.im_history.chat_id_env}`,
          });
        }
      }
    } else if (config.sources.feishu.im_history.enabled) {
      checks.push({
        name: '采集会话 ID',
        ok: Boolean(process.env[config.sources.feishu.im_history.chat_id_env]),
        detail: `feishu.im_history.${config.sources.feishu.im_history.chat_id_env}`,
      });
    }
  }

  if (config.sources.github.enabled) checks.push({ name: 'GitHub 令牌', ok: Boolean(process.env.GITHUB_TOKEN), detail: 'GITHUB_TOKEN' });
  if (config.sources.linear.enabled) {
    checks.push(
      process.env.LINEAR_API_KEY
        ? { name: 'Linear API Key', ok: true, level: 'ok', detail: 'LINEAR_API_KEY' }
        : {
            name: 'Linear API Key',
            ok: true,
            level: 'warning',
            detail: 'LINEAR_API_KEY · not configured; Codex Linear fallback will be used',
          },
    );
  }

  return checks;
}

function codexProcessEnv(): NodeJS.ProcessEnv {
  return { ...process.env };
}

function codexHomeDetail(): string {
  return process.env.CODEX_HOME ? `CODEX_HOME=${process.env.CODEX_HOME}` : 'using default Codex home';
}

async function codexLoginCheck(codexBin: string, env: NodeJS.ProcessEnv): Promise<DoctorCheck> {
  const result = await runCommand(codexBin, ['login', 'status'], { timeoutMs: 10000, env });
  if (result.ok) {
    return {
      name: 'Codex 登录',
      ok: true,
      detail: (result.stdout || result.stderr).trim() || 'authenticated',
    };
  }
  // daily-os #199: a 10s timeout here is not "not logged in" — under launchd the
  // CLI hangs on the Keychain. Report the no-response condition instead of sending
  // the user to run `codex login` (which succeeds in Terminal and changes nothing).
  if (result.timedOut) {
    return {
      name: 'Codex 登录',
      ok: false,
      level: 'warning',
      detail: 'codex login status 10s 内没有返回，无法判定登录状态。若本服务在 macOS 后台(launchd)运行，订阅版 CLI 会因 Keychain 阻塞而无响应（#199）——这不代表未登录。定时任务请改用 API-key provider。',
    };
  }
  return {
    name: 'Codex 登录',
    ok: false,
    detail: `Run \`${codexBin} login\` in Terminal, then rerun checks. ${(result.stderr || result.stdout).trim()}`.trim(),
  };
}

async function claudeAuthCheck(claudeBin: string): Promise<DoctorCheck> {
  const result = await runCommand(claudeBin, ['auth', 'status'], { timeoutMs: 10000 });
  const loggedIn = result.ok && /"loggedIn"\s*:\s*true/.test(result.stdout);
  if (loggedIn) {
    return {
      name: 'Claude Code 登录',
      ok: true,
      detail: (result.stdout.match(/"authMethod"\s*:\s*"([^"]+)"/)?.[1]) ?? 'authenticated',
    };
  }
  // daily-os #199: distinguish "no response" (launchd Keychain hang) from "not
  // logged in" — the old message sent the user to `claude auth login`, which works
  // in Terminal and leaves the background service just as broken.
  if (result.timedOut) {
    return {
      name: 'Claude Code 登录',
      ok: false,
      level: 'warning',
      detail: 'claude auth status 10s 内没有返回，无法判定登录状态。若本服务在 macOS 后台(launchd)运行，订阅版 CLI 会因 Keychain 阻塞而无响应（#199）——这不代表未登录。定时任务请改用 API-key provider。',
    };
  }
  return {
    name: 'Claude Code 登录',
    ok: false,
    detail: `Run \`${claudeBin} auth login\` in Terminal, then rerun checks. ${(result.stderr || result.stdout).trim()}`.trim(),
  };
}

function usesLarkCliFeishu(config: AppConfig): boolean {
  const outputNeedsLarkCli = config.output.feishu.enabled && config.output.feishu.provider !== 'sdk' && !feishuSdkStatus().ok;
  return Boolean(outputNeedsLarkCli || config.feedback.feishu.enabled || config.sources.feishu.enabled);
}

async function larkCliAuthCheck(): Promise<DoctorCheck> {
  const result = await runCommand('lark-cli', ['auth', 'status'], { timeoutMs: 10000 });
  if (!result.ok) {
    return {
      name: 'lark-cli 登录',
      ok: false,
      detail: `Run \`lark-cli config init\` and \`lark-cli auth login\`, then rerun checks. ${(result.stderr || result.stdout).slice(0, 500)}`.trim(),
    };
  }
  const text = result.stdout || result.stderr;
  const hasUser = /"user"\s*:\s*\{[\s\S]*?"available"\s*:\s*true/.test(text);
  const hasBot = /"bot"\s*:\s*\{[\s\S]*?"available"\s*:\s*true/.test(text);
  return {
    name: 'lark-cli 登录',
    ok: hasUser || hasBot,
    detail: hasUser || hasBot ? `已登录身份：${[hasUser ? 'user' : '', hasBot ? 'bot' : ''].filter(Boolean).join(', ')}` : '没有可用的 user 或 bot 身份',
  };
}

async function toCheck(name: string, checkPromise: Promise<{ state: string; detail?: string }>): Promise<Omit<DoctorCheck, 'name'>> {
  const result = await checkPromise;
  return { ok: result.state === 'available', detail: result.detail };
}

export function formatDoctor(checks: DoctorCheck[]): string {
  return checks
    .map((check) => `${formatCheckLevel(check)} ${check.name}${check.detail ? ` - ${check.detail}` : ''}`)
    .join('\n');
}

function formatCheckLevel(check: DoctorCheck): string {
  if (check.level === 'warning') return 'WARNING';
  return check.ok ? 'OK' : 'MISSING';
}
