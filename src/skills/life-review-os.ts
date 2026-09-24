import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppConfig } from '../config/schema.js';
import { runCommand } from '../utils/command.js';
import { checkLifeReviewOsConfig } from './life-review-os-config.js';

type SkillEntry = AppConfig['skills']['registry'][number];

export interface LifeReviewOsRunResult {
  runId: string;
  draft: string;
  writeback?: LifeReviewOsWriteback;
}

interface LifeReviewOsWriteback {
  doc_label?: string;
  target_week?: string;
  task_header?: string;
  action?: 'append_to_existing_empty_column' | 'insert_columns';
  ready?: boolean;
  items?: LifeReviewOsWritebackItem[];
}

interface LifeReviewOsWritebackItem {
  text?: string;
  target_row?: number | null;
  target_row_label?: string;
  is_mit?: boolean;
}

export interface LifeReviewOsWritebackPreview {
  token: string;
  skillId: string;
  mode: string;
  target: {
    docLabel: string;
    weekLabel: string;
    taskHeader: string;
    action: 'append_to_existing_empty_column' | 'insert_columns';
  };
  items: Array<{ text: string; targetRowLabel: string; isMit: boolean }>;
  review?: { text: string; retroHeader: string };
}

export interface LifeReviewOsWritebackResult {
  taskHeader: string;
  itemCount: number;
  skippedCount: number;
  insertedColumns: boolean;
  alreadyWritten: boolean;
  /** Retro review outcome. Absent only if the CLI predates the write-review command. */
  review?: LifeReviewOsReviewResult;
}

export interface LifeReviewOsReviewResult {
  written: boolean;
  alreadyWritten: boolean;
  retroHeader: string;
  targetRow: number;
  chars: number;
  /** Set when the review could not be written; the priorities were still written. */
  error?: string;
}

export function isLifeReviewOsEntry(entry: SkillEntry): boolean {
  return entry.id === 'weekly-review' && Boolean(resolveLifeReviewOsCli(entry));
}

export async function runLifeReviewOsSkill(input: {
  entry: SkillEntry;
  mode: string;
  provider: 'codex' | 'claude';
  userText: string;
  inputPackPath: string;
}): Promise<LifeReviewOsRunResult> {
  const cli = requireLifeReviewOsCli(input.entry);
  const args = [cli, 'run', input.mode, '--json', '--provider', input.provider, '--daily-os-input', input.inputPackPath];
  if (input.userText.trim()) args.push('--user-text', input.userText.trim());
  // Must stay above life-review-os's own provider timeout (20 min by default),
  // plus room for the Feishu reads around it. When this one fires first the CLI
  // dies before it can report anything, which is the least useful failure of the
  // two — a measured biweekly run is ~9.5 min, so neither should trip normally.
  const result = await runCommand('node', args, { cwd: lifeReviewOsRoot(cli), timeoutMs: 1500000 });
  const parsed = parseLifeReviewOsJson(result.stdout, result.stderr, 'run', result.ok);
  return {
    runId: stringValue(parsed.run_id),
    draft: stripWritebackJsonBlock(stringValue(parsed.draft)),
    writeback: asWriteback(parsed.writeback),
  };
}

