import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppConfig } from '../config/schema.js';
import { appVersion } from '../utils/version.js';
import { runCommand } from '../utils/command.js';
import { runDoctor, type DoctorCheck } from './doctor.js';
import { listRecentWorkflowRuns } from '../workflows/run-ledger.js';

/**
 * LEO-294 — a redacted diagnostic bundle for bug reports.
 *
 * The problem it solves: helping someone debug meant asking them to hand over
 * `logs/` and `config/config.yaml`, which carry API keys, vault paths, cycle
 * bodies, Linear project/team names. "Redact it yourself" is not redaction.
 *
 * So this assembles only what a report needs — versions, platform, service
 * state, recent run *metadata*, error-log tail, data-source *connectivity*
 * (never credentials) — and runs every string through a redactor built from the
 * running config, so the machine's own secrets and identifiers are scrubbed by
 * value rather than by a hand-maintained denylist. Cycle/retro bodies are left
 * out entirely unless `includeContent` is set.
 *
 * Everything here is filesystem-only, so a bundle can be produced even when the
 * service is not running (the §"验收" degradation requirement).
 */

export interface DiagnosticsOptions {
  configPath?: string;
  /** How many recent workflow runs to include (metadata only). */
  recentRuns?: number;
  /** Include cycle/retro bodies. Off by default — they are the private part. */
  includeContent?: boolean;
  /** Error-log tail length. */
  logLines?: number;
  now?: Date;
}

export interface DiagnosticsRunMeta {
  id: string;
  workflow: string;
  trigger: string;
  date: string;
  status: string;
  started_at: string;
  completed_at?: string;
  output_chars?: number;
  send_status?: string;
  error?: string;
}

export interface Diagnostics {
  meta: {
    generated_at: string;
    app_version: string;
    platform: string;
    arch: string;
    os_release: string;
    node_version: string;
    /** Top-level config keys present — schema shape, never values. */
    config_keys: string[];
  };
  service: {
    working_dir: string;
    log_present: boolean;
    last_error_log_at?: string;
  };
  /** Data-source connectivity / setup checks, details redacted. */
  doctor: DoctorCheck[];
  recent_runs: DiagnosticsRunMeta[];
  error_log_tail: string;
  content_included: boolean;
  redaction: {
    rules: string[];
    scrubbed_value_count: number;
  };
}

const SENSITIVE_ENV_KEY = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|COOKIE|APP_ID|APP_SECRET|OPEN_ID|CHAT_ID|WEBHOOK|INVITE|CREDENTIAL)/i;
const REDACTED = '[REDACTED]';

/**
 * Scrubs strings for the bundle. Built once from the running config + env so it
 * removes *this machine's* actual secrets and identifiers by value: nothing
 * here is specific to any one user.
 */
export class Redactor {
  // Exact secret values to strike wherever they appear, longest first so a
  // value that contains another is removed before its substring.
  private readonly values: string[];
  private readonly home: string;

  constructor(config: AppConfig) {
    const values = new Set<string>();
    // Every secret-looking env value: API keys, tokens, chat ids, open ids,
    // invite codes, webhooks. Keyed by name, so we never have to recognise the
    // shape of a secret we have not seen.
    for (const [key, value] of Object.entries(process.env)) {
      if (value && value.length >= 4 && SENSITIVE_ENV_KEY.test(key)) values.add(value);
    }
    // Identifiers that are not "secret" but are private: the Linear workspace.
    // Linear project/team/member names are masked by the generic id patterns
    // below plus this configured value.
    const linearWorkspace = config.sources?.linear?.workspace || '';
    if (linearWorkspace) values.add(linearWorkspace);
    this.values = [...values].filter(Boolean).sort((a, b) => b.length - a.length);
    this.home = os.homedir();
  }

  get scrubbedValueCount(): number {
    return this.values.length;
  }

