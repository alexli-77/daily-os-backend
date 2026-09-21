/**
 * LEO-210 web console tests. Independent, tsx-runnable:
 *
 *   npx tsx scripts/tests/platform-ui.test.ts
 *
 * Covers: login flow (401/200 + cookie), console page redirect, member
 * write 403 + whitelisted 200, admin-via-token 200, artifacts index read/write,
 * and RunManager cancel escalation on a mock child process.
 *
 * The whole run happens inside an isolated temp working directory so it never
 * touches the real data/runtime/users.json or artifacts index.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let passed = 0;
let failed = 0;
function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function setupTempWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-os-ui-test-'));
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  fs.copyFileSync(path.join(REPO_ROOT, '.env.example'), path.join(dir, '.env.example'));
  fs.copyFileSync(path.join(REPO_ROOT, 'config', 'config.example.yaml'), path.join(dir, 'config', 'config.example.yaml'));
  // A real secret so the LEO-288 env-secret reveal gate can be tested meaningfully.
  fs.writeFileSync(path.join(dir, '.env'), 'OPENAI_API_KEY=FAKE_SECRET_LEO288\n');
  return dir;
}

function cookieFrom(setCookie: string | null): string {
  if (!setCookie) return '';
  return setCookie.split(';')[0];
}

async function main(): Promise<void> {
  const tmp = setupTempWorkspace();
  const originalCwd = process.cwd();
  process.chdir(tmp);

  // Import after chdir so all cwd-relative path resolution lands in the temp dir.
  const auth = await import('../../src/ui/auth.js');
  const artifacts = await import('../../src/storage/artifacts.js');
  const { loadConfig } = await import('../../src/config/load-config.js');
  const { writeLatestWorkflowOutput } = await import('../../src/storage/memory.js');
  const { todayInTimezone } = await import('../../src/utils/date.js');
  const { runManager } = await import('../../src/service/run-manager.js');
  const { startUiServer } = await import('../../src/ui/server.js');

  // --- RunManager cancel (mock child) --------------------------------------
  {
    const signals: string[] = [];
    let cancelledCallbackRan = false;
    const stubborn = {
      pid: 4242,
      killed: false,
      kill(signal?: NodeJS.Signals | number) {
        signals.push(String(signal));
        if (signal === 'SIGKILL') this.killed = true; // ignores SIGTERM -> forces escalation
        return true;
      },
    };
    runManager.register('run_stub', stubborn, { workflow: 'daily_plan', onCancel: () => { cancelledCallbackRan = true; } });
    check('run-manager lists active run', runManager.list().some((r) => r.runId === 'run_stub'));
    const result = await runManager.cancel('run_stub', { escalationMs: 40 });
    check('run-manager escalates SIGTERM then SIGKILL', signals.join(',') === 'SIGTERM,SIGKILL', signals.join(','));
    check('run-manager cancel status killed', result.status === 'killed', result.status);
    check('run-manager onCancel writeback ran', cancelledCallbackRan);
    check('run-manager unregisters after cancel', !runManager.isActive('run_stub'));

    const exits: string[] = [];
    const graceful = {
      pid: 99,
      killed: false,
      kill(signal?: NodeJS.Signals | number) { exits.push(String(signal)); this.killed = true; return true; },
    };
    runManager.register('run_graceful', graceful, {});
    const gr = await runManager.cancel('run_graceful', { escalationMs: 200 });
    check('run-manager graceful stop uses only SIGTERM', exits.join(',') === 'SIGTERM', exits.join(','));
    check('run-manager graceful status signalled', gr.status === 'signalled', gr.status);

    const missing = await runManager.cancel('nope');
    check('run-manager cancel missing run -> not-found', missing.status === 'not-found' && missing.ok === false);
  }

  // --- Artifacts index read/write ------------------------------------------
  {
    const outDir = path.resolve('data/outputs');
    fs.mkdirSync(outDir, { recursive: true });
    const file = path.join(outDir, 'sample-report.md');
    fs.writeFileSync(file, '# hello\nartifact body');

    const record = artifacts.registerArtifact({ path: file, tags: ['report'], source: 'test' });
    check('registerArtifact returns a record', Boolean(record) && record?.type === 'markdown', record?.type);
    check('registerArtifact is previewable', record ? artifacts.isPreviewableType(record.type) : false);

    const index = artifacts.readArtifactsIndex();
    check('artifacts index contains registered file', index.some((a) => a.name === 'sample-report.md'));

    fs.writeFileSync(path.join(outDir, 'extra.log'), 'log line');
    const scan = artifacts.scanAndIndex();
    check('scanAndIndex picks up new files', scan.total >= 2, JSON.stringify(scan));

    const found = record ? artifacts.findArtifactById(record.id) : undefined;
    check('findArtifactById round-trips', Boolean(found) && found?.name === 'sample-report.md');
  }

  // --- Seed users before starting the server (so ensureAuthInitialized no-ops)
  auth.resetSessionCacheForTests();
  auth.addUser('admin', 'admin-password-1', 'admin');
  auth.addUser('member', 'member-password-1', 'member');

  const controls = await startUiServer({
    configPath: 'config/config.yaml',
    envPath: '.env',
    host: '127.0.0.1',
    port: 0,
    open: false,
  });
  const base = controls.url;

  try {
    // --- Login flow --------------------------------------------------------
    const badLogin = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'wrong' }),
    });
    check('login with wrong password -> 401', badLogin.status === 401, String(badLogin.status));

    const adminLogin = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin-password-1' }),
    });
    check('login with correct password -> 200', adminLogin.status === 200, String(adminLogin.status));
    const adminCookie = cookieFrom(adminLogin.headers.get('set-cookie'));
    check('login sets session cookie', adminCookie.startsWith(`${auth.SESSION_COOKIE}=`), adminCookie);

    // --- Console page auth -------------------------------------------------
    const noAuthPage = await fetch(`${base}/dashboard`, { redirect: 'manual' });
    // Signing in is a dialog on the welcome page now; `signin=1` asks that page
    // to open on the sign-in form rather than on sign-up.
    check('dashboard without session -> redirect to the welcome page', noAuthPage.status === 302 && noAuthPage.headers.get('location') === '/?signin=1', `${noAuthPage.status} -> ${noAuthPage.headers.get('location')}`);

    const authedPage = await fetch(`${base}/dashboard`, { headers: { cookie: adminCookie } });
    const pageText = await authedPage.text();
    check('dashboard with admin session -> 200 html', authedPage.status === 200 && pageText.includes('Recent runs'), String(authedPage.status));

    // --- Console UI: avatar dropdown, profile page, font-size preference ----
    check('topbar renders the avatar dropdown menu', pageText.includes('data-usermenu') && pageText.includes('data-usermenu-toggle'), 'usermenu missing');
    check('avatar hover tooltip present', pageText.includes('打开用户导航栏'));
    check('dropdown has 个人信息 / 设置 / 退出', pageText.includes('>个人信息<') && pageText.includes('>设置<') && pageText.includes('data-logout'));
    check('Config link removed from the top nav bar', !pageText.includes('>Config</a>'), 'top nav still has Config');
    check('head applies the saved font preference early', pageText.includes('daily_os_font'));

    const profilePage = await fetch(`${base}/profile`, { headers: { cookie: adminCookie } });
    const profileText = await profilePage.text();
    check('profile page renders for the signed-in user', profilePage.status === 200 && profileText.includes('admin') && profileText.includes('角色'), String(profilePage.status));

    const configPage = await fetch(`${base}/console`, { headers: { cookie: adminCookie } });
    const configText = await configPage.text();
    check('Config Setup has the font-size control', configPage.status === 200 && configText.includes('font-size-control') && configText.includes('界面字体'), String(configPage.status));

    const cssText = await (await fetch(`${base}/assets/app.css`)).text();
    check('app.css scales the UI via data-font zoom', cssText.includes('data-font') && cssText.includes('zoom'), 'no zoom rule');
    const jsText = await (await fetch(`${base}/assets/app.js`)).text();
    check('app.js wires the font preference', jsText.includes('daily_os_font'), 'no font wiring');

    const todayConfig = loadConfig('config/config.yaml');
    todayConfig.sources.linear.workspace = '';
    // Dated today, not a fixed date. The subject here is the Linear link, but
    // since LEO-309 the Today page only renders a plan that belongs to today —
    // a hard-coded 2026-07-31 now renders the "还没有今日 plan" empty state and
    // the assertion below fails for a reason that has nothing to do with the
    // workspace config it is testing.
    writeLatestWorkflowOutput(
      todayConfig,
      'daily_plan',
      todayInTimezone(todayConfig),
      '{"todos":[{"rank":1,"text":"录完官网 Demo","candidateId":"linear:CUTTO-301"}]}',
    );
    const todayPage = await fetch(`${base}/today`, { headers: { cookie: adminCookie } });
    const todayText = await todayPage.text();
    check(
      'today: Linear issue remains clickable without workspace config',
      todayPage.status === 200 && todayText.includes('href="https://linear.app/issue/CUTTO-301"'),
      String(todayPage.status),
    );

    const apiNoAuth = await fetch(`${base}/api/artifacts/reindex`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    check('write api without auth -> 401', apiNoAuth.status === 401, String(apiNoAuth.status));

    // --- Member role gating ------------------------------------------------
    const memberLogin = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'member', password: 'member-password-1' }),
    });
    const memberCookie = cookieFrom(memberLogin.headers.get('set-cookie'));

    const memberWrite = await fetch(`${base}/api/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: memberCookie },
      body: JSON.stringify({ config: {} }),
    });
    check('member non-whitelisted write -> 403', memberWrite.status === 403, String(memberWrite.status));

    const memberWhitelisted = await fetch(`${base}/api/today/todo-feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: memberCookie },
      body: JSON.stringify({ id: 'todo-1', action: 'check' }),
    });
    check('member whitelisted write -> 200', memberWhitelisted.status === 200, String(memberWhitelisted.status));

    // LEO-287: installing a skill is a privileged write — members are refused.
    const memberInstall = await fetch(`${base}/api/skills/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: memberCookie },
      body: '{}',
    });
    check('member cannot install a skill -> 403', memberInstall.status === 403, String(memberInstall.status));

    // --- LEO-291 Scope A: owner-only config surfaces -----------------------
    // The whole config console + state/secret endpoints are admin(owner)-only.
    const memberSecret = await fetch(`${base}/api/env-secret?key=OPENAI_API_KEY&reveal=1`, { headers: { cookie: memberCookie } });
    check('member cannot reach /api/env-secret -> 403', memberSecret.status === 403, String(memberSecret.status));
    const memberState = await fetch(`${base}/api/state`, { headers: { cookie: memberCookie } });
    check('member cannot read /api/state -> 403', memberState.status === 403, String(memberState.status));
    const memberConsole = await fetch(`${base}/console`, { headers: { cookie: memberCookie }, redirect: 'manual' });
    check(
      'member is redirected away from /console',
      memberConsole.status === 302 && memberConsole.headers.get('location') === '/dashboard',
      `${memberConsole.status} -> ${memberConsole.headers.get('location')}`,
    );
    const anonConsole = await fetch(`${base}/console`, { redirect: 'manual' });
    check('signed-out visitor cannot open /console -> redirect', anonConsole.status === 302, String(anonConsole.status));

    // The owner (admin) keeps full access to all of it.
    const adminConsole = await fetch(`${base}/console`, { headers: { cookie: adminCookie }, redirect: 'manual' });
    check('admin can open /console -> 200', adminConsole.status === 200, String(adminConsole.status));
    const adminState = await fetch(`${base}/api/state`, { headers: { cookie: adminCookie } });
    check('admin can read /api/state -> 200', adminState.status === 200, String(adminState.status));
    const adminSecret = await fetch(`${base}/api/env-secret?key=OPENAI_API_KEY&reveal=1`, { headers: { cookie: adminCookie } });
    check('admin can query /api/env-secret -> 200', adminSecret.status === 200, String(adminSecret.status));

    const adminReveal = (await fetch(`${base}/api/env-secret?key=OPENAI_API_KEY&reveal=1`, {
      headers: { authorization: `Bearer ${controls.token}` },
    }).then((r) => r.json())) as { value?: string };
    check('admin (runtime token) can still reveal the secret', adminReveal.value === 'FAKE_SECRET_LEO288', JSON.stringify(adminReveal));

    // --- Admin via runtime token ------------------------------------------
    const tokenWrite = await fetch(`${base}/api/artifacts/reindex`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${controls.token}` },
      body: '{}',
    });
    check('admin via runtime token write -> 200', tokenWrite.status === 200, String(tokenWrite.status));

    // --- Web console chat (LEO-236) ---------------------------------------
    // Parse an SSE response body into decoded event objects.
    const readSse = (text: string): Array<Record<string, unknown>> =>
      text
        .split('\n\n')
        .map((chunk) =>
          chunk
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trim())
            .join(''),
        )
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line) as Record<string, unknown>;
          } catch {
            return {};
          }
        });
    const sendChat = async (cookie: string, session: string | undefined, text: string) => {
      const res = await fetch(`${base}/api/chat/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ ...(session ? { session } : {}), text }),
      });
      const body = await res.text();
      return {
        status: res.status,
        events: res.status === 200 ? readSse(body) : [],
        sessionId: res.headers.get('x-chat-session-id') || '',
        body,
      };
    };

    // Sending the first instruction from an empty Chat page creates the chat
    // atomically and returns its id to the browser.
    const firstTurn = await sendChat(adminCookie, undefined, 'daily-os status');
    check('chat: first instruction auto-creates a session', firstTurn.status === 200 && firstTurn.sessionId.length > 0, `${firstTurn.status} ${firstTurn.body.slice(0, 120)}`);
    check(
      'chat: completed command emits an assistant completion reply',
      firstTurn.events.some((event) => event.type === 'reply' && event.content === '执行完成。'),
      JSON.stringify(firstTurn.events),
    );
    const firstMessages = (await fetch(`${base}/api/chat/messages?session=${encodeURIComponent(firstTurn.sessionId)}`, {
      headers: { cookie: adminCookie },
    }).then((r) => r.json())) as { messages?: Array<{ role: string; content: string }> };
    check(
      'chat: auto-created session persists the first turn',
      Boolean(firstMessages.messages?.some((message) => message.role === 'user' && message.content === 'daily-os status')),
      JSON.stringify(firstMessages.messages || []),
    );

    // Admin: create a session, run a command turn (no codex needed), verify it
    // streams a reply, persists both messages, and lands a usage-ledger row.
    const created = await fetch(`${base}/api/chat/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: '{}',
    }).then((r) => r.json());
    const sessionId = String((created as { session?: { id?: string } })?.session?.id || '');
    check('chat: admin creates a session', created && (created as { ok?: boolean }).ok === true && sessionId.length > 0, sessionId);

    const sessionsList = (await fetch(`${base}/api/chat/sessions`, { headers: { cookie: adminCookie } }).then((r) => r.json())) as {
      sessions?: Array<{ id: string }>;
    };
    check('chat: session appears in list', Boolean(sessionsList.sessions?.some((s) => s.id === sessionId)));

    const adminTurn = await sendChat(adminCookie, sessionId, 'daily-os status');
    check('chat: command turn streams over SSE 200', adminTurn.status === 200, String(adminTurn.status));
    const adminReply = adminTurn.events.find((e) => e.type === 'reply');
    check('chat: command turn produced a reply', Boolean(adminReply) && String(adminReply?.content).includes('Daily OS'), JSON.stringify(adminReply || {}));
    check('chat: turn signals done', adminTurn.events.some((e) => e.type === 'done'));

    const messages = (await fetch(`${base}/api/chat/messages?session=${encodeURIComponent(sessionId)}`, {
      headers: { cookie: adminCookie },
    }).then((r) => r.json())) as { messages?: Array<{ role: string; content: string }> };
    check(
      'chat: user + assistant messages persisted',
      Boolean(messages.messages && messages.messages.length === 2 && messages.messages[0].role === 'user' && messages.messages[1].role === 'assistant'),
      JSON.stringify(messages.messages || []),
    );

    const ledger = fs.existsSync(path.resolve('data/runtime/usage-ledger.jsonl'))
      ? fs.readFileSync(path.resolve('data/runtime/usage-ledger.jsonl'), 'utf8')
      : '';
    check('chat: every turn lands a usage-ledger row', ledger.includes('"provider":"web_chat"'), ledger.slice(0, 200));

    // Channel separation: the shared session catalog tags this session channel=web.
    const catalog = fs.existsSync(path.resolve('data/memory/feishu-session-catalog.json'))
      ? fs.readFileSync(path.resolve('data/memory/feishu-session-catalog.json'), 'utf8')
      : '';
    check('chat: session stored with channel=web', catalog.includes('"channel": "web"'), catalog.slice(0, 200));

    // Member: whitelisted command turn is allowed; free-form (over-privileged) is rejected.
    const memberSession = String(
      ((await fetch(`${base}/api/chat/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: memberCookie },
        body: '{}',
      }).then((r) => r.json())) as { session?: { id?: string } })?.session?.id || '',
    );
    check('chat: member can create a session', memberSession.length > 0, memberSession);

    const memberCommand = await sendChat(memberCookie, memberSession, 'daily-os status');
    check('chat: member whitelisted command -> 200', memberCommand.status === 200, String(memberCommand.status));

    const memberFreeform = await sendChat(memberCookie, memberSession, '帮我随便聊聊今天的安排');
    check('chat: member over-privileged free-form turn -> 403', memberFreeform.status === 403, `${memberFreeform.status} ${memberFreeform.body.slice(0, 120)}`);
  } finally {
    await controls.stop();
    process.chdir(originalCwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