export async function prepareLifeReviewOsWriteback(input: {
  config: AppConfig;
  skillId: string;
  mode?: string;
  runId?: string;
}): Promise<LifeReviewOsWritebackPreview> {
  assertFeishuWritebackEnabled(input.config);
  const entry = skillEntry(input.config, input.skillId);
  const runId = input.runId || readLatestStoredRunId(input.config, input.skillId, input.mode || 'weekly');
  if (!runId) throw new Error('No recent weekly-review run found. Run `daily-os weekly deep` first.');
  const parsed = await callLifeReviewOs(entry, ['preview', '--run-id', runId, '--json'], 'preview');
  const writeback = asWriteback(parsed.writeback);
  assertWritebackReady(writeback);
  return {
    token: runId,
    skillId: input.skillId,
    mode: input.mode || stringValue(parsed.mode) || 'weekly',
    target: {
      docLabel: stringValue(writeback.doc_label) || 'Weekly',
      weekLabel: stringValue(writeback.target_week),
      taskHeader: stringValue(writeback.task_header),
      action: writeback.action || 'append_to_existing_empty_column',
    },
    items: (writeback.items || []).map((item) => ({
      text: stringValue(item.text),
      targetRowLabel: stringValue(item.target_row_label),
      isMit: Boolean(item.is_mit),
    })),
    // Surfaced so it can be read before being confirmed, rather than written
    // as an invisible side effect of confirming the priorities.
    review: reviewPreview(writeback),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function reviewPreview(writeback: LifeReviewOsWriteback): { text: string; retroHeader: string } | undefined {
  const review = (writeback as Record<string, unknown>).review;
  if (!isRecord(review)) return undefined;
  const text = stringValue(review.text).trim();
  if (!text) return undefined;
  return { text, retroHeader: stringValue(review.source_task_header) || stringValue(review.target_retro_header) || 'retro' };
}

export interface CycleReviewInput {
  cycle: string;
  mode: string;
  priorities: string;
  retro: string;
  context?: string;
}

/**
 * Draft a review for one already-finished cycle.
 *
 * The full biweekly reviews a cycle it reads out of Feishu; this asks for the
 * same thing about a cycle whose text we already hold locally, without
 * re-planning and without a Feishu round trip. The rules and the style contract
 * live in life-review-os, so the prompt is built there — this only carries the
 * content across and hands back the prose.
 *
 * The payload goes through a temp file, not argv: a retro is multi-line and can
 * run to thousands of characters.
 */
export async function generateCycleReview(config: AppConfig, skillId: string, input: CycleReviewInput): Promise<{ text: string; chars: number }> {
  const entry = skillEntry(config, skillId);
  const file = path.join(os.tmpdir(), `daily-os-review-${crypto.randomUUID()}.json`);
  fs.writeFileSync(file, JSON.stringify(input), 'utf8');
  try {
    // Same ceiling as a full run's provider call: this is one model round trip,
    // and the drafting model is the same slow one.
    const parsed = await callLifeReviewOs(entry, ['review-cycle', '--input', file, '--json'], 'review-cycle', 1500000);
    const review = parsed.review && typeof parsed.review === 'object' ? (parsed.review as Record<string, unknown>) : {};
    const text = stringValue(review.text).trim();
    if (!text) throw new Error('life-review-os returned an empty review.');
    return { text, chars: text.length };
  } finally {
    try {
      fs.unlinkSync(file);
    } catch {
      // A leftover temp file is not worth failing a successful review over.
    }
  }
}

/**
 * The single gate for every Feishu write the weekly-review skill can make.
 *
 * Default off (`skills.feishu_writeback`): the cycle's 要务 and retro already
 * land in local `20_CYCLES/*.md`, and the Feishu weekly report table is a shared
 * document a local-first install should not touch unless explicitly re-enabled.
 * Enforced here rather than at each caller (chat / feishu / command) so no path
 * can reach the table with it off.
 */
function assertFeishuWritebackEnabled(config: AppConfig): void {
  if (!config.skills.feishu_writeback) {
    throw new Error(
      '飞书写回已关闭（config skills.feishu_writeback=false）。要务和复盘已写进本地周期文件（20_CYCLES/*.md）；如需写回飞书周报表，把该项设为 true 并重启服务。',
    );
  }
}

export async function executeLifeReviewOsWriteback(config: AppConfig, skillId: string, runId: string): Promise<LifeReviewOsWritebackResult> {
  assertFeishuWritebackEnabled(config);
  const entry = skillEntry(config, skillId);
  const parsed = await callLifeReviewOs(entry, ['writeback', '--run-id', runId, '--json'], 'writeback');
  return {
    taskHeader: stringValue(parsed.task_header),
    itemCount: numberValue(parsed.item_count),
    skippedCount: numberValue(parsed.skipped_count),
    insertedColumns: Boolean(parsed.inserted_columns),
    alreadyWritten: Boolean(parsed.already_written),
  };
}

/**
 * The retro review is confirmed on its own.
 *
 * It rode along on the priorities write-back when the wiring first landed,
 * which meant one confirmation covered two writes into two different cells —
 * and the review was never shown before it happened. They are separate
 * decisions, so they are separate calls.
 */
export async function executeLifeReviewOsRetroReview(config: AppConfig, skillId: string, runId: string): Promise<LifeReviewOsReviewResult> {
  assertFeishuWritebackEnabled(config);
  return writeLifeReviewOsRetroReview(skillEntry(config, skillId), runId);
}

/**
 * The retro review is a second, independent write: it goes into the retro cell
 * next to the priorities column, which only exists once write-back has created
 * the pair. Nothing called this before, so the review sat in the run record and
 * never reached Feishu even though every draft produced one.
 *
 * Deliberately never throws. The priorities are already in the document by the
 * time this runs, and there is no rollback — failing the whole write-back over
 * the review would report a success as a failure and invite a duplicate retry.
 */
async function writeLifeReviewOsRetroReview(entry: SkillEntry, runId: string): Promise<LifeReviewOsReviewResult> {
  try {
    const parsed = await callLifeReviewOs(entry, ['write-review', '--run-id', runId, '--json'], 'write-review');
    return {
      written: Boolean(parsed.written),
      alreadyWritten: Boolean(parsed.already_written),
      retroHeader: stringValue(parsed.retro_header),
      targetRow: numberValue(parsed.target_row),
      chars: numberValue(parsed.chars),
    };
  } catch (error) {
    return {
      written: false,
      alreadyWritten: false,
      retroHeader: '',
      targetRow: 0,
      chars: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** One line describing what happened to the retro review, for either channel. */
export function formatRetroReviewOutcome(review: LifeReviewOsReviewResult | undefined): string {
  if (!review) return '';
  if (review.error) return `retro review 未写入：${review.error}`;
  if (review.alreadyWritten) return `retro review 已存在（${review.retroHeader}），未重复写入`;
  if (review.written) return `retro review：已写入 ${review.retroHeader} 第 ${review.targetRow} 行，${review.chars} 字`;
  return 'retro review 未写入';
}

function assertWritebackReady(writeback: LifeReviewOsWriteback): void {
  const items = writeback.items || [];
  const unmapped = items.filter((item) => typeof item.target_row !== 'number');
  if (!writeback.ready || items.length === 0 || unmapped.length > 0) {
    const sample = unmapped
      .slice(0, 3)
      .map((item) => stringValue(item.text))
      .filter(Boolean)
      .join('；');
    throw new Error(sample ? `写回预检失败：有要务无法对应到第一列 OKR 行：${sample}` : '写回预检失败：没有可按 OKR 行写回的下周要务。');
  }
}

async function callLifeReviewOs(entry: SkillEntry, args: string[], label: string, timeoutMs = 300000): Promise<Record<string, unknown>> {
  const cli = requireLifeReviewOsCli(entry);
  const result = await runCommand('node', [cli, ...args], { cwd: lifeReviewOsRoot(cli), timeoutMs });
  return parseLifeReviewOsJson(result.stdout, result.stderr, label, result.ok);
}

function parseLifeReviewOsJson(stdout: string, stderr: string, label: string, ok: boolean): Record<string, unknown> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    throw new Error(`life-review-os ${label} returned invalid JSON: ${(stderr || stdout).slice(0, 1000)}`);
  }
  if (!ok || parsed.ok === false) {
    throw new Error(`life-review-os ${label} failed: ${stringValue(parsed.error) || (stderr || stdout).slice(0, 1000)}`);
  }
  return parsed;
}

function requireLifeReviewOsCli(entry: SkillEntry): string {
  const cli = resolveLifeReviewOsCli(entry);
  if (!cli) throw new Error('life-review-os CLI not found. Set weekly-review workdir to the life-review-os repo or install bin/life-review-os.mjs in the skill folder.');
  assertLifeReviewOsConfigFilled(cli);
  return cli;
}

/**
 * Refuse to start a run whose config.yaml still holds template placeholders.
 *
 * Without this the CLI sends `YOUR_2026_DOG_WEEKLY_TABLE_BLOCK_ID` to Feishu
 * as a block id and the run dies as `1770001 invalid param` — an error that
 * names neither the field nor the file (#218). A missing config.yaml is left
 * to the CLI, which already says so.
 */
function assertLifeReviewOsConfigFilled(cli: string): void {
  const configPath = path.join(lifeReviewOsRoot(cli), 'config.yaml');
  if (!fs.existsSync(configPath)) return;
  const check = checkLifeReviewOsConfig(configPath);
  if (check.error) throw new Error(`life-review-os 的 config.yaml 读不了：${check.error}（${configPath}）`);
  if (check.unfilled.length > 0) {
    throw new Error(
      `life-review-os 的 config.yaml 还是模板，${check.unfilled.join('、')} 没填。` +
        `填入飞书 Weekly 文档的 token 和表格 block_id 后再跑：${configPath}`,
    );
  }
}

function resolveLifeReviewOsCli(entry: SkillEntry): string {
  const candidates = [
    process.env.LIFE_REVIEW_OS_CLI || '',
    path.join(skillWorkdir(entry), 'bin/life-review-os.mjs'),
    path.join(path.dirname(expandPath(entry.path)), 'bin/life-review-os.mjs'),
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || '';
}

function lifeReviewOsRoot(cliPath: string): string {
  return path.resolve(path.dirname(cliPath), '..');
}

function skillEntry(config: AppConfig, skillId: string): SkillEntry {
  const entry = config.skills.registry.find((candidate) => candidate.id === skillId);
  if (!entry) throw new Error(`Skill not configured: ${skillId}`);
  return entry;
}

function readLatestStoredRunId(config: AppConfig, skillId: string, mode: string): string {
  const filePath = path.resolve(config.skills.inputs_dir, '_skill-runs.json');
  if (!fs.existsSync(filePath)) return '';
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Array<Record<string, unknown>>;
    const latest = parsed
      .filter((run) => run.skillId === skillId && run.mode === mode && typeof run.runId === 'string')
      .sort((left, right) => stringValue(right.createdAt).localeCompare(stringValue(left.createdAt)))[0];
    return typeof latest?.runId === 'string' ? latest.runId : '';
  } catch {
    return '';
  }
}

function skillWorkdir(entry: SkillEntry): string {
  if (entry.workdir.trim()) return expandPath(entry.workdir);
  return path.dirname(expandPath(entry.path));
}

function expandPath(value: string): string {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return path.resolve(value);
}

function asWriteback(value: unknown): LifeReviewOsWriteback {
  return value && typeof value === 'object' ? (value as LifeReviewOsWriteback) : {};
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

function numberValue(value: unknown): number {
  return typeof value === 'number' ? value : typeof value === 'string' ? Number(value) || 0 : 0;
}

/**
 * Strip only the Feishu `writeback_plan` fenced JSON block from a life-review-os
 * draft, processing one ```json fence at a time so a co-located biweekly
 * `kr_progress` block always survives. Removing the block per-fence (rather than
 * with a single spanning regex) is what keeps a kr_progress block that appears
 * before the writeback_plan block from being swallowed — that block is the only
 * channel the Feishu biweekly flow has to reach the local-OKR write-back card
 * (LEO-109). Any fence that itself carries `kr_progress` is kept verbatim.
 */
export function stripWritebackJsonBlock(value: string): string {
  return value
    .replace(/```json\s*([\s\S]*?)```/gi, (match, body: string) =>
      /"writeback_plan"/.test(body) && !/"kr_progress"/.test(body) ? '' : match,
    )
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
