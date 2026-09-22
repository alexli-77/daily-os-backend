import type { AppConfig } from '../config/schema.js';
import { runCommand } from '../utils/command.js';

/**
 * Runtime-environment helpers for the agent providers.
 *
 * **This file used to refuse every CLI provider under launchd, and that was
 * wrong.** daily-os #199 reported `provider=claude` hanging for the full timeout
 * in the background service and concluded that subscription CLIs cannot work
 * there at all. The conclusion was drawn from one CLI. It does not hold:
 * measured on the reporting machine, in the service's own environment, at the
 * same moment —
 *
 *   codex exec "Reply with exactly: OK"   → returned OK in 10s
 *   claude -p   "Reply with exactly: OK"  → still running after 120s
 *
 * — and that machine's run ledger has 77 successful launchd-scheduled runs,
 * every one of them on `provider=codex`. Blocking both by name would have taken
 * away the only provider that ever worked there, in the name of a limitation
 * that provider does not have.
 *
 * The named cause was wrong too. `--bare` (which documents that it skips
 * keychain reads) hangs identically, and so does a run with
 * `CLAUDE_CODE_OAUTH_TOKEN` set, so whatever blocks `claude -p` is not the
 * Keychain prompt. It is still unidentified — which is exactly why the gate
 * should not encode a theory about it.
 *
 * So: ask, do not assume. Before the first CLI run in a process, spend one
 * trivial prompt finding out whether this CLI answers in this environment, and
 * cache the answer. A CLI that works keeps working; one that hangs is refused
 * in seconds with an honest message instead of burning the whole timeout.
 */

/** CLI providers that authenticate through a subscription rather than an API key. */
export function isCliProvider(provider: string): boolean {
  return provider === 'claude' || provider === 'codex';
}

/**
 * True when we are running as a macOS launchd background agent.
 *
 * `DAILY_OS_LAUNCHD=1` is injected into our own launchd plist; launchd also sets
 * `XPC_SERVICE_NAME`, which covers services installed before that marker existed.
 *
 * Kept as a *signal*, not as a verdict. It decides whether the probe below is
 * worth running at all — in a terminal the CLIs are known-good and the probe
 * would be pure latency — and it sharpens the wording when one does hang.
 */
export function isHeadlessLaunchd(): boolean {
  if (process.platform !== 'darwin') return false;
  if (process.env.DAILY_OS_LAUNCHD === '1') return true;
  const xpc = process.env.XPC_SERVICE_NAME;
  return Boolean(xpc && xpc !== '0');
}

/** Skip the probe entirely. For an operator who knows their CLI is fine. */
export function cliProbeSkipped(): boolean {
  return process.env.DAILY_OS_ALLOW_CLI_UNDER_LAUNCHD === '1' || process.env.DAILY_OS_SKIP_CLI_PROBE === '1';
}

/** How long a CLI gets to answer a one-line prompt before we call it hung. */
const PROBE_TIMEOUT_MS = 25_000;
const PROBE_PROMPT = 'Reply with exactly: OK';

export interface CliProbeResult {
  ok: boolean;
  /** Milliseconds the probe took. */
  elapsedMs: number;
  /** Populated when `ok` is false. */
  reason?: string;
  /** True when the CLI never answered, as opposed to answering with an error. */
  hung?: boolean;
}

/**
 * One probe per provider per process. The service is long-lived, so this is a
 * few seconds at the first workflow after a restart and free thereafter.
 *
 * Cached as the promise, not the result: two workflows firing at the same
 * minute would otherwise each pay for a probe.
 */
const probes = new Map<string, Promise<CliProbeResult>>();

/** Visible for tests; a new process starts with no cached verdicts. */
export function resetCliProbeCache(): void {
  probes.clear();
}

export function probeCliProvider(
  provider: string,
  bin: string,
  run: typeof runCommand = runCommand,
): Promise<CliProbeResult> {
  const key = `${provider}:${bin}`;
  const cached = probes.get(key);
  if (cached) return cached;
  const started = Date.now();
  const pending = run(bin, probeArgs(provider), { input: PROBE_PROMPT, timeoutMs: PROBE_TIMEOUT_MS })
    .then((result): CliProbeResult => {
      const elapsedMs = Date.now() - started;
      if (result.timedOut) {
        return { ok: false, hung: true, elapsedMs, reason: `${bin} 在 ${Math.round(PROBE_TIMEOUT_MS / 1000)}s 内没有任何返回` };
      }
      // A non-zero exit is not a reason to refuse the real run: the CLI answered,
      // which is the only thing this probe is entitled to conclude. A bad model
      // name or an expired login is the real run's error to report, in its own
      // words, rather than something to guess at from a one-line prompt.
      return { ok: true, elapsedMs };
    })
    .catch((error): CliProbeResult => ({
      ok: false,
      elapsedMs: Date.now() - started,
      reason: error instanceof Error ? error.message : String(error),
    }));
  probes.set(key, pending);
  return pending;
}

