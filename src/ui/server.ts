import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';
import { AppConfigSchema, type AppConfig, type WorkflowName } from '../config/schema.js';
import { loadConfig } from '../config/load-config.js';
import { formatDoctor, runDoctor } from '../cli/doctor.js';
import { collectEvidence } from '../workflows/evidence.js';
import { runWorkflow } from '../workflows/run-workflow.js';
import { addDays, todayInTimezone } from '../utils/date.js';
import { pollFeishuFeedback } from '../feedback/feishu-feedback.js';
import { sendFeishuMessage } from '../connectors/lark-cli.js';
import { readLatestWorkflowOutput } from '../storage/memory.js';
import { listTodoFeedback } from '../todo/feedback.js';
import { applyUserOrder, buildTodayPlanSnapshot } from '../todo/today-plan.js';
import { readArtifactsIndex } from '../storage/artifacts.js';
import { buildDailyPlanTable, extractDailyPlanTodos, formatWorkflowSummaryForFeishu, normalizePlanMinutes, type DailyPlanTodo } from '../workflows/summary.js';
import { bundledAsset } from '../utils/install-root.js';
import { getLaunchAgentStatus, installLaunchAgent, uninstallLaunchAgent } from '../service/launchd.js';
import { runCommand } from '../utils/command.js';
import { appendUiLog, clearUiLogs, readUiLogs } from '../storage/ui-log.js';
import { appVersion } from '../utils/version.js';
import { startDecisionOnboarding } from '../decision/onboarding.js';
import { ensureDecisionPolicyFiles } from '../decision/policy.js';
import {
  defaultRhythmMarkdown,
  ensureRhythmFile,
  normalizeRestDays,
  readRhythmNotes,
  resolveDayShape,
  rhythmNotesAreTemplate,
} from '../user/rhythm.js';
import { BIWEEKLY_STRATEGY_FILE, defaultBiweeklyStrategy, expandPath, runConfiguredSkill } from '../skills/runner.js';
import { defaultSkillInstallDir, installSkillRepo, readSkillRepoState, updateSkillRepo } from '../skills/update.js';
import { generateCycleReview, isLifeReviewOsEntry } from '../skills/life-review-os.js';
import { readOkrEditorState, writeOkrFile } from '../okr/editor.js';
import { normalizeOkrMarkdown } from '../okr/normalize.js';
import type { OkrLevel } from '../okr/editor.js';
import { CYCLE_SECTIONS, cycleFilePath, cyclesDir, listCycles, parseCycleId, readCycle, writeCycle, writeSection } from '../cycles/file.js';
import type { CycleSection } from '../cycles/file.js';
import { MAX_CYCLE_DAYS, MIN_CYCLE_DAYS, planNextCycle, type NextCyclePlan } from '../cycles/next.js';
import { formatLocalCycleWriteback } from '../cycles/writeback.js';
import { assertLocalCycleWriteTarget, pushLocalCycle, readTeamTodayState, readTeamViewState, startTeamSync, syncTeamOnce } from '../team/sync.js';
import type { TeamSyncLoop } from '../team/sync.js';
import { collectProgressCandidates, formatProgressCandidates } from '../progress/capture.js';
import { analyzeChatContext, formatChatContextAnalysis } from '../chat/context-analysis.js';
import { readBackgroundSuggestionsState } from '../service/background-suggestions.js';
import {
  handleTodoInboxCommand,
  listTodoInboxItems,
  openTodoInboxItems,
  parseTodoInboxCommand,
  updateTodoInboxItemById,
} from '../todo/inbox.js';
import { recordTodoFeedback } from '../todo/feedback.js';
import { formatCalendarDraftForFeishu, runCalendarDraft, testCalendarBridge } from '../calendar/bridge.js';
import {
  SESSION_COOKIE,
  addUser,
  createSession,
  destroySession,
  ensureAuthInitialized,
  findUser,
  findUserByEmail,
  getSession,
  listUsers,
  parseCookies,
  registerUser,
  setPassword,
  verifyPassword,
  type Role,
} from './auth.js';
import { PLATFORM_PAGES, renderWelcomePage, renderPlatformPage, type PageContext } from './pages.js';
import {
  createWebChatSession,
  deleteWebChatSession,
  isWebChatTurnAllowed,
  listWebChatMessages,
  listWebChatSessions,
  runWebChatTurn,
  stopWebChatSession,
  type WebChatEvent,
} from './chat.js';
import { looksLikeServiceRoleKey } from '../team/session.js';
import {
  createTeam,
  joinTeam,
  leaveTeam,
  readTeamUiState,
  refreshTeam,
  rotateInviteCode,
  signIn,
  signOut,
  signUp,
  type TeamActionResult,
} from '../team/team.js';
import { runManager } from '../service/run-manager.js';
import { scanAndIndex } from '../storage/artifacts.js';
import { listRecentWorkflowRuns, markWorkflowRunFailed } from '../workflows/run-ledger.js';
import { writeFileAtomic } from '../utils/atomic-write.js';

const SECRET_ENV_KEYS = new Set(['OPENAI_API_KEY', 'GITHUB_TOKEN', 'LINEAR_API_KEY', 'VAULT_GATE_TOKEN', 'LARK_APP_SECRET']);
const DEFAULT_UI_RUNTIME_PATH = './data/runtime/ui.json';

/**
 * Where this server advertises its address and token.
 *
 * `DAILY_OS_UI_RUNTIME_PATH` overrides it, for the same reason
 * `DAILY_OS_DB_PATH` exists: a test that boots a real server resolves this
 * against its own cwd, which is the repo root — so it overwrote the *live*
 * runtime file with a throwaway server's ephemeral port and token. The running
 * Mac app then read that file, dialled a port nothing was listening on, and
 * reported the service as down. Running the test suite should not be able to
 * disconnect the app.
 */
function uiRuntimePath(): string {
  return path.resolve(process.env.DAILY_OS_UI_RUNTIME_PATH || DEFAULT_UI_RUNTIME_PATH);
}
const PLAIN_ENV_KEYS = [
  'FEISHU_CHAT_ID',
  'DAILY_OS_DECISION_CHAT_ID',
  'FEISHU_OWNER_OPEN_ID',
  'VAULT_GATE_URL',
  'CODEX_BIN',
  'CODEX_HOME',
  'CLAUDE_BIN',
  'TZ',
  'LARK_APP_ID',
];
const ENV_KEYS = [...PLAIN_ENV_KEYS, ...SECRET_ENV_KEYS];

// Local-only auth token generated per server start. All /api/* routes require it,
// and it is written into ui.json (for mac-companion) and injected into the served HTML.
let runtimeToken = '';
// The 60s cycle-sync poll (LEO-284). Owned by the running server so it starts
// and stops with it; null when no server is up.
let teamSyncLoop: TeamSyncLoop | null = null;
const HTML_TOKEN_PLACEHOLDER = '__UI_TOKEN_PLACEHOLDER__';
const HTML_VERSION_PLACEHOLDER = '__UI_VERSION_PLACEHOLDER__';
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);

function extractHostname(hostHeader: string | undefined): string {
  if (!hostHeader) return '';
  const value = hostHeader.trim();
  const bracketed = value.match(/^\[(.+)\]/); // IPv6 like [::1]:14573
  if (bracketed) return bracketed[1].toLowerCase();
  return value.split(':')[0].toLowerCase();
}

function isPublicBind(host: string): boolean {
  return host === '0.0.0.0' || host === '::';
}

function isAllowedHostname(hostname: string, options: UiServerOptions): boolean {
  if (!hostname) return false;
  if (LOOPBACK_HOSTNAMES.has(hostname)) return true;
  // When bound to a public address, host allow-listing is not meaningful; the token is the gate.
  if (isPublicBind(options.host)) return true;
  const configured = extractHostname(options.host);
  return Boolean(configured) && hostname === configured;
}

function isAllowedApiOrigin(originHeader: string | undefined, options: UiServerOptions): boolean {
  if (!originHeader) return true; // same-origin GET or non-browser client (mac-companion) sends no Origin
  try {
    return isAllowedHostname(new URL(originHeader).hostname.toLowerCase(), options);
  } catch {
    return false;
  }
}

function extractRequestToken(request: http.IncomingMessage, url: URL): string {
  const header = request.headers.authorization;
  if (typeof header === 'string') {
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (match) return match[1].trim();
  }
  return url.searchParams.get('token') || '';
}

function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function maskSecret(value: string): string {
  if (!value) return '';
  if (value.length <= 8) return '***';
  return `${value.slice(0, 3)}***${value.slice(-2)}`;
}

export interface UiServerOptions {
  configPath: string;
  envPath: string;
  host: string;
  port: number;
  open: boolean;
}

export interface UiServerControls {
  url: string;
  token: string;
  stop: () => Promise<void>;
}

export async function startUiServer(options: UiServerOptions): Promise<UiServerControls> {
  ensureLocalFiles(options.configPath, options.envPath);

  // First-run bootstrap for the web console: create an `admin` with a random
  // password when no users exist yet. Surface it once so the operator can log in.
  const authInit = ensureAuthInitialized();

  const token = crypto.randomBytes(32).toString('hex');
  runtimeToken = token;

  const server = http.createServer((request, response) => {
    void handleRequest(request, response, options);
  });

  await listenWithFallback(server, options);

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : options.port;
  const url = `http://${options.host === '0.0.0.0' ? '127.0.0.1' : options.host}:${port}`;
  writeUiRuntime(url, token, authInit.createdAdmin ? authInit.initialPassword : undefined);
  console.log(`daily-os-feishu UI running at ${url}`);
  if (authInit.createdAdmin && authInit.initialPassword) {
    console.log('');
    console.log('  ================================================================');
    console.log('  Web console admin account created (first run).');
    console.log(`    username: ${authInit.adminUsername}`);
    console.log(`    password: ${authInit.initialPassword}`);
    console.log('  Saved to data/runtime/ui.json (admin_initial_password). Change it after first login.');
    console.log('  ================================================================');
    console.log('');
  }
  console.log('Press Ctrl+C to stop.');

  // Cycle sync polls while the console runs. Config is re-read each tick so a
  // change in Setup takes effect without a restart. With no Supabase, no login
  // or no team it short-circuits before any network call, so this is a no-op
  // for every single-user install.
  teamSyncLoop = startTeamSync(() => loadConfig(options.configPath));

  if (isPublicBind(options.host) || !LOOPBACK_HOSTNAMES.has(extractHostname(options.host))) {
    console.warn('');
    console.warn('  ****************************************************************');
    console.warn(`  *  WARNING: UI is bound to a non-loopback address (${options.host}).`);
    console.warn('  *  The local auth token is REQUIRED for every /api request, but');
    console.warn('  *  anyone on your network who obtains it can control this app.');
    console.warn('  *  Prefer binding to 127.0.0.1 unless you understand the risk.');
    console.warn('  ****************************************************************');
    console.warn('');
  }

  if (options.open) {
    const openUrl = `${url}${url.includes('?') ? '&' : '?'}token=${token}`;
    const opened = await runCommand('open', [openUrl], { timeoutMs: 5000 });
    if (!opened.ok) console.warn(`Could not open browser: ${opened.stderr || opened.stdout}`);
  }

  return {
    url,
    token,
    stop: async () => {
      teamSyncLoop?.stop();
      teamSyncLoop = null;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
  };
}

export function readUiRuntimeUrl(): string | null {
  const filePath = uiRuntimePath();
  if (!fs.existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { url?: unknown };
    return typeof parsed.url === 'string' && parsed.url.trim() ? parsed.url : null;
  } catch {
    return null;
  }
}

async function listenWithFallback(server: http.Server, options: UiServerOptions): Promise<void> {
  try {
    await listen(server, options.port, options.host);
  } catch (error) {
    if (!isAddressInUse(error) || options.port === 0) throw error;
    console.warn(`daily-os-feishu UI port ${options.port} is already in use. Falling back to a random local port.`);
    await listen(server, 0, options.host);
  }
}

function listen(server: http.Server, port: number, host: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

function isAddressInUse(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'EADDRINUSE');
}

function writeUiRuntime(url: string, token: string, adminInitialPassword?: string): void {
  const filePath = uiRuntimePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const payload = JSON.stringify(
    {
      url,
      token,
      pid: process.pid,
      updated_at: new Date().toISOString(),
      ...(adminInitialPassword ? { admin_initial_password: adminInitialPassword } : {}),
    },
    null,
    2,
  );
  // Write atomically via a temp file so mac-companion never reads a half-written token.
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, payload, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tempPath, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // best-effort: token file should stay owner-only, but do not fail startup on chmod issues
  }
}

async function handleRequest(request: http.IncomingMessage, response: http.ServerResponse, options: UiServerOptions): Promise<void> {
  const started = Date.now();
  try {
    const url = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`);
    attachNetworkLog(request, response, url, started);

    const hostname = extractHostname(request.headers.host);
    const isLoopbackRequest = LOOPBACK_HOSTNAMES.has(hostname);
    // DNS-rebinding defence: reject any request whose Host header is not an allowed local host.
    if (!isAllowedHostname(hostname, options)) {
      return sendJson(response, { ok: false, error: 'Forbidden host' }, 403);
    }

    // Auth context: a valid runtime token (mac-companion / existing SPA / CLI open
    // with ?token=) grants admin-equivalent access; a browser session cookie grants
    // its stored role. Either one satisfies the /api gate.
    const auth = resolveAuthContext(request, url);

    // Public console auth endpoints. Still Origin-checked, but no token/session required.
    if (
      url.pathname === '/api/login' ||
      url.pathname === '/api/logout' ||
      url.pathname === '/api/register' ||
      url.pathname === '/api/reset-password'
    ) {
      if (!isAllowedApiOrigin(request.headers.origin, options)) {
        return sendJson(response, { ok: false, error: 'Forbidden origin' }, 403);
      }
      if (request.method === 'POST' && url.pathname === '/api/login') return handleLogin(request, response);
      if (request.method === 'POST' && url.pathname === '/api/register') return handleRegister(request, response);
      if (request.method === 'POST' && url.pathname === '/api/logout') return handleLogout(request, response, auth);
      // GH #192: a packaged install has no checkout to run admin:reset-password.
      // A reset is allowed only from loopback — the same trust as running the CLI.
      if (request.method === 'POST' && url.pathname === '/api/reset-password') {
        return handleResetPassword(request, response, isLoopbackRequest);
      }
      return sendJson(response, { ok: false, error: 'Not found' }, 404);
    }

    // Auth + CSRF defence for all /api routes.
    if (url.pathname.startsWith('/api/')) {
      if (!isAllowedApiOrigin(request.headers.origin, options)) {
        return sendJson(response, { ok: false, error: 'Forbidden origin' }, 403);
      }
      if (!auth.authenticated) {
        return sendJson(response, { ok: false, error: 'Unauthorized' }, 401);
      }
      // Members are read-only in the console except for explicitly whitelisted actions.
      if (auth.role === 'member' && isWriteRequest(request.method) && !isMemberWriteWhitelisted(url.pathname)) {
        return sendJson(response, { ok: false, error: 'Forbidden for member role' }, 403);
      }
    }

    // LEO-291 Scope A: owner-only surfaces. The Config console + full state/config
    // /env endpoints expose the owner's config and .env presence. The member gate
    // above only covers writes, and /console has no auth gate at all — so a member
    // (or a signed-in stranger) could read the owner's config. Lock them to admin.
    if (isOwnerOnlyPath(url.pathname) && auth.role !== 'admin') {
      if (url.pathname === '/console') return redirect(response, auth.authenticated ? '/dashboard' : '/?signin=1');
      if (!auth.authenticated) return sendJson(response, { ok: false, error: 'Unauthorized' }, 401);
      return sendJson(response, { ok: false, error: 'Owner only' }, 403);
    }

    // Signing in is a dialog on the welcome page, not a page of its own. /login
    // stays routed so an old bookmark or a stale tab still lands somewhere that
    // can actually sign you in.
    if (request.method === 'GET' && url.pathname === '/login') {
      return redirect(response, auth.authenticated ? '/dashboard' : '/?signin=1');
    }

    // Server-rendered console pages require an authenticated session or token.
    if (request.method === 'GET' && PLATFORM_PAGES.has(url.pathname)) {
      // `signin=1` tells the welcome page to open the dialog on the sign-in
      // form rather than on sign-up: whoever was bounced here has an account.
      if (!auth.authenticated) return redirect(response, '/?signin=1');
      const ctx = buildPageContext(auth, url, options);
      return send(response, 200, renderPlatformPage(url.pathname, ctx), 'text/html; charset=utf-8');
    }

    // Console API routes (auth + member gate already enforced above).
    if (request.method === 'POST' && url.pathname === '/api/today/todo-feedback') return sendJson(response, await todoFeedback(options, await readJson(request)));
    if (request.method === 'POST' && url.pathname === '/api/today/plan-order') return sendJson(response, await reorderTodayPlan(options, await readJson(request)));
    if (request.method === 'POST' && url.pathname === '/api/today/resend') return sendJson(response, await resendLatestWorkflow(options));
    if (request.method === 'POST' && url.pathname === '/api/runs/cancel') return sendJson(response, await cancelRun(options, await readJson(request)));
    if (request.method === 'POST' && url.pathname === '/api/runs/rerun') return sendJson(response, await rerunWorkflow(options, await readJson(request)));
    if (request.method === 'POST' && url.pathname === '/api/schedules/backfill') return sendJson(response, await backfillSchedule(options, await readJson(request)));
    if (request.method === 'GET' && url.pathname === '/api/schedules/logs') return sendScheduleLogs(response, url);
    // Same gap the plan had: the artifact index was reachable only as rendered
    // HTML, so a native client could list nothing and its 打开 button had no
    // path to open. `path` is the absolute one — the point of this screen is to
    // hand a file back to the user, not to describe it.
    if (request.method === 'GET' && url.pathname === '/api/artifacts') {
      return sendJson(response, { ok: true, artifacts: readArtifactsIndex() });
    }
    if (request.method === 'POST' && url.pathname === '/api/artifacts/reindex') return sendJson(response, reindexArtifacts());
    if (request.method === 'POST' && url.pathname === '/api/admin/users') return sendJson(response, adminUsers(auth, await readJson(request)));
    if (request.method === 'POST' && url.pathname === '/api/skills/update') return sendJson(response, await updateSkill(options, auth));
    if (request.method === 'POST' && url.pathname === '/api/skills/install') return sendJson(response, await installSkill(options, auth, await readJson(request)));

    // Web console chat (LEO-236).
    if (request.method === 'GET' && url.pathname === '/api/chat/sessions') return sendJson(response, chatSessions(options));
    if (request.method === 'POST' && url.pathname === '/api/chat/session') return sendJson(response, chatCreateSession(options));
    if (request.method === 'GET' && url.pathname === '/api/chat/messages') return sendJson(response, chatMessages(url));
    if (request.method === 'POST' && url.pathname === '/api/chat/stop') return sendJson(response, await chatStop(await readJson(request)));
    if (request.method === 'POST' && url.pathname === '/api/chat/session/delete') return sendJson(response, await chatDeleteSession(options, await readJson(request)));
    if (request.method === 'POST' && url.pathname === '/api/chat/send') return handleChatSend(request, response, options, auth);

    // Homepage is the platform dashboard (where Chat lives). The legacy ops
    // console (setup / sources / checks) stays reachable at /console. (LEO-241)
    // Signed out, the root is a welcome page rather than a bounce to /login.
    // The old redirect chain (/ -> /dashboard -> /login) left the login form as
    // the only thing a new visitor ever saw, with no way back out of it.
    if (request.method === 'GET' && url.pathname === '/') {
      if (auth.authenticated) return redirect(response, '/dashboard');
      return send(response, 200, renderWelcomePage(), 'text/html; charset=utf-8');
    }
    if (request.method === 'GET' && url.pathname === '/console') return send(response, 200, renderHtml(), 'text/html; charset=utf-8');
    if (request.method === 'GET' && url.pathname === '/assets/app.css') return send(response, 200, CSS, 'text/css; charset=utf-8');
    if (request.method === 'GET' && url.pathname === '/assets/app.js') return send(response, 200, JS, 'application/javascript; charset=utf-8');
    if (request.method === 'GET' && url.pathname === '/api/state') return sendJson(response, await buildState(options));
    if (request.method === 'GET' && url.pathname === '/api/logs') return sendJson(response, { ok: true, logs: readUiLogs() });
    if (request.method === 'GET' && url.pathname === '/api/env-secret') {
      // LEO-288: revealing plaintext is admin-only. This is a GET, so the member
      // write-gate above never covered it — a member (or any signed-in stranger)
      // could otherwise read .env secrets. Non-admins get presence + masked only.
      const reveal = url.searchParams.get('reveal') === '1' && auth.role === 'admin';
      return sendJson(response, readSecret(options, url.searchParams.get('key') || '', { reveal, loopback: isLoopbackRequest }));
    }
    // The native clients need today's plan, and until now it existed only as
    // server-rendered HTML: `renderPlanColumn` computed it inline and nothing
    // returned it as data. So the Mac app had no way to show the same list the
    // web shows, and fell back to the todo inbox — a different set of rows that
    // merely looked plausible.
    if (request.method === 'GET' && url.pathname === '/api/today/plan') {
      return sendJson(response, readTodayPlan(options));
    }
    if (request.method === 'POST' && url.pathname === '/api/capture') return sendJson(response, await captureTodo(options, await readJson(request)));
    if (request.method === 'POST' && url.pathname === '/api/todo-inbox') return sendJson(response, await updateTodoInbox(options, await readJson(request)));
    if (request.method === 'POST' && url.pathname === '/api/decision-policy') return sendJson(response, await saveDecisionPolicy(options, await readJson(request)));
    if (request.method === 'POST' && url.pathname === '/api/rhythm') return sendJson(response, await saveRhythm(options, await readJson(request)));
    if (request.method === 'POST' && url.pathname === '/api/strategy') return sendJson(response, await saveStrategy(options, await readJson(request)));
    if (request.method === 'POST' && url.pathname === '/api/okr') return sendJson(response, await saveOkr(options, await readJson(request)));
    if (request.method === 'POST' && url.pathname === '/api/okr/format') return sendJson(response, formatOkr(await readJson(request)));
    // Everything the /cycles page needs, and nothing else. /api/state would do,
    // but it re-runs the doctor checks on every page load and refresh; this is a
    // pair of disk reads.
    if (request.method === 'GET' && url.pathname === '/api/cycles/state') return sendJson(response, await readCyclesPageState(options));
    // Teammates' today lists, from the team cache on disk. Read-only and
    // network-free like /api/cycles/state; the 60s sync loop is what fills it.
    if (request.method === 'GET' && url.pathname === '/api/team/today') return sendJson(response, await readTeamTodayPage(options));
    if (request.method === 'POST' && url.pathname === '/api/cycles/section') return sendJson(response, await saveCycleSection(options, await readJson(request)));
    if (request.method === 'POST' && url.pathname === '/api/cycles/review') return sendJson(response, await generateCycleReviewSection(options, await readJson(request)));
    if (request.method === 'POST' && url.pathname === '/api/cycles/create') return sendJson(response, await createCycle(options, await readJson(request)));
    // Team / Supabase (LEO-282/283/284/285). Writes, so the member gate above
    // already rejects the member role; nothing here is on the member whitelist.
    // /api/team/sync is matched first: the prefix handler below would otherwise
    // swallow it and dispatch 'sync' as an unknown team action.
    if (request.method === 'POST' && url.pathname === '/api/team/sync') return sendJson(response, await runTeamSync(options));
    if (request.method === 'POST' && url.pathname.startsWith('/api/team/')) {
      return sendJson(response, await teamAction(options, url.pathname.slice('/api/team/'.length), await readJson(request), auth));
    }
    if (request.method === 'POST' && url.pathname === '/api/config') return sendJson(response, await saveConfig(options, await readJson(request)));
    if (request.method === 'POST' && url.pathname === '/api/env') return sendJson(response, await saveEnv(options, await readJson(request)));
    if (request.method === 'POST' && url.pathname === '/api/action') return sendJson(response, await runAction(options, await readJson(request)));
    if (request.method === 'DELETE' && url.pathname === '/api/logs') {
      clearUiLogs();
      appendUiLog({ event: 'action', level: 'info', status: 'success', action: 'clear_logs', detail: 'UI logs cleared by user.' });
      return sendJson(response, { ok: true, logs: readUiLogs() });
    }
    return sendJson(response, { ok: false, error: 'Not found' }, 404);
  } catch (error) {
    sendJson(response, { ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
  }
}

interface AuthContext {
  authenticated: boolean;
  role: Role;
  username: string;
  via: 'token' | 'session' | 'none';
  sessionToken?: string;
}

// A valid runtime token maps to admin (mac-companion, existing SPA, CLI open).
// Otherwise fall back to the browser session cookie and its stored role.
function resolveAuthContext(request: http.IncomingMessage, url: URL): AuthContext {
  const token = extractRequestToken(request, url);
  if (token && runtimeToken && timingSafeEqual(token, runtimeToken)) {
    return { authenticated: true, role: 'admin', username: 'runtime-token', via: 'token' };
  }
  const cookies = parseCookies(request.headers.cookie);
  const sessionToken = cookies[SESSION_COOKIE];
  if (sessionToken) {
    const session = getSession(sessionToken);
    if (session) {
      return { authenticated: true, role: session.role, username: session.username, via: 'session', sessionToken };
    }
  }
  return { authenticated: false, role: 'member', username: '', via: 'none' };
}

function isWriteRequest(method: string | undefined): boolean {
  return method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
}

// Members may only trigger these write endpoints; everything else is admin-only.
// Chat send/session/stop are whitelisted so members can hold a conversation; the
// per-turn access policy inside the chat controller still rejects over-privileged
// (durable-write / free-form agent) turns for the member role.
const MEMBER_WRITE_WHITELIST = new Set([
  '/api/today/todo-feedback',
  // Reordering your own day is the same class of act as ticking a row on it.
  '/api/today/plan-order',
  '/api/capture',
  '/api/todo-inbox',
  '/api/chat/session',
  '/api/chat/session/delete',
  '/api/chat/send',
  '/api/chat/stop',
]);
function isMemberWriteWhitelisted(pathname: string): boolean {
  return MEMBER_WRITE_WHITELIST.has(pathname);
}

// LEO-291 Scope A: surfaces that expose the owner's config / .env and must never
// be readable by a member or a signed-in stranger. /console is the Config SPA;
// /api/state dumps configPath/envPath/redactedEnv; the rest read/write config/env.
const OWNER_ONLY_PATHS = new Set(['/console', '/api/state', '/api/env', '/api/env-secret', '/api/config']);
function isOwnerOnlyPath(pathname: string): boolean {
  return OWNER_ONLY_PATHS.has(pathname);
}

function redirect(response: http.ServerResponse, location: string): void {
  response.writeHead(302, { location, 'cache-control': 'no-store' });
  response.end();
}

function buildPageContext(auth: AuthContext, url: URL, options: UiServerOptions): PageContext {
  const env = readEnvFile(options.envPath);
  applyEnv(env);
  const config = loadConfig(options.configPath);
  // The runtime-token path has no user record behind it, so the seed can be
  // absent; the renderer falls back to the username.
  const user = findUser(auth.username);
  const avatarSeed = user?.avatar_seed || '';
  return { config, role: auth.role, username: auth.username, email: user?.email || '', avatarSeed, url };
}

function sessionCookieHeader(token: string): string {
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${7 * 24 * 60 * 60}`;
}

function clearCookieHeader(): string {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}

// --- login brute-force throttle --------------------------------------------
// Basic defence: after a few failed attempts for the same (username, client)
// key inside a rolling window, add an escalating delay before answering. This
// slows credential-stuffing without a full lockout that could be abused for DoS.
interface LoginAttemptState {
  failures: number;
  last: number;
}
const loginAttempts = new Map<string, LoginAttemptState>();
const LOGIN_FREE_ATTEMPTS = 3;
const LOGIN_DELAY_STEP_MS = 200;
const LOGIN_MAX_DELAY_MS = 3000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

function loginThrottleKey(request: http.IncomingMessage, username: string): string {
  const ip = request.socket.remoteAddress || 'unknown';
  return `${ip}::${username.toLowerCase()}`;
}

/** Delay to apply for the *next* attempt given the current failure count. */
export function loginFailureDelayMs(failures: number): number {
  if (failures <= LOGIN_FREE_ATTEMPTS) return 0;
  return Math.min((failures - LOGIN_FREE_ATTEMPTS) * LOGIN_DELAY_STEP_MS, LOGIN_MAX_DELAY_MS);
}

function recordLoginFailure(key: string): number {
  const now = Date.now();
  const prev = loginAttempts.get(key);
  const failures = prev && now - prev.last < LOGIN_WINDOW_MS ? prev.failures + 1 : 1;
  loginAttempts.set(key, { failures, last: now });
  return failures;
}

function clearLoginFailures(key: string): void {
  loginAttempts.delete(key);
}

/** Test-only: reset the login throttle so unit tests start clean. */
export function resetLoginThrottleForTests(): void {
  loginAttempts.clear();
}

async function handleLogin(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
  const body = readRecord(await readJson(request));
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  if (!username || !password) return sendJson(response, { ok: false, error: '请填写用户名或邮箱，以及密码。' }, 400);
  const throttleKey = loginThrottleKey(request, username);
  // Either identifier: people remember the address they signed up with more
  // reliably than the handle they picked at the same moment.
  const user = findUser(username) || findUserByEmail(username);
  if (!user || !verifyPassword(user, password)) {
    const failures = recordLoginFailure(throttleKey);
    const delayMs = loginFailureDelayMs(failures);
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    return sendJson(response, { ok: false, error: 'Invalid username or password.' }, 401);
  }
  clearLoginFailures(throttleKey);
  const session = createSession(user.username, user.role);
  response.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'set-cookie': sessionCookieHeader(session.token),
  });
  response.end(JSON.stringify({ ok: true, role: user.role, username: user.username }));
}

