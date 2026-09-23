import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import type { AppConfig } from '../config/schema.js';
import { loadConfig } from '../config/load-config.js';
import { runCommand } from '../utils/command.js';

/**
 * Updating the weekly-review skill from the console.
 *
 * The skill is not a copied bundle. The CLI's skill entry is a symlink to the
 * life-review-os checkout, and that checkout is also the `workdir` this app
 * shells into. So "update the skill" is one operation on one directory —
 * `git pull --ff-only` — and both the CLI and Daily OS see the result
 * immediately. There is nothing to copy and nothing to keep in sync.
 *
 * Which CLI is a per-install question: Claude Code reads `~/.claude/skills`,
 * Codex reads `~/.codex/skills`, and both are supported skill providers. So the
 * install location is discovered rather than assumed — see `skillInstallLinks()`.
 *
 * Two rules make the button safe to press without reading the code first:
 *
 *   - `--ff-only`, so a pull can never create a merge commit or rewrite local
 *     history. If the branch has diverged the pull fails and says so.
 *   - a dirty *tracked* file blocks the update before anything is fetched.
 *     life-review-os keeps a real `config.yaml` in its root; that one is
 *     gitignored, so untracked files are deliberately not counted.
 */

/** One CLI's skill directory entry for this skill. */
export interface SkillInstallLink {
  /** Which CLI's skill directory this is, e.g. `claude` or `codex`. */
  cli: string;
  path: string;
  /** Where `path` resolves to, or '' when it does not exist. */
  target: string;
  /** True when this CLI's entry resolves to the workdir Daily OS updates. */
  linked: boolean;
}

export interface SkillRepoState {
  skillId: string;
  workdir: string;
  /**
   * Every known CLI skill directory for this skill, so the console can say which
   * CLI actually sees the checkout being updated.
   */
  installs: SkillInstallLink[];
  /**
   * The CLI entry pointing at `workdir`; falls back to the first that exists,
   * then to the first known location. Kept for callers that predate `installs`.
   */
  installPath: string;
  installTarget: string;
  available: boolean;
  isGitRepo: boolean;
  branch: string;
  commit: string;
  subject: string;
  committedAt: string;
  /** Tracked files with local modifications. Non-empty means an update is refused. */
  dirty: string[];
  /** Commits behind the upstream as of the last fetch; -1 when unknown. */
  behind: number;
  /** Why this repo cannot be updated, if it cannot. */
  blocked: string;
}

export interface SkillUpdateResult {
  ok: boolean;
  changed: boolean;
  before: string;
  after: string;
  /** One line per commit pulled in, newest first. */
  commits: string[];
  message: string;
}

const SKILL_ID = 'weekly-review';
const GIT_TIMEOUT_MS = 120000;
const SKILL_REPO_URL = 'https://github.com/alexli-77/life-review-os';

/** The default clone location when the operator does not pick one. */
export function defaultSkillInstallDir(): string {
  return path.join(os.homedir(), '.daily-os', 'skills', 'life-review-os');
}

export interface SkillInstallResult {
  ok: boolean;
  dir: string;
  /** Registry entry the caller should persist into config.skills.registry. */
  registered?: { id: string; path: string; workdir: string };
  message: string;
}

/**
 * LEO-287: clone life-review-os so the weekly-review skill can be installed from
 * the console without a terminal. Does the git + filesystem work only; the caller
 * (the endpoint) persists the registry entry, since config paths live there.
 *
 * The command runner is injectable so tests exercise the whole flow — git-missing,
 * non-empty target, clone failure, and the config.yaml seed — with no real clone.
 */
/** Minimal command runner so tests can drive install without a real git. */
export type SkillCommandRunner = (
  command: string,
  args: string[],
  options?: { timeoutMs?: number },
) => Promise<{ ok: boolean; stdout: string; stderr: string }>;