function probeArgs(provider: string): string[] {
  if (provider === 'codex') return ['exec', '--skip-git-repo-check', '--ignore-rules', '--ephemeral', '-'];
  return ['-p', '--output-format', 'text', '--strict-mcp-config'];
}

/**
 * Throw before a doomed run, and only before a doomed one.
 *
 * Terminal runs skip the probe: the CLIs work there, and nobody should wait on a
 * check for a problem they do not have.
 */
export async function assertCliProviderUsable(
  provider: string,
  bin: string,
  run: typeof runCommand = runCommand,
): Promise<void> {
  if (!isCliProvider(provider)) return;
  if (!isHeadlessLaunchd()) return;
  if (cliProbeSkipped()) return;
  const probe = await probeCliProvider(provider, bin, run);
  if (probe.ok) return;
  throw new Error(cliUnavailableMessage(provider, bin, probe));
}

/** What to tell the operator when their CLI does not answer in this environment. */
export function cliUnavailableMessage(provider: string, bin: string, probe: CliProbeResult): string {
  const lines = [
    `provider=${provider} 在这个后台服务(launchd)环境里没有响应：${probe.reason ?? '探测失败'}。`,
    '已在真正跑工作流之前拦下，避免又耗满整个超时却只拿到一句 "timeout"。',
  ];
  if (probe.hung) {
    lines.push(
      `同一台机器上另一个 CLI provider 可能是好的——这不是"所有订阅版 CLI 都不行"，请分别验证（daily-os #199）。`,
      `手动复现：在终端执行 \`echo '${PROBE_PROMPT}' | ${bin} ${probeArgs(provider).join(' ')}\`，再用服务的环境跑一次对比。`,
    );
  }
  lines.push(
    '可选：换另一个 CLI provider、改用 API-key provider（anthropic/openai），或设 DAILY_OS_SKIP_CLI_PROBE=1 跳过这个检查。',
  );
  return lines.join('\n');
}

/** Absolute per-*attempt* upper bound in ms (backstop); 0 means no cap. */
export function resolveAgentTimeoutMs(config: AppConfig): number {
  return config.llm.timeout_ms;
}

/**
 * Idle (no-output) window in ms for CLI providers; 0 means no idle detection.
 *
 * This is the fast-fail knob: a hung CLI stops emitting and trips it quickly,
 * while a slow-but-streaming run resets it and is never misjudged.
 */
export function resolveIdleTimeoutMs(config: AppConfig): number {
  return config.llm.idle_timeout_ms;
}

/** How many times to run one agent call before giving up. At least 1. */
export function resolveMaxAttempts(config: AppConfig): number {
  return Math.max(1, config.llm.max_attempts);
}

/**
 * Thrown when an attempt hit the per-attempt timeout (the CLI hung), as opposed
 * to answering with an error. `runAgent` retries only this — a hung `claude`
 * under launchd is bimodal (it either answers in a minute or never), so a fresh
 * attempt has a real chance where waiting longer does not. Real errors (bad
 * model, spent budget, missing key) are not retried: they would fail the same
 * way every time and only burn budget.
 */
export class AgentTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentTimeoutError';
  }
}

/** A timeout message that says which provider/model/prompt size timed out, and why. */
export function describeAgentTimeout(
  provider: string,
  model: string,
  promptChars: number,
  elapsedMs: number,
  timeoutMs: number,
  kind: 'idle' | 'total' = 'total',
): string {
  const waited = Math.round(elapsedMs / 1000);
  const cap = Math.round(timeoutMs / 1000);
  const tail =
    isCliProvider(provider) && isHeadlessLaunchd()
      ? `在 launchd 后台环境里这个 CLI 可能根本不返回（daily-os #199）。先确认另一个 CLI provider 是否正常——它们的表现并不一致——否则改用 API-key provider（anthropic/openai）。`
      : '如果这是正常的长耗时生成，可调大 config 里的 llm.idle_timeout_ms / llm.timeout_ms（设 0 可关闭对应上限），或后续简化 prompt 长度。';
  const cause =
    kind === 'idle'
      ? `无输出超过 ${cap}s 被判为挂起并中止（已运行 ${waited}s）`
      : `运行超过 ${cap}s 被中止（已等待 ${waited}s）`;
  return `${provider} ${cause}。provider=${provider} model=${model || 'default'} prompt≈${promptChars} 字符。${tail}`;
}