/**
 * Sign-up. Public, like login, and Origin-checked the same way.
 *
 * Errors come back keyed by field so the form can put each message under its
 * own input; the client validates too, but that only decides what the form
 * looks like — this is the check that decides what gets stored.
 *
 * On success the session cookie is set here, so registering logs you in without
 * a second round trip and without the page having to know the password again.
 */
async function handleRegister(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
  const body = readRecord(await readJson(request));
  const result = registerUser({
    username: String(body.username || ''),
    email: String(body.email || ''),
    password: String(body.password || ''),
  });
  if ('errors' in result) {
    // GH #192: "用户名已被用" is a dead end unless we say which names exist. The
    // server is loopback-only and this lists usernames only (never emails), so a
    // stuck operator can see which local account to sign into.
    const taken = result.errors.username === '这个用户名已经被用了';
    return sendJson(
      response,
      { ok: false, errors: result.errors, ...(taken ? { existingUsers: listUsers().map((entry) => entry.username) } : {}) },
      400,
    );
  }

  const session = createSession(result.user.username, result.user.role);
  response.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'set-cookie': sessionCookieHeader(session.token),
  });
  response.end(JSON.stringify({ ok: true, username: result.user.username, role: result.user.role }));
}

/**
 * GH #192: reset a local account's password without a checkout. Allowed only
 * from loopback — being able to reach 127.0.0.1 is the same trust level as being
 * able to run `npm run admin:reset-password` or read the DB, so this adds no new
 * attack surface. Errors stay generic so it never becomes a username oracle
 * beyond what the sign-up form already reveals.
 */
async function handleResetPassword(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  isLoopback: boolean,
): Promise<void> {
  if (!isLoopback) return sendJson(response, { ok: false, error: '密码重置只能在本机（127.0.0.1）上操作。' }, 403);
  const body = readRecord(await readJson(request));
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  if (!username) return sendJson(response, { ok: false, errors: { username: '请选择要重置的账号' } }, 400);
  if (password.length < 8 || password.length > 20) {
    return sendJson(response, { ok: false, errors: { password: '密码需要 8-20 个字符' } }, 400);
  }
  try {
    setPassword(username, password);
  } catch {
    return sendJson(response, { ok: false, errors: { username: '重置失败：找不到这个账号' } }, 400);
  }
  return sendJson(response, { ok: true, username });
}

function handleLogout(_request: http.IncomingMessage, response: http.ServerResponse, auth: AuthContext): void {
  if (auth.sessionToken) destroySession(auth.sessionToken);
  response.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'set-cookie': clearCookieHeader(),
  });
  response.end(JSON.stringify({ ok: true }));
}

/**
 * Manually push the latest workflow output (plan/review) to the configured IM —
 * the escape hatch when the automatic send failed or the run was send-less.
 */
async function resendLatestWorkflow(options: UiServerOptions): Promise<Record<string, unknown>> {
  const env = readEnvFile(options.envPath);
  applyEnv(env);
  const config = loadConfig(options.configPath);
  const latest = readLatestWorkflowOutput(config);
  if (!latest) return { ok: false, error: '没有可发送的 workflow 产物。' };
  if (!config.output.feishu.enabled) return { ok: false, error: 'output.feishu.enabled=false；未配置 IM 输出。' };
  const todos = latest.workflow === 'daily_plan' ? extractDailyPlanTodos(latest.content) : [];
  // Re-collect evidence so the resent card renders identically to a direct run
  // (the two-part briefing needs the Linear items; without evidence it degraded
  // to the plain list). Best-effort: a failed collection falls back to no
  // evidence rather than blocking the resend.
  const evidence = await collectEvidence(config, latest.date).catch(() => undefined);
  const planTable = latest.workflow === 'daily_plan' ? buildDailyPlanTable(latest.content, latest.date, evidence, config) : null;
  try {
    await sendFeishuMessage(config, formatWorkflowSummaryForFeishu(latest.workflow, latest.date, latest.content, evidence, config), {
      workflow: latest.workflow,
      date: latest.date,
      ...(todos.length ? { todos } : {}),
      ...(planTable ? { planTable } : {}),
    });
  } catch (error) {
    return { ok: false, error: `发送失败：${error instanceof Error ? error.message : String(error)}` };
  }
  return { ok: true, text: `已发送 ${latest.workflow}（${latest.date}）到飞书。` };
}

/**
 * Reorder today's plan.
 *
 * The plan's order is the model's ranking, and the person doing the work is
 * allowed to disagree with it. That disagreement is recorded rather than
 * applied: the workflow output on disk is what `daily_plan` said, and rewriting
 * it would destroy the record the evening review reconciles against — and the
 * signal the scorer eventually wants, which is precisely "the model put this
 * fourth and the user moved it first".
 *
 * So it writes one `reorder` entry per row into the same append-only ledger
 * that already holds complete / defer / estimate edits. `reorder` has been in
 * `TodoFeedbackEvent` since the ledger was written; this is the first thing to
 * produce one.
 *
 * Takes the whole order, not a moved id and a destination. A single moved row
 * leaves every other row's rank implicit, and "implicit" has to be recomputed
 * identically on both sides forever; sending the full list means the ledger
 * says what the day looks like rather than how it got there.
 */
/**
 * Put the user's ordering back over the model's, and renumber.
 *
 * A row with no recorded rank keeps the model's position rather than being
 * swept to one end: the plan can grow between a reorder and a read — a rerun
 * adds rows, and the ledger says nothing about them — and a new row silently
 * appearing at the top of someone's day is worse than it appearing where the
 * model put it.
 *
 * `rank` is rewritten to the final 1..n, because it is not decoration: it is
 * half the ledger key every client sends back with complete / defer / update.
 * Leaving the model's original numbers on a reordered list would make two rows
 * claim the same position.
 */
// Lives in todo/today-plan.ts now (team sync builds the same snapshot); kept
// exported here for callers and tests that import it from the server module.
export { applyUserOrder };

async function reorderTodayPlan(options: UiServerOptions, body: unknown): Promise<Record<string, unknown>> {
  const request = readRecord(body);
  const order = Array.isArray(request.order)
    ? request.order.map((id) => String(id || '').trim()).filter(Boolean)
    : [];
  if (order.length === 0) return { ok: false, error: 'order must be a non-empty array of candidate ids.' };
  if (new Set(order).size !== order.length) return { ok: false, error: 'order contains duplicate candidate ids.' };

  const env = readEnvFile(options.envPath);
  applyEnv(env);
  const config = loadConfig(options.configPath);
  const date = todayInTimezone(config);
  const ts = new Date().toISOString();
  for (const [index, candidateId] of order.entries()) {
    recordTodoFeedback(config, {
      ts,
      date,
      event: 'reorder',
      candidateId,
      rank: index + 1,
      source: 'console-today',
    });
  }
  return { ok: true, order, text: '已调整顺序' };
}

async function todoFeedback(options: UiServerOptions, body: unknown): Promise<Record<string, unknown>> {
  const request = readRecord(body);

  // Plan-card feedback (Today's plan): keyed by the daily_plan candidateId and
  // recorded in the structured ledger the evening daily_review reconciles.
  const candidateId = String(request.candidateId || '').trim();
  if (candidateId) {
    const event = String(request.event || '').trim();
    // `reopen` was already a `TodoFeedbackEvent`, already written by the My
    // Todos restore path, and already honoured by `getCompletedCandidateIds` —
    // only this gate refused it, which made ticking a plan row the one action in
    // the product with no way back. A mis-click is not a decision.
    if (event !== 'complete' && event !== 'partial' && event !== 'defer' && event !== 'update' && event !== 'reopen') {
      return { ok: false, error: 'event must be complete, partial, defer, update or reopen.' };
    }
    const note = typeof request.note === 'string' ? request.note.trim() : '';
    const rank = Number(request.rank) || 0;
    // Only on `update`: complete and defer say nothing about how long the thing
    // takes, and accepting a duration alongside them would let a stray field
    // rewrite an estimate as a side effect of ticking a box.
    //
    // A literal 0 is not garbage — it is how the client says "I have no idea,
    // put it back to unknown". It has to be recorded as 0 rather than as an
    // absent field, because an `update` that merely carries a note must leave
    // an existing estimate alone, and both cases would otherwise look the same
    // in the ledger. Without this, an estimate could be set but never unset.
    const minutes = event === 'update' ? normalizePlanMinutes(request.minutes) : undefined;
    const clearsMinutes = minutes === undefined && event === 'update' && Number(request.minutes) === 0 && request.minutes !== undefined && request.minutes !== null;
    const env = readEnvFile(options.envPath);
    applyEnv(env);
    const config = loadConfig(options.configPath);
    recordTodoFeedback(config, {
      date: todayInTimezone(config),
      event,
      candidateId,
      rank,
      source: 'console-today',
      ...(note ? { note } : {}),
      ...(minutes ? { minutes } : clearsMinutes ? { minutes: 0 } : {}),
    });
    return {
      ok: true,
      candidateId,
      event,
      ...(minutes ? { minutes } : {}),
      text:
        event === 'complete'
          ? '已标记完成'
          : event === 'partial'
            ? '已标记部分完成'
            : event === 'defer'
            ? '已延期'
            : event === 'reopen'
              ? '已恢复'
              : minutes
                ? `已改为 ${minutes} 分钟`
                : clearsMinutes
                  ? '已清掉估时'
                  : '已记录更新',
    };
  }

  // Inbox feedback (My todos). This must write through to the inbox ledger's own
  // status, not just the display-state line: the next daily plan builds its
  // candidates from `todoInboxEvidence().open`, so a "Done" that only recorded a
  // display state left the item open and it kept being re-planned.
  const id = String(request.id || '').trim();
  const action = String(request.action || '').trim();
  if (!id) return { ok: false, error: 'Todo id is required.' };
  if (action !== 'check' && action !== 'defer') return { ok: false, error: 'action must be check or defer.' };
  const env = readEnvFile(options.envPath);
  applyEnv(env);
  const config = loadConfig(options.configPath);
  updateTodoInboxItemById(config, id, { status: action === 'check' ? 'done' : 'deferred' });
  return { ok: true, id, action };
}

async function cancelRun(options: UiServerOptions, body: unknown): Promise<Record<string, unknown>> {
  const request = readRecord(body);
  const runId = String(request.runId || '').trim();
  if (!runId) return { ok: false, error: 'runId is required.' };
  const result = await runManager.cancel(runId);
  if (!result.ok) return { ok: false, error: `Run not active: ${runId}` };
  // Best-effort ledger writeback for in-process runs that have no killable child.
  try {
    const config = loadConfig(options.configPath);
    const run = listRecentWorkflowRuns(config, 50).find((item) => item.id === runId);
    if (run && run.status === 'running') markWorkflowRunFailed(config, run, 'Cancelled by operator from console.');
  } catch {
    // ledger writeback is best-effort; the process signal already happened.
  }
  return { ok: true, runId, status: result.status, signals: result.signals };
}