export async function installSkillRepo(
  targetDir: string,
  deps: { run?: SkillCommandRunner } = {},
): Promise<SkillInstallResult> {
  const run: SkillCommandRunner = deps.run ?? runCommand;
  const dir = path.resolve((targetDir || '').trim() || defaultSkillInstallDir());
  const fail = (message: string): SkillInstallResult => ({ ok: false, dir, message });

  const version = await run('git', ['--version'], { timeoutMs: 10000 });
  if (!version.ok) return fail('git 不可用：请先安装 git 或确认它在 PATH 里。');

  // Never clone over existing content — an existing non-empty dir is an error, not
  // something to overwrite.
  if (fs.existsSync(dir) && fs.readdirSync(dir).length > 0) {
    return fail(`目标目录已存在且非空，未覆盖：${dir}`);
  }

  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const cloned = await run('git', ['clone', '--depth', '1', SKILL_REPO_URL, dir], { timeoutMs: GIT_TIMEOUT_MS });
  if (!cloned.ok) return fail(`git clone 失败：${(cloned.stderr || cloned.stdout || '未知错误').slice(0, 300)}`);

  // life-review-os keeps config.yaml gitignored; the repo ships only
  // config.example.yaml. Seed the real file so the CLI has something to read —
  // the returned message tells the operator to fill in the tokens.
  const example = path.join(dir, 'config.example.yaml');
  const configFile = path.join(dir, 'config.yaml');
  let seeded = false;
  try {
    if (fs.existsSync(example) && !fs.existsSync(configFile)) {
      fs.copyFileSync(example, configFile);
      seeded = true;
    }
  } catch {
    // Non-fatal: the clone succeeded; the operator can copy it by hand.
  }

  return {
    ok: true,
    dir,
    registered: { id: SKILL_ID, path: path.join(dir, 'SKILL.md'), workdir: dir },
    message: seeded
      ? `已安装到 ${dir}。请在 ${configFile} 填入飞书文档 token 与 linear.workspace 后再运行 weekly-review。`
      : `已安装到 ${dir}（未找到 config.example.yaml，需手动创建 config.yaml）。`,
  };
}

/**
 * CLI skill directories this app knows about. Both Claude Code and Codex are
 * supported skill providers (`skills.registry[].provider`), and each reads its
 * own directory, so neither can be assumed.
 */
const CLI_SKILL_HOMES: ReadonlyArray<{ cli: string; home: string }> = [
  { cli: 'claude', home: '.claude' },
  { cli: 'codex', home: '.codex' },
];

function realpathOrEmpty(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return '';
  }
}

/**
 * Where each supported CLI would look for this skill, and whether that entry
 * resolves to `workdir` — the checkout Daily OS actually updates. An entry that
 * is a copy rather than a symlink comes back `linked: false`, which is the
 * signal that pressing Update will not change what the CLI loads.
 */
export function skillInstallLinks(workdir = '', skillId = SKILL_ID): SkillInstallLink[] {
  const resolvedWorkdir = workdir ? realpathOrEmpty(workdir) : '';
  return CLI_SKILL_HOMES.map(({ cli, home }) => {
    const installPath = path.join(os.homedir(), home, 'skills', skillId);
    const target = realpathOrEmpty(installPath);
    return {
      cli,
      path: installPath,
      target,
      linked: Boolean(target) && Boolean(resolvedWorkdir) && target === resolvedWorkdir,
    };
  });
}

/**
 * The single install path worth showing: the one linked to `workdir`, else the
 * first that exists at all, else the first known location.
 */
export function skillInstallPath(skillId = SKILL_ID, workdir = ''): string {
  const links = skillInstallLinks(workdir, skillId);
  return (links.find((link) => link.linked) || links.find((link) => link.target) || links[0]).path;
}

function workdirFor(config: AppConfig): string {
  const entry = config.skills.registry.find((candidate) => candidate.id === SKILL_ID);
  if (!entry) return '';
  const raw = (entry.workdir || '').trim() || path.dirname(entry.path || '');
  if (!raw) return '';
  const expanded = raw === '~' ? os.homedir() : raw.startsWith('~/') ? path.join(os.homedir(), raw.slice(2)) : path.resolve(raw);
  return expanded;
}

async function git(cwd: string, args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  const result = await runCommand('git', ['-C', cwd, ...args], { timeoutMs: GIT_TIMEOUT_MS });
  return { ok: result.ok, out: (result.stdout || '').trim(), err: (result.stderr || '').trim() };
}