  redact(input: string): string {
    if (!input) return input;
    let out = input;
    // 1. Home-dir absolute paths → ~ (own home first, then any /Users|/home/<name>).
    if (this.home) out = out.split(this.home).join('~');
    out = out.replace(/\/(?:Users|home)\/[^/\s"']+/g, '~');
    // 2. Exact secret/identifier values from config + env.
    for (const value of this.values) out = out.split(value).join(REDACTED);
    // 3. Shape-based fallbacks for tokens/ids that never went through env here:
    //    Feishu object ids (oc_/ou_/on_/cli_…), bearer tokens, KEY=secret lines.
    out = out.replace(/\b(?:oc|ou|on|om|cli|secret|token)_[A-Za-z0-9_-]{8,}/g, REDACTED);
    out = out.replace(/\bBearer\s+[A-Za-z0-9._-]{8,}/gi, `Bearer ${REDACTED}`);
    out = out.replace(new RegExp(`\\b([A-Z0-9_]*(?:${SENSITIVE_ENV_KEY.source})[A-Z0-9_]*)\\s*[=:]\\s*\\S+`, 'gi'), `$1=${REDACTED}`);
    return out;
  }
}

export async function buildDiagnostics(config: AppConfig, options: DiagnosticsOptions = {}): Promise<Diagnostics> {
  const now = options.now ?? new Date();
  const recentRuns = options.recentRuns ?? 10;
  const logLines = options.logLines ?? 200;
  const redactor = new Redactor(config);

  // Never let a broken config crash the bundle — that is the exact moment it is
  // needed. A doctor that throws is reported as one failed check.
  let doctor: DoctorCheck[];
  try {
    doctor = (await runDoctor(config, options.configPath ?? 'config/config.yaml')).map((check) => ({
      ...check,
      detail: check.detail ? redactor.redact(check.detail) : check.detail,
    }));
  } catch (error) {
    doctor = [{ name: 'doctor', ok: false, level: 'missing', detail: redactor.redact(error instanceof Error ? error.message : String(error)) }];
  }

  const recent = recentRunMeta(config, recentRuns, redactor);

  const logPath = path.resolve('logs', 'service.err.log');
  const logPresent = fs.existsSync(logPath);
  const errorTail = logPresent ? redactor.redact(tail(logPath, logLines)) : '';

  return {
    meta: {
      generated_at: now.toISOString(),
      app_version: appVersion(),
      platform: process.platform,
      arch: process.arch,
      os_release: os.release(),
      node_version: process.version,
      config_keys: Object.keys(config).sort(),
    },
    service: {
      working_dir: redactor.redact(process.cwd()),
      log_present: logPresent,
      last_error_log_at: logPresent ? fs.statSync(logPath).mtime.toISOString() : undefined,
    },
    doctor,
    recent_runs: recent,
    error_log_tail: errorTail,
    content_included: Boolean(options.includeContent),
    redaction: {
      rules: [
        'API key / token / cookie / 邀请码 / webhook → 全抹（按 env 名识别值，不靠形状）',
        '家目录绝对路径 → ~（含其他 /Users|/home 用户）',
        'Feishu 对象 id（oc_/ou_/on_/cli_…）、Bearer token、KEY=secret 行 → 抹',
        'Linear workspace（及经 id 模式命中的项目/团队/成员）→ 抹',
        `周期与 retro 正文 → ${options.includeContent ? '已按 --include-content 带上' : '默认不含'}`,
        '不含 .env、config.yaml 原文、data/ 库文件',
      ],
      scrubbed_value_count: redactor.scrubbedValueCount,
    },
  };
}

function recentRunMeta(config: AppConfig, limit: number, redactor: Redactor): DiagnosticsRunMeta[] {
  let runs: ReturnType<typeof listRecentWorkflowRuns>;
  try {
    runs = listRecentWorkflowRuns(config, limit);
  } catch {
    return [];
  }
  return runs.map<DiagnosticsRunMeta>((run) => ({
    id: run.id,
    workflow: run.workflow,
    trigger: run.trigger,
    date: run.date,
    status: run.status,
    started_at: run.started_at,
    completed_at: run.completed_at,
    output_chars: run.output_chars,
    send_status: run.send.status,
    error: run.error ? redactor.redact(run.error) : undefined,
  }));
}

/**
 * The bundle's files, as a name→content map. Split out so it is testable
 * without touching the filesystem or `ditto`.
 */
export function renderDiagnosticsFiles(diag: Diagnostics): Record<string, string> {
  return {
    'diagnostics.json': `${JSON.stringify(diag, null, 2)}\n`,
    'doctor.txt': `${diag.doctor.map((c) => `${c.level ?? (c.ok ? 'ok' : 'missing')} ${c.name}${c.detail ? ` - ${c.detail}` : ''}`).join('\n')}\n`,
    'error-log.txt': diag.error_log_tail || '(no error log, or service never wrote one)\n',
    'REDACTION.md': renderManifest(diag),
  };
}

function renderManifest(diag: Diagnostics): string {
  return [
    '# 诊断包脱敏清单',
    '',
    `生成时间：${diag.meta.generated_at}`,
    `版本：${diag.meta.app_version}（${diag.meta.platform}/${diag.meta.arch}, node ${diag.meta.node_version}）`,
    '',
    '抹掉了以下几类内容，核对无误后再发出：',
    '',
    ...diag.redaction.rules.map((rule) => `- ${rule}`),
    '',
    `按值抹掉的密钥/标识符数量：${diag.redaction.scrubbed_value_count}`,
    '',
    '包内不含：`.env`、`config/config.yaml` 原文、`data/` 下的库文件。',
  ].join('\n');
}

/**
 * Write the bundle as a zip and return its path. Uses `ditto` (present on macOS,
 * the only platform the app ships to; same tool package.sh uses). On a host
 * without `ditto` it leaves the unzipped directory and returns that instead, so
 * the bundle is never lost just because the archiver is missing.
 */
export async function writeDiagnosticsBundle(config: AppConfig, options: DiagnosticsOptions = {}): Promise<string> {
  const diag = await buildDiagnostics(config, options);
  const stamp = (options.now ?? new Date()).toISOString().replace(/[:.]/g, '-');
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-os-diag-'));
  try {
    for (const [name, content] of Object.entries(renderDiagnosticsFiles(diag))) {
      fs.writeFileSync(path.join(stageDir, name), content, 'utf8');
    }
    const outZip = path.resolve(`diagnostics-${stamp}.zip`);
    const result = await runCommand('ditto', ['-c', '-k', stageDir, outZip], { timeoutMs: 20000 });
    if (result.ok) return outZip;
    // No ditto (or it failed): keep the directory so nothing is lost.
    const outDir = path.resolve(`diagnostics-${stamp}`);
    fs.cpSync(stageDir, outDir, { recursive: true });
    return outDir;
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true });
  }
}

function tail(file: string, lines: number): string {
  const text = fs.readFileSync(file, 'utf8');
  const all = text.split('\n');
  return all.slice(Math.max(0, all.length - lines)).join('\n');
}