async function rerunWorkflow(options: UiServerOptions, body: unknown): Promise<Record<string, unknown>> {
  const request = readRecord(body);
  const workflow = String(request.workflow || '').trim();
  if (!isWorkflowName(workflow)) return { ok: false, error: `Unknown workflow: ${workflow}` };
  const env = readEnvFile(options.envPath);
  applyEnv(env);
  const config = loadConfig(options.configPath);
  // Fire-and-forget: the run registers with runManager immediately (visible
  // under "In flight" on reload) and the response returns right away instead
  // of blocking the button for the whole workflow. Mirrors the scheduler's IM
  // behavior (send: true) so a console-triggered run also notifies Feishu.
  void runWorkflow(config, workflow, { send: true, trigger: 'ui', source: 'console-rerun' }).catch((error) => {
    console.warn(`[console-rerun] ${workflow} failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  return { ok: true, workflow, started: true, text: `已启动 ${workflow}，见 In flight;完成后会同步发送 IM。` };
}

async function backfillSchedule(options: UiServerOptions, body: unknown): Promise<Record<string, unknown>> {
  const request = readRecord(body);
  const workflow = String(request.workflow || '').trim();
  if (!isWorkflowName(workflow)) return { ok: false, error: `Unknown workflow: ${workflow}` };
  const env = readEnvFile(options.envPath);
  applyEnv(env);
  const config = loadConfig(options.configPath);
  const text = await runWorkflow(config, workflow, { send: true, trigger: 'ui', source: 'console-backfill' });
  return { ok: true, workflow, chars: text.length };
}

function isWorkflowName(value: string): value is WorkflowName {
  return value === 'daily_plan' || value === 'daily_review' || value === 'weekly_review';
}

// Only allow tailing known log files inside the repo logs/ directory.
function sendScheduleLogs(response: http.ServerResponse, url: URL): void {
  const name = url.searchParams.get('name') || 'launchd.err.log';
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return send(response, 400, 'Invalid log name.', 'text/plain; charset=utf-8');
  const filePath = path.resolve('logs', name);
  const logsRoot = path.resolve('logs');
  if (!filePath.startsWith(logsRoot + path.sep) || !fs.existsSync(filePath)) {
    return send(response, 404, `Log not found: ${name}`, 'text/plain; charset=utf-8');
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  const tail = raw.split('\n').slice(-300).join('\n');
  send(response, 200, tail, 'text/plain; charset=utf-8');
}

function reindexArtifacts(): Record<string, unknown> {
  const result = scanAndIndex();
  return { ok: true, ...result };
}

/**
 * Pull the weekly-review skill repo. Admin-only: it mutates a checkout that the
 * Claude CLI also reads through `~/.claude/skills/weekly-review`, so a member
 * pressing it would change what everyone's next run executes.
 */
async function updateSkill(options: UiServerOptions, auth: AuthContext): Promise<Record<string, unknown>> {
  if (auth.role !== 'admin') return { ok: false, error: 'Admin role required.' };
  const config = loadConfig(options.configPath);
  const result = await updateSkillRepo(config);
  return { ...result, state: await readSkillRepoState(config) };
}

/**
 * LEO-287: install the weekly-review skill from the console — git clone
 * life-review-os, then register its checkout in config.skills.registry so the
 * CLI and Daily OS both find it. Admin-only (it is also a non-whitelisted write,
 * so the member gate already rejects it).
 */
async function installSkill(options: UiServerOptions, auth: AuthContext, body: unknown): Promise<Record<string, unknown>> {
  if (auth.role !== 'admin') return { ok: false, error: 'Admin role required.' };
  const dir = typeof readRecord(body).dir === 'string' ? String(readRecord(body).dir) : '';
  const result = await installSkillRepo(dir || defaultSkillInstallDir());
  if (!result.ok || !result.registered) return { ...result };
  // Persist the checkout into the registry (same write path as saveConfig).
  const config = loadConfig(options.configPath);
  const entry: AppConfig['skills']['registry'][number] = {
    id: 'weekly-review',
    provider: 'auto',
    path: result.registered.path,
    workdir: result.registered.workdir,
    default_mode: 'weekly',
    effects: ['read', 'draft', 'feishu_write'],
    require_confirmation_for: ['feishu_write'],
  };
  const registry = [...config.skills.registry.filter((existing) => existing.id !== 'weekly-review'), entry];
  const nextConfig: AppConfig = { ...config, skills: { ...config.skills, enabled: true, registry } };
  fs.writeFileSync(path.resolve(options.configPath), `${yaml.dump(nextConfig, { lineWidth: 120, noRefs: true })}`, 'utf8');
  return { ...result };
}

function adminUsers(auth: AuthContext, body: unknown): Record<string, unknown> {
  if (auth.role !== 'admin') return { ok: false, error: 'Admin role required.' };
  const request = readRecord(body);
  const action = String(request.action || 'add').trim();
  const username = String(request.username || '').trim();
  const password = String(request.password || '');
  try {
    if (action === 'add') {
      const role: Role = request.role === 'admin' ? 'admin' : 'member';
      addUser(username, password, role);
      return { ok: true, action, username, role, users: listUsers() };
    }
    if (action === 'set_password') {
      setPassword(username, password);
      return { ok: true, action, username, users: listUsers() };
    }
    return { ok: false, error: `Unknown action: ${action}` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// --- web console chat (LEO-236) ---------------------------------------------

function loadRuntimeConfig(options: UiServerOptions): AppConfig {
  const env = readEnvFile(options.envPath);
  applyEnv(env);
  return loadConfig(options.configPath);
}

function chatSessions(options: UiServerOptions): Record<string, unknown> {
  return { ok: true, sessions: listWebChatSessions(loadRuntimeConfig(options)) };
}

function chatCreateSession(options: UiServerOptions): Record<string, unknown> {
  return { ok: true, session: createWebChatSession(loadRuntimeConfig(options)) };
}

function chatMessages(url: URL): Record<string, unknown> {
  const sessionId = (url.searchParams.get('session') || '').trim();
  if (!sessionId) return { ok: false, error: 'session is required' };
  return { ok: true, messages: listWebChatMessages(sessionId) };
}

async function chatStop(body: unknown): Promise<Record<string, unknown>> {
  const sessionId = String(readRecord(body).session || '').trim();
  if (!sessionId) return { ok: false, error: 'session is required' };
  return { ok: true, stopped: await stopWebChatSession(sessionId) };
}

async function chatDeleteSession(options: UiServerOptions, body: unknown): Promise<Record<string, unknown>> {
  const sessionId = String(readRecord(body).session || '').trim();
  if (!sessionId) return { ok: false, error: 'session is required' };
  // Stop any in-flight run first so an orphaned stream cannot keep writing.
  await stopWebChatSession(sessionId);
  const env = readEnvFile(options.envPath);
  applyEnv(env);
  const config = loadConfig(options.configPath);
  return { ok: true, deleted: deleteWebChatSession(config, sessionId) };
}

/**
 * Streams a chat turn to the browser over SSE. Members are pre-checked so an
 * over-privileged (free-form / durable-write) turn is rejected with 403 before
 * the stream opens; allowed turns run through the shared agent-mode + command
 * backends and forward progress + reply events as they happen.
 */
async function handleChatSend(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  options: UiServerOptions,
  auth: AuthContext,
): Promise<void> {
  const body = readRecord(await readJson(request));
  const text = String(body.text || '');
  if (!text.trim()) return sendJson(response, { ok: false, error: 'text is required' }, 400);

  const config = loadRuntimeConfig(options);
  const allowed = isWebChatTurnAllowed(config, auth.role, text);
  if (!allowed.ok) return sendJson(response, { ok: false, error: `权限不足：${allowed.reason}` }, 403);
  const sessionId = String(body.session || '').trim() || createWebChatSession(config).id;

  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-content-type-options': 'nosniff',
    'x-chat-session-id': sessionId,
  });
  const write = (event: WebChatEvent): void => {
    if (!response.writableEnded) response.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  // Heartbeat comments keep intermediaries from closing an idle stream while a
  // long codex turn is running.
  const heartbeat = setInterval(() => {
    if (!response.writableEnded) response.write(': ping\n\n');
  }, 15_000);
  // A client disconnect (navigation, or the Stop button aborting the fetch)
  // terminates the in-flight run for this session.
  request.on('close', () => {
    void stopWebChatSession(sessionId);
  });

  try {
    await runWebChatTurn({ config, sessionId, role: auth.role, text, onEvent: write });
  } catch (error) {
    write({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  } finally {
    clearInterval(heartbeat);
    if (!response.writableEnded) response.end();
  }
}

function attachNetworkLog(request: http.IncomingMessage, response: http.ServerResponse, url: URL, started: number): void {
  if (!url.pathname.startsWith('/api/') || url.pathname === '/api/logs') return;
  response.once('finish', () => {
    const statusCode = response.statusCode;
    appendUiLog({
      event: 'network',
      level: statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warning' : 'info',
      status: statusCode >= 400 ? 'error' : 'ok',
      method: request.method || 'GET',
      path: safeLogPath(url),
      status_code: statusCode,
      duration_ms: Date.now() - started,
    });
  });
}

function safeLogPath(url: URL): string {
  if (url.pathname === '/api/env-secret') return '/api/env-secret';
  return url.pathname;
}

function readSecret(
  options: UiServerOptions,
  key: string,
  access: { reveal: boolean; loopback: boolean },
): Record<string, unknown> {
  if (!SECRET_ENV_KEYS.has(key)) return { ok: false, error: 'Secret key is not allowed' };
  const env = readEnvFile(options.envPath);
  const value = env[key] || process.env[key] || '';
  const present = Boolean(value);
  // Default response never leaks the plaintext value: presence + masked preview only.
  // The real value is echoed back only for an explicit local reveal (token already verified
  // by the request guard, and the request must come from a loopback host).
  if (access.reveal && access.loopback) {
    return { ok: true, key, present, masked: maskSecret(value), value };
  }
  return { ok: true, key, present, masked: maskSecret(value) };
}

async function buildState(options: UiServerOptions): Promise<Record<string, unknown>> {
  const env = readEnvFile(options.envPath);
  applyEnv(env);
  const config = loadConfig(options.configPath);
  const checks = await runDoctor(config, options.configPath);
  return {
    ok: true,
    configPath: path.resolve(options.configPath),
    envPath: path.resolve(options.envPath),
    config,
    env: redactedEnv(env),
    doctor: checks,
    doctorText: formatDoctor(checks),
    service: await getLaunchAgentStatus(),
    backgroundSuggestions: readBackgroundSuggestionsState(config),
    decisionPolicy: readDecisionPolicyState(config),
    rhythm: readRhythmState(config),
    strategy: readStrategyState(config),
    // Local git reads only — no fetch. This runs on every console load, and the
    // page must not wait on the network to render.
    skillRepo: await readSkillRepoState(config),
    okr: readOkrEditorState(config),
    cycles: readCyclesState(config),
    // Two halves of the same feature, merged under one key so neither silently
    // overwrites the other: identity/team membership at the top level, and the
    // sync + read-only view state under `view`.
    //
    // Local disk read only — see readTeamUiState / readTeamViewState. Nothing in
    // /api/state may depend on Supabase being reachable.
    team: { ...readTeamUiState(config), view: await readTeamViewState(config) },
    todoInbox: {
      enabled: config.todo_inbox.enabled,
      open: openTodoInboxItems(config),
      recent: listTodoInboxItems(config).filter((item) => item.status !== 'deleted').slice(-40).reverse(),
    },
  };
}

/**
 * The rules behind a cycle live in several files across two repos: the block this
 * app injects into the input pack, and the life-review-os files its prompt
 * builders embed — two for planning the next cycle, two for reviewing the one
 * that ended. Editing only one leaves the planner reading two versions of the
 * same rule, so the console exposes them together.
 *
 * Clients send an id from this list, never a path — the allowlist is what keeps
 * the endpoint from turning into an arbitrary file write.
 */
interface StrategyFile {
  id: string;
  label: string;
  hint: string;
  path: string;
}

function strategyFiles(config: AppConfig): StrategyFile[] {
  const files: StrategyFile[] = [
    {
      id: 'biweekly_strategy',
      label: '计划条目规则（注入 input pack）',
      hint: 'Daily OS 拼进双周 input pack 的计划条目规则。留空则回退到代码内置的默认规则。',
      path: path.resolve(BIWEEKLY_STRATEGY_FILE),
    },
  ];
  const workdir = lifeReviewOsWorkdir(config);
  if (workdir) {
    files.push(
      {
        id: 'plan_rules',
        label: 'engine/03-plan.md（规划规则）',
        hint: 'life-review-os 作为 "# Planning Rules" 整段嵌入 prompt：MIT 数量、要务粒度、照搬规则、Linear 覆盖核对。',
        path: path.join(workdir, 'engine', '03-plan.md'),
      },
      {
        id: 'biweekly_mode',
        label: 'modes/biweekly.md（双周模式）',
        hint: '双周模式独有的读取范围、趋势分析和写回行为。',
        path: path.join(workdir, 'modes', 'biweekly.md'),
      },
      // The two files the review itself is built from. Until these were listed,
      // the console could change how the next cycle gets planned but not how it
      // gets reviewed — including from the Cycles page's own generate button.
      {
        id: 'analyze_rules',
        label: 'engine/02-analyze.md（分析规则）',
        hint: 'life-review-os 作为 "# Analysis Rules" 整段嵌入 prompt。完整 weekly/biweekly 和 Cycles 页的「用 AI 生成 review」都读它。',
        path: path.join(workdir, 'engine', '02-analyze.md'),
      },
      {
        id: 'review_style',
        label: 'engine/08-retro-review.md（review 文体）',
        hint: 'review 的长度与段落约束（默认 350 字以内、固定两段）。<!-- CONTRACT --> 之后的正文才会进 prompt，前面是给你看的说明。清空或删除会回退到内置默认。',
        path: path.join(workdir, 'engine', '08-retro-review.md'),
      },
    );
  }
  return files;
}

function lifeReviewOsWorkdir(config: AppConfig): string {
  const entry = config.skills.registry.find((candidate) => candidate.id === 'weekly-review');
  if (!entry) return '';
  const workdir = expandPath(entry.workdir || '');
  return workdir && fs.existsSync(workdir) ? workdir : '';
}

function readStrategyState(config: AppConfig): Record<string, unknown> {
  return {
    files: strategyFiles(config).map((file) => ({
      id: file.id,
      label: file.label,
      hint: file.hint,
      path: file.path,
      exists: fs.existsSync(file.path),
      markdown: readTextIfExists(file.path),
    })),
    defaultStrategy: defaultBiweeklyStrategy(),
  };
}

async function saveStrategy(options: UiServerOptions, body: unknown): Promise<Record<string, unknown>> {
  const request = readRecord(body);
  const env = readEnvFile(options.envPath);
  applyEnv(env);
  const config = loadConfig(options.configPath);
  const id = String(request.id || '');
  const file = strategyFiles(config).find((candidate) => candidate.id === id);
  if (!file) throw new Error(`Unknown strategy file: ${id || '(empty)'}`);
  const markdown = String(request.markdown ?? '').replace(/\r\n/g, '\n');
  fs.mkdirSync(path.dirname(file.path), { recursive: true });
  fs.writeFileSync(file.path, markdown, 'utf8');
  return { ok: true, text: `Saved ${file.path}`, state: await buildState(options) };
}

function readDecisionPolicyState(config: AppConfig): Record<string, unknown> {
  const files = ensureDecisionPolicyFiles(config);
  return {
    repositoryPath: files.repositoryPath,
    notesPath: files.notesPath,
    policyMd: readTextIfExists(files.notesPath),
  };
}

/**
 * The user's rhythm, as the console needs it.
 *
 * `today` is the point of the whole page. Showing only the settings would leave
 * the user to work out for themselves that "rest_days: [SAT, SUN]" means this
 * particular Saturday gets one work item — which is exactly the inference this
 * feature exists to stop asking people to make. Resolved through the same
 * `resolveDayShape` the planner uses, so what the page claims and what the plan
 * does cannot drift.
 */
function readRhythmState(config: AppConfig): Record<string, unknown> {
  const files = ensureRhythmFile(config);
  const notes = readRhythmNotes(config);
  const today = todayInTimezone(config);
  return {
    repositoryPath: files.repositoryPath,
    notesPath: files.notesPath,
    notesMd: notes,
    isTemplate: rhythmNotesAreTemplate(notes),
    defaultMd: defaultRhythmMarkdown(),
    restDays: normalizeRestDays(config.user.rhythm.rest_days),
    today: resolveDayShape(config, today),
    tomorrow: resolveDayShape(config, addDays(today, 1)),
  };
}

/**
 * Today's plan, as data.
 *
 * Deliberately the same snapshot `renderPlanColumn` renders — the point is that
 * the web page and the native client cannot drift, so this reuses the builder
 * rather than re-implementing it.
 *
 * `stale` is always false and stays on the wire anyway: the snapshot is today's
 * plan or nothing (LEO-309), so there is no longer a day-behind plan to flag,
 * but the Mac client decodes the field as a required Bool and dropping it would
 * fail the whole response. Sent as a constant rather than as a comparison that
 * can only come out false.
 */
function readTodayPlan(options: UiServerOptions): Record<string, unknown> {
  const env = readEnvFile(options.envPath);
  applyEnv(env);
  const config = loadConfig(options.configPath);
  const today = todayInTimezone(config);
  const snapshot = buildTodayPlanSnapshot(config);
  if (!snapshot) return { ok: true, plan: null, todos: [], feedback: {}, today };
  return {
    ok: true,
    plan: { date: snapshot.date, workflow: 'daily_plan', stale: false, generated_at: snapshot.generated_at },
    todos: snapshot.todos,
    feedback: snapshot.feedback,
    today,
  };
}

async function captureTodo(options: UiServerOptions, body: unknown): Promise<Record<string, unknown>> {
  const request = readRecord(body);
  const text = String(request.text || '').trim();
  if (!text) throw new Error('Capture text is empty.');
  const env = readEnvFile(options.envPath);
  applyEnv(env);
  const config = loadConfig(options.configPath);
  const command = parseTodoInboxCommand(text) || { type: 'capture' as const, text };
  if (command.type === 'capture' && typeof request.type === 'string' && isTodoInboxType(request.type)) command.itemType = request.type;
  const result = handleTodoInboxCommand(config, command, { source: 'local-ui' });
  return { ok: true, text: result.reply || 'Todo inbox updated.', items: result.items || [], state: await buildState(options) };
}

async function updateTodoInbox(options: UiServerOptions, body: unknown): Promise<Record<string, unknown>> {
  const request = readRecord(body);
  const id = String(request.id || '').trim();
  if (!id) throw new Error('Todo id is required.');
  const env = readEnvFile(options.envPath);
  applyEnv(env);
  const config = loadConfig(options.configPath);
  const status = typeof request.status === 'string' && isTodoInboxStatus(request.status) ? request.status : undefined;
  const result = updateTodoInboxItemById(config, id, {
    text: typeof request.text === 'string' ? request.text : undefined,
    type: typeof request.type === 'string' && isTodoInboxType(request.type) ? request.type : undefined,
    status,
    note: typeof request.note === 'string' ? request.note : undefined,
  });
  // Restoring from History/Deferred must also clear the completed state in the
  // feedback ledger, or the scorer would keep excluding it and the restored todo
  // could never be planned again.
  if (status === 'open') {
    recordTodoFeedback(config, {
      date: todayInTimezone(config),
      event: 'reopen',
      candidateId: `todo_inbox:${id}`,
      rank: 0,
      source: 'console-my-todos',
    });
  }
  return { ok: true, text: result.reply || 'Todo inbox updated.', items: result.items || [], state: await buildState(options) };
}

async function saveRhythm(options: UiServerOptions, body: unknown): Promise<Record<string, unknown>> {
  const request = readRecord(body);
  const env = readEnvFile(options.envPath);
  applyEnv(env);
  const config = loadConfig(options.configPath);
  const files = ensureRhythmFile(config);
  const markdown = String(request.notesMd ?? '').replace(/\r\n/g, '\n');
  fs.mkdirSync(path.dirname(files.notesPath), { recursive: true });
  fs.writeFileSync(files.notesPath, markdown, 'utf8');
  return { ok: true, text: `Saved rhythm notes: ${files.notesPath}`, state: await buildState(options) };
}

async function saveDecisionPolicy(options: UiServerOptions, body: unknown): Promise<Record<string, unknown>> {
  const request = readRecord(body);
  const env = readEnvFile(options.envPath);
  applyEnv(env);
  const config = loadConfig(options.configPath);
  const files = ensureDecisionPolicyFiles(config);
  const markdown = String(request.policyMd ?? '').replace(/\r\n/g, '\n');
  fs.mkdirSync(path.dirname(files.notesPath), { recursive: true });
  fs.writeFileSync(files.notesPath, markdown, 'utf8');
  return { ok: true, text: `Saved decision policy notes: ${files.notesPath}`, state: await buildState(options) };
}

async function saveOkr(options: UiServerOptions, body: unknown): Promise<Record<string, unknown>> {
  const request = readRecord(body);
  const env = readEnvFile(options.envPath);
  applyEnv(env);
  const config = loadConfig(options.configPath);
  const level = String(request.level ?? '');
  const markdown = String(request.markdown ?? '');
  const result = writeOkrFile(config, level, markdown);
  return { ok: true, text: `Saved OKR: ${result.path}`, state: await buildState(options) };
}

function formatOkr(body: unknown): Record<string, unknown> {
  const request = readRecord(body);
  const level = String(request.level ?? '') as OkrLevel;
  const markdown = String(request.markdown ?? '');
  return { ok: true, formatted: normalizeOkrMarkdown(markdown, level) };
}

/**
 * Cycle documents for the console (LEO-277).
 *
 * `sections` is passed through as the file layer reports it: a section that was
 * never written has no key at all, which the page has to show differently from
 * one someone deliberately emptied. `frontmatterError` travels with the cycle
 * because the write path refuses those files — the page disables saving rather
 * than letting the user type a retro that will bounce.
 */
function readCyclesState(config: AppConfig): Record<string, unknown> {
  const items = listCycles(config).map((doc) => ({
    id: doc.id,
    startDate: doc.startDate,
    cycle: doc.cycle,
    mode: doc.mode,
    updatedAt: doc.updatedAt,
    path: cycleFilePath(config, doc.id),
    frontmatterError: doc.frontmatterError || '',
    sections: doc.sections,
  }));
  return { dir: cyclesDir(config), items };
}

/**
 * Read model for the standalone /cycles page: my own cycle files plus the
 * read-only teammate view. Both readers are the same ones /api/state uses, so
 * the page and the console cannot drift apart on what a cycle looks like.
 *
 * Disk only — a page render must never be able to hang on a Supabase poll.
 */
async function readCyclesPageState(options: UiServerOptions): Promise<Record<string, unknown>> {
  const env = readEnvFile(options.envPath);
  applyEnv(env);
  const config = loadConfig(options.configPath);
  return { ok: true, cycles: readCyclesState(config), team: await readTeamViewState(config) };
}

async function readTeamTodayPage(options: UiServerOptions): Promise<Record<string, unknown>> {
  const env = readEnvFile(options.envPath);
  applyEnv(env);
  const config = loadConfig(options.configPath);
  return { ok: true, ...(await readTeamTodayState(config)) };
}

/**
 * Save one section of one cycle. The other two sections are left byte-identical
 * by `writeSection`, so editing the retro mid-cycle cannot restamp the
 * planner-written priorities.
 *
 * The user is always the author here: whatever they type is `source: 'user'`,
 * which is what stops a later planner run from overwriting it.
 */
/**
 * Draft the review for one local cycle, using life-review-os's own rules.
 *
 * Nothing is written: the prose comes back to the page as an unsaved draft. A
 * generated opinion about a cycle the user lived through is theirs to read and
 * edit before it becomes part of their record, so it goes through the same save
 * button as anything they typed.
 *
 * `save: true` is the one exception, and it exists for clients that cannot hold
 * a draft across the call: the Mac app gives up on the socket after 30 seconds
 * while the drafting model runs for one to two minutes, so a returned draft is
 * one nobody receives. Writing it here means the prose survives the disconnect
 * — as `source: 'ai'`, never as the user's own words. It only ever fills a gap:
 * a cycle that already has a review is refused below, before the minutes are
 * spent, so this can neither clobber a draft nor quietly bill for one.
 */
async function generateCycleReviewSection(options: UiServerOptions, body: unknown): Promise<Record<string, unknown>> {
  const request = readRecord(body);
  const env = readEnvFile(options.envPath);
  applyEnv(env);
  const config = loadConfig(options.configPath);

  // Same guard as the save path: a request naming an owner must name the
  // signed-in account. Generating for a teammate would read their cached cycle
  // and hand it back as something to save into this vault.
  await assertLocalCycleWriteTarget(config, request.owner ?? request.ownerId);

  const id = String(request.id || '').trim();
  if (!parseCycleId(id)) throw new Error(`Invalid cycle id: ${id || '(empty)'}`);
  const cycle = readCycle(config, id);
  if (!cycle) throw new Error(`Cycle not found: ${id}`);

  const priorities = cycle.sections['要务']?.content || '';
  const retro = cycle.sections.retro?.content || '';
  if (!priorities.trim() && !retro.trim()) {
    throw new Error(`周期 ${cycle.cycle || id} 既没有要务也没有 retro，没有可以复盘的内容。先写 retro 再生成。`);
  }

  const save = request.save === true;
  if (save && (cycle.sections.review?.content || '').trim()) {
    throw new Error(`周期 ${cycle.cycle || id} 已经有 review 了，不会覆盖。要重写就先把这一段清空再生成。`);
  }
  if (save && cycle.frontmatterError) {
    throw new Error(`周期 ${id} 的 frontmatter 无法解析（${cycle.frontmatterError}），写不进去。请先在文件里修好 YAML。`);
  }

  const review = await generateCycleReview(config, 'weekly-review', {
    cycle: cycle.cycle || id,
    mode: cycle.mode || 'biweekly',
    priorities,
    retro,
  });
  const saved = save ? writeSection(config, id, 'review', review.text, 'ai') : null;
  return {
    ok: true,
    id,
    review: review.text,
    chars: review.chars,
    hadRetro: Boolean(retro.trim()),
    savedAt: saved?.sections.review?.updatedAt || '',
  };
}

async function saveCycleSection(options: UiServerOptions, body: unknown): Promise<Record<string, unknown>> {
  const request = readRecord(body);
  const env = readEnvFile(options.envPath);
  applyEnv(env);
  const config = loadConfig(options.configPath);

  // LEO-285: the page can be showing a teammate's cycles, and that view is
  // read-only. The buttons are hidden there, but hiding is not enforcement — a
  // stale tab or a hand-made request would otherwise write a teammate's text
  // into the local vault as the local user's own. A request that names an owner
  // must name the signed-in account; one that names none targets 20_CYCLES,
  // which belongs to whoever is at this machine.
  await assertLocalCycleWriteTarget(config, request.owner ?? request.ownerId);

  const id = String(request.id || '').trim();
  if (!parseCycleId(id)) throw new Error(`Invalid cycle id: ${id || '(empty)'}`);
  const section = String(request.section || '') as CycleSection;
  if (!CYCLE_SECTIONS.includes(section)) throw new Error(`Unknown cycle section: ${String(request.section || '(empty)')}`);

  // Only cycles that already exist are editable. The console offers the list it
  // read from disk, so an id that is not there is a stale page or a typo, and
  // honouring it would create an empty cycle file nobody asked for.
  const current = readCycle(config, id);
  if (!current) throw new Error(`Cycle not found: ${id}`);
  if (current.frontmatterError) {
    throw new Error(
      `周期 ${id} 的 frontmatter 无法解析（${current.frontmatterError}），已拒绝保存。请先在文件里修好 YAML 再回来。`,
    );
  }

  const doc = writeSection(config, id, section, String(request.content ?? ''), 'user');

  // Upload after the file is on disk, and never let it change the outcome of
  // the save. The local write is the thing that succeeded; sync is a transport
  // that retries on the next poll. Awaited only so the state we return already
  // reflects the attempt.
  // Through the loop when there is one, so this push is serialized against the
  // 60s tick and the file watcher instead of racing them for state.json.
  const sync = await (teamSyncLoop ? teamSyncLoop.pushCycle(id) : pushLocalCycle(config, id)).catch((error: unknown) => ({
    status: 'error' as const,
    reason: error instanceof Error ? error.message : String(error),
  }));

  return {
    ok: true,
    text: `已保存 ${section} → ${cycleFilePath(config, id)}`,
    savedAt: doc.sections[section]?.updatedAt || '',
    sync: { status: sync.status, reason: sync.reason },
    state: await buildState(options),
  };
}

/**
 * Create the next cycle file, and set the planner going on its 要务.
 *
 * Until now a cycle file only ever came into being as a side effect of a
 * finished life-review-os run (`cycles/writeback.ts`), which meant there was no
 * way to say "start the next one" — you waited for a run, or you made the file
 * by hand in the vault. This is that missing verb.
 *
 * Every field is optional and a blank one is answered from the previous cycle
 * rather than from a constant; `planNextCycle` explains why. The file is created
 * with frontmatter only: 要务 belongs to the planner, and seeding it with
 * anything would leave a fabricated priority list sitting in a real cycle if the
 * run never finishes.
 *
 * The planning run is *not* awaited — see `startCyclePlanning`.
 */
async function createCycle(options: UiServerOptions, body: unknown): Promise<Record<string, unknown>> {
  const request = readRecord(body);
  const env = readEnvFile(options.envPath);
  applyEnv(env);
  const config = loadConfig(options.configPath);

  // Same guard as the save path: creating a cycle is a write into 20_CYCLES,
  // which belongs to whoever is at this machine, and a request that names an
  // owner must name the signed-in account.
  await assertLocalCycleWriteTarget(config, request.owner ?? request.ownerId);

  const days = readOptionalCount(request.days, '周期长度', MIN_CYCLE_DAYS, MAX_CYCLE_DAYS);
  const taskCount = readOptionalCount(request.taskCount, '要务数量', 1, 50);
  const note = String(request.note ?? '').trim();

  // Newest first, so `[0]` is the cycle this one follows.
  const plan = planNextCycle(listCycles(config)[0] || null, {
    ...(days === undefined ? {} : { days }),
    today: todayInTimezone(config),
  });

  // Refuse rather than merge. `writeCycle` would happily fold new frontmatter
  // into an existing file, and the cycle most likely to collide here is the one
  // a planning run already wrote 要务 into — the exact file whose contents
  // nobody can reconstruct, since 20_CYCLES is untracked in git.
  const filePath = cycleFilePath(config, plan.id);
  if (fs.existsSync(filePath)) {
    throw new Error(`周期 ${plan.label} 已经存在了（${filePath}），没有创建也没有覆盖。要重开这一期，先把文件挪走。`);
  }

  writeCycle(config, plan.id, { cycle: plan.label, mode: plan.mode });
  const planning = startCyclePlanning(config, plan, { ...(taskCount === undefined ? {} : { taskCount }), note });

  return {
    ok: true,
    id: plan.id,
    cycle: plan.label,
    mode: plan.mode,
    startDate: plan.startDate,
    endDate: plan.endDate,
    days: plan.days,
    lengthFrom: plan.lengthFrom,
    path: filePath,
    text: `已创建周期 ${plan.label}（${plan.startDate} 起 ${plan.days} 天，${describeCycleLength(plan)}）。`,
    planning,
  };
}

/** How the length was decided, in the words the user would use to check it. */
function describeCycleLength(plan: NextCyclePlan): string {
  if (plan.lengthFrom === 'request') return '按你填的长度';
  if (plan.lengthFrom === 'previous-label') return `沿用上一期 ${plan.previousId.split('_')[1] || ''}`.trim();
  if (plan.lengthFrom === 'previous-mode') return '沿用上一期的 mode';
  return '没有上一期可以参考，用的默认双周';
}

/**
 * Start the planning run that fills in 要务, and report only whether it started.
 *
 * Not awaited on purpose: a biweekly run takes roughly ten minutes, and the
 * caller is an HTTP request whose client gives up after thirty seconds. Awaiting
 * it would turn every successful creation into a timeout.
 *
 * That makes the run's outcome invisible to this response, and there is a second
 * reason it has to be reported elsewhere: life-review-os resolves its own target
 * week from today's date, so the cycle it writes 要务 into is its decision, not
 * ours. Creating the next cycle on the day the current one ends puts the two in
 * agreement; creating one a week early does not. The UI log records which cycle
 * actually received the priorities, rather than this endpoint promising one.
 */
function startCyclePlanning(
  config: AppConfig,
  plan: NextCyclePlan,
  hints: { taskCount?: number; note: string },
): { status: 'started' | 'unavailable'; reason: string } {
  if (!config.skills.enabled) {
    return { status: 'unavailable', reason: 'skills.enabled=false，没有跑规划。要务需要你自己写，或者启用技能后再跑一次。' };
  }
  const entry = config.skills.registry.find((candidate) => candidate.id === 'weekly-review');
  if (!entry || !isLifeReviewOsEntry(entry)) {
    return { status: 'unavailable', reason: '没有可用的 weekly-review skill（life-review-os CLI 找不到），没有跑规划。要务需要你自己写。' };
  }

  const mode = plan.mode === 'weekly' ? 'weekly' : 'biweekly';
  void runConfiguredSkill({
    config,
    skillId: entry.id,
    mode,
    userText: planningRequestText(plan, hints),
    source: 'local-ui-cycle-create',
    messageId: `cycle-create-${plan.id}`,
  })
    .then((result) => {
      appendUiLog({
        event: 'action',
        level: 'info',
        status: 'success',
        action: 'cycle_create_plan',
        detail: result.localCycles ? formatLocalCycleWriteback(result.localCycles) : `规划跑完了，但没有写入任何周期文件（${plan.label}）。`,
      });
    })
    .catch((error: unknown) => {
      appendUiLog({
        event: 'action',
        level: 'error',
        status: 'error',
        action: 'cycle_create_plan',
        detail: `${plan.label} 规划失败：${error instanceof Error ? error.message : String(error)}`,
      });
    });

  return {
    status: 'started',
    reason: `规划已经在后台跑了（${mode === 'biweekly' ? '双周' : '单周'}，大约十分钟）。跑完要务会自己写进周期文件，中途可以在 Runs 里看进度。`,
  };
}

/** The planning run reads free text, so the optional fields travel as a sentence. */
function planningRequestText(plan: NextCyclePlan, hints: { taskCount?: number; note: string }): string {
  return [
    `为周期 ${plan.label}（${plan.startDate} 到 ${plan.endDate}，共 ${plan.days} 天）规划要务。`,
    hints.taskCount === undefined ? '' : `这一期计划 ${hints.taskCount} 条要务。`,
    hints.note ? `这一期要考虑的重要事件：${hints.note}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * An optional whole number from the request body.
 *
 * Empty, missing and null all mean "decide for me" — that is the whole contract
 * of the dialog these come from. Anything else has to be a number in range:
 * silently flooring a `"七天"` or a `0` to a default would look like the app
 * ignored what was typed, which is worse than refusing it.
 */
function readOptionalCount(value: unknown, label: string, min: number, max: number): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label}要填 ${min}-${max} 之间的整数，收到的是「${String(value)}」。留空就按默认策略。`);
  }
  return parsed;
}

/**
 * Team / Supabase actions (LEO-282/283).
 *
 * Deliberately its own endpoint family rather than /api/action: the bodies carry
 * passwords and invite codes, and /api/action writes its request into the UI log.
 * Only the action name and any error message are logged here — never the body,
 * never a token, never a password.
 *
 * Every branch returns a plain { ok, text|error } result and the rebuilt state.
 * A remote failure is data, not an exception: the console keeps working.
 */
async function teamAction(options: UiServerOptions, action: string, body: unknown, auth: AuthContext): Promise<Record<string, unknown>> {
  const request = readRecord(body);
  const env = readEnvFile(options.envPath);
  applyEnv(env);
  const config = loadConfig(options.configPath);
  // LEO-302 (GH #193): map the local console account to the Supabase member by
  // defaulting the display_name to the local username, so「我是谁」lines up across
  // the two identities. An explicit display name from the form still wins.
  const localUsername = findUser(auth.username)?.username || '';

  const run = async (): Promise<TeamActionResult> => {
    switch (action) {
      case 'signup':
        return signUp(config, {
          email: String(request.email || ''),
          password: String(request.password || ''),
          displayName: String(request.displayName || '') || localUsername,
          memberId: String(request.memberId || ''),
        });
      case 'signin':
        return signIn(config, { email: String(request.email || ''), password: String(request.password || '') });
      case 'signout':
        return signOut(config);
      case 'create':
        return createTeam(config, String(request.name || ''));
      case 'join':
        return joinTeam(config, String(request.code || ''));
      case 'leave':
        return leaveTeam(config);
      case 'rotate-code':
        return rotateInviteCode(config);
      case 'refresh':
        return refreshTeam(config);
      default:
        return { ok: false, error: `Unknown team action: ${action || '(empty)'}` };
    }
  };

  let result: TeamActionResult;
  try {
    result = await run();
  } catch (error) {
    // Nothing above is supposed to throw; if it does, it still must not take
    // the console down with a 500.
    result = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  appendUiLog({
    event: 'action',
    level: result.ok ? 'info' : 'error',
    status: result.ok ? 'success' : 'error',
    action: `team_${action}`,
    detail: result.error || '',
  });
  return { ...result, state: await buildState(options) };
}

/**
 * Run a sync tick now (the console's 同步 button). Reports the outcome rather
 * than throwing: "could not reach Supabase" is a status to display, not a
 * failed console operation.
 */
async function runTeamSync(options: UiServerOptions): Promise<Record<string, unknown>> {
  const env = readEnvFile(options.envPath);
  applyEnv(env);
  const config = loadConfig(options.configPath);
  // Go through the loop when there is one, so a manual click cannot overlap a
  // scheduled tick and double-push.
  const result = teamSyncLoop ? await teamSyncLoop.runNow() : await syncTeamOnce(config);
  return { ok: true, sync: result, state: await buildState(options) };
}

function isTodoInboxType(value: string): value is 'todo' | 'reminder' | 'time_boundary' | 'note' {
  return value === 'todo' || value === 'reminder' || value === 'time_boundary' || value === 'note';
}

function isTodoInboxStatus(value: string): value is 'open' | 'done' | 'deferred' | 'deleted' {
  return value === 'open' || value === 'done' || value === 'deferred' || value === 'deleted';
}

async function saveConfig(options: UiServerOptions, body: unknown): Promise<Record<string, unknown>> {
  const config = AppConfigSchema.parse(readRecord(body).config);
  // The service_role key carries BYPASSRLS: with it in a laptop's config every
  // policy in supabase/migrations is a no-op and any teammate can read and
  // overwrite everyone's rows. The two keys sit next to each other in the
  // Supabase dashboard, so refuse the wrong one at the point it is pasted.
  if (looksLikeServiceRoleKey(config.team.supabase_anon_key.trim())) {
    throw new Error('这看起来是 service_role key。它会绕过所有 RLS 策略，绝不能放在客户端；请改用 anon key。');
  }
  fs.mkdirSync(path.dirname(path.resolve(options.configPath)), { recursive: true });
  fs.writeFileSync(path.resolve(options.configPath), `${yaml.dump(config, { lineWidth: 120, noRefs: true })}`, 'utf8');
  return { ok: true, state: await buildState(options) };
}

async function saveEnv(options: UiServerOptions, body: unknown): Promise<Record<string, unknown>> {
  const values = readRecord(readRecord(body).values);
  const existing = readEnvFile(options.envPath);
  const next: Record<string, string> = { ...existing };

  for (const key of ENV_KEYS) {
    const rawValue = values[key];
    if (typeof rawValue !== 'string') continue;
    const value = rawValue.trim();
    if (SECRET_ENV_KEYS.has(key) && !value) continue;
    next[key] = value;
  }

  writeEnvFile(options.envPath, next);
  applyEnv(next);
  return { ok: true, state: await buildState(options) };
}

async function runAction(options: UiServerOptions, body: unknown): Promise<Record<string, unknown>> {
  const request = readRecord(body);
  const action = String(request.action || '');
  const started = Date.now();
  appendUiLog({ event: 'action', level: 'info', status: 'started', action });
  try {
    const result = await runActionInner(options, request, action);
    appendUiLog({
      event: 'action',
      level: 'info',
      status: 'success',
      action,
      duration_ms: Date.now() - started,
      detail: actionResultDetail(action),
    });
    return result;
  } catch (error) {
    appendUiLog({
      event: 'action',
      level: 'error',
      status: 'error',
      action,
      duration_ms: Date.now() - started,
      detail: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function runActionInner(options: UiServerOptions, request: Record<string, unknown>, action: string): Promise<Record<string, unknown>> {
  const sendOutput = request.send !== false;
  const env = readEnvFile(options.envPath);

  if (action === 'discover_github_token') {
    return { ok: true, text: await discoverGitHubTokenForUi(options, env) };
  }

  if (action === 'discover_linear_token') {
    return { ok: true, text: discoverLinearTokenForUi(options, env) };
  }

  if (action === 'discover_feishu_setup') {
    return { ok: true, text: await discoverFeishuSetupForUi(options, env), state: await buildState(options) };
  }

  if (action === 'discover_codex_binary') {
    return { ok: true, text: await discoverCliBinaryForUi(options, env, CLI_SPECS.codex), state: await buildState(options) };
  }

  if (action === 'choose_codex_binary') {
    return chooseCliBinary(options, env, CLI_SPECS.codex);
  }

  if (action === 'choose_codex_home') {
    return chooseCodexHome(options, env);
  }

  if (action === 'codex_test') {
    return { ok: true, text: await testCodexForUi(env) };
  }

  if (action === 'discover_claude_binary') {
    return { ok: true, text: await discoverCliBinaryForUi(options, env, CLI_SPECS.claude), state: await buildState(options) };
  }

  if (action === 'choose_claude_binary') {
    return chooseCliBinary(options, env, CLI_SPECS.claude);
  }

  if (action === 'claude_test') {
    return { ok: true, text: await testClaudeForUi(env) };
  }

  if (action === 'choose_vault_folder') {
    return chooseVaultFolder();
  }

  if (action === 'choose_memory_repository') {
    return chooseMemoryRepositoryFolder();
  }

  if (action === 'choose_calendar_workdir') {
    return chooseCalendarWorkdirFolder();
  }

  applyEnv(env);
  const config = loadConfig(options.configPath);

  if (action === 'doctor') {
    const checks = await runDoctor(config, options.configPath);
    return { ok: true, text: formatDoctor(checks) };
  }

  if (action === 'collect') {
    return { ok: true, text: JSON.stringify(await collectEvidence(config, todayInTimezone(config)), null, 2) };
  }

  if (action === 'progress') {
    return { ok: true, text: formatProgressCandidates(await collectProgressCandidates(config, todayInTimezone(config))) };
  }

  if (action === 'calendar_week' || action === 'calendar_today') {
    const result = await runCalendarDraft(config, action === 'calendar_week' ? 'week' : 'today');
    return { ok: true, text: formatCalendarDraftForFeishu(result) };
  }

  if (action === 'calendar_test') {
    const result = await testCalendarBridge(config);
    const text = [
      result.message,
      '',
      `engine: ${result.engine}`,
      `workdir: ${result.workdir}`,
      `cli: ${result.cliPath}`,
      `input: ${result.inputPath}`,
      result.stdoutPreview ? ['', 'Preview:', result.stdoutPreview].join('\n') : '',
    ]
      .filter(Boolean)
      .join('\n');
    if (!result.ok) throw new Error(text);
    return { ok: true, text };
  }

  if (action === 'todo_capture') {
    const text = String(request.text || '').trim();
    if (!text) throw new Error('Todo capture text is empty.');
    const command = parseTodoInboxCommand(text) || { type: 'capture' as const, text };
    const result = handleTodoInboxCommand(config, command, { source: 'local-ui' });
    return { ok: true, text: result.reply || 'Todo inbox updated.', state: await buildState(options) };
  }

  if (action === 'chat_analysis' || action === 'chat_analysis_todo' || action === 'chat_analysis_review') {
    if (!config.chat_analysis.enabled) return { ok: true, text: 'chat_analysis.enabled=false；聊天上下文分析已禁用。' };
    const mode = action === 'chat_analysis_todo' ? 'todo' : action === 'chat_analysis_review' ? 'review' : config.chat_analysis.default_mode;
    return { ok: true, text: formatChatContextAnalysis(await analyzeChatContext(config, todayInTimezone(config), mode)) };
  }

  if (action === 'feishu_test') {
    if (!config.output.feishu.enabled) throw new Error('Feishu output is disabled in config.');
    await sendFeishuMessage(config, `daily-os-feishu test message\n${new Date().toISOString()}`);
    return { ok: true, text: 'Feishu test message sent.' };
  }

  if (action === 'decision_onboarding_start') {
    const result = await startDecisionOnboarding(config, { envPath: options.envPath });
    return {
      ok: true,
      text: [
        result.created ? '已创建决策校准群。' : '决策校准群已准备好。',
        `名称：${result.chatName}`,
        `群 ID：${result.chatId}`,
        '',
        result.welcomeSent ? '已发送欢迎卡片。请到这个飞书群里继续校准决策规则。' : '欢迎卡片 24 小时内已经发送过，本次没有重复发送。',
      ].join('\n'),
      state: await buildState(options),
    };
  }

  if (action === 'feedback_poll') {
    return { ok: true, text: JSON.stringify(await pollFeishuFeedback(config, { send: sendOutput }), null, 2) };
  }

  if (action === 'service_install') {
    const plistPath = await installLaunchAgent();
    return { ok: true, text: `Registered launch agent: ${plistPath}`, service: await getLaunchAgentStatus() };
  }

  if (action === 'service_uninstall') {
    const plistPath = await uninstallLaunchAgent();
    return { ok: true, text: `Unregistered launch agent: ${plistPath}`, service: await getLaunchAgentStatus() };
  }

  const workflows: Record<string, WorkflowName> = {
    plan: 'daily_plan',
    review: 'daily_review',
    weekly: 'weekly_review',
  };
  if (action in workflows) {
    return { ok: true, text: await runWorkflow(config, workflows[action], { send: sendOutput, trigger: 'ui', source: action }) };
  }

  throw new Error(`Unknown action: ${action}`);
}

function actionResultDetail(action: string): string {
  if (action === 'collect') return 'Evidence collection completed. Response body is not written to logs.';
  if (['plan', 'review', 'weekly'].includes(action)) return 'Workflow completed. Generated content is not written to logs.';
  if (action === 'calendar_test') return 'Calendar engine smoke test completed. Personal source data is not collected.';
  if (action.startsWith('calendar_')) return 'Calendar draft generated. Draft content is not written to logs.';
  if (action === 'progress') return 'Progress candidates collected. Candidate text is not written to logs.';
  if (action.startsWith('chat_analysis')) return 'Chat context suggestions generated. Message bodies are not written to logs.';
  if (action === 'feedback_poll') return 'Feishu feedback poll completed. Message bodies are not written to logs.';
  if (action === 'feishu_test') return 'Feishu test message sent.';
  if (action === 'decision_onboarding_start') return '决策校准群已准备好。';
  return 'Action completed.';
}

async function chooseVaultFolder(): Promise<Record<string, unknown>> {
  const result = await runCommand(
    'osascript',
    ['-e', 'POSIX path of (choose folder with prompt "Select your vault knowledge base folder")'],
    { timeoutMs: 30000 },
  );
  if (!result.ok) {
    throw new Error('Folder selection was cancelled or unavailable.');
  }
  return { ok: true, path: result.stdout.trim(), text: 'Vault folder selected.' };
}

async function chooseMemoryRepositoryFolder(): Promise<Record<string, unknown>> {
  const result = await runCommand(
    'osascript',
    ['-e', 'POSIX path of (choose folder with prompt "Select your Daily OS memory repository folder")'],
    { timeoutMs: 30000 },
  );
  if (!result.ok) {
    throw new Error('Folder selection was cancelled or unavailable.');
  }
  return { ok: true, path: result.stdout.trim(), text: 'Memory repository folder selected.' };
}

async function chooseCalendarWorkdirFolder(): Promise<Record<string, unknown>> {
  const result = await runCommand(
    'osascript',
    ['-e', 'POSIX path of (choose folder with prompt "Select your calendar-planning-os folder")'],
    { timeoutMs: 30000 },
  );
  if (!result.ok) {
    throw new Error('Folder selection was cancelled or unavailable.');
  }
  return { ok: true, path: result.stdout.trim(), text: 'Calendar engine folder selected.' };
}

interface CliSpec {
  key: 'codex' | 'claude';
  command: string;
  envKey: string;
  label: string;
}

const CLI_SPECS: Record<'codex' | 'claude', CliSpec> = {
  codex: { key: 'codex', command: 'codex', envKey: 'CODEX_BIN', label: 'Codex CLI' },
  claude: { key: 'claude', command: 'claude', envKey: 'CLAUDE_BIN', label: 'Claude Code CLI' },
};

async function chooseCliBinary(options: UiServerOptions, env: Record<string, string>, spec: CliSpec): Promise<Record<string, unknown>> {
  const prompt = `Enter the ${spec.label} command name or full path`;
  const result = await runCommand(
    'osascript',
    ['-e', `text returned of (display dialog "${prompt}" default answer "${spec.command}" with title "Choose ${spec.label}")`],
    { timeoutMs: 60000 },
  );
  if (!result.ok) throw new Error(`${spec.label} selection was cancelled or unavailable.`);
  const entered = result.stdout.trim();
  if (!entered) throw new Error(`No ${spec.label} name or path entered.`);
  const resolved = await resolveCliBinary(entered, env);
  if (!resolved) {
    throw new Error(`Could not find a runnable ${spec.label} from "${entered}". Enter a full path to the executable, or install it and click Find ${spec.label}.`);
  }
  const next = { ...env, [spec.envKey]: resolved };
  writeEnvFile(options.envPath, next);
  applyEnv(next);
  return { ok: true, path: resolved, text: `${spec.label} path saved: ${resolved}`, state: await buildState(options) };
}

async function resolveCliBinary(entered: string, env: Record<string, string>): Promise<string> {
  const expandHome = (value: string) => (value.startsWith('~') ? path.join(os.homedir(), value.slice(1)) : value);
  if (entered.includes('/')) {
    const candidate = expandHome(entered);
    return (await isUsableCli(candidate, env)) ? candidate : '';
  }
  const candidates = [
    await whichCommand(entered),
    `/opt/homebrew/bin/${entered}`,
    `/usr/local/bin/${entered}`,
    path.join(os.homedir(), '.local', 'bin', entered),
  ];
  for (const candidate of candidates) {
    if (candidate && (await isUsableCli(candidate, env))) return candidate;
  }
  return '';
}

async function chooseCodexHome(options: UiServerOptions, env: Record<string, string>): Promise<Record<string, unknown>> {
  const result = await runCommand(
    'osascript',
    ['-e', 'POSIX path of (choose folder with prompt "Select the Codex home folder, usually ~/.codex")'],
    { timeoutMs: 30000 },
  );
  if (!result.ok) throw new Error('Codex home selection was cancelled or unavailable.');
  const codexHome = result.stdout.trim();
  const next = { ...env, CODEX_HOME: codexHome };
  writeEnvFile(options.envPath, next);
  applyEnv(next);
  return { ok: true, path: codexHome, text: `Codex home saved: ${codexHome}`, state: await buildState(options) };
}

async function discoverCliBinaryForUi(options: UiServerOptions, env: Record<string, string>, spec: CliSpec): Promise<string> {
  const found = await discoverCliBinary(spec, env);
  if (!found.value) {
    return `${spec.label} not found. Install it, or click Choose CLI and enter the executable name or full path.`;
  }
  const next = { ...env, [spec.envKey]: found.value };
  writeEnvFile(options.envPath, next);
  applyEnv(next);
  return `${spec.label} found from ${found.source} and saved locally: ${found.value}`;
}

async function discoverCliBinary(spec: CliSpec, env: Record<string, string>): Promise<{ value?: string; source: string }> {
  const candidates = [
    { value: env[spec.envKey], source: 'configured .env' },
    { value: process.env[spec.envKey], source: `process.env.${spec.envKey}` },
    { value: await whichCommand(spec.command), source: 'PATH' },
    { value: `/opt/homebrew/bin/${spec.command}`, source: '/opt/homebrew/bin' },
    { value: `/usr/local/bin/${spec.command}`, source: '/usr/local/bin' },
    { value: path.join(os.homedir(), '.local', 'bin', spec.command), source: '~/.local/bin' },
  ];

  for (const candidate of candidates) {
    if (!candidate.value) continue;
    if (await isUsableCli(candidate.value, env)) return { value: candidate.value, source: candidate.source };
  }
  return { source: 'local PATH or common install locations' };
}

async function whichCommand(command: string): Promise<string> {
  const result = await runCommand('/usr/bin/env', ['which', command], { timeoutMs: 5000 });
  return result.ok ? result.stdout.trim().split('\n')[0] || '' : '';
}

async function isUsableCli(command: string, env: Record<string, string>): Promise<boolean> {
  const result = await runCommand(command, ['--version'], { timeoutMs: 5000, env: cliEnv(env) });
  return result.ok;
}

async function testCodexForUi(env: Record<string, string>): Promise<string> {
  const codexBin = env.CODEX_BIN || process.env.CODEX_BIN || 'codex';
  const version = await runCommand(codexBin, ['--version'], { timeoutMs: 10000, env: cliEnv(env) });
  if (!version.ok) {
    return `Codex CLI is not runnable from ${codexBin}. Click Find Codex CLI or Choose CLI, then try again.\n${version.stderr || version.stdout}`;
  }
  const login = await runCommand(codexBin, ['login', 'status'], { timeoutMs: 10000, env: cliEnv(env) });
  const versionText = (version.stdout || version.stderr).trim();
  if (login.ok) return `Codex CLI 正常：${versionText}\n${(login.stdout || login.stderr).trim() || '已登录。'}`;
  // daily-os #199: a timeout here is "no response in this environment", not "not
  // logged in" — don't send the user to `codex login` (it works in Terminal and
  // the background service stays broken).
  if (login.timedOut) {
    return `Codex CLI 正常：${versionText}\n无法判定登录状态：codex login status 10s 内没有返回。若本工具装成了 macOS 后台服务(launchd)，订阅版 CLI 会因 Keychain 阻塞而无响应（#199）——这不代表未登录。定时任务请改用 API-key provider（anthropic/openai）。`;
  }
  return `Codex CLI 正常：${versionText}\n当前配置下 Codex 尚未登录。请在 Terminal 中运行以下命令，然后回到 UI 再点击 Test Codex login：\n${codexBin} login`;
}

async function testClaudeForUi(env: Record<string, string>): Promise<string> {
  const claudeBin = env.CLAUDE_BIN || process.env.CLAUDE_BIN || 'claude';
  const version = await runCommand(claudeBin, ['--version'], { timeoutMs: 10000, env: cliEnv(env) });
  if (!version.ok) {
    return `Claude Code CLI is not runnable from ${claudeBin}. Click Find Claude CLI or Choose CLI, then try again.\n${version.stderr || version.stdout}`;
  }
  const auth = await runCommand(claudeBin, ['auth', 'status'], { timeoutMs: 10000, env: cliEnv(env) });
  const versionText = (version.stdout || version.stderr).trim();
  const loggedIn = auth.ok && /"loggedIn"\s*:\s*true/.test(auth.stdout);
  if (loggedIn) return `Claude Code CLI 正常：${versionText}\n${auth.stdout.match(/"authMethod"\s*:\s*"([^"]+)"/)?.[1] ?? '已登录。'}`;
  // daily-os #199: distinguish "no response" (launchd Keychain hang) from "not
  // logged in" so the user isn't sent to a `claude auth login` dead-end.
  if (auth.timedOut) {
    return `Claude Code CLI 正常：${versionText}\n无法判定登录状态：claude auth status 10s 内没有返回。若本工具装成了 macOS 后台服务(launchd)，订阅版 CLI 会因 Keychain 阻塞而无响应（#199）——这不代表未登录。定时任务请改用 API-key provider（anthropic/openai）。`;
  }
  return `Claude Code CLI 正常：${versionText}\n当前配置下 Claude 尚未登录。请在 Terminal 中运行以下命令，然后回到 UI 再点击 Test Claude login：\n${claudeBin} auth login`;
}

function cliEnv(env: Record<string, string>): NodeJS.ProcessEnv {
  return { ...process.env, ...env };
}

async function discoverFeishuSetupForUi(options: UiServerOptions, env: Record<string, string>): Promise<string> {
  const next = { ...env };
  const lines: string[] = [];
  const config = await readLarkCliConfig();
  const auth = await readLarkCliAuthStatus();

  if (!config.ok && !auth.ok) {
    return [
      '没有找到 lark-cli 飞书配置。',
      '请先运行 `lark-cli config init`，再运行 `lark-cli auth login`，然后重新点击自动配置。',
      compactCommandError(config.text || auth.text),
    ].filter(Boolean).join('\n');
  }

  if (config.appId && !next.LARK_APP_ID) {
    next.LARK_APP_ID = config.appId;
    lines.push(`已从 lark-cli 保存飞书 App ID（${maskValue(config.appId)}）。`);
  } else if (config.appId) {
    lines.push(`lark-cli 中已存在飞书 App ID（${maskValue(config.appId)}）。`);
  }

  if (auth.ownerOpenId && !next.FEISHU_OWNER_OPEN_ID) {
    next.FEISHU_OWNER_OPEN_ID = auth.ownerOpenId;
    lines.push(`已从 lark-cli user 登录信息保存 owner open_id（${maskValue(auth.ownerOpenId)}）。`);
  } else if (auth.ownerOpenId) {
    lines.push(`lark-cli 中已存在 user open_id（${maskValue(auth.ownerOpenId)}）。`);
  }

  if (!next.FEISHU_CHAT_ID) {
    lines.push('未自动检测到 Feishu Chat ID。只有需要发送输出、轮询反馈或采集 IM 历史时，才需要粘贴 `oc_...`。');
  }

  if (!next.LARK_APP_SECRET) {
    lines.push('无法从 lark-cli/keychain 读回 App Secret。只有启用 websocket 交互层时，才需要手动粘贴。');
  }

  lines.push(auth.userReady ? 'lark-cli user 身份已就绪。' : 'lark-cli user 身份未就绪；如需用 user 读取日历/任务/文档，请运行 `lark-cli auth login`。');
  lines.push(auth.botReady ? 'lark-cli bot 身份已就绪。' : 'lark-cli bot 身份未就绪；在飞书应用 bot 启用前，bot 输出可能失败。');

  const scopes = auth.scopes;
  if (scopes.length > 0) {
    lines.push(scopeSummary('日历', scopes, ['calendar:calendar.event:read', 'calendar:calendar:readonly', 'calendar:calendar:read']));
    lines.push(scopeSummary('任务', scopes, ['task:task:read', 'task:tasklist:read']));
    lines.push(scopeSummary('文档', scopes, ['docx:document:readonly', 'docs:doc:readonly', 'wiki:wiki:readonly']));
    lines.push(scopeSummary('IM 历史', scopes, ['im:message:readonly', 'im:message.p2p_msg:get_as_user', 'im:message.group_msg:get_as_user']));
  } else {
    lines.push('无法从 lark-cli 读取已授权 scope；请用 Run Checks 或 Collect 查看第一个缺失权限。');
  }

  writeEnvFile(options.envPath, next);
  applyEnv(next);
  return lines.join('\n');
}

async function readLarkCliConfig(): Promise<{ ok: boolean; appId?: string; text: string }> {
  const result = await runCommand('lark-cli', ['config', 'show'], { timeoutMs: 10000 });
  const text = result.stdout || result.stderr;
  const parsed = parseFirstJsonObject(text);
  const appId = typeof parsed?.appId === 'string' ? parsed.appId : undefined;
  return { ok: result.ok, appId, text };
}

async function readLarkCliAuthStatus(): Promise<{
  ok: boolean;
  ownerOpenId?: string;
  userReady: boolean;
  botReady: boolean;
  scopes: string[];
  text: string;
}> {
  const result = await runCommand('lark-cli', ['auth', 'status'], { timeoutMs: 10000 });
  const text = result.stdout || result.stderr;
  const parsed = parseFirstJsonObject(text);
  const identities = readRecord(parsed?.identities);
  const user = readRecord(identities.user);
  const bot = readRecord(identities.bot);
  const scopeText = typeof user.scope === 'string' ? user.scope : '';
  return {
    ok: result.ok,
    ownerOpenId: typeof user.openId === 'string' ? user.openId : undefined,
    userReady: user.available === true || user.status === 'ready',
    botReady: bot.available === true || bot.status === 'ready',
    scopes: scopeText.split(/\s+/).filter(Boolean),
    text,
  };
}

function parseFirstJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaping = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (escaping) {
      escaping = false;
      continue;
    }
    if (char === '\\') {
      escaping = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    if (depth === 0) {
      try {
        const parsed = JSON.parse(text.slice(start, index + 1)) as unknown;
        return readRecord(parsed);
      } catch {
        return null;
      }
    }
  }
  return null;
}