/** Local-only: never touches the network, so the console can render it on every load. */
export async function readSkillRepoState(config: AppConfig): Promise<SkillRepoState> {
  const workdir = workdirFor(config);
  const installs = skillInstallLinks(workdir);
  const primary = installs.find((link) => link.linked) || installs.find((link) => link.target) || installs[0];
  const state: SkillRepoState = {
    skillId: SKILL_ID,
    workdir,
    installs,
    installPath: primary.path,
    installTarget: primary.target,
    available: Boolean(workdir) && fs.existsSync(workdir),
    isGitRepo: false,
    branch: '',
    commit: '',
    subject: '',
    committedAt: '',
    dirty: [],
    behind: -1,
    blocked: '',
  };
  if (!workdir) {
    state.blocked = '没有配置 weekly-review skill（config.yaml 的 skills.registry 里没有这一项）。';
    return state;
  }
  if (!state.available) {
    state.blocked = `skill workdir 不存在：${workdir}`;
    return state;
  }
  if (!(await git(workdir, ['rev-parse', '--git-dir'])).ok) {
    state.blocked = `${workdir} 不是一个 git 仓库，没法用 git pull 更新。`;
    return state;
  }
  state.isGitRepo = true;
  state.branch = (await git(workdir, ['rev-parse', '--abbrev-ref', 'HEAD'])).out;
  state.commit = (await git(workdir, ['rev-parse', '--short', 'HEAD'])).out;
  state.subject = (await git(workdir, ['log', '-1', '--format=%s'])).out;
  state.committedAt = (await git(workdir, ['log', '-1', '--format=%cI'])).out;

  // `diff --name-only HEAD` rather than `status --porcelain`: it lists tracked
  // files that differ from HEAD, staged or not, as bare paths. Porcelain's
  // fixed-width `XY ` prefix has to be sliced off, and the leading space of an
  // unstaged change does not survive trimming the command's output — which ate
  // the first character of every such path.
  //
  // Untracked files are excluded either way, and that is deliberate:
  // life-review-os keeps a real, gitignored config.yaml in its working tree,
  // and counting it would block updates forever.
  const status = await git(workdir, ['diff', '--name-only', 'HEAD']);
  state.dirty = status.out ? status.out.split('\n').map((line) => line.trim()).filter(Boolean) : [];

  const behind = await git(workdir, ['rev-list', '--count', 'HEAD..@{upstream}']);
  state.behind = behind.ok && /^\d+$/.test(behind.out) ? Number(behind.out) : -1;

  if (state.dirty.length > 0) {
    state.blocked = `工作区有未提交的改动（${state.dirty.slice(0, 3).join('、')}${state.dirty.length > 3 ? ' 等' : ''}），先处理掉再更新。`;
  }
  return state;
}

/** Fetch and fast-forward. Never throws: every failure comes back as `ok: false`. */
export async function updateSkillRepo(config: AppConfig): Promise<SkillUpdateResult> {
  const fail = (message: string, before = ''): SkillUpdateResult => ({
    ok: false,
    changed: false,
    before,
    after: before,
    commits: [],
    message,
  });

  const state = await readSkillRepoState(config);
  if (!state.isGitRepo || state.blocked) return fail(state.blocked || '这个 skill 无法用 git 更新。');

  const workdir = state.workdir;
  const before = (await git(workdir, ['rev-parse', 'HEAD'])).out;

  const fetched = await git(workdir, ['fetch', '--prune', 'origin']);
  if (!fetched.ok) return fail(`git fetch 失败：${fetched.err || fetched.out || '未知错误'}`, before);

  const pulled = await git(workdir, ['pull', '--ff-only']);
  if (!pulled.ok) {
    // --ff-only refusing is the interesting case: it means the local branch has
    // commits the remote does not, which a button must not silently resolve.
    return fail(`git pull --ff-only 失败：${pulled.err || pulled.out || '未知错误'}`, before);
  }

  const after = (await git(workdir, ['rev-parse', 'HEAD'])).out;
  if (after === before) {
    return { ok: true, changed: false, before, after, commits: [], message: `已经是最新的（${state.branch} @ ${before.slice(0, 7)}）。` };
  }
  const log = await git(workdir, ['log', '--oneline', `${before}..${after}`]);
  const commits = log.out ? log.out.split('\n').filter(Boolean) : [];
  return {
    ok: true,
    changed: true,
    before,
    after,
    commits,
    message: `已更新 ${before.slice(0, 7)} → ${after.slice(0, 7)}，${commits.length} 个新提交。`,
  };
}

// --- startup self-provisioning ------------------------------------------------

export type SkillProvisionAction = 'disabled' | 'install' | 'update' | 'skip';

export interface SkillProvisionDecision {
  action: SkillProvisionAction;
  reason: string;
}

/** Branches safe to fast-forward automatically; anything else is a dev branch we leave alone. */
const DEFAULT_BRANCHES = new Set(['main', 'master']);

/**
 * Pure policy: given the local skill state and the auto_update flag, decide what
 * startup should do. Kept apart from the git/filesystem work so the guards that
 * protect a developer's checkout are unit-testable without a real repo.
 *
 *   - auto_update off        → do nothing.
 *   - no usable checkout     → install (clone).
 *   - dirty / feature branch → skip: never touch a checkout someone is working in.
 *   - clean, default branch  → update (fetch + ff-only; a no-op when already current).
 */
export function decideSkillProvisioning(state: SkillRepoState, autoUpdate: boolean): SkillProvisionDecision {
  if (!autoUpdate) return { action: 'disabled', reason: 'skills.auto_update=false' };
  if (!state.available) {
    return { action: 'install', reason: state.workdir ? `checkout 不存在：${state.workdir}` : 'weekly-review 技能未安装' };
  }
  if (!state.isGitRepo) return { action: 'skip', reason: `${state.workdir} 不是 git 仓库，跳过自动更新` };
  if (state.dirty.length > 0) return { action: 'skip', reason: `本地有未提交改动（${state.dirty.slice(0, 3).join('、')}），跳过` };
  if (!DEFAULT_BRANCHES.has(state.branch)) {
    return { action: 'skip', reason: `在分支 ${state.branch || '(未知)'} 上（非默认分支），跳过自动更新` };
  }
  return { action: 'update', reason: `在 ${state.branch} 上，检查并快进更新` };
}

export interface EnsureSkillResult {
  action: SkillProvisionAction | 'install-failed' | 'update-failed';
  message: string;
}

/**
 * Startup self-provisioning for the weekly-review skill (life-review-os).
 *
 * Non-fatal by contract: the caller runs it in the background and the service
 * works regardless of the outcome. Clones the (public) repo when it is missing —
 * so a machine gets biweekly by launching the app, no manual clone — otherwise
 * fast-forwards a clean checkout on the default branch, so fixes arrive without a
 * `git pull` in a terminal and without repackaging the app. A developer's feature
 * branch or dirty tree is deliberately left untouched.
 */
export async function ensureWeeklyReviewSkill(configPath: string): Promise<EnsureSkillResult> {
  const config = loadConfig(configPath);
  const state = await readSkillRepoState(config);
  const decision = decideSkillProvisioning(state, config.skills.auto_update);

  if (decision.action === 'disabled' || decision.action === 'skip') {
    return { action: decision.action, message: decision.reason };
  }

  if (decision.action === 'install') {
    const result = await installSkillRepo(defaultSkillInstallDir());
    if (!result.ok || !result.registered) return { action: 'install-failed', message: result.message };
    persistSkillRegistration(configPath, result.registered);
    return { action: 'install', message: result.message };
  }

  const result = await updateSkillRepo(config);
  if (!result.ok) return { action: 'update-failed', message: result.message };
  return { action: 'update', message: result.message };
}

/**
 * Write a freshly-cloned checkout into config.skills.registry — the same write
 * path the console's Install button uses, so both reach an identical entry. Reads
 * the config fresh right before writing to avoid clobbering a concurrent edit.
 */
function persistSkillRegistration(configPath: string, registered: { id: string; path: string; workdir: string }): void {
  const config = loadConfig(configPath);
  const entry: AppConfig['skills']['registry'][number] = {
    id: SKILL_ID,
    provider: 'auto',
    path: registered.path,
    workdir: registered.workdir,
    default_mode: 'weekly',
    effects: ['read', 'draft', 'feishu_write'],
    require_confirmation_for: ['feishu_write'],
  };
  const registry = [...config.skills.registry.filter((existing) => existing.id !== SKILL_ID), entry];
  const nextConfig: AppConfig = { ...config, skills: { ...config.skills, enabled: true, registry } };
  fs.writeFileSync(path.resolve(configPath), `${yaml.dump(nextConfig, { lineWidth: 120, noRefs: true })}`, 'utf8');
}