function scopeSummary(label: string, granted: string[], accepted: string[]): string {
  const ok = accepted.some((scope) => granted.includes(scope));
  return `${ok ? 'OK' : '需要权限'}：${label}${ok ? '' : `（${accepted.join(' 或 ')}）`}`;
}

function maskValue(value: string): string {
  if (value.length <= 10) return 'configured';
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function compactCommandError(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 500);
}

async function discoverGitHubTokenForUi(options: UiServerOptions, env: Record<string, string>): Promise<string> {
  const next = { ...env };
  const github = await discoverGitHubToken(env);
  if (github.value) {
    next.GITHUB_TOKEN = github.value;
    writeEnvFile(options.envPath, next);
    applyEnv(next);
    return `GitHub token found from ${github.source} and saved locally.`;
  }
  return '未找到 GitHub token。请先运行 `gh auth login` 后重试，或手动粘贴 GITHUB_TOKEN。';
}

function discoverLinearTokenForUi(options: UiServerOptions, env: Record<string, string>): string {
  const next = { ...env };
  const linear = discoverEnvToken('LINEAR_API_KEY', env);
  if (linear.value) {
    next.LINEAR_API_KEY = linear.value;
    writeEnvFile(options.envPath, next);
    applyEnv(next);
    return `Linear API key found from ${linear.source} and saved locally.`;
  }
  return 'Linear API key not found. No usable local Linear CLI auth token was found. Create one in Linear settings and paste LINEAR_API_KEY manually.';
}

async function discoverGitHubToken(env: Record<string, string>): Promise<{ value?: string; source: string }> {
  const local = discoverEnvToken('GITHUB_TOKEN', env);
  if (local.value) return local;

  const result = await runCommand('gh', ['auth', 'token'], { timeoutMs: 10000 });
  const token = result.ok ? result.stdout.trim() : '';
  if (token) return { value: token, source: 'gh auth token' };

  const hostsPath = path.join(os.homedir(), '.config', 'gh', 'hosts.yml');
  if (fs.existsSync(hostsPath)) return { source: hostsPath };
  return { source: 'local env or GitHub CLI' };
}

function discoverEnvToken(key: string, env: Record<string, string>): { value?: string; source: string } {
  if (env[key]) return { value: env[key], source: 'configured .env' };
  if (process.env[key]) return { value: process.env[key], source: `process.env.${key}` };
  if (key === 'LINEAR_API_KEY') return discoverLinearCliToken();
  return { source: `process.env.${key}` };
}

function discoverLinearCliToken(): { value?: string; source: string } {
  const commands: Array<[string, string[]]> = [
    ['linear', ['auth', 'token']],
    ['linear', ['auth', 'status', '--json']],
    ['linear', ['whoami', '--json']],
    ['linear-cli', ['auth', 'token']],
  ];

  for (const [command, args] of commands) {
    const result = runCommandSync(command, args);
    if (!result) continue;
    const token = extractToken(result);
    if (token) return { value: token, source: `${command} ${args.join(' ')}` };
  }

  return { source: 'local env or Linear CLI auth' };
}

function runCommandSync(command: string, args: string[]): string | null {
  const child = spawnSync(command, args, { encoding: 'utf8', timeout: 5000 });
  if (child.error || child.status !== 0) return null;
  return `${child.stdout || ''}\n${child.stderr || ''}`.trim();
}

function extractToken(text: string): string {
  if (!text) return '';
  try {
    const parsed = JSON.parse(text) as unknown;
    const token = findTokenInObject(parsed);
    if (token) return token;
  } catch {
    // Continue with text patterns.
  }
  const match = text.match(/lin_api_[A-Za-z0-9_-]+|[A-Za-z0-9_-]{40,}/);
  return match?.[0] || '';
}

function findTokenInObject(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  if (Array.isArray(value)) return value.map(findTokenInObject).find(Boolean) || '';
  const record = value as Record<string, unknown>;
  for (const [key, raw] of Object.entries(record)) {
    if (/token|apiKey|api_key|key/i.test(key) && typeof raw === 'string' && raw.length >= 20) return raw;
    const nested = findTokenInObject(raw);
    if (nested) return nested;
  }
  return '';
}

function ensureLocalFiles(configPath: string, envPath: string): void {
  // Templates come from where the code is; the copies land where the data is.
  // The same pair of lines in `ensureLocalSetup` was fixed when the service
  // started shipping inside the Mac app, and this one was missed — it survived
  // because `daily-os start` runs that function first, so by the time this ran
  // the files already existed and `copyIfMissing` returned early. `daily-os ui`
  // does not, and crashed outright on a working directory it had never seen:
  // ENOENT on `.env.example`, in the cwd, where no template has lived since the
  // code and the data stopped being the same directory.
  copyIfMissing(bundledAsset('.env.example'), envPath);
  copyIfMissing(bundledAsset('config', 'config.example.yaml'), configPath);
  fs.mkdirSync(path.resolve('data/memory/daily'), { recursive: true });
  fs.mkdirSync(path.resolve('data/logs'), { recursive: true });
  fs.mkdirSync(path.resolve('data/snapshots/chrome'), { recursive: true });
  fs.mkdirSync(path.resolve('data/snapshots/calendar'), { recursive: true });
}

function copyIfMissing(from: string, to: string): void {
  const absoluteTo = path.resolve(to);
  if (fs.existsSync(absoluteTo)) return;
  fs.mkdirSync(path.dirname(absoluteTo), { recursive: true });
  fs.copyFileSync(path.resolve(from), absoluteTo);
}

function readEnvFile(envPath: string): Record<string, string> {
  const absolute = path.resolve(envPath);
  if (!fs.existsSync(absolute)) return {};
  const values: Record<string, string> = {};
  for (const rawLine of fs.readFileSync(absolute, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const [key, ...rest] = line.split('=');
    values[key] = unquote(rest.join('='));
  }
  return values;
}

function writeEnvFile(envPath: string, values: Record<string, string>): void {
  const absolute = path.resolve(envPath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const existingLines = fs.existsSync(absolute) ? fs.readFileSync(absolute, 'utf8').split('\n') : [];
  const written = new Set<string>();
  const lines = existingLines
    .filter((line, index, allLines) => index < allLines.length - 1 || line.length > 0)
    .map((rawLine) => {
      const trimmed = rawLine.trim();
      if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) return rawLine;
      const [key] = trimmed.split('=');
      if (!(key in values)) return rawLine;
      written.add(key);
      return `${key}=${quoteEnv(values[key])}`;
    });

  for (const key of orderedEnvKeys(values)) {
    if (written.has(key) || !(key in values)) continue;
    lines.push(`${key}=${quoteEnv(values[key])}`);
  }
  fs.writeFileSync(absolute, `${lines.join('\n')}\n`, 'utf8');
}

function orderedEnvKeys(values: Record<string, string>): string[] {
  const known = ENV_KEYS.filter((key) => key in values);
  const custom = Object.keys(values)
    .filter((key) => !ENV_KEYS.includes(key))
    .filter((key) => /^[A-Z][A-Z0-9_]*$/.test(key))
    .sort();
  return [...known, ...custom];
}

function applyEnv(values: Record<string, string>): void {
  for (const [key, value] of Object.entries(values)) {
    if (value) process.env[key] = value;
    else delete process.env[key];
  }
}

function redactedEnv(values: Record<string, string>): Record<string, unknown> {
  const env: Record<string, unknown> = {};
  for (const key of PLAIN_ENV_KEYS) env[key] = values[key] || '';
  for (const key of SECRET_ENV_KEYS) env[`${key}_present`] = Boolean(values[key]);
  return env;
}

function readTextIfExists(filePath: string): string {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
}

function quoteEnv(value: string): string {
  if (!value) return '';
  if (/^[A-Za-z0-9_./:@-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function unquote(value: string): string {
  return value.trim().replace(/^"(.*)"$/, '$1');
}

async function readJson(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

function readRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function sendJson(response: http.ServerResponse, body: unknown, status = 200): void {
  send(response, status, JSON.stringify(body), 'application/json; charset=utf-8');
}

function renderHtml(): string {
  // Inject the current runtime token so any local page load (CLI open, mac-companion open,
  // manual navigation) can authenticate its /api calls without a query string.
  return HTML.split(HTML_TOKEN_PLACEHOLDER)
    .join(runtimeToken)
    .split(HTML_VERSION_PLACEHOLDER)
    .join(appVersion());
}

function send(response: http.ServerResponse, status: number, body: string, contentType: string): void {
  response.writeHead(status, {
    'content-type': contentType,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

const HTML = String.raw`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Daily OS Feishu</title>
    <link rel="stylesheet" href="/assets/app.css" />
    <script>try{var f=localStorage.getItem('daily_os_font');if(f==='small'||f==='large')document.documentElement.setAttribute('data-font',f);}catch(e){}</script>
  </head>
  <body>
    <header class="topbar">
      <div>
        <h1>Daily OS Feishu</h1>
        <p id="paths"></p>
      </div>
      <div class="top-status">
        <a class="top-link" href="/dashboard">Console &amp; Chat →</a>
        <span class="save-status" aria-live="polite"></span>
        <div class="status" id="summary-status" title="Local setup checks">Loading</div>
      </div>
    </header>
    <div class="toast" id="toast" role="status" aria-live="polite"></div>

    <main class="layout">
      <nav class="nav" aria-label="Sections">
        <button class="nav-button active" data-section="overview">Overview</button>
        <button class="nav-button" data-section="guide">Guide</button>
        <button class="nav-button" data-section="rhythm">Rhythm</button>
        <button class="nav-button" data-section="decision">Decision Policy</button>
        <button class="nav-button" data-section="strategy">Review Strategy</button>
        <button class="nav-button" data-section="okr">OKR</button>
        <button class="nav-button" data-section="setup">Setup</button>
        <button class="nav-button" data-section="sources">Sources</button>
        <button class="nav-button" data-section="workflows">Workflows</button>
        <button class="nav-button" data-section="logs">Logs</button>
      </nav>

      <section class="content">
        <form id="config-form">
          <section class="panel active" id="section-overview">
            <div class="panel-head">
              <h2>Overview</h2>
              <button type="button" class="secondary" data-action="doctor" title="Rerun local setup checks">Run Checks</button>
            </div>
            <div class="checks" id="checks"></div>
            <div class="actions">
              <button type="button" data-action="feishu_test">Test Feishu</button>
              <button type="button" data-action="feedback_poll">Poll Feedback</button>
              <button type="button" data-action="collect">Collect</button>
              <button type="button" data-action="chat_analysis">Chat Analysis</button>
              <button type="button" data-action="chat_analysis_todo">Todo Signals</button>
              <button type="button" data-action="chat_analysis_review">Review Signals</button>
              <button type="button" data-action="progress">Progress</button>
              <button type="button" data-action="calendar_week">Calendar Week</button>
              <button type="button" data-action="calendar_today">Calendar Today</button>
              <label class="inline">
                <input id="send-output" type="checkbox" checked />
                Send output
              </label>
            </div>
            <pre id="output" aria-live="polite"></pre>
          </section>

          <section class="panel" id="section-guide">
            <div class="panel-head">
              <div>
                <h2>Guide</h2>
                <p class="hint">日常使用说明。先看这里，再去 Setup / Sources 填配置。</p>
              </div>
            </div>
            <div class="guide-document">
              <section aria-labelledby="guide-start-title">
                <h3 id="guide-start-title">先做什么</h3>
                <table class="guide-table">
                  <thead><tr><th>步骤</th><th>去哪里</th><th>做什么</th></tr></thead>
                  <tbody>
                    <tr><td>1</td><td>Setup</td><td>配置 Codex、Feishu 输出、后台服务。</td></tr>
                    <tr><td>2</td><td>Sources</td><td>配置 vault、Feishu 文档、Linear、GitHub。</td></tr>
                    <tr><td>3</td><td>Decision Policy</td><td>写你的偏好：优先看什么、哪些事不要做。</td></tr>
                    <tr><td>4</td><td>Todo Inbox</td><td>记录临时小事。Daily plan 和 review 会参考它。</td></tr>
                  </tbody>
                </table>
              </section>

              <section aria-labelledby="guide-feishu-title">
                <h3 id="guide-feishu-title">Feishu 指令</h3>
                <table class="guide-table">
                  <thead><tr><th>指令</th><th>用途</th><th>什么时候用</th></tr></thead>
                  <tbody>
                    <tr><td><code>daily-os status</code></td><td>发一张操作卡片。</td><td>想点按钮时。</td></tr>
                    <tr><td><code>daily-os plan</code></td><td>生成今日安排。</td><td>每天开始工作前。</td></tr>
                    <tr><td><code>daily-os review</code></td><td>生成今日复盘。</td><td>晚上收尾时。</td></tr>
                    <tr><td><code>daily-os weekly</code></td><td>生成普通周复盘。</td><td>只想快速看本周总结时。</td></tr>
                    <tr><td><code>daily-os weekly deep</code></td><td>运行 weekly-review skill。</td><td>要生成可写回 Feishu Weekly 的草稿时。</td></tr>
                    <tr><td><code>daily-os calendar week</code></td><td>生成本周日历草稿。</td><td>周计划之后，想把任务落到时间块时。</td></tr>
                    <tr><td><code>daily-os calendar today</code></td><td>生成今日日历草稿。</td><td>今天临时事项变化后。</td></tr>
                    <tr><td><code>daily-os details</code></td><td>展开最近一次完整输出。</td><td>卡片内容太短时。</td></tr>
                    <tr><td><code>daily-os progress</code></td><td>找今日进展候选。</td><td>复盘前想补进展时。</td></tr>
                    <tr><td><code>daily-os chat</code></td><td>分析最近聊天里的线索。</td><td>想从聊天里找任务、日程、文档更新时。</td></tr>
                    <tr><td><code>daily-os chat todo</code></td><td>只找 todo 线索。</td><td>聊天里有人安排事情后。</td></tr>
                    <tr><td><code>daily-os chat review</code></td><td>只找进展和复盘线索。</td><td>晚上复盘前。</td></tr>
                    <tr><td><code>daily-os remember 今天进展：...</code></td><td>手动记录进展。</td><td>系统没识别到你做了什么时。</td></tr>
                    <tr><td><code>daily-os 修改今日安排：...</code></td><td>调整今日安排。</td><td>计划不对时。</td></tr>
                  </tbody>
                </table>
              </section>

              <section aria-labelledby="guide-weekly-title">
                <h3 id="guide-weekly-title">写回 Feishu Weekly</h3>
                <table class="guide-table">
                  <thead><tr><th>动作</th><th>说明</th></tr></thead>
                  <tbody>
                    <tr><td>先发 <code>daily-os weekly deep</code></td><td>先生成草稿。不要直接写文档。</td></tr>
                    <tr><td>看 Feishu 卡片</td><td>确认目标文档、周列、要务/retro 列和要写入的行。</td></tr>
                    <tr><td>点确认写回</td><td>确认后才改 Feishu 文档。</td></tr>
                    <tr><td>不要从企鹅直接写回</td><td>写回会改外部文档，必须先看到内容和目标位置。</td></tr>
                  </tbody>
                </table>
              </section>

              <section aria-labelledby="guide-biweekly-title">
                <h3 id="guide-biweekly-title">双周复盘 · OKR 写回</h3>
                <p class="hint">对比计划与执行、生成下期计划，并把 KR 进度写回本地 OKR。跑的是 Life Review OS skill 的 biweekly 模式（LEO-109）。</p>
                <table class="guide-table">
                  <thead><tr><th>步骤</th><th>指令 / 位置</th><th>说明</th></tr></thead>
                  <tbody>
                    <tr><td>前置</td><td><code>memory-vault/10_OKR/*.md</code></td><td>north-star / annual / current 三层 OKR 需填真值；仍是占位 TODO 时 Today 页显示「not found」，也无法写回 KR。目前只能改文件，没有 UI 编辑器。</td></tr>
                    <tr><td>触发</td><td><code>daily-os skills run weekly-review biweekly</code>（中文 <code>daily-os 运行技能 weekly-review biweekly</code>）</td><td>在 Chat 或 Feishu 里发。<strong>必须带 <code>daily-os</code> 前缀</strong>，否则会被当成自由对话。也支持 <code>weekly</code> / <code>quarterly</code> 模式。</td></tr>
                    <tr><td>看草稿</td><td>Chat / Feishu 卡片</td><td>草稿含「计划 vs 执行」复盘、下期安排，以及结构化的 KR 进度块。</td></tr>
                    <tr><td>确认写回</td><td>点卡片「确认写回 OKR」</td><td>确认后才更新对应 KR 的 Current / Progress；未确认不改任何文件。</td></tr>
                  </tbody>
                </table>
              </section>

              <section aria-labelledby="guide-dashboard-title">
                <h3 id="guide-dashboard-title">Dashboard 页面</h3>
                <table class="guide-table">
                  <thead><tr><th>页面</th><th>用途</th></tr></thead>
                  <tbody>
                    <tr><td>Overview</td><td>跑检查、测试 Feishu、采集证据、手动触发常用动作。</td></tr>
                    <tr><td>Todo Inbox</td><td>管理你手动记录的日常 todo。</td></tr>
                    <tr><td>Rhythm</td><td>设置哪几天是休息日，以及写自己的周作息表。页面顶部会显示今天被判成工作日还是休息日。</td></tr>
                    <tr><td>Decision Policy</td><td>编辑 Daily OS 做决策时读取的 markdown 规则。</td></tr>
                    <tr><td>Sources</td><td>配置 Feishu 文档、聊天、vault、Linear、GitHub。</td></tr>
                    <tr><td>Workflows</td><td>配置 daily plan、daily review、weekly review，以及 optional calendar-planning-os。</td></tr>
                    <tr><td>Logs</td><td>看服务状态和最近错误。</td></tr>
                  </tbody>
                </table>
              </section>

              <section aria-labelledby="guide-companion-title">
                <h3 id="guide-companion-title">桌面伴侣</h3>
                <table class="guide-table">
                  <thead><tr><th>操作</th><th>作用</th></tr></thead>
                  <tbody>
                    <tr><td>点击企鹅</td><td>打开快捷菜单：Dashboard、Plan、Review、Weekly、服务状态。</td></tr>
                    <tr><td>悬停企鹅</td><td>查看你手动记录的 Todo Inbox 提醒。</td></tr>
                    <tr><td>拖动企鹅</td><td>移动到屏幕任意位置。</td></tr>
                  </tbody>
                </table>
              </section>

              <section aria-labelledby="guide-install-title">
                <h3 id="guide-install-title">安装边界</h3>
                <p>现在支持一键安装后台服务。还不是签名 Mac App，也不是 DMG 安装包。</p>
                <pre class="guide-code"><code>npm ci
npm run setup
npm run ui
npm run build
npm run service:install</code></pre>
              </section>

              <section aria-labelledby="guide-calendar-title">
                <h3 id="guide-calendar-title">日历草稿</h3>
                <table class="guide-table">
                  <thead><tr><th>动作</th><th>说明</th></tr></thead>
                  <tbody>
                    <tr><td>Workflows -> Calendar planning</td><td>启用 calendar bridge，填写 calendar-planning-os folder 和 CLI path。</td></tr>
                    <tr><td>Test Calendar Engine</td><td>只跑样例输入，检查本机路径和 CLI 是否可用。</td></tr>
                    <tr><td><code>daily-os calendar week</code></td><td>读取真实上下文，生成本周日历草稿卡片。</td></tr>
                    <tr><td>保存配置后</td><td>下一次 Feishu 命令会读新配置；通常不用重启服务。</td></tr>
                  </tbody>
                </table>
              </section>
            </div>
          </section>


          <section class="panel" id="section-okr">
            <div class="panel-head">
              <div>
                <h2>OKR</h2>
                <p class="hint">编辑 5年 / 年度 / 本季 三层 OKR。Today 页与日计划从这里读取；填上真值后 Today 的 North Star 就不再是 "not found"。保存只写本地 markdown 文件。</p>
                <p class="hint">不用手写表格：每个目标写一行（可带 P0/P1），KR 用 <code>-</code> 或 <code>*</code> 开头列在下面，点「整理格式」自动转成标准结构，检查后再 Save。</p>
                <p class="hint" id="okr-dir"></p>
              </div>
              <div class="panel-actions">
                <button type="button" class="secondary compact" data-action="okr_reload">Refresh</button>
              </div>
            </div>
            <div class="decision-page">
              <section class="decision-editor">
                <div><h3>5年 North Star · north-star-okr.md</h3><p class="hint" id="okr-path-north-star"></p></div>
                <textarea id="okr-md-north-star" spellcheck="false" placeholder="## Objective N1: 你的 5 年目标"></textarea>
                <div class="panel-actions"><button type="button" class="secondary" data-action="okr_format_north-star">整理格式</button><button type="button" data-action="okr_save_north-star">Save North Star</button></div>
                <p class="hint" id="okr-status-north-star"></p>
              </section>
              <section class="decision-editor">
                <div><h3>年度 Annual · annual-okr.md</h3><p class="hint" id="okr-path-annual"></p></div>
                <textarea id="okr-md-annual" spellcheck="false" placeholder="## Objective A1: 你的年度目标"></textarea>
                <div class="panel-actions"><button type="button" class="secondary" data-action="okr_format_annual">整理格式</button><button type="button" data-action="okr_save_annual">Save Annual</button></div>
                <p class="hint" id="okr-status-annual"></p>
              </section>
              <section class="decision-editor">
                <div><h3>本季 Current · current-okr.md</h3><p class="hint" id="okr-path-current"></p></div>
                <textarea id="okr-md-current" spellcheck="false" placeholder="## Objective O1: 本季目标"></textarea>
                <div class="panel-actions"><button type="button" class="secondary" data-action="okr_format_current">整理格式</button><button type="button" data-action="okr_save_current">Save Current</button></div>
                <p class="hint" id="okr-status-current"></p>
              </section>
            </div>
          </section>

          <section class="panel" id="section-strategy">
            <div class="panel-head">
              <div>
                <h2>Review Strategy</h2>
                <p class="hint">双周 / 周复盘的计划策略。这三个文件一起决定要务怎么生成，改完下一次 review 立即生效，不用重启。</p>
              </div>
              <div class="panel-actions">
                <button type="button" class="secondary compact" data-action="strategy_reload">Refresh</button>
                <button type="button" data-action="strategy_save">Save Markdown</button>
              </div>
            </div>
            <div class="decision-page">
              <section class="decision-editor" aria-labelledby="strategy-editor-title">
                <div>
                  <h3 id="strategy-editor-title">策略文件</h3>
                  <select id="strategy-file"></select>
                  <p class="hint" id="strategy-hint"></p>
                  <p class="hint" id="strategy-path"></p>
                </div>
                <textarea id="strategy-md" spellcheck="false" placeholder="计划条目规则（下双周要务）："></textarea>
                <p class="hint" id="strategy-status"></p>
              </section>
              <section class="decision-example-panel" aria-labelledby="strategy-default-title">
                <div>
                  <h3 id="strategy-default-title">内置默认规则</h3>
                  <p class="hint">「计划条目规则」文件为空或删掉时，回退到这份内置副本。可以照抄回去做重置。</p>
                </div>
                <pre class="decision-example"><code id="strategy-default"></code></pre>
              </section>
            </div>
          </section>

          <section class="panel" id="section-rhythm">
            <div class="panel-head">
              <div>
                <h2>Rhythm</h2>
                <p class="hint">你的一周作息。哪几天是休息日、休息日最多留几条工作，以及排不进设置项的那些规则。改完下一次计划立刻生效，不用重启。</p>
              </div>
              <div class="panel-actions">
                <button type="button" class="secondary compact" data-action="rhythm_reload">Refresh</button>
                <button type="button" data-action="rhythm_save">Save Markdown</button>
              </div>
            </div>

            <section class="rhythm-resolved" aria-labelledby="rhythm-resolved-title">
              <h3 id="rhythm-resolved-title">今天会被当成什么日子</h3>
              <p class="hint">这是计划真正读到的结论，不是设置的回显。下面两条和排计划用的是同一个判断。</p>
              <div class="rhythm-today" id="rhythm-today"></div>
              <p class="hint" id="rhythm-tomorrow"></p>
            </section>

            <fieldset class="rhythm-settings">
              <legend>休息日设置</legend>
              <label class="inline"><input type="checkbox" id="rhythm-enabled" /> 启用作息规则</label>
              <p class="hint">关掉之后每天都按工作日排，跟这个功能上线前一样。</p>
              <div class="rhythm-days" id="rhythm-days">
                <label class="inline"><input type="checkbox" id="rhythm-day-MON" data-rhythm-day="MON" /> 周一</label>
                <label class="inline"><input type="checkbox" id="rhythm-day-TUE" data-rhythm-day="TUE" /> 周二</label>
                <label class="inline"><input type="checkbox" id="rhythm-day-WED" data-rhythm-day="WED" /> 周三</label>
                <label class="inline"><input type="checkbox" id="rhythm-day-THU" data-rhythm-day="THU" /> 周四</label>
                <label class="inline"><input type="checkbox" id="rhythm-day-FRI" data-rhythm-day="FRI" /> 周五</label>
                <label class="inline"><input type="checkbox" id="rhythm-day-SAT" data-rhythm-day="SAT" /> 周六</label>
                <label class="inline"><input type="checkbox" id="rhythm-day-SUN" data-rhythm-day="SUN" /> 周日</label>
              </div>
              <label>休息日的工作任务上限<input id="rhythm-work-cap" type="number" min="0" max="20" step="1" /></label>
              <p class="hint">只限制来自 Linear / 每周要务的条目。自己手记的 todo 不受影响——休息日照样可以有「给家里做顿饭」。已经逾期或今天到期的工作项不受上限压制，仍会出现。</p>
              <p class="hint">这三项跟其他设置一起保存，点页面右上角的 Save。下面的 markdown 有自己的 Save Markdown 按钮。</p>
            </fieldset>

            <div class="decision-page">
              <section class="decision-editor" aria-labelledby="rhythm-editor-title">
                <div>
                  <h3 id="rhythm-editor-title">rhythm.md</h3>
                  <p class="hint">排不成设置项的规则写这里，大白话就行。模型做计划时原样读。</p>
                  <p class="hint" id="rhythm-notes-path"></p>
                  <p class="hint" id="rhythm-repository"></p>
                </div>
                <textarea id="rhythm-md" spellcheck="false" placeholder="# 作息"></textarea>
                <p class="hint" id="rhythm-status"></p>
              </section>
              <section class="decision-example-panel" aria-labelledby="rhythm-example-title">
                <div>
                  <h3 id="rhythm-example-title">示例</h3>
                  <p class="hint">照着改，或者整段拷过去当起点。</p>
                </div>
                <pre class="decision-example"><code># 作息

## 工作日

- 工作时间 09:30-18:30，19:00 之后不要再排工作任务。
- 上午留给需要安静的活，会议尽量排下午。

## 休息日

- 只处理已经逾期的事，其余时间留给生活。
- 不要把下周的活提前拿到周末做。

## 固定占用

- 周二、周四 19:00-21:00 教球，不可占用。
- 周日 20:00 周复盘。

## 其他

- 连续加班三天后，第四天按休息日排。</code></pre>
              </section>
            </div>
          </section>

          <section class="panel" id="section-decision">
            <div class="panel-head">
              <div>
                <h2>Decision Policy</h2>
                <p class="hint">This page shows the markdown decision notes Daily OS loads from the memory repository.</p>
              </div>
              <div class="panel-actions">
                <button type="button" class="secondary compact" data-action="decision_policy_reload">Refresh</button>
                <button type="button" data-action="decision_policy_save">Save Markdown</button>
              </div>
            </div>
            <div class="decision-page">
              <section class="decision-editor" aria-labelledby="decision-editor-title">
                <div>
                  <h3 id="decision-editor-title">decision-policy.md</h3>
                  <p class="hint" id="decision-policy-md-path"></p>
                  <p class="hint" id="decision-policy-repository"></p>
                </div>
                <textarea id="decision-policy-md" spellcheck="false" placeholder="# 决策规则"></textarea>
                <p class="hint" id="decision-policy-status"></p>
              </section>
              <section class="decision-example-panel" aria-labelledby="decision-example-title">
                <div>
                  <h3 id="decision-example-title">Example</h3>
                  <p class="hint">A simple sample showing what users can write in each section.</p>
                </div>
                <pre class="decision-example"><code># 决策规则

## 信息源优先级

- 每周要务优先于 Linear。
- 用户今天手动记录的 todo 优先级最高。
- Linear 只用来看任务状态和链接。

## 每日计划规则

- 每天最多给我 3 个重点任务。
- 先放今天必须完成的事。
- 不确定的任务放到“暂缓”。

## 复盘规则

- 先检查今天有没有完成重点任务。
- 没完成时，告诉我原因可能是什么。
- 不要只总结，要给下一步建议。

## AI 分工规则

- Codex 可以先写草稿和检查清单。
- 对外发送邮件前必须让我确认。
- 涉及隐私或付款的事只提醒，不自动执行。

## 不要做

- 不要把过期 Linear 日期当成今天任务。
- 不要一次给太多任务。
- 不要在我没确认前改长期规则。

## 校准记录

- 如果今天计划太多，下次减少到 3 项以内。
- 如果任务说不清楚，下次写成可执行动作。</code></pre>
              </section>
            </div>
          </section>

          <section class="panel" id="section-setup">
            <div class="panel-head">
              <h2>Setup</h2>
              <div class="panel-actions"><span class="save-status" aria-live="polite"></span><button type="submit">Save</button></div>
            </div>
            <fieldset class="wide-fieldset" id="font-size-fieldset">
              <legend>界面字体</legend>
              <p class="hint">调整控制台整体字号，立即生效，仅影响这台浏览器（不写入 config，无需 Save）。</p>
              <div class="font-choices" id="font-size-control">
                <label><input type="radio" name="ui-font" value="small" /> 小</label>
                <label><input type="radio" name="ui-font" value="medium" /> 中</label>
                <label><input type="radio" name="ui-font" value="large" /> 大</label>
              </div>
            </fieldset>
            <div class="grid">
              <label>Display name<input id="user-display-name" /></label>
              <label>Timezone<input id="user-timezone" /></label>
              <label>Language<input id="assistant-language" /></label>
              <label>LLM provider<select id="llm-provider"><option>anthropic</option><option>openai</option><option>codex</option><option>claude</option></select><span class="hint">后台定时任务请用 <code>anthropic</code> / <code>openai</code>（API key）。<code>codex</code> / <code>claude</code> 是订阅版 CLI，在 launchd 后台里无法返回（#199）。</span></label>
              <label>Model<select id="llm-model-select"></select><input id="llm-model" autocomplete="off" placeholder="model id" hidden /><span class="hint">Options follow the selected provider. Choose <code>Custom…</code> to type any id the provider accepts; <code>default</code> follows the provider's own default.</span></label>
              <div class="form-field">
                <label for="secret-OPENAI_API_KEY">OpenAI API key</label>
                <div class="secret-control"><input id="secret-OPENAI_API_KEY" type="password" autocomplete="new-password" /><button type="button" class="icon-button" data-toggle-secret="OPENAI_API_KEY" aria-label="Show OpenAI API key">&#128065;</button></div>
              </div>
              <label>Feishu output provider<select id="output-provider"><option>auto</option><option>sdk</option><option>lark_cli</option></select></label>
              <label>Feishu send mode<select id="output-send-mode"><option>markdown</option><option>text</option></select></label>
              <label>Feedback prefix<input id="feedback-prefix" /></label>
              <label>Feedback poll limit<input id="feedback-poll-limit" type="number" min="1" max="100" /></label>
            </div>
            <fieldset class="wide-fieldset" id="skill-repo-fieldset">
              <legend>weekly-review skill</legend>
              <p class="hint"><code>~/.claude/skills/weekly-review</code> 是指向 life-review-os 检出目录的符号链接，Daily OS 也在同一个目录里执行它。所以这里点一次更新，Claude CLI 和 Daily OS 同时生效——没有需要拷贝或同步的第二份。</p>
              <p class="hint status-line mono" id="skill-repo-status"></p>
              <p class="hint" id="skill-repo-blocked" hidden></p>
              <div class="panel-actions">
                <button type="button" class="secondary" id="skill-repo-update">更新 skill（git pull）</button>
                <span class="save-status" aria-live="polite" id="skill-repo-result"></span>
              </div>
              <div class="panel-actions" id="skill-repo-install-row" hidden>
                <input id="skill-repo-install-dir" placeholder="留空用默认 ~/.daily-os/skills/life-review-os" />
                <button type="button" id="skill-repo-install">安装 skill（git clone）</button>
              </div>
              <pre class="mono small" id="skill-repo-commits" hidden></pre>
            </fieldset>
            <fieldset class="wide-fieldset" id="team-fieldset">
              <legend>Team（Supabase 只读同步）</legend>
              <p class="hint">本地 markdown 永远是真相源。Supabase 只是一个中转，让队友<strong>只读</strong>看到你的周期（weekly / retro / review）。没配置、没登录、断网时，Cycles 和其它本地功能全部照常工作。</p>
              <div class="grid">
                <label>Supabase URL<input id="team-supabase-url" placeholder="https://xxxxxxxx.supabase.co" autocomplete="off" /></label>
                <label>Supabase anon key<input id="team-supabase-anon-key" autocomplete="off" placeholder="eyJhbGciOi..." /><span class="hint">只能填 <code>anon</code> key（它本来就是公开的）。<code>service_role</code> key 会绕过所有 RLS 策略，保存时会被拒绝。</span></label>
              </div>
              <p class="hint">改完这两项要先点右上角的 <strong>Save</strong> 写进 config.yaml，下面的登录才会生效。</p>
              <p class="hint status-line" id="team-status"></p>

              <div id="team-auth-block" hidden>
                <div class="grid">
                  <label>邮箱<input id="team-email" type="email" autocomplete="username" /></label>
                  <label>密码<input id="team-password" type="password" autocomplete="current-password" /></label>
                  <label>显示名<input id="team-display-name" placeholder="Leon" autocomplete="off" /><span class="hint">只有注册时用得上：它同时作为团队里的显示标签，之后可以改。</span></label>
                </div>
                <div class="source-row">
                  <button type="button" data-action="team_signin">登录</button>
                  <button type="button" class="secondary compact" data-action="team_signup">注册新账号</button>
                </div>
                <p class="hint">密码只发给你自己的 Supabase 项目，不写日志、不落盘；本地只保存刷新令牌（0600），所以重启服务不用重新登录。</p>
              </div>

              <div id="team-join-block" hidden>
                <p class="hint">已登录为 <span id="team-identity"></span>，还没有加入任何团队。</p>
                <div class="grid">
                  <label>新建团队<input id="team-new-name" placeholder="daily-os" autocomplete="off" /></label>
                  <label>用邀请码加入<input id="team-invite-input" placeholder="粘贴队友给你的邀请码" autocomplete="off" /></label>
                </div>
                <div class="source-row">
                  <button type="button" data-action="team_create">创建团队</button>
                  <button type="button" data-action="team_join">加入团队</button>
                  <button type="button" class="secondary compact" data-action="team_signout">退出登录</button>
                </div>
              </div>

              <div id="team-info-block" hidden>
                <p class="hint">团队：<strong id="team-name"></strong>　你：<span id="team-identity-joined"></span></p>
                <ul class="hint" id="team-members"></ul>
                <div class="form-field">
                  <label for="team-invite-code">邀请码</label>
                  <div class="path-control"><input id="team-invite-code" readonly /><button type="button" class="secondary compact" data-action="team_copy_code">复制</button></div>
                </div>
                <p class="hint">邀请码是别人进入这个团队的唯一凭据，只发给队友本人。重新生成后旧邀请码立即失效。</p>
                <div class="source-row">
                  <button type="button" class="secondary compact" data-action="team_refresh">刷新团队信息</button>
                  <button type="button" class="secondary compact" data-action="team_rotate_code">重新生成邀请码</button>
                  <button type="button" class="secondary compact" data-action="team_leave">退出团队</button>
                  <button type="button" class="secondary compact" data-action="team_signout">退出登录</button>
                </div>
                <p class="hint">退出团队只影响以后：已经同步上去的周期仍留在原团队里。</p>
              </div>
            </fieldset>
            <fieldset class="wide-fieldset">
              <legend>决策校准</legend>
              <p class="hint">创建或复用一个飞书私有群，用来和用户一起磨合 Daily OS 的决策方式。Mac UI 只负责配置；规则沟通发生在飞书里。</p>
              <div class="source-row">
                <button type="button" class="secondary compact" data-action="decision_onboarding_start">开始决策校准</button>
                <label class="check-row"><input id="decision-auto-create" type="checkbox" /> 飞书交互层启动时自动创建</label>
              </div>
              <label>校准群名称<input id="decision-chat-name" /></label>
              <label>决策校准群 ID<input id="env-DAILY_OS_DECISION_CHAT_ID" placeholder="自动创建，或手动粘贴 oc_xxx" /></label>
              <p class="hint">默认不自动创建，避免客户刚启动工具就被突然拉群。只有确认飞书应用已开通 <code>im:chat</code> 权限后，再启用自动创建。</p>
            </fieldset>
            <fieldset class="wide-fieldset" id="codex-fieldset">
              <legend>Codex</legend>
              <p class="hint"><strong>通常你什么都不用填。</strong>provider=codex 时会自动探测 Codex CLI 的位置，探测到就直接用。</p>
              <p class="hint warn-hint">⚠️ 后台服务(launchd)的 PATH 和你终端里的不是同一个，所以“终端能跑通”不代表“后台能跑通”——这正是这一屏存在的理由。另外：订阅版 CLI 在后台会因 Keychain 阻塞而无法返回（#199），定时任务请把 LLM provider 改成 <code>anthropic</code> 或 <code>openai</code>（API key）。</p>
              <p class="hint status-line detect-line" id="codex-detect">进入此项时会自动探测…</p>
              <div class="source-row">
                <button type="button" class="secondary compact" data-action="discover_codex_binary">重新探测</button>
                <button type="button" class="secondary compact" data-action="codex_test">测 Codex 登录</button>
              </div>
              <details class="cli-manual" id="codex-manual">
                <summary>找不到？手动指定路径</summary>
                <div class="form-field">
                  <label for="env-CODEX_BIN">Codex binary</label>
                  <div class="path-control"><input id="env-CODEX_BIN" placeholder="codex or /opt/homebrew/bin/codex" /><button type="button" class="secondary compact" data-action="choose_codex_binary">选择…</button></div>
                </div>
                <div class="form-field">
                  <label for="env-CODEX_HOME">Codex home</label>
                  <div class="path-control"><input id="env-CODEX_HOME" placeholder="Optional, usually ~/.codex" /><button type="button" class="secondary compact" data-action="choose_codex_home">选择文件夹</button></div>
                </div>
              </details>
              <p class="hint status-line" id="codex-status"></p>
            </fieldset>
            <fieldset class="wide-fieldset" id="claude-fieldset" hidden>
              <legend>Claude Code</legend>
              <p class="hint"><strong>通常你什么都不用填。</strong>provider=claude 时会自动探测 Claude Code CLI 的位置，探测到就直接用。</p>
              <p class="hint warn-hint">⚠️ 后台服务(launchd)的 PATH 和你终端里的不是同一个，所以“终端能跑通”不代表“后台能跑通”——这正是这一屏存在的理由。另外：订阅版 CLI 在后台会因 Keychain 阻塞而无法返回（#199），定时任务请把 LLM provider 改成 <code>anthropic</code> 或 <code>openai</code>（API key）。</p>
              <p class="hint status-line detect-line" id="claude-detect">进入此项时会自动探测…</p>
              <div class="source-row">
                <button type="button" class="secondary compact" data-action="discover_claude_binary">重新探测</button>
                <button type="button" class="secondary compact" data-action="claude_test">测 Claude 登录</button>
              </div>
              <details class="cli-manual" id="claude-manual">
                <summary>找不到？手动指定路径</summary>
                <div class="form-field">
                  <label for="env-CLAUDE_BIN">Claude binary</label>
                  <div class="path-control"><input id="env-CLAUDE_BIN" placeholder="claude or /opt/homebrew/bin/claude" /><button type="button" class="secondary compact" data-action="choose_claude_binary">选择…</button></div>
                </div>
              </details>
              <p class="hint status-line" id="claude-status"></p>
            </fieldset>
            <div class="toggles">
              <label><input id="output-feishu-enabled" type="checkbox" /> Feishu output</label>
              <label><input id="feedback-feishu-enabled" type="checkbox" /> Feishu feedback</label>
            </div>
          </section>

          <section class="panel" id="section-sources">
            <div class="panel-head">
              <h2>Sources</h2>
              <div class="panel-actions"><span class="save-status" aria-live="polite"></span><button type="submit">Save</button></div>
            </div>
            <div class="source-list">
              <fieldset>
                <legend>Knowledge vault</legend>
                <p class="hint">This is the user's existing knowledge-base vault used as a source. It is separate from the Daily OS memory repository below.</p>
                <label><input id="vault-enabled" type="checkbox" /> Enabled</label>
                <label>Provider<select id="vault-provider"><option>local</option><option>remote</option></select></label>
                <div class="form-field">
                  <label for="vault-local-path">Local path</label>
                  <div class="path-control"><input id="vault-local-path" /><button type="button" class="secondary compact" data-action="choose_vault_folder">Choose folder</button></div>
                </div>
                <label>Vault gate URL<input id="env-VAULT_GATE_URL" /></label>
                <div class="form-field">
                  <label for="secret-VAULT_GATE_TOKEN">Vault gate token</label>
                  <div class="secret-control"><input id="secret-VAULT_GATE_TOKEN" type="password" autocomplete="new-password" /><button type="button" class="icon-button" data-toggle-secret="VAULT_GATE_TOKEN" aria-label="Show Vault gate token">&#128065;</button></div>
                </div>
              </fieldset>

              <fieldset>
                <legend>Memory repository</legend>
                <p class="hint">This is Daily OS working memory. Leave empty to use the generic built-in template at <code>memory-vault/default</code>. Choose a private folder for durable goals, projects, commitments, and review notes.</p>
                <div class="form-field">
                  <label for="memory-repository-path">Repository path</label>
                  <div class="path-control"><input id="memory-repository-path" placeholder="Use built-in default when empty" /><button type="button" class="secondary compact" data-action="choose_memory_repository">Choose folder</button></div>
                </div>
                <label>Long-term append log<input id="memory-long-term-path" /></label>
                <label>Daily run log folder<input id="memory-daily-dir" /></label>
              </fieldset>

              <fieldset>
                <legend>Feishu</legend>
                <label><input id="source-feishu-enabled" type="checkbox" /> Enabled</label>
                <div class="source-block">
                  <p class="hint"><strong>Simple setup:</strong> Daily OS uses your existing <code>lark-cli</code> login whenever possible. Click auto configure first; only fill the remaining fields it reports.</p>
                  <div class="source-row">
                    <button type="button" class="secondary compact" data-action="discover_feishu_setup">Auto configure from lark-cli</button>
                    <button type="button" class="secondary compact" data-action="doctor">Run Checks</button>
                  </div>
                  <p class="hint status-line" id="feishu-setup-status"></p>
                </div>
                <details class="advanced-settings">
                  <summary>Manual Feishu credentials</summary>
                  <p class="hint">App ID and App Secret are used by the official Feishu SDK for bot output and the websocket interaction layer. If output provider is <code>auto</code>, Daily OS uses SDK when both are configured and falls back to lark-cli otherwise.</p>
                  <label>Feishu App ID<input id="env-LARK_APP_ID" placeholder="cli_xxx" /></label>
                  <div class="form-field">
                    <label for="secret-LARK_APP_SECRET">Feishu App Secret</label>
                    <div class="secret-control"><input id="secret-LARK_APP_SECRET" type="password" autocomplete="new-password" /><button type="button" class="icon-button" data-toggle-secret="LARK_APP_SECRET" aria-label="Show Feishu App Secret">&#128065;</button></div>
                  </div>
                  <label>Feishu Chat ID <span class="required">Only for output, feedback, or IM history</span><input id="env-FEISHU_CHAT_ID" placeholder="oc_xxx" /></label>
                  <label>Owner open_id <span class="required">Only for secure interaction</span><input id="env-FEISHU_OWNER_OPEN_ID" placeholder="ou_xxx" /></label>
                </details>
                <div class="source-block">
                  <p class="hint"><strong>Source profiles:</strong> choose what lark-cli should collect. Calendar and tasks usually need no extra fields after user login. Docs need document URLs/tokens. IM history needs a chat ID.</p>
                </div>
                <details class="advanced-settings">
                  <summary>Feishu interaction layer</summary>
                  <p class="hint">Optional websocket listener for remote commands in Feishu. It uses the same official SDK credentials as SDK output.</p>
                  <label><input id="interaction-feishu-enabled" type="checkbox" /> Feishu interaction layer</label>
                  <label>Interaction prefix<input id="interaction-feishu-prefix" /></label>
                  <label>Reply mode<select id="interaction-feishu-reply-mode"><option>markdown</option><option>text</option></select></label>
                  <label>Debounce ms<input id="interaction-feishu-debounce" type="number" min="0" /></label>
                  <label><input id="interaction-feishu-require-mention" type="checkbox" /> Require @mention in groups</label>
                  <label>Access level<select id="interaction-feishu-access-level"><option>read_only</option><option>workspace</option><option>full</option></select></label>
                  <label>Admin open IDs<textarea id="interaction-feishu-admins" rows="3" spellcheck="false" placeholder="One Feishu open_id per line"></textarea></label>
                  <label>Allowed user open IDs<textarea id="interaction-feishu-users" rows="3" spellcheck="false" placeholder="One Feishu open_id per line"></textarea></label>
                  <label>Allowed chat IDs<textarea id="interaction-feishu-chats" rows="3" spellcheck="false" placeholder="One Feishu chat_id per line"></textarea></label>
                  <label>Allowed workspaces<textarea id="interaction-feishu-workspaces" rows="3" spellcheck="false" placeholder="One local workspace path per line"></textarea></label>
                  <p class="hint">Safe default: interaction messages are denied until owner open_id, allowed users, or allowed chats are configured. Use full access only for trusted private deployments.</p>
                </details>
                <div class="manual-help">
                  <p class="hint"><strong>Multiple Feishu profiles:</strong> use profiles for different source mixes under the same lark-cli app. For separate Feishu tenants or apps, run a separate local config.</p>
                </div>
                <div id="feishu-profiles" class="profile-list"></div>
                <button type="button" class="secondary" id="add-feishu-profile">Add Feishu profile</button>
              </fieldset>

              <fieldset>
                <legend>Other sources</legend>
                <div class="source-block">
                  <div class="source-row">
                    <label class="check-row"><input id="source-github" type="checkbox" /> GitHub</label>
                    <button type="button" class="secondary compact" data-action="discover_github_token">Find GitHub token</button>
                  </div>
                  <div class="form-field">
                    <label for="secret-GITHUB_TOKEN">GitHub token</label>
                    <div class="secret-control"><input id="secret-GITHUB_TOKEN" type="password" autocomplete="new-password" /><button type="button" class="icon-button" data-toggle-secret="GITHUB_TOKEN" aria-label="Show GitHub token">&#128065;</button></div>
                  </div>
                  <label>GitHub repositories<textarea id="github-repositories" rows="4" spellcheck="false" placeholder="owner/repo, one per line"></textarea></label>
                  <label>Per repo limit<input id="github-per-repo-limit" type="number" min="1" max="100" /></label>
                  <p class="hint status-line" id="github-token-status"></p>
                </div>
                <div class="source-block">
                  <div class="source-row">
                    <label class="check-row"><input id="source-linear" type="checkbox" /> Linear</label>
                    <button type="button" class="secondary compact" data-action="discover_linear_token">Find Linear key</button>
                  </div>
                  <div class="form-field">
                    <label for="secret-LINEAR_API_KEY">Linear API key</label>
                    <div class="secret-control"><input id="secret-LINEAR_API_KEY" type="password" autocomplete="new-password" /><button type="button" class="icon-button" data-toggle-secret="LINEAR_API_KEY" aria-label="Show Linear API key">&#128065;</button></div>
                  </div>
                  <p class="hint">Linear API key is preferred for direct collection. If it is empty, this app will try the local Codex Linear connection as a fallback.</p>
                  <label>Assignee（我的任务标识）<input id="linear-assignee" placeholder="me / 邮箱 / 显示名；留空=整个团队" /></label>
                  <label class="check-row"><input id="linear-active-cycle" type="checkbox" /> 仅当前 Cycle 的任务</label>
                  <p class="hint">Assignee 作用于所有过滤（含团队/项目白名单）：me = API key 所属账号；填邮箱或 Linear 显示名可指定他人；留空拉整个团队。</p>
                  <details class="source-advanced">
                    <summary>高级过滤（query · 项目/团队 白名单）</summary>
                    <label>Linear query<input id="linear-query" placeholder="留空即可；仅在需要自定义 GraphQL 过滤时填" /></label>
                    <label>Allowed projects<textarea id="linear-projects-allowlist" rows="3" spellcheck="false" placeholder="每行一个 Linear 项目名（例如 Web / Mobile）"></textarea></label>
                    <label>Blocked projects<textarea id="linear-projects-blocklist" rows="3" spellcheck="false" placeholder="每行一个要排除的项目名"></textarea></label>
                    <label>Allowed teams<textarea id="linear-teams-allowlist" rows="3" spellcheck="false" placeholder="每行一个 Linear 团队名或 key（例如 Engineering / ENG）"></textarea></label>
                    <label>Blocked teams<textarea id="linear-teams-blocklist" rows="3" spellcheck="false" placeholder="每行一个要排除的团队名或 key"></textarea></label>
                    <p class="hint">项目过滤用 Linear 项目名；团队过滤用团队名或 key。匹配忽略大小写、空格、连字符和下划线。</p>
                  </details>
                  <p class="hint status-line" id="linear-token-status"></p>
                </div>
                <label><input id="source-chrome" type="checkbox" /> Chrome snapshot</label>
                <label><input id="source-apple-calendar" type="checkbox" /> Apple Calendar snapshot</label>
              </fieldset>

              <fieldset>
                <legend>Local files</legend>
                <label><input id="local-files-enabled" type="checkbox" /> Enabled</label>
                <label>Files<textarea id="local-files" rows="5" spellcheck="false"></textarea></label>
              </fieldset>
            </div>
          </section>

          <section class="panel" id="section-workflows">
            <div class="panel-head">
              <h2>Workflows</h2>
              <div class="panel-actions"><span class="save-status" aria-live="polite"></span><button type="submit">Save</button></div>
            </div>
            <div class="workflow-grid">
              <fieldset>
                <legend>Daily plan</legend>
                <label><input id="workflow-plan-enabled" type="checkbox" /> Enabled</label>
                <label>Time<input id="workflow-plan-time" type="time" /></label>
                <button type="button" data-action="plan">Run now</button>
              </fieldset>
              <fieldset>
                <legend>Daily review</legend>
                <label><input id="workflow-review-enabled" type="checkbox" /> Enabled</label>
                <label>Time<input id="workflow-review-time" type="time" /></label>
                <label><input id="workflow-review-skip-weekly-day" type="checkbox" /> Skip automatic review on weekly review day</label>
                <button type="button" data-action="review">Run now</button>
              </fieldset>
              <fieldset>
                <legend>Weekly review</legend>
                <label><input id="workflow-weekly-enabled" type="checkbox" /> Enabled</label>
                <label>Weekday<select id="workflow-weekly-weekday"><option>MON</option><option>TUE</option><option>WED</option><option>THU</option><option>FRI</option><option>SAT</option><option>SUN</option></select></label>
                <label>Time<input id="workflow-weekly-time" type="time" /></label>
                <button type="button" data-action="weekly">Run now</button>
              </fieldset>
              <fieldset>
                <legend>Calendar planning</legend>
                <p class="hint">Optional bridge to <code>calendar-planning-os</code>. Saving these fields does not require a service restart; the next Feishu command reads the latest config.</p>
                <label><input id="calendar-enabled" type="checkbox" /> Enabled</label>
                <label>Engine mode<select id="calendar-engine-mode"><option value="auto">auto</option><option value="external">external</option><option value="builtin">builtin</option></select></label>
                <label>Command<input id="calendar-command" placeholder="node" /></label>
                <div class="form-field">
                  <label for="calendar-workdir">calendar-planning-os folder</label>
                  <div class="path-control"><input id="calendar-workdir" placeholder="../calendar-planning-os" /><button type="button" class="secondary compact" data-action="choose_calendar_workdir">Choose folder</button></div>
                </div>
                <label>CLI path<input id="calendar-cli-path" placeholder="bin/calendar-planning-os.mjs" /></label>
                <label>Policy file<input id="calendar-policy-file" placeholder="Optional local markdown file" /></label>
                <label>Routines file<input id="calendar-routines-file" placeholder="Optional local yaml file" /></label>
                <div class="todo-form-grid">
                  <label>Week days<input id="calendar-week-days" type="number" min="1" max="14" /></label>
                  <label>Max tasks<input id="calendar-max-tasks" type="number" min="1" max="20" /></label>
                </div>
                <div class="source-row">
                  <button type="button" class="secondary compact" data-action="calendar_test">Test Calendar Engine</button>
                  <button type="button" class="secondary compact" data-action="calendar_week">Draft Week</button>
                  <button type="button" class="secondary compact" data-action="calendar_today">Draft Today</button>
                </div>
                <p class="hint status-line" id="calendar-status"></p>
              </fieldset>
              <fieldset>
                <legend>Service</legend>
                <p class="hint">Install creates a macOS launchd background service for the UI, scheduler, and Feishu realtime connection.</p>
                <label><input id="service-prevent-sleep" type="checkbox" /> Prevent idle sleep while Daily OS is running</label>
                <p class="hint">Uses macOS caffeinate. Closing a MacBook lid, especially on battery, can still force sleep.</p>
                <div class="service-status" id="service-status" aria-live="polite"></div>
                <button type="button" id="service-install-button" data-action="service_install">Install</button>
                <button type="button" id="service-uninstall-button" class="secondary" data-action="service_uninstall">Uninstall</button>
              </fieldset>
              <fieldset>
                <legend>Background suggestions</legend>
                <label><input id="background-suggestions-enabled" type="checkbox" /> Enabled</label>
                <label>Mode<select id="background-suggestions-mode"><option value="review">Review</option><option value="todo">Todo</option><option value="manual">Manual</option></select></label>
                <label>Interval minutes<input id="background-suggestions-interval" type="number" min="1" /></label>
                <label>Minimum confidence<select id="background-suggestions-confidence"><option value="medium">Medium</option><option value="high">High</option><option value="low">Low</option></select></label>
                <label><input id="background-suggestions-send" type="checkbox" /> Send Feishu summary</label>
                <label><input id="background-suggestions-change-only" type="checkbox" /> Send only when changed</label>
                <div class="service-status" id="background-suggestions-status" aria-live="polite"></div>
              </fieldset>
            </div>
          </section>

          <section class="panel" id="section-logs">
            <div class="panel-head">
              <div>
                <h2>Logs</h2>
                <p class="hint">Local UI/API request status and action lifecycle. Retained for 7 days; secrets and response bodies are not logged.</p>
              </div>
              <div class="panel-actions">
                <button type="button" class="secondary" id="refresh-logs">Refresh</button>
                <button type="button" class="secondary" id="clear-logs">Clear logs</button>
              </div>
            </div>
            <div class="log-list" id="logs" aria-live="polite"></div>
          </section>
        </form>
      </section>
    </main>

    <footer class="appfoot">Daily OS Feishu · v__UI_VERSION_PLACEHOLDER__</footer>

    <script>window.__UI_TOKEN__ = '__UI_TOKEN_PLACEHOLDER__';</script>
    <script src="/assets/app.js"></script>
  </body>
</html>`;

const CSS = String.raw`:root {
  color-scheme: light;
  --bg: #f6f7f4;
  --surface: #ffffff;
  --surface-2: #eef3ee;
  --text: #202421;
  --muted: #68726b;
  --border: #d7ddd8;
  --accent: #1f6f58;
  --accent-2: #0d5f8c;
  --danger: #9f2d2d;
  --ok: #1e7a4d;
  --warn: #a06413;
}

* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  letter-spacing: 0;
}

.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 1rem 1.25rem;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
}

.top-status, .panel-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: .75rem;
}

.top-link {
  font-weight: 600;
  text-decoration: none;
  color: var(--accent, #0a7);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: .35rem .7rem;
  white-space: nowrap;
}
.top-link:hover { background: var(--surface-2, #f2f4f7); }

.save-status {
  color: var(--muted);
  font-size: .9rem;
  min-width: 8rem;
  text-align: right;
}
.save-status.success { color: var(--ok); }
.save-status.error { color: var(--danger); }

.toast {
  position: fixed;
  top: 1rem;
  right: 1rem;
  z-index: 20;
  max-width: min(32rem, calc(100vw - 2rem));
  padding: .8rem 1rem;
  border: 1px solid var(--border);
  border-radius: .5rem;
  background: var(--panel);
  box-shadow: 0 12px 32px rgb(0 0 0 / .12);
  color: var(--text);
  opacity: 0;
  transform: translateY(-.35rem);
  pointer-events: none;
  transition: opacity .16s ease, transform .16s ease;
  white-space: pre-wrap;
}
.toast.visible {
  opacity: 1;
  transform: translateY(0);
}
.toast.success {
  border-color: #98c8aa;
  background: #edf7ef;
}
.toast.error {
  border-color: #d5a4a4;
  background: #fff0f0;
}

h1, h2, h3, legend, p { margin: 0; }
h1 { font-size: 1.25rem; font-weight: 700; }
h2 { font-size: 1rem; }
h3 { font-size: .95rem; }
p, .hint { color: var(--muted); font-size: .85rem; }
.appfoot { padding: 12px 20px; color: var(--muted); font-size: .78rem; text-align: center; }
code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: .82em;
}

.required {
  color: var(--warn);
  font-size: .75rem;
  font-weight: 700;
}

.status {
  min-width: 8rem;
  text-align: center;
  border: 1px solid var(--border);
  border-radius: .5rem;
  padding: .45rem .65rem;
  color: var(--muted);
}
.status.ok { color: var(--ok); border-color: #98c8aa; background: #edf7ef; }
.status.warn { color: var(--warn); border-color: #dfc497; background: #fff7e8; }

.layout {
  display: grid;
  grid-template-columns: 13rem minmax(0, 1fr);
  min-height: calc(100vh - 73px);
}

.nav {
  padding: 1rem;
  border-right: 1px solid var(--border);
}

.nav-button, button, select, input, textarea {
  font: inherit;
}

.nav-button {
  width: 100%;
  height: 2.5rem;
  text-align: left;
  border: 0;
  border-radius: .5rem;
  padding: 0 .75rem;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
}
.nav-button.active {
  background: var(--surface-2);
  color: var(--text);
  font-weight: 600;
}

.content { padding: 1rem; }
.panel {
  display: none;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: .5rem;
  padding: 1rem;
}
.panel.active { display: block; }
.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 1rem;
}

.guide-document {
  display: grid;
  gap: 1.15rem;
  max-width: 58rem;
  border: 1px solid var(--border);
  border-radius: .5rem;
  background: #fbfcfb;
  padding: 1rem;
}
.guide-document section {
  display: grid;
  gap: .55rem;
}
.guide-document h3 {
  margin: 0;
}
.guide-document p {
  margin: 0;
  color: var(--muted);
}
.guide-table {
  width: 100%;
  border-collapse: collapse;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: .4rem;
  overflow: hidden;
}
.guide-table th,
.guide-table td {
  border-bottom: 1px solid #edf0ed;
  padding: .55rem .65rem;
  text-align: left;
  vertical-align: top;
}
.guide-table tr:last-child td {
  border-bottom: 0;
}
.guide-table th {
  color: var(--muted);
  background: #f7f8f6;
  font-weight: 650;
}
.guide-table td:first-child {
  white-space: nowrap;
}
.guide-code {
  margin: 0;
  overflow: auto;
  white-space: pre-wrap;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: .4rem;
  padding: .7rem;
}

.grid, .workflow-grid, .source-list {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(17rem, 1fr));
  gap: .85rem;
  align-items: start;
}

label {
  display: grid;
  gap: .35rem;
  color: var(--muted);
  font-size: .85rem;
}

.form-field {
  display: grid;
  gap: .35rem;
  color: var(--muted);
  font-size: .85rem;
}

.inline, .toggles label, label:has(> input[type="checkbox"]), .check-row {
  display: flex;
  align-items: center;
  gap: .5rem;
}

input, select, textarea {
  width: 100%;
  border: 1px solid var(--border);
  border-radius: .45rem;
  background: #fff;
  color: var(--text);
  padding: .55rem .65rem;
}

input, select {
  min-height: 2.5rem;
}

input[type="checkbox"] {
  width: auto;
  min-width: 1rem;
  height: 1rem;
}

textarea {
  min-height: 8rem;
  resize: vertical;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: .82rem;
}

button {
  border: 1px solid var(--accent);
  border-radius: .45rem;
  background: var(--accent);
  color: white;
  min-height: 2.35rem;
  padding: .45rem .75rem;
  cursor: pointer;
}
button.secondary {
  background: white;
  color: var(--accent);
}
button:disabled {
  opacity: .55;
  cursor: progress;
}

.secret-control {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 2.5rem;
  align-items: stretch;
}
.secret-control input {
  border-radius: .45rem 0 0 .45rem;
}
.icon-button {
  min-height: 2.5rem;
  padding: 0;
  border-radius: 0 .45rem .45rem 0;
  background: white;
  color: var(--accent);
}

.path-control {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: .5rem;
  align-items: center;
}

fieldset {
  border: 1px solid var(--border);
  border-radius: .5rem;
  padding: .85rem;
  display: grid;
  gap: .7rem;
  min-width: 0;
  align-content: start;
  grid-auto-rows: max-content;
}
.wide-fieldset {
  margin-top: .85rem;
}
fieldset[hidden] {
  display: none;
}
legend {
  padding: 0 .35rem;
  font-weight: 700;
}

.profile-list {
  display: grid;
  gap: .75rem;
}
.profile {
  border: 1px solid var(--border);
  border-radius: .5rem;
  background: #fbfcfb;
}
.profile-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: .75rem;
  padding: .75rem;
  cursor: pointer;
}
.profile-title {
  font-weight: 700;
}
.profile-meta {
  color: var(--muted);
  font-size: .8rem;
  text-align: right;
}
.profile-body {
  border-top: 1px solid var(--border);
  padding: .75rem;
  display: grid;
  gap: .65rem;
}
.profile-options {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
  gap: .5rem;
}
.advanced-settings {
  border: 1px dashed var(--border);
  border-radius: .45rem;
  padding: .55rem .65rem;
}
.advanced-settings summary {
  color: var(--muted);
  cursor: pointer;
  font-size: .85rem;
  font-weight: 600;
}
.advanced-settings[open] summary {
  margin-bottom: .65rem;
}

.source-block {
  display: grid;
  gap: .6rem;
  border: 1px solid var(--border);
  border-radius: .5rem;
  padding: .75rem;
  background: #fbfcfb;
}
.source-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: .75rem;
}
/* LEO-250: collapse the advanced Linear filters so the core fields lead. */
.source-advanced {
  border: 1px solid var(--border);
  border-radius: .5rem;
  background: var(--surface, #fff);
  padding: 0 .6rem;
}
.source-advanced > summary {
  cursor: pointer;
  padding: .5rem .1rem;
  color: var(--muted);
  font-size: .85rem;
  list-style: revert;
}
.source-advanced[open] > summary {
  color: var(--text);
  border-bottom: 1px solid var(--border);
  margin-bottom: .5rem;
}
.source-advanced > label {
  display: grid;
  gap: .3rem;
  margin-bottom: .5rem;
}
.compact {
  min-height: 2rem;
  padding: .3rem .6rem;
}
.status-line {
  min-height: 1.1rem;
}

.warn-hint {
  border-left: 3px solid #d97706;
  padding-left: .55rem;
  color: #92600a;
}

.detect-line {
  font-weight: 600;
  color: var(--text);
  white-space: pre-wrap;
}

.cli-manual > summary {
  cursor: pointer;
  color: var(--muted);
  font-size: .85rem;
}

.cli-manual[open] > summary {
  margin-bottom: .4rem;
}

.service-status {
  border: 1px solid var(--border);
  border-radius: .45rem;
  padding: .55rem .65rem;
  color: var(--muted);
  background: #fbfcfb;
  font-size: .85rem;
}

.service-status.registered {
  color: var(--ok);
  border-color: #98c8aa;
  background: #edf7ef;
}
.service-status.error {
  color: var(--danger);
  border-color: #d5a4a4;
  background: #fff0f0;
}

.manual-help {
  display: grid;
  gap: .55rem;
  border: 1px solid var(--border);
  border-radius: .5rem;
  padding: .65rem;
  background: #fbfcfb;
}

.toggles, .actions {
  display: flex;
  flex-wrap: wrap;
  gap: .75rem;
  margin-top: 1rem;
}

.checks {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
  gap: .5rem;
}
.check {
  display: flex;
  justify-content: space-between;
  gap: .75rem;
  border: 1px solid var(--border);
  border-radius: .45rem;
  padding: .6rem .7rem;
  min-height: 2.6rem;
}
.check strong { font-size: .9rem; }
.check span { font-size: .8rem; color: var(--muted); }
.check.ok strong { color: var(--ok); }
.check.warning strong { color: var(--warn); }
.check.missing strong { color: var(--danger); }

.todo-page {
  display: grid;
  grid-template-columns: minmax(18rem, 24rem) minmax(0, 1fr);
  gap: 1rem;
  align-items: start;
}

.todo-editor textarea {
  min-height: 7rem;
  font-family: inherit;
  font-size: .9rem;
}
.todo-form-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: .7rem;
}
.todo-editor-actions,
.todo-item-actions {
  display: flex;
  flex-wrap: wrap;
  gap: .5rem;
}
.todo-list-head {
  display: flex;
  justify-content: space-between;
  gap: .75rem;
}
.todo-list {
  display: grid;
  gap: .55rem;
}
.todo-item {
  display: grid;
  gap: .45rem;
  border: 1px solid var(--border);
  border-radius: .45rem;
  background: #fff;
  padding: .65rem .7rem;
}
.todo-item-main {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: .75rem;
}
.todo-item-title {
  font-weight: 650;
  overflow-wrap: anywhere;
}
.todo-item-meta {
  color: var(--muted);
  font-size: .78rem;
}
.todo-chip {
  flex: 0 0 auto;
  border-radius: 999px;
  border: 1px solid #e7c991;
  background: #fff7e8;
  color: var(--warn);
  padding: .12rem .45rem;
  font-size: .75rem;
  font-weight: 700;
}
.todo-empty {
  border: 1px dashed var(--border);
  border-radius: .45rem;
  color: var(--muted);
  padding: 1rem;
}

.decision-page {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(22rem, .72fr);
  gap: 1rem;
  align-items: start;
}
.decision-editor,
.decision-example-panel {
  display: grid;
  gap: .75rem;
  border: 1px solid var(--border);
  border-radius: .5rem;
  background: #fbfcfb;
  padding: .85rem;
}
.decision-editor textarea {
  min-height: 34rem;
  line-height: 1.5;
}
.decision-example-panel {
  background: #fffdfa;
}
.decision-example {
  min-height: 34rem;
  margin: 0;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--text);
  background: #ffffff;
  border: 1px solid var(--border);
  border-radius: .4rem;
  padding: .75rem;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  font-size: .86rem;
  line-height: 1.5;
}
.rhythm-resolved,
.rhythm-settings {
  display: grid;
  gap: .6rem;
  border: 1px solid var(--border);
  border-radius: .5rem;
  background: #fbfcfb;
  padding: .85rem;
  margin-bottom: 1rem;
}
.rhythm-settings {
  border-color: var(--border);
}
.rhythm-settings legend {
  font-size: .95rem;
  font-weight: 700;
  padding: 0 .35rem;
}
.rhythm-today {
  font-size: 1.05rem;
  font-weight: 600;
  line-height: 1.5;
}
.rhythm-today .rhythm-rest {
  color: var(--accent-2);
}
.rhythm-today .rhythm-work {
  color: var(--accent);
}
.rhythm-today .rhythm-off {
  color: var(--muted);
  font-weight: 400;
}
.rhythm-days {
  display: flex;
  flex-wrap: wrap;
  gap: .5rem 1rem;
}
.rhythm-settings input[type="number"] {
  max-width: 6rem;
}
@media (max-width: 1080px) {
  .decision-page {
    grid-template-columns: minmax(0, 1fr);
  }
  .guide-document {
    max-width: none;
  }
  .guide-table {
    display: block;
    overflow-x: auto;
  }
}

.log-list {
  display: grid;
  gap: .5rem;
  max-height: 65vh;
  overflow: auto;
}

.log-entry {
  display: grid;
  grid-template-columns: 10.5rem 5.5rem minmax(0, 1fr) 5rem;
  gap: .75rem;
  align-items: center;
  border: 1px solid var(--border);
  border-radius: .45rem;
  padding: .55rem .65rem;
  background: #fbfcfb;
  font-size: .82rem;
}

.log-time, .log-meta, .log-duration {
  color: var(--muted);
}

.log-target {
  min-width: 0;
  overflow-wrap: anywhere;
}

.log-badge {
  display: inline-flex;
  justify-content: center;
  min-width: 4.5rem;
  border-radius: 999px;
  border: 1px solid var(--border);
  padding: .15rem .45rem;
  font-weight: 700;
  text-transform: uppercase;
}

.log-badge.info { color: var(--ok); border-color: #98c8aa; background: #edf7ef; }
.log-badge.warning { color: var(--warn); border-color: #dfc497; background: #fff7e8; }
.log-badge.error { color: var(--danger); border-color: #d5a4a4; background: #fff0f0; }

pre {
  margin: 1rem 0 0;
  min-height: 14rem;
  max-height: 42vh;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: .5rem;
  background: #101412;
  color: #eff5ef;
  padding: .85rem;
  white-space: pre-wrap;
  font-size: .82rem;
}

@media (max-width: 760px) {
  .topbar { align-items: flex-start; flex-direction: column; }
  .layout { grid-template-columns: 1fr; }
  .nav {
    display: flex;
    overflow-x: auto;
    border-right: 0;
    border-bottom: 1px solid var(--border);
  }
  .nav-button { flex: 0 0 auto; width: auto; }
  .todo-page { grid-template-columns: 1fr; }
  .log-entry { grid-template-columns: 1fr; gap: .35rem; }
}
/* UI font size preference (Setup): small / medium / large via body zoom. */
html[data-font="small"] { --ui-zoom: 0.9; }
html[data-font="large"] { --ui-zoom: 1.14; }
body { zoom: var(--ui-zoom, 1); }
.font-choices { display: flex; gap: 10px; flex-wrap: wrap; }
.font-choices label { display: inline-flex; align-items: center; gap: 5px; font-size: 13px; cursor: pointer; }
`;

/**
 * Exported so tests can evaluate the shipped console script against a DOM stub.
 * A syntax check is not enough on its own: the model picker regressed while
 * parsing perfectly, because the defect was behavioural — a datalist filters
 * its suggestions against the input's current value, so a field that always
 * holds a value never showed a menu.
 */
export const JS = String.raw`let state;

// UI font-size preference (Setup → 界面字体). Client-only, persisted in localStorage.
(function () {
  var control = document.getElementById('font-size-control');
  if (!control || typeof control.querySelector !== 'function' || typeof control.addEventListener !== 'function') return;
  var current = 'medium';
  try { var f = localStorage.getItem('daily_os_font'); if (f === 'small' || f === 'large') current = f; } catch (e) {}
  var checked = control.querySelector('input[value="' + current + '"]');
  if (checked) checked.checked = true;
  control.addEventListener('change', function (ev) {
    var val = ev.target && ev.target.value;
    if (val !== 'small' && val !== 'medium' && val !== 'large') return;
    try { localStorage.setItem('daily_os_font', val); } catch (e) {}
    if (val === 'medium') document.documentElement.removeAttribute('data-font');
    else document.documentElement.setAttribute('data-font', val);
  });
})();

const UI_TOKEN = (function () {
  // Priority: ?token=... (first open) -> sessionStorage -> token injected into the page HTML.
  try {
    const params = new URLSearchParams(window.location.search);
    const fromQuery = params.get('token');
    if (fromQuery) {
      sessionStorage.setItem('daily_os_ui_token', fromQuery);
      params.delete('token');
      const cleaned = window.location.pathname + (params.toString() ? '?' + params.toString() : '') + window.location.hash;
      window.history.replaceState({}, document.title, cleaned);
      return fromQuery;
    }
    const stored = sessionStorage.getItem('daily_os_ui_token');
    if (stored) return stored;
  } catch (error) {
    // sessionStorage may be unavailable; fall back to the injected token.
  }
  return window.__UI_TOKEN__ || '';
})();

function apiFetch(url, options) {
  const opts = options ? Object.assign({}, options) : {};
  const headers = Object.assign({}, opts.headers || {});
  if (UI_TOKEN) headers['Authorization'] = 'Bearer ' + UI_TOKEN;
  opts.headers = headers;
  return fetch(url, opts);
}

const $ = (id) => document.getElementById(id);
const set = (id, value) => { const el = $(id); if (el) el.value = value ?? ''; };
const checked = (id, value) => { const el = $(id); if (el) el.checked = Boolean(value); };
const value = (id) => $(id)?.value ?? '';
const isChecked = (id) => Boolean($(id)?.checked);

document.querySelectorAll('.nav-button').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('.nav-button').forEach((item) => item.classList.remove('active'));
    document.querySelectorAll('.panel').forEach((item) => item.classList.remove('active'));
    button.classList.add('active');
    $('section-' + button.dataset.section).classList.add('active');
    if (button.dataset.section === 'logs') void loadLogs();
  });
});

// Deep-link a section via hash, e.g. /console#guide from the chat page.
(() => {
  const section = (location.hash || '').replace('#', '');
  if (!section) return;
  const target = document.querySelector('.nav-button[data-section="' + section + '"]');
  if (target) target.click();
})();

document.querySelectorAll('[data-action]').forEach((button) => {
  button.addEventListener('click', () => runAction(button.dataset.action));
});

$('llm-provider')?.addEventListener('change', () => {
  // An explicit provider switch should re-probe the newly selected CLI.
  cliAutoDetected = { codex: false, claude: false };
  updateProviderSections();
});
$('llm-model-select')?.addEventListener('change', onModelSelectChange);

$('strategy-file')?.addEventListener('change', () => {
  const status = $('strategy-status');
  if (status) status.textContent = '';
  renderStrategy(state?.strategy);
});

$('todo-list')?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-todo-action]');
  if (!button) return;
  void handleTodoItemAction(button.dataset.todoAction, button.dataset.todoId);
});

document.querySelectorAll('[data-toggle-secret]').forEach((button) => {
  button.addEventListener('click', () => toggleSecret(button.dataset.toggleSecret));
});

document.querySelectorAll('[id^="secret-"]').forEach((input) => {
  input.addEventListener('input', () => {
    input.dataset.masked = 'false';
  });
});

$('add-feishu-profile').addEventListener('click', () => {
  const profiles = getFeishuProfilesForUi(state.config);
  profiles.push(defaultFeishuProfile(profiles.length + 1));
  state.config.sources.feishu.profiles = profiles;
  renderFeishuProfiles(profiles);
});

$('config-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await saveAll();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    $('output').textContent = 'Save failed: ' + message;
    setSaveStatus('Save failed', 'error', false);
    showToast('Save failed: ' + message, 'error', false);
  }
});

$('skill-repo-update')?.addEventListener('click', () => updateSkillRepo());
$('skill-repo-install')?.addEventListener('click', () => installSkillRepoUi());
$('refresh-logs').addEventListener('click', () => loadLogs());
$('clear-logs').addEventListener('click', () => clearLogs());

loadState().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  showToast('Failed to load local state: ' + message, 'error', false);
});

async function loadState() {
  const response = await apiFetch('/api/state');
  const data = await response.json();
  if (!data.ok) throw new Error(data.error || 'Failed to load state');
  state = data;
  render();
}

// Suggestions only, never the allowed set. Model ids move faster than this file
// does — 'gpt-6-astra' started rolling out mid-2026 and was in no list shipped
// before it — so anything configured that is missing here is preserved as a
// selectable option rather than replaced, and "Custom…" always allows an id we
// have never heard of. See updateModelSuggestions().
const MODEL_SUGGESTIONS = {
  codex: [
    ['default', "follow the Codex CLI's own default"],
    ['gpt-6-astra', 'most capable, for complex work'],
    ['gpt-5.6-terra', 'balanced, everyday work'],
    ['gpt-5.6-sol', 'reliable everyday workhorse'],
    ['gpt-5.6-luna', 'fast and affordable'],
    ['gpt-5.5', 'proven previous generation'],
    ['gpt-5.4-mini', 'small, fast, cost-efficient'],
  ],
  openai: [
    ['default', 'gpt-4o-mini'],
    ['gpt-4.1-mini', ''], ['gpt-4.1', ''], ['gpt-4o-mini', ''], ['gpt-4o', ''], ['o3-mini', ''], ['o3', ''],
  ],
  claude: [
    ['default', 'claude-sonnet-5'],
    ['claude-haiku-4-5', 'fastest, cheapest'], ['claude-sonnet-5', 'balanced'], ['claude-opus-5', 'most capable'],
    // No row in DEFAULT_PRICE_TABLE resolves this one, so the budget meter
    // would score it as $0 until billing.price_overrides names a price.
    ['claude-fable-5-1', 'needs billing.price_overrides'],
  ],
  anthropic: [
    ['default', 'claude-sonnet-5'],
    ['claude-haiku-4-5', 'fastest, cheapest'], ['claude-sonnet-5', 'balanced'], ['claude-opus-5', 'most capable'],
    // No row in DEFAULT_PRICE_TABLE resolves this one, so the budget meter
    // would score it as $0 until billing.price_overrides names a price.
    ['claude-fable-5-1', 'needs billing.price_overrides'],
  ],
};

const MODEL_CUSTOM = '__custom__';

// #llm-model stays the single source of truth that collect() reads. The select
// mirrors into it, and is the only visible control unless "Custom…" is picked.
function updateModelSuggestions() {
  const select = $('llm-model-select');
  const custom = $('llm-model');
  if (!select || !custom) return;
  const current = custom.value;
  const options = (MODEL_SUGGESTIONS[value('llm-provider')] || [['default', '']]).slice();
  // An id we do not ship (a model newer than this build, or one from another
  // deployment) must stay selectable, or opening this page would silently
  // rewrite it on the next save.
  if (current && !options.some((entry) => entry[0] === current)) {
    options.unshift([current, 'current setting']);
  }
  options.push([MODEL_CUSTOM, 'enter a model id manually']);
  select.innerHTML = options
    .map((entry) => {
      const label = entry[1] ? entry[0] + ' — ' + entry[1] : entry[0];
      return '<option value="' + escapeAttr(entry[0]) + '">' + escapeHtml(entry[0] === MODEL_CUSTOM ? 'Custom…' : label) + '</option>';
    })
    .join('');
  const isCustom = !options.some((entry) => entry[0] === current && entry[0] !== MODEL_CUSTOM);
  select.value = isCustom ? MODEL_CUSTOM : current;
  custom.hidden = !isCustom;
}

function onModelSelectChange() {
  const select = $('llm-model-select');
  const custom = $('llm-model');
  if (!select || !custom) return;
  if (select.value === MODEL_CUSTOM) {
    custom.hidden = false;
    custom.focus();
    return;
  }
  custom.hidden = true;
  custom.value = select.value;
}

var cliAutoDetected = { codex: false, claude: false };

function updateProviderSections() {
  const provider = value('llm-provider');
  const codex = $('codex-fieldset');
  const claude = $('claude-fieldset');
  if (codex) codex.hidden = provider !== 'codex';
  if (claude) claude.hidden = provider !== 'claude';
  updateModelSuggestions();
  // #200: auto-detect is the primary path. When a CLI fieldset becomes visible,
  // probe for the binary once and show the result as status; only fall back to the
  // (collapsed) manual input when detection fails.
  if ((provider === 'codex' || provider === 'claude') && !cliAutoDetected[provider]) {
    cliAutoDetected[provider] = true;
    void autoDetectCli(provider);
  }
}

async function autoDetectCli(kind) {
  const detect = $(kind + '-detect');
  const manual = $(kind + '-manual');
  if (detect) detect.textContent = '正在探测 CLI 路径…';
  try {
    const action = kind === 'codex' ? 'discover_codex_binary' : 'discover_claude_binary';
    const result = await post('/api/action', { action });
    const text = (result.text || '').trim();
    if (result.state) { state = result.state; }
    if (detect) detect.textContent = text || '探测完成。';
    // Open the manual entry only when detection did not resolve a usable path.
    const found = text.indexOf('/') !== -1 && !/not found|未找到|not runnable/i.test(text);
    if (manual) manual.open = !found;
  } catch (error) {
    if (detect) detect.textContent = '探测失败：' + (error && error.message ? error.message : String(error));
    if (manual) manual.open = true;
  }
}

function render() {
  const config = state.config;
  $('paths').textContent = state.configPath + '  |  ' + state.envPath;

  checked('rhythm-enabled', config.user.rhythm?.enabled);
  set('rhythm-work-cap', config.user.rhythm?.work_task_cap_on_rest_days ?? 1);
  const restDays = (config.user.rhythm?.rest_days || []).map((day) => String(day).trim().toUpperCase().slice(0, 3));
  document.querySelectorAll('[data-rhythm-day]').forEach((input) => {
    input.checked = restDays.includes(input.dataset.rhythmDay);
  });
  set('user-display-name', config.user.display_name);
  set('user-timezone', config.user.timezone);
  set('assistant-language', config.assistant.language);
  set('llm-provider', config.llm.provider);
  set('llm-model', config.llm.model);
  const todoInbox = state.todoInbox || {};
  const openTodos = Array.isArray(todoInbox.open) ? todoInbox.open : [];
  const todoInboxStatus = $('todo-inbox-status');
  if (todoInboxStatus) {
    todoInboxStatus.textContent = todoInbox.enabled
      ? 'Open Todo Inbox items: ' + openTodos.length
      : 'Todo Inbox disabled.';
  }
  renderTodoInbox(openTodos);
  renderDecisionPolicy(state.decisionPolicy);
  renderRhythm(state.rhythm);
  renderStrategy(state.strategy);
  renderOkr(state.okr);
  renderSkillRepo(state.skillRepo);
  set('team-supabase-url', (config.team && config.team.supabase_url) || '');
  set('team-supabase-anon-key', (config.team && config.team.supabase_anon_key) || '');
  renderTeam(state.team);
  set('env-CODEX_BIN', state.env.CODEX_BIN || 'codex');
  set('env-CODEX_HOME', state.env.CODEX_HOME || '');
  set('env-CLAUDE_BIN', state.env.CLAUDE_BIN || 'claude');
  updateProviderSections();
  set('env-LARK_APP_ID', state.env.LARK_APP_ID);
  set('env-FEISHU_CHAT_ID', state.env.FEISHU_CHAT_ID);
  set('env-DAILY_OS_DECISION_CHAT_ID', state.env.DAILY_OS_DECISION_CHAT_ID);
  set('env-FEISHU_OWNER_OPEN_ID', state.env.FEISHU_OWNER_OPEN_ID);
  set('output-provider', config.output.feishu.provider || 'auto');
  set('output-send-mode', config.output.feishu.send_mode);
  checked('output-feishu-enabled', config.output.feishu.enabled);
  checked('feedback-feishu-enabled', config.feedback.feishu.enabled);
  set('feedback-prefix', config.feedback.feishu.command_prefix);
  set('feedback-poll-limit', config.feedback.feishu.poll_limit);
  set('decision-chat-name', config.decision.onboarding.chat_name);
  checked('decision-auto-create', config.decision.onboarding.auto_create_on_setup);

  checked('vault-enabled', config.sources.vault.enabled);
  set('vault-provider', config.sources.vault.provider);
  set('vault-local-path', config.sources.vault.local_path);
  set('env-VAULT_GATE_URL', state.env.VAULT_GATE_URL);
  set('memory-repository-path', config.memory.repository_path || '');
  set('memory-long-term-path', config.memory.long_term_path);
  set('memory-daily-dir', config.memory.daily_dir);

  checked('source-feishu-enabled', config.sources.feishu.enabled);
  checked('interaction-feishu-enabled', config.interaction.feishu.enabled);
  checked('interaction-feishu-require-mention', config.interaction.feishu.require_mention_in_groups);
  set('interaction-feishu-prefix', config.interaction.feishu.command_prefix);
  set('interaction-feishu-reply-mode', config.interaction.feishu.reply_mode);
  set('interaction-feishu-debounce', config.interaction.feishu.debounce_ms);
  set('interaction-feishu-access-level', config.interaction.feishu.security.access_level);
  set('interaction-feishu-admins', (config.interaction.feishu.security.admin_open_ids || []).join('\n'));
  set('interaction-feishu-users', (config.interaction.feishu.security.allowed_user_open_ids || []).join('\n'));
  set('interaction-feishu-chats', (config.interaction.feishu.security.allowed_chat_ids || []).join('\n'));
  set('interaction-feishu-workspaces', (config.interaction.feishu.security.allowed_workspaces || []).join('\n'));
  config.sources.feishu.profiles = getFeishuProfilesForUi(config);
  renderFeishuProfiles(config.sources.feishu.profiles);
  checked('source-github', config.sources.github.enabled);
  set('github-repositories', (config.sources.github.repositories || []).join('\n'));
  set('github-per-repo-limit', config.sources.github.per_repo_limit || 20);
  checked('source-linear', config.sources.linear.enabled);
  set('linear-assignee', config.sources.linear.assignee ?? 'me');
  checked('linear-active-cycle', Boolean(config.sources.linear.active_cycle_only));
  set('linear-query', config.sources.linear.query || '');
  set('linear-projects-allowlist', (config.sources.linear.projects_allowlist || []).join('\n'));
  set('linear-projects-blocklist', (config.sources.linear.projects_blocklist || []).join('\n'));
  set('linear-teams-allowlist', (config.sources.linear.teams_allowlist || []).join('\n'));
  set('linear-teams-blocklist', (config.sources.linear.teams_blocklist || []).join('\n'));
  checked('source-chrome', config.sources.chrome_snapshot.enabled);
  checked('source-apple-calendar', config.sources.apple_calendar_snapshot.enabled);
  checked('local-files-enabled', config.sources.local_files.enabled);
  set('local-files', config.sources.local_files.files.map((file) => file.name + ' | ' + file.path).join('\n'));

  checked('workflow-plan-enabled', config.workflows.daily_plan.enabled);
  set('workflow-plan-time', config.workflows.daily_plan.time);
  checked('workflow-review-enabled', config.workflows.daily_review.enabled);
  set('workflow-review-time', config.workflows.daily_review.time);
  checked('workflow-review-skip-weekly-day', config.workflows.daily_review.skip_on_weekly_review_day);
  checked('workflow-weekly-enabled', config.workflows.weekly_review.enabled);
  set('workflow-weekly-weekday', config.workflows.weekly_review.weekday);
  set('workflow-weekly-time', config.workflows.weekly_review.time);
  checked('calendar-enabled', config.calendar.enabled);
  set('calendar-engine-mode', config.calendar.engine.mode);
  set('calendar-command', config.calendar.engine.command);
  set('calendar-workdir', config.calendar.engine.workdir);
  set('calendar-cli-path', config.calendar.engine.cli_path);
  set('calendar-policy-file', config.calendar.engine.policy_file);
  set('calendar-routines-file', config.calendar.engine.routines_file);
  set('calendar-week-days', config.calendar.draft.week_days);
  set('calendar-max-tasks', config.calendar.draft.max_tasks);
  checked('service-prevent-sleep', config.service?.prevent_sleep?.enabled);
  checked('background-suggestions-enabled', config.background_suggestions?.enabled);
  set('background-suggestions-mode', config.background_suggestions?.mode || 'review');
  set('background-suggestions-interval', config.background_suggestions?.interval_minutes || 120);
  set('background-suggestions-confidence', config.background_suggestions?.min_confidence || 'medium');
  checked('background-suggestions-send', config.background_suggestions?.send_to_feishu);
  checked('background-suggestions-change-only', config.background_suggestions?.send_on_change_only);

  for (const key of ['OPENAI_API_KEY', 'LARK_APP_SECRET', 'GITHUB_TOKEN', 'LINEAR_API_KEY', 'VAULT_GATE_TOKEN']) renderSecret(key);

  renderChecks(state.doctor);
  renderServiceStatus(state.service);
  renderBackgroundSuggestionsStatus(state.backgroundSuggestions, config.background_suggestions);
  $('output').textContent = state.doctorText || '';
}

function renderServiceStatus(service) {
  const installButton = $('service-install-button');
  const uninstallButton = $('service-uninstall-button');
  const status = $('service-status');
  if (!installButton || !uninstallButton || !status) return;

  const registered = Boolean(service?.registered);
  installButton.disabled = registered;
  installButton.textContent = registered ? 'Registered' : 'Install';
  uninstallButton.disabled = !registered && !service?.installed;
  status.className = 'service-status ' + (registered ? 'registered' : '');
  status.textContent = registered
    ? 'Registered with macOS launchd. UI, scheduler, and Feishu realtime connection can run in the background.'
    : service?.installed
      ? 'Plist exists, but launchd is not registered. Click Install to register the full background service again.'
      : 'Not registered. Click Install to create and register the full macOS background service.';
}

function renderBackgroundSuggestionsStatus(background, config) {
  const status = $('background-suggestions-status');
  if (!status) return;
  const enabled = Boolean(config?.enabled);
  const stateText = background?.last_status || (enabled ? 'waiting' : 'disabled');
  const parts = [
    enabled ? 'Enabled' : 'Disabled',
    'status: ' + stateText,
    background?.last_run_at ? 'last run: ' + formatClientTime(background.last_run_at) : 'last run: never',
    background?.next_run_at ? 'next run: ' + formatClientTime(background.next_run_at) : '',
    typeof background?.last_suggestion_count === 'number' ? 'suggestions: ' + background.last_suggestion_count : '',
    typeof background?.last_inspected_messages === 'number' ? 'messages: ' + background.last_inspected_messages : '',
    background?.last_sent_at ? 'last sent: ' + formatClientTime(background.last_sent_at) : '',
    background?.last_error ? 'error: ' + background.last_error : '',
  ].filter(Boolean);
  status.className = 'service-status ' + (background?.last_status === 'error' ? 'error' : enabled ? 'registered' : '');
  status.textContent = parts.join(' | ');
}

function renderChecks(checks) {
  const required = checks.filter((check) => check.level !== 'warning');
  const requiredOk = required.filter((check) => check.ok).length;
  const warnings = checks.filter((check) => check.level === 'warning').length;
  $('summary-status').textContent = warnings > 0
    ? 'Checks ' + requiredOk + '/' + required.length + ' OK, ' + warnings + ' warning'
    : 'Checks ' + requiredOk + '/' + required.length + ' OK';
  $('summary-status').className = 'status ' + (requiredOk === required.length ? (warnings > 0 ? 'warn' : 'ok') : 'warn');
  $('checks').innerHTML = checks.map((check) => {
    const detail = check.detail ? '<span>' + escapeHtml(check.detail) + '</span>' : '';
    const level = check.level || (check.ok ? 'ok' : 'missing');
    const label = level === 'warning' ? 'WARNING' : (check.ok ? 'OK' : 'MISSING');
    return '<div class="check ' + level + '"><div><strong>' +
      label + '</strong><br><span>' + escapeHtml(check.name) + '</span></div>' + detail + '</div>';
  }).join('');
}

function renderTodoInbox(openTodos) {
  const list = $('todo-list');
  const summary = $('todo-list-summary');
  if (!list || !summary) return;

  summary.textContent = openTodos.length
    ? openTodos.length + ' open item' + (openTodos.length === 1 ? '' : 's')
    : 'All reminders completed';

  if (!openTodos.length) {
    list.innerHTML = '<div class="todo-empty">All Reminders Completed</div>';
    return;
  }

  list.innerHTML = openTodos.map((item) => {
    const note = item.note ? '<div class="todo-item-meta">' + escapeHtml(item.note) + '</div>' : '';
    const due = item.due_hint ? ' · ' + escapeHtml(item.due_hint) : '';
    return '<article class="todo-item">' +
      '<div class="todo-item-main">' +
        '<div><div class="todo-item-title">' + escapeHtml(item.text || 'Untitled') + '</div>' +
        '<div class="todo-item-meta">' + escapeHtml(typeLabel(item.type)) + due + ' · ' + escapeHtml(formatClientTime(item.created_at)) + '</div>' + note + '</div>' +
        '<span class="todo-chip">' + escapeHtml(typeLabel(item.type)) + '</span>' +
      '</div>' +
      '<div class="todo-item-actions">' +
        '<button type="button" class="secondary compact" data-todo-action="edit" data-todo-id="' + escapeHtml(item.id) + '">Edit</button>' +
        '<button type="button" class="secondary compact" data-todo-action="done" data-todo-id="' + escapeHtml(item.id) + '">Done</button>' +
        '<button type="button" class="secondary compact" data-todo-action="defer" data-todo-id="' + escapeHtml(item.id) + '">Defer</button>' +
        '<button type="button" class="secondary compact" data-todo-action="delete" data-todo-id="' + escapeHtml(item.id) + '">Delete</button>' +
      '</div>' +
    '</article>';
  }).join('');
}

function renderOkr(okr) {
  if (!okr || !okr.files) return;
  okr.files.forEach((file) => {
    set('okr-md-' + file.level, file.markdown || '');
    const pathEl = $('okr-path-' + file.level);
    if (pathEl) pathEl.textContent = file.path || '';
  });
  const dirEl = $('okr-dir');
  if (dirEl) dirEl.textContent = okr.dir ? 'OKR dir: ' + okr.dir : '';
}

async function saveOkrFromPage(level) {
  const markdown = value('okr-md-' + level);
  const status = $('okr-status-' + level);
  if (status) status.textContent = 'Saving...';
  const result = await post('/api/okr', { level: level, markdown: markdown });
  if (result.state) state = result.state;
  render();
  if (status) status.textContent = result.text || 'Saved';
  showToast('OKR saved', 'success');
}

async function formatOkrFromPage(level) {
  const markdown = value('okr-md-' + level);
  const status = $('okr-status-' + level);
  if (status) status.textContent = 'Formatting...';
  const result = await post('/api/okr/format', { level: level, markdown: markdown });
  if (result.formatted != null) set('okr-md-' + level, result.formatted);
  if (status) status.textContent = '已整理为标准格式，请检查后点 Save 保存。';
  showToast('OKR formatted', 'success');
}

function strategyFileById(id) {
  var files = (state && state.strategy && state.strategy.files) || [];
  for (var i = 0; i < files.length; i += 1) if (files[i].id === id) return files[i];
  return null;
}

function renderStrategy(strategy) {
  if (!strategy) return;
  var select = $('strategy-file');
  if (!select) return;
  var files = strategy.files || [];
  // Keep the current pick across re-renders, or an edit + save would silently
  // bounce the editor back to the first file.
  var selected = select.value && strategyFileById(select.value) ? select.value : (files[0] || {}).id;
  if (select.options.length !== files.length) {
    select.innerHTML = '';
    for (var i = 0; i < files.length; i += 1) {
      var option = document.createElement('option');
      option.value = files[i].id;
      option.textContent = files[i].label;
      select.appendChild(option);
    }
  }
  select.value = selected || '';
  var file = strategyFileById(select.value);
  set('strategy-md', file ? file.markdown || '' : '');
  var hint = $('strategy-hint');
  if (hint) hint.textContent = file ? file.hint || '' : '';
  var pathHint = $('strategy-path');
  if (pathHint) pathHint.textContent = file ? file.path + (file.exists ? '' : '（文件不存在，保存后创建）') : '';
  var fallback = $('strategy-default');
  if (fallback) fallback.textContent = strategy.defaultStrategy || '';
}

async function saveStrategyFromPage() {
  var select = $('strategy-file');
  var id = select ? select.value : '';
  var status = $('strategy-status');
  if (!id) {
    if (status) status.textContent = 'No strategy file selected.';
    return;
  }
  if (status) status.textContent = 'Saving...';
  var result = await post('/api/strategy', { id: id, markdown: value('strategy-md') });
  if (result.state) state = result.state;
  render();
  if (status) status.textContent = result.text || 'Saved.';
  showToast('Review strategy saved', 'success');
}

function renderRhythm(rhythm) {
  if (!rhythm) return;
  set('rhythm-md', rhythm.notesMd || '');
  const notesPath = $('rhythm-notes-path');
  if (notesPath) notesPath.textContent = rhythm.notesPath || '';
  const repository = $('rhythm-repository');
  if (repository) repository.textContent = rhythm.repositoryPath ? 'Memory repository: ' + rhythm.repositoryPath : '';

  const today = rhythm.today || {};
  const box = $('rhythm-today');
  if (box) {
    if (!today.enabled) {
      box.innerHTML = '<span class="rhythm-off">作息规则已关闭——今天和每一天都按工作日排。</span>';
    } else {
      // Lead with the verdict, then the consequence. A user who reads only the
      // first line should already know whether today is protected.
      const cls = today.isRestDay ? 'rhythm-rest' : 'rhythm-work';
      const head = escapeHtml((today.date || '') + ' ' + (today.weekdayLabel || '') + ' · ' + (today.dayTypeLabel || ''));
      const detail = today.isRestDay
        ? (today.workTaskCap === 0
            ? '今天不排工作任务。'
            : '工作任务最多 ' + today.workTaskCap + ' 条，且只留给已经逾期或今天必须交付的项。')
        : '按工作日排，条数由 Decision Policy 和默认规则决定。';
      box.innerHTML = '<span class="' + cls + '">' + head + '</span><br><span class="rhythm-off">' + escapeHtml(detail) + '</span>';
    }
  }

  const tomorrow = rhythm.tomorrow || {};
  const tomorrowLine = $('rhythm-tomorrow');
  if (tomorrowLine) {
    tomorrowLine.textContent = tomorrow.enabled
      ? '明天 ' + (tomorrow.date || '') + ' ' + (tomorrow.weekdayLabel || '') + ' · ' + (tomorrow.dayTypeLabel || '')
      : '';
  }

  if (rhythm.isTemplate) {
    const status = $('rhythm-status');
    if (status && !status.textContent) status.textContent = 'rhythm.md 还是空模板——写点东西进去，它才会影响计划。';
  }
}

function renderDecisionPolicy(policy) {
  if (!policy) return;
  set('decision-policy-md', policy.policyMd || '');
  const mdPath = $('decision-policy-md-path');
  if (mdPath) mdPath.textContent = policy.notesPath || '';
  const repository = $('decision-policy-repository');
  if (repository) repository.textContent = policy.repositoryPath ? 'Memory repository: ' + policy.repositoryPath : '';
}

function typeLabel(type) {
  if (type === 'time_boundary') return 'Time';
  if (type === 'reminder') return 'Reminder';
  if (type === 'note') return 'Note';
  return 'Todo';
}

function todoById(id) {
  const open = state?.todoInbox?.open || [];
  return open.find((item) => item.id === id);
}

function clearTodoEditor() {
  set('todo-page-edit-id', '');
  set('todo-page-text', '');
  set('todo-page-note', '');
  set('todo-page-type', 'todo');
  const saveButton = document.querySelector('[data-action="todo_page_save"]');
  if (saveButton) saveButton.textContent = 'Add Todo';
  const status = $('todo-page-status');
  if (status) status.textContent = '';
}

async function saveTodoFromPage() {
  const text = value('todo-page-text').trim();
  const id = value('todo-page-edit-id').trim();
  if (!text) {
    $('todo-page-status').textContent = 'Task is empty.';
    return;
  }

  const payload = id
    ? { id, text, type: value('todo-page-type'), note: value('todo-page-note') }
    : { text, type: value('todo-page-type') };
  const result = await post(id ? '/api/todo-inbox' : '/api/capture', payload);
  if (result.state) state = result.state;
  await loadState();
  clearTodoEditor();
  $('todo-page-status').textContent = id ? 'Todo updated.' : 'Todo added.';
  showToast(id ? 'Todo updated' : 'Todo added', 'success');
}

async function saveDecisionPolicyFromPage() {
  const markdown = value('decision-policy-md');
  const status = $('decision-policy-status');
  if (status) status.textContent = 'Saving...';
  const result = await post('/api/decision-policy', { policyMd: markdown });
  if (result.state) state = result.state;
  render();
  if (status) status.textContent = result.text || 'Saved decision-policy.md';
  showToast('Decision policy markdown saved', 'success');
}

async function handleTodoItemAction(action, id) {
  if (!action || !id) return;
  const item = todoById(id);
  if (!item) return;

  if (action === 'edit') {
    set('todo-page-edit-id', item.id);
    set('todo-page-text', item.text || '');
    set('todo-page-note', item.note || '');
    set('todo-page-type', item.type || 'todo');
    const saveButton = document.querySelector('[data-action="todo_page_save"]');
    if (saveButton) saveButton.textContent = 'Save Changes';
    $('todo-page-status').textContent = 'Editing: ' + item.text;
    return;
  }

  const status = action === 'done' ? 'done' : action === 'delete' ? 'deleted' : 'deferred';
  const result = await post('/api/todo-inbox', { id, status });
  if (result.state) state = result.state;
  await loadState();
  showToast(result.text || 'Todo updated', 'success');
}

async function saveAll() {
  setSaveStatus('Saving...', 'info', false);
  const next = structuredClone(state.config);
  next.user.display_name = value('user-display-name');
  next.user.timezone = value('user-timezone');
  if (!next.user.rhythm) next.user.rhythm = { enabled: true, file: 'rhythm.md', rest_days: [], work_task_cap_on_rest_days: 1 };
  next.user.rhythm.enabled = isChecked('rhythm-enabled');
  next.user.rhythm.rest_days = Array.from(document.querySelectorAll('[data-rhythm-day]'))
    .filter((input) => input.checked)
    .map((input) => input.dataset.rhythmDay);
  next.user.rhythm.work_task_cap_on_rest_days = Math.max(0, Math.min(20, Number(value('rhythm-work-cap') || 0)));
  next.assistant.language = value('assistant-language');
  next.llm.provider = value('llm-provider');
  next.llm.model = value('llm-model');
  next.output.feishu.enabled = isChecked('output-feishu-enabled');
  next.output.feishu.provider = value('output-provider');
  next.output.feishu.send_mode = value('output-send-mode');
  next.feedback.feishu.enabled = isChecked('feedback-feishu-enabled');
  next.feedback.feishu.command_prefix = value('feedback-prefix');
  next.feedback.feishu.poll_limit = Number(value('feedback-poll-limit') || 20);
  next.decision.enabled = true;
  next.decision.onboarding.enabled = true;
  next.decision.onboarding.chat_name = value('decision-chat-name') || 'Daily OS - 决策校准';
  next.decision.onboarding.chat_id_env = 'DAILY_OS_DECISION_CHAT_ID';
  next.decision.onboarding.owner_open_id_env = 'FEISHU_OWNER_OPEN_ID';
  next.decision.onboarding.auto_create_on_setup = isChecked('decision-auto-create');

  next.sources.vault.enabled = isChecked('vault-enabled');
  next.sources.vault.provider = value('vault-provider');
  next.sources.vault.local_path = value('vault-local-path');
  next.interaction.feishu.enabled = isChecked('interaction-feishu-enabled');
  next.interaction.feishu.command_prefix = value('interaction-feishu-prefix') || 'daily-os';
  next.interaction.feishu.reply_mode = value('interaction-feishu-reply-mode');
  next.interaction.feishu.debounce_ms = Number(value('interaction-feishu-debounce') || 600);
  next.interaction.feishu.require_mention_in_groups = isChecked('interaction-feishu-require-mention');
  next.interaction.feishu.security.owner_open_id_env = 'FEISHU_OWNER_OPEN_ID';
  next.interaction.feishu.security.access_level = value('interaction-feishu-access-level');
  next.interaction.feishu.security.admin_open_ids = parseLines(value('interaction-feishu-admins'));
  next.interaction.feishu.security.allowed_user_open_ids = parseLines(value('interaction-feishu-users'));
  next.interaction.feishu.security.allowed_chat_ids = parseLines(value('interaction-feishu-chats'));
  next.interaction.feishu.security.allowed_workspaces = parseLines(value('interaction-feishu-workspaces'));
  next.sources.feishu.enabled = isChecked('source-feishu-enabled');
  next.sources.feishu.profiles = readFeishuProfiles();
  if (next.sources.feishu.profiles.length > 0) {
    const first = next.sources.feishu.profiles[0];
    next.sources.feishu.calendar = first.calendar;
    next.sources.feishu.tasks = first.tasks;
    next.sources.feishu.docs = first.docs;
    next.sources.feishu.im_history = first.im_history;
  }
  next.sources.github.enabled = isChecked('source-github');
  next.sources.github.repositories = parseLines(value('github-repositories'));
  next.sources.github.per_repo_limit = Number(value('github-per-repo-limit') || 20);
  next.sources.linear.enabled = isChecked('source-linear');
  next.sources.linear.assignee = value('linear-assignee').trim();
  next.sources.linear.active_cycle_only = isChecked('linear-active-cycle');
  next.sources.linear.query = value('linear-query') || "assignee = me and state.type != 'completed'";
  next.sources.linear.projects_allowlist = parseLines(value('linear-projects-allowlist'));
  next.sources.linear.projects_blocklist = parseLines(value('linear-projects-blocklist'));
  next.sources.linear.teams_allowlist = parseLines(value('linear-teams-allowlist'));
  next.sources.linear.teams_blocklist = parseLines(value('linear-teams-blocklist'));
  next.sources.chrome_snapshot.enabled = isChecked('source-chrome');
  next.sources.apple_calendar_snapshot.enabled = isChecked('source-apple-calendar');
  next.sources.local_files.enabled = isChecked('local-files-enabled');
  next.sources.local_files.files = parseFiles(value('local-files'));
  next.team = next.team || { supabase_url: '', supabase_anon_key: '' };
  next.team.supabase_url = value('team-supabase-url').trim();
  next.team.supabase_anon_key = value('team-supabase-anon-key').trim();
  next.memory.repository_path = value('memory-repository-path');
  next.memory.long_term_path = value('memory-long-term-path') || './data/memory/long-term.md';
  next.memory.daily_dir = value('memory-daily-dir') || './data/memory/daily';

  next.workflows.daily_plan.enabled = isChecked('workflow-plan-enabled');
  next.workflows.daily_plan.time = value('workflow-plan-time');
  next.workflows.daily_review.enabled = isChecked('workflow-review-enabled');
  next.workflows.daily_review.time = value('workflow-review-time');
  next.workflows.daily_review.skip_on_weekly_review_day = isChecked('workflow-review-skip-weekly-day');
  next.workflows.weekly_review.enabled = isChecked('workflow-weekly-enabled');
  next.workflows.weekly_review.weekday = value('workflow-weekly-weekday');
  next.workflows.weekly_review.time = value('workflow-weekly-time');
  next.calendar = next.calendar || {};
  next.calendar.enabled = isChecked('calendar-enabled');
  next.calendar.engine = next.calendar.engine || {};
  next.calendar.engine.mode = value('calendar-engine-mode') || 'auto';
  next.calendar.engine.command = value('calendar-command') || 'node';
  next.calendar.engine.workdir = value('calendar-workdir') || '../calendar-planning-os';
  next.calendar.engine.cli_path = value('calendar-cli-path') || 'bin/calendar-planning-os.mjs';
  next.calendar.engine.policy_file = value('calendar-policy-file');
  next.calendar.engine.routines_file = value('calendar-routines-file');
  next.calendar.engine.timeout_ms = Number(next.calendar.engine.timeout_ms || 120000);
  next.calendar.engine.input_path = next.calendar.engine.input_path || './data/runtime/calendar-draft-input.json';
  next.calendar.draft = next.calendar.draft || {};
  next.calendar.draft.week_days = Number(value('calendar-week-days') || 5);
  next.calendar.draft.max_tasks = Number(value('calendar-max-tasks') || 8);
  next.service = next.service || {};
  next.service.prevent_sleep = { enabled: isChecked('service-prevent-sleep') };
  next.background_suggestions = next.background_suggestions || {};
  next.background_suggestions.enabled = isChecked('background-suggestions-enabled');
  next.background_suggestions.mode = value('background-suggestions-mode');
  next.background_suggestions.interval_minutes = Number(value('background-suggestions-interval') || 120);
  next.background_suggestions.min_confidence = value('background-suggestions-confidence');
  next.background_suggestions.send_to_feishu = isChecked('background-suggestions-send');
  next.background_suggestions.send_on_change_only = isChecked('background-suggestions-change-only');

  await post('/api/config', { config: next });
  const envValues = {
    CODEX_BIN: value('env-CODEX_BIN'),
    CODEX_HOME: value('env-CODEX_HOME'),
    CLAUDE_BIN: value('env-CLAUDE_BIN'),
    LARK_APP_ID: value('env-LARK_APP_ID'),
    FEISHU_CHAT_ID: value('env-FEISHU_CHAT_ID'),
    DAILY_OS_DECISION_CHAT_ID: value('env-DAILY_OS_DECISION_CHAT_ID'),
    FEISHU_OWNER_OPEN_ID: value('env-FEISHU_OWNER_OPEN_ID'),
    VAULT_GATE_URL: value('env-VAULT_GATE_URL'),
    OPENAI_API_KEY: secretValue('OPENAI_API_KEY'),
    LARK_APP_SECRET: secretValue('LARK_APP_SECRET'),
    GITHUB_TOKEN: secretValue('GITHUB_TOKEN'),
    LINEAR_API_KEY: secretValue('LINEAR_API_KEY'),
    VAULT_GATE_TOKEN: secretValue('VAULT_GATE_TOKEN'),
  };
  const result = await post('/api/env', { values: envValues });
  state = result.state;
  const savedChat = state.env.FEISHU_CHAT_ID || '';
  const decisionChat = state.env.DAILY_OS_DECISION_CHAT_ID || '';
  const message = [
    'Saved local configuration.',
    'Config: ' + state.configPath,
    'Env: ' + state.envPath,
    'Active FEISHU_CHAT_ID: ' + maskClientValue(savedChat),
    '决策校准群 ID：' + maskClientValue(decisionChat),
  ].join('\n');
  render();
  $('output').textContent = message;
  setSaveStatus('Saved', 'success');
  showToast(message, 'success');
}

function renderSecret(key) {
  const input = $('secret-' + key);
  const button = document.querySelector('[data-toggle-secret="' + key + '"]');
  const present = Boolean(state.env[key + '_present']);
  input.type = 'password';
  input.value = present ? '********' : '';
  input.placeholder = present ? '' : 'Not configured';
  input.dataset.masked = present ? 'true' : 'false';
  if (button) button.setAttribute('aria-label', 'Show ' + key);
}

async function toggleSecret(key) {
  const input = $('secret-' + key);
  const button = document.querySelector('[data-toggle-secret="' + key + '"]');
  if (!input) return;

  if (input.dataset.masked === 'true') {
    const result = await apiFetch('/api/env-secret?key=' + encodeURIComponent(key) + '&reveal=1').then((response) => response.json());
    if (!result.ok) throw new Error(result.error || 'Failed to read secret');
    input.type = 'text';
    input.value = result.value || '';
    input.dataset.masked = 'false';
    if (button) button.setAttribute('aria-label', 'Hide ' + key);
  } else {
    input.type = 'password';
    input.value = state.env[key + '_present'] ? '********' : '';
    input.dataset.masked = state.env[key + '_present'] ? 'true' : 'false';
    if (button) button.setAttribute('aria-label', 'Show ' + key);
  }
}

function secretValue(key) {
  const input = $('secret-' + key);
  if (!input || input.dataset.masked === 'true') return '';
  return input.value;
}

// --- Team (LEO-282/283) ----------------------------------------------------
// The panel renders entirely from state.team, which the server builds from the
// The skill lives in a git checkout that ~/.claude/skills/weekly-review points
// at, so updating it is a pull. The button is disabled whenever the repo cannot
// be fast-forwarded, and says why, rather than failing after the click.
function renderSkillRepo(repo) {
  var status = $('skill-repo-status');
  var blocked = $('skill-repo-blocked');
  var button = $('skill-repo-update');
  if (!status || !button) return;
  repo = repo || {};
  if (!repo.isGitRepo) {
    status.textContent = repo.workdir || '(未配置 weekly-review skill)';
    button.disabled = true;
  } else {
    var parts = [repo.branch + ' @ ' + repo.commit, repo.subject];
    if (repo.behind > 0) parts.push('落后远端 ' + repo.behind + ' 个提交');
    else if (repo.behind === 0) parts.push('与上次 fetch 时的远端一致');
    // Which CLI actually loads this checkout. Without it, Update can report
    // success while the CLI keeps loading an unrelated copy of the skill.
    var linked = (repo.installs || []).filter(function (link) { return link.linked; });
    parts.push(linked.length
      ? linked.map(function (link) { return link.cli; }).join(' / ') + ' CLI 已链接'
      : '没有 CLI 链接到这个目录');
    status.textContent = parts.filter(Boolean).join('  ·  ');
    button.disabled = Boolean(repo.blocked);
  }
  if (blocked) {
    blocked.hidden = !repo.blocked;
    blocked.textContent = repo.blocked || '';
  }
  // LEO-287: offer install (git clone) when the skill is not present yet.
  var installRow = $('skill-repo-install-row');
  if (installRow) installRow.hidden = repo.available === true;
}

async function updateSkillRepo() {
  var button = $('skill-repo-update');
  var result = $('skill-repo-result');
  var commits = $('skill-repo-commits');
  if (!button) return;
  button.disabled = true;
  if (result) result.textContent = '正在 fetch + pull…';
  if (commits) commits.hidden = true;
  try {
    const response = await fetch('/api/skills/update', { method: 'POST' });
    const data = await response.json();
    if (result) result.textContent = data.ok ? data.message : (data.error || data.message || '更新失败');
    if (commits && data.commits && data.commits.length) {
      commits.textContent = data.commits.join('\n');
      commits.hidden = false;
    }
    // The button's own enabled state comes from the refreshed repo state, so a
    // repo that just became dirty or diverged stays disabled with a reason.
    if (data.state) renderSkillRepo(data.state);
    else button.disabled = false;
  } catch (error) {
    if (result) result.textContent = '更新失败：' + error;
    button.disabled = false;
  }
}

// LEO-287: install (git clone) the weekly-review skill. The registry changes, so
// on success reload the page to re-render config + status from fresh state.
async function installSkillRepoUi() {
  var button = $('skill-repo-install');
  var result = $('skill-repo-result');
  var dirInput = $('skill-repo-install-dir');
  if (!button) return;
  button.disabled = true;
  if (result) result.textContent = '正在 git clone…（首次安装可能要十几秒）';
  try {
    const response = await fetch('/api/skills/install', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dir: dirInput ? dirInput.value.trim() : '' }),
    });
    const data = await response.json();
    if (result) result.textContent = data.ok ? data.message : (data.error || data.message || '安装失败');
    if (data.ok) {
      setTimeout(function () { location.reload(); }, 1200);
    } else {
      button.disabled = false;
    }
  } catch (error) {
    if (result) result.textContent = '安装失败：' + error;
    button.disabled = false;
  }
}

// local session file. Nothing here runs on page load, so an unreachable
// Supabase can only ever make a button fail, never the console.
function renderTeam(team) {
  const info = team || {};
  const configured = Boolean(info.configured);
  const signedIn = Boolean(info.signedIn);
  const joined = Boolean(info.teamId);

  const authBlock = $('team-auth-block');
  const joinBlock = $('team-join-block');
  const infoBlock = $('team-info-block');
  if (authBlock) authBlock.hidden = !configured || signedIn;
  if (joinBlock) joinBlock.hidden = !configured || !signedIn || joined;
  if (infoBlock) infoBlock.hidden = !configured || !signedIn || !joined;

  const status = $('team-status');
  if (status && !status.dataset.sticky) {
    status.textContent = !configured
      ? '尚未配置 Supabase。团队功能关闭，本地功能全部照常。'
      : !signedIn
        ? '已配置 Supabase，尚未登录。'
        : !joined
          ? '已登录，尚未加入团队。'
          : '已加入团队' + (info.updatedAt ? '（团队信息读取于 ' + info.updatedAt + '）' : '') + '。';
  }

  const who = (info.displayName || info.memberId || '') + (info.email ? ' <' + info.email + '>' : '');
  const identity = $('team-identity');
  if (identity) identity.textContent = who;
  const identityJoined = $('team-identity-joined');
  if (identityJoined) identityJoined.textContent = who;
  const name = $('team-name');
  if (name) name.textContent = info.teamName || '(未命名)';
  set('team-invite-code', info.inviteCode || '');

  const list = $('team-members');
  if (list) {
    const members = Array.isArray(info.members) ? info.members : [];
    list.innerHTML = members.length
      ? members
          .map((member) => {
            const label = escapeHtml(member.displayName || member.memberId || '');
            const short = escapeHtml(member.memberId || '');
            const self = member.userId && member.userId === info.userId ? '（你）' : '';
            return '<li>' + label + ' · ' + short + self + '</li>';
          })
          .join('')
      : '<li>还没有读到成员列表，点「刷新团队信息」。</li>';
  }
}

const TEAM_ENDPOINTS = {
  team_signin: 'signin',
  team_signup: 'signup',
  team_signout: 'signout',
  team_create: 'create',
  team_join: 'join',
  team_leave: 'leave',
  team_rotate_code: 'rotate-code',
  team_refresh: 'refresh',
};

function teamRequestBody(action) {
  if (action === 'team_signin') return { email: value('team-email'), password: value('team-password') };
  if (action === 'team_signup') {
    return { email: value('team-email'), password: value('team-password'), displayName: value('team-display-name') };
  }
  if (action === 'team_create') return { name: value('team-new-name') };
  if (action === 'team_join') return { code: value('team-invite-input') };
  return {};
}

async function handleTeamAction(action) {
  const status = $('team-status');
  if (action === 'team_copy_code') {
    const code = value('team-invite-code');
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      showToast('邀请码已复制', 'success');
    } catch (error) {
      const input = $('team-invite-code');
      if (input) input.select();
      showToast('自动复制失败，请手动复制选中的邀请码', 'error', false);
    }
    return;
  }
  if (action === 'team_leave' && !window.confirm('退出团队后就看不到队友的周期了（已同步的内容仍留在原团队）。确定退出？')) return;
  if (action === 'team_rotate_code' && !window.confirm('重新生成后旧邀请码立即失效。确定？')) return;

  const endpoint = TEAM_ENDPOINTS[action];
  if (!endpoint) return;
  if (status) {
    status.dataset.sticky = '1';
    status.textContent = '处理中…';
  }
  // Not post(): a failed team action still returns fresh state (a rejected
  // refresh token clears the session), and the panel must re-render from it
  // instead of throwing the state away.
  let data;
  try {
    const response = await apiFetch('/api/team/' + endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(teamRequestBody(action)),
    });
    data = await response.json();
  } catch (error) {
    data = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (data && data.state) {
    state = data.state;
    render();
  }
  const message = data && data.ok ? data.text || '完成' : (data && data.error) || '操作失败';
  if (status) {
    delete status.dataset.sticky;
    status.textContent = message;
  }
  showToast(message, data && data.ok ? 'success' : 'error', Boolean(data && data.ok));
  if (data && data.ok) {
    set('team-password', '');
    if (action === 'team_join') set('team-invite-input', '');
    if (action === 'team_create') set('team-new-name', '');
  }
}

async function runAction(action) {
  if (action.indexOf('team_') === 0) {
    await handleTeamAction(action);
    return;
  }
  if (action === 'strategy_reload') {
    await loadState();
    showToast('Review strategy reloaded', 'success');
    return;
  }
  if (action === 'strategy_save') {
    try {
      await saveStrategyFromPage();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = $('strategy-status');
      if (status) status.textContent = message;
      showToast('Review strategy save failed: ' + message, 'error', false);
    }
    return;
  }
  if (action === 'rhythm_reload') {
    await loadState();
    showToast('Rhythm reloaded', 'success');
    return;
  }
  if (action === 'rhythm_save') {
    const status = $('rhythm-status');
    try {
      if (status) status.textContent = 'Saving...';
      const result = await post('/api/rhythm', { notesMd: value('rhythm-md') });
      if (result.state) state = result.state;
      render();
      if (status) status.textContent = result.text || 'Saved rhythm.md';
      showToast('Rhythm saved', 'success');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (status) status.textContent = message;
      showToast('Rhythm save failed: ' + message, 'error', false);
    }
    return;
  }
  if (action === 'decision_policy_reload') {
    await loadState();
    showToast('Decision policy reloaded', 'success');
    return;
  }
  if (action === 'decision_policy_save') {
    try {
      await saveDecisionPolicyFromPage();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = $('decision-policy-status');
      if (status) status.textContent = message;
      showToast('Decision policy save failed: ' + message, 'error', false);
    }
    return;
  }
  if (action === 'okr_reload') {
    await loadState();
    showToast('OKR reloaded', 'success');
    return;
  }
  if (action === 'okr_save_north-star' || action === 'okr_save_annual' || action === 'okr_save_current') {
    const level = action.slice('okr_save_'.length);
    try {
      await saveOkrFromPage(level);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = $('okr-status-' + level);
      if (status) status.textContent = message;
      showToast('OKR save failed: ' + message, 'error', false);
    }
    return;
  }
  if (action === 'okr_format_north-star' || action === 'okr_format_annual' || action === 'okr_format_current') {
    const level = action.slice('okr_format_'.length);
    try {
      await formatOkrFromPage(level);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = $('okr-status-' + level);
      if (status) status.textContent = message;
      showToast('OKR format failed: ' + message, 'error', false);
    }
    return;
  }
  if (action === 'todo_refresh') {
    await loadState();
    showToast('Todo Inbox refreshed', 'success');
    return;
  }
  if (action === 'todo_page_clear') {
    clearTodoEditor();
    return;
  }
  if (action === 'todo_page_save') {
    try {
      await saveTodoFromPage();
    } catch (error) {
      $('todo-page-status').textContent = error.message;
      showToast(error.message, 'error', false);
    }
    return;
  }

  const buttons = [...document.querySelectorAll('button')];
  buttons.forEach((button) => button.disabled = true);
  $('output').textContent = 'Running ' + action + '...';
  try {
    const payload = { action, send: isChecked('send-output') };
    const result = await post('/api/action', payload);
    if (action === 'choose_vault_folder' && result.path) {
      set('vault-local-path', result.path);
      $('output').textContent = result.text || 'Vault folder selected.';
      setSaveStatus('Folder selected');
      return;
    }
    if (action === 'choose_memory_repository' && result.path) {
      set('memory-repository-path', result.path);
      $('output').textContent = result.text || 'Memory repository folder selected.';
      setSaveStatus('Folder selected');
      return;
    }
    if (action === 'choose_calendar_workdir' && result.path) {
      set('calendar-workdir', result.path);
      $('output').textContent = result.text || 'Calendar engine folder selected.';
      setSourceStatus(action, result.text || 'Calendar engine folder selected.');
      setSaveStatus('Folder selected');
      return;
    }
    if (action === 'choose_codex_binary' && result.path) {
      set('env-CODEX_BIN', result.path);
      if (result.state) state = result.state;
      await loadState();
      $('output').textContent = result.text || 'Codex CLI selected.';
      setSourceStatus(action, result.text || 'Codex CLI selected.');
      setSaveStatus('Codex saved');
      return;
    }
    if (action === 'choose_codex_home' && result.path) {
      set('env-CODEX_HOME', result.path);
      if (result.state) state = result.state;
      await loadState();
      $('output').textContent = result.text || 'Codex home selected.';
      setSourceStatus(action, result.text || 'Codex home selected.');
      setSaveStatus('Codex saved');
      return;
    }
    if (action === 'choose_claude_binary' && result.path) {
      set('env-CLAUDE_BIN', result.path);
      if (result.state) state = result.state;
      await loadState();
      $('output').textContent = result.text || 'Claude CLI selected.';
      setSourceStatus(action, result.text || 'Claude CLI selected.');
      setSaveStatus('Claude saved');
      return;
    }
    await loadState();
    $('output').textContent = result.text || 'Done.';
    setSourceStatus(action, result.text || 'Done.');
  } catch (error) {
    $('output').textContent = error.message;
    setSourceStatus(action, error.message);
  } finally {
    buttons.forEach((button) => button.disabled = false);
    renderServiceStatus(state?.service);
    renderBackgroundSuggestionsStatus(state?.backgroundSuggestions, state?.config?.background_suggestions);
    if (document.querySelector('.nav-button.active')?.dataset.section === 'logs') void loadLogs();
  }
}

async function loadLogs() {
  const response = await apiFetch('/api/logs');
  const data = await response.json();
  if (!data.ok) throw new Error(data.error || 'Failed to load logs');
  renderLogs(data.logs || []);
}

async function clearLogs() {
  const response = await apiFetch('/api/logs', { method: 'DELETE' });
  const data = await response.json();
  if (!data.ok) throw new Error(data.error || 'Failed to clear logs');
  renderLogs(data.logs || []);
}

function renderLogs(logs) {
  if (!logs.length) {
    $('logs').innerHTML = '<p class="hint">No logs yet.</p>';
    return;
  }
  $('logs').innerHTML = logs.map((entry) => {
    const target = entry.event === 'action'
      ? 'Action: ' + (entry.action || 'unknown')
      : (entry.method || 'GET') + ' ' + (entry.path || '');
    const meta = entry.event === 'network'
      ? 'HTTP ' + (entry.status_code || '')
      : entry.status;
    const detail = entry.detail ? '<div class="log-meta">' + escapeHtml(entry.detail) + '</div>' : '';
    return '<div class="log-entry">' +
      '<div class="log-time">' + escapeHtml(formatLogTime(entry.timestamp)) + '</div>' +
      '<div><span class="log-badge ' + escapeHtml(entry.level || 'info') + '">' + escapeHtml(entry.status || 'ok') + '</span></div>' +
      '<div class="log-target"><div>' + escapeHtml(target) + '</div><div class="log-meta">' + escapeHtml(meta) + '</div>' + detail + '</div>' +
      '<div class="log-duration">' + escapeHtml(formatDuration(entry.duration_ms)) + '</div>' +
      '</div>';
  }).join('');
}

function formatLogTime(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp || '';
  return date.toLocaleString();
}

function formatClientTime(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp || '';
  return date.toLocaleString();
}

function formatDuration(value) {
  return typeof value === 'number' ? value + ' ms' : '';
}

function setSaveStatus(text, level = 'info', autoClear = true) {
  document.querySelectorAll('.save-status').forEach((item) => {
    item.textContent = text;
    item.className = 'save-status ' + level;
  });
  window.clearTimeout(setSaveStatus.timer);
  if (autoClear) {
    setSaveStatus.timer = window.setTimeout(() => {
      document.querySelectorAll('.save-status').forEach((item) => {
        item.textContent = '';
        item.className = 'save-status';
      });
    }, 5000);
  }
}
setSaveStatus.timer = 0;

function showToast(text, level = 'success', autoClear = true) {
  const toast = $('toast');
  if (!toast) return;
  toast.textContent = text;
  toast.className = 'toast visible ' + level;
  window.clearTimeout(showToast.timer);
  if (autoClear) {
    showToast.timer = window.setTimeout(() => {
      toast.className = 'toast';
      toast.textContent = '';
    }, 6000);
  }
}
showToast.timer = 0;

function maskClientValue(value) {
  if (!value) return '<empty>';
  if (value.length <= 12) return 'configured';
  return value.slice(0, 5) + '...' + value.slice(-5) + ' (' + value.length + ' chars)';
}

function setSourceStatus(action, text) {
  const target = action === 'discover_github_token' ? $('github-token-status') :
    action === 'discover_linear_token' ? $('linear-token-status') :
    action === 'discover_feishu_setup' ? $('feishu-setup-status') :
    ['choose_calendar_workdir', 'calendar_test', 'calendar_week', 'calendar_today'].includes(action) ? $('calendar-status') :
    ['discover_codex_binary', 'choose_codex_binary', 'choose_codex_home', 'codex_test'].includes(action) ? $('codex-status') :
    ['discover_claude_binary', 'choose_claude_binary', 'claude_test'].includes(action) ? $('claude-status') : null;
  if (target) target.textContent = text;
}

async function post(url, body) {
  const response = await apiFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!data.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function parseFiles(text) {
  return text.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    const [name, ...rest] = line.split('|').map((part) => part.trim());
    return { name, path: rest.join('|') };
  }).filter((file) => file.name && file.path);
}

function parseLines(text) {
  return [...new Set(text.split('\n').map((line) => line.trim()).filter(Boolean))];
}

function getFeishuProfilesForUi(config) {
  if (Array.isArray(config.sources.feishu.profiles) && config.sources.feishu.profiles.length > 0) {
    return structuredClone(config.sources.feishu.profiles);
  }
  return [{
    id: 'default',
    label: 'Default',
    enabled: true,
    identity: 'user',
    calendar: structuredClone(config.sources.feishu.calendar),
    tasks: structuredClone(config.sources.feishu.tasks),
    docs: structuredClone(config.sources.feishu.docs),
    im_history: structuredClone(config.sources.feishu.im_history),
  }];
}

function defaultFeishuProfile(index) {
  return {
    id: 'feishu_' + index,
    label: 'Feishu ' + index,
    enabled: true,
    identity: 'user',
    calendar: { enabled: false, days: 1 },
    tasks: { enabled: false, include_completed: false, page_limit: 5 },
    docs: { enabled: false, documents: [] },
    im_history: { enabled: false, chat_id_env: 'FEISHU_CHAT_ID', limit: 80 },
  };
}

function renderFeishuProfiles(profiles) {
  $('feishu-profiles').innerHTML = profiles.map((profile, index) => '<details class="profile" data-profile-index="' + index + '">' +
    '<summary class="profile-summary"><span class="profile-title">' + escapeHtml(profile.label || profile.id || ('Feishu ' + (index + 1))) + '</span>' +
    '<span class="profile-meta">' + escapeHtml(profileMeta(profile)) + '</span></summary>' +
    '<div class="profile-body">' +
    '<div class="grid">' +
    labelInput('Display name', profileFieldId(index, 'label'), profile.label) +
    labelSelect('Access identity', profileFieldId(index, 'identity'), profile.identity, ['user', 'bot']) +
    '</div>' +
    '<div class="profile-options">' +
    labelCheck('Enabled', profileFieldId(index, 'enabled'), profile.enabled) +
    labelCheck('Calendar', profileFieldId(index, 'calendar'), profile.calendar.enabled) +
    labelCheck('Tasks', profileFieldId(index, 'tasks'), profile.tasks.enabled) +
    labelCheck('Docs', profileFieldId(index, 'docs'), profile.docs.enabled) +
    labelCheck('IM history', profileFieldId(index, 'im'), profile.im_history.enabled) +
    '</div>' +
    '<label>Document URLs or tokens<textarea id="' + profileFieldId(index, 'docs-list') + '" rows="4" spellcheck="false" placeholder="Weekly plan | https://.../docx/...\nProject doc | doccn...">' + escapeHtml(formatFeishuDocs(profile.docs.documents || [])) + '</textarea></label>' +
    '<p class="hint">Docs are optional and cannot be guessed by lark-cli. Use one per line: <code>Name | document URL or token</code>. A plain URL/token also works.</p>' +
    '<div class="grid">' +
    labelNumber('Calendar days', profileFieldId(index, 'calendar-days'), profile.calendar.days, 1, 30) +
    labelNumber('Task pages', profileFieldId(index, 'task-pages'), profile.tasks.page_limit, 1, 20) +
    labelNumber('IM limit', profileFieldId(index, 'im-limit'), profile.im_history.limit, 1, 100) +
    '</div>' +
    '<details class="advanced-settings">' +
    '<summary>Advanced local settings</summary>' +
    '<div class="grid">' +
    labelInput('Local source key', profileFieldId(index, 'id'), profile.id) +
    labelInput('Chat ID env var', profileFieldId(index, 'chat-env'), profile.im_history.chat_id_env) +
    '</div>' +
    '<p class="hint">These are Daily OS local settings. Local source key controls evidence names. Chat ID env var names the .env variable containing a Feishu Chat ID, and is only used when IM history is enabled.</p>' +
    '</details>' +
    '<button type="button" class="secondary" data-remove-feishu-profile="' + index + '">Remove profile</button>' +
    '</div></details>').join('');

  document.querySelectorAll('[data-remove-feishu-profile]').forEach((button) => {
    button.addEventListener('click', () => {
      const next = readFeishuProfiles();
      next.splice(Number(button.dataset.removeFeishuProfile), 1);
      state.config.sources.feishu.profiles = next;
      renderFeishuProfiles(next);
    });
  });

}

function profileMeta(profile) {
  const parts = [profile.identity || 'user'];
  const enabled = [];
  if (profile.calendar?.enabled) enabled.push('calendar');
  if (profile.tasks?.enabled) enabled.push('tasks');
  if (profile.docs?.enabled) enabled.push('docs');
  if (profile.im_history?.enabled) enabled.push('im');
  parts.push(enabled.length > 0 ? enabled.join(', ') : 'no sources');
  return parts.join(' / ');
}

function readFeishuProfiles() {
  return [...document.querySelectorAll('[data-profile-index]')].map((card) => {
    const index = Number(card.dataset.profileIndex);
    const previous = state.config.sources.feishu.profiles?.[index] || {};
    return {
      id: value(profileFieldId(index, 'id')) || 'feishu_' + (index + 1),
      label: value(profileFieldId(index, 'label')) || 'Feishu ' + (index + 1),
      enabled: isChecked(profileFieldId(index, 'enabled')),
      identity: value(profileFieldId(index, 'identity')) || 'user',
      calendar: {
        enabled: isChecked(profileFieldId(index, 'calendar')),
        days: Number(value(profileFieldId(index, 'calendar-days')) || 1),
      },
      tasks: {
        enabled: isChecked(profileFieldId(index, 'tasks')),
        include_completed: Boolean(previous.tasks?.include_completed),
        page_limit: Number(value(profileFieldId(index, 'task-pages')) || 5),
      },
      docs: {
        enabled: isChecked(profileFieldId(index, 'docs')),
        documents: parseFeishuDocs(value(profileFieldId(index, 'docs-list'))),
      },
      im_history: {
        enabled: isChecked(profileFieldId(index, 'im')),
        chat_id_env: value(profileFieldId(index, 'chat-env')) || 'FEISHU_CHAT_ID',
        limit: Number(value(profileFieldId(index, 'im-limit')) || 80),
      },
    };
  });
}

function formatFeishuDocs(documents) {
  return (documents || []).map((doc) => (doc.name || 'Document') + ' | ' + (doc.token || '')).join('\n');
}

function parseFeishuDocs(text) {
  return text.split('\n').map((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) return null;
    const [name, ...rest] = trimmed.split('|').map((part) => part.trim());
    const token = rest.join('|') || name;
    return {
      name: rest.length > 0 && name ? name : 'Document ' + (index + 1),
      token,
    };
  }).filter(Boolean);
}

function profileFieldId(index, name) {
  return 'feishu-profile-' + index + '-' + name;
}

function labelInput(label, id, currentValue, badge) {
  return '<label>' + escapeHtml(label) + badgeHtml(badge) + '<input id="' + id + '" value="' + escapeAttr(currentValue || '') + '" /></label>';
}

function labelNumber(label, id, currentValue, min, max) {
  return '<label>' + escapeHtml(label) + '<input id="' + id + '" type="number" min="' + min + '" max="' + max + '" value="' + escapeAttr(currentValue || '') + '" /></label>';
}

function labelSelect(label, id, currentValue, options, badge) {
  return '<label>' + escapeHtml(label) + badgeHtml(badge) + '<select id="' + id + '">' + options.map((option) =>
    '<option ' + (option === currentValue ? 'selected' : '') + '>' + escapeHtml(option) + '</option>').join('') + '</select></label>';
}

function labelCheck(label, id, currentValue) {
  return '<label><input id="' + id + '" type="checkbox" ' + (currentValue ? 'checked' : '') + ' /> ' + escapeHtml(label) + '</label>';
}

function badgeHtml(text) {
  return text ? ' <span class="required">' + escapeHtml(text) + '</span>' : '';
}

function escapeAttr(text) {
  return escapeHtml(text).replace(/\x60/g, '&#96;');
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}`;
