/**
 * Cycle sync + read-only teammate view (LEO-284 / LEO-285).
 *
 * Independent, tsx-runnable:  npx tsx scripts/tests/team-sync.test.ts
 *
 * Everything here runs against a stub `TeamSessionProvider` and a temp
 * workspace. No Supabase project, no network, and — deliberately — no regex
 * over the source: the assertions are about what the sync engine sends, what it
 * writes to disk, and what the shipped console script renders.
 *
 * The properties worth protecting, in the order they would hurt:
 *
 *   1. Local markdown is never overwritten by the remote. There is no code path
 *      that writes a remote row into `20_CYCLES/`, so a stale row cannot eat a
 *      retro that was just typed.
 *   2. Teammate data stays out of `20_CYCLES/`. That directory means "mine",
 *      and everything local treats a file there as writable.
 *   3. Read-only is enforced on the write path, not by hiding buttons.
 *   4. Nothing about local editing depends on the remote being reachable.
 *   5. The poll is cheap: an unchanged remote costs exactly one single-row
 *      request and fetches no bodies.
 *   6. The cache is keyed by owner uuid, so renaming a teammate does not orphan
 *      what we already pulled.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

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

const SELF_ID = '11111111-1111-4111-8111-111111111111';
const MATE_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_TEAM_MATE_ID = '33333333-3333-4333-8333-333333333333';
const TEAM_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const MINE_ID = '2026-08-24_8.24-9.6';
const MATE_CYCLE_ID = '2026-08-24_8.24-9.6';
const MATE_OLD_CYCLE_ID = '2026-06-01_6.1-6.14';

function cycleFile(cycle: string, body: string, updatedAt = '2026-08-24T08:00:00.000Z'): string {
  return [
    '---',
    `cycle: '${cycle}'`,
    'mode: biweekly',
    `updated_at: ${updatedAt}`,
    'sections:',
    `  要务: {source: planner, updated_at: '${updatedAt}'}`,
    '---',
    '',
    '## 要务',
    body,
    '',
  ].join('\n');
}

function writeConfig(root: string, vault: string): void {
  const parsed = yaml.load(fs.readFileSync(path.join(REPO_ROOT, 'config', 'config.example.yaml'), 'utf8')) as Record<string, any>;
  parsed.memory.repository_path = vault;
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config', 'config.yaml'), yaml.dump(parsed), 'utf8');
}

function cookieFrom(setCookie: string | null): string {
  return setCookie ? setCookie.split(';')[0] : '';
}

// --- the stub remote ---------------------------------------------------------

interface RemoteRow {
  owner: string;
  cycle_id: string;
  mode: string;
  markdown: string;
  updated_at: string;
}

interface PlanRow {
  owner: string;
  plan_date: string;
  payload: Record<string, unknown>;
  updated_at: string;
}

interface StubOptions {
  configured?: boolean;
  session?: {
    userId: string;
    email: string;
    accessToken: string;
    teamId: string | null;
    memberId: string;
  } | null;
  rows?: RemoteRow[];
  plans?: PlanRow[];
  /** false = the project never ran the daily_plans migration. */
  plansTable?: boolean;
  members?: Array<{ userId: string; memberId: string; displayName: string }>;
}

/**
 * A PostgREST-shaped stub: it answers the two queries sync makes and applies
 * the same ownership rule the RLS policy does, so a client that tried to write
 * a teammate's row here would get the 403 it gets in production.
 */
function makeStub(options: StubOptions = {}) {
  const stub = {
    configured: options.configured !== false,
    session:
      options.session === undefined
        ? { userId: SELF_ID, email: 'leon@example.com', accessToken: 'token', teamId: TEAM_ID, memberId: 'leon' }
        : options.session,
    rows: options.rows ? [...options.rows] : [],
    plans: options.plans ? [...options.plans] : [],
    members: options.members || [
      { userId: SELF_ID, memberId: 'leon', displayName: 'Leon' },
      { userId: MATE_ID, memberId: 'penguin', displayName: '企鹅' },
    ],
    calls: [] as Array<{ method: string; path: string; body?: unknown }>,
    failNext: null as Error | null,
    memberListError: null as Error | null,
    /** Hold each request open this long, so overlapping work would be visible. */
    delayMs: 0,
    /** Requests in flight right now, and the high-water mark. */
    concurrent: 0,
    maxConcurrent: 0,
    isSupabaseConfigured: (): boolean => stub.configured,
    readTeamSession: () => stub.session,
    listTeamMembers: async () => {
      if (stub.memberListError) throw stub.memberListError;
      return stub.members;
    },
    supabaseFetch: async (config: unknown, requestPath: string, init?: RequestInit): Promise<Response> => {
      stub.concurrent += 1;
      stub.maxConcurrent = Math.max(stub.maxConcurrent, stub.concurrent);
      try {
        if (stub.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, stub.delayMs));
        return await handle(config, requestPath, init);
      } finally {
        stub.concurrent -= 1;
      }
    },
  };

  async function handle(_config: unknown, requestPath: string, init?: RequestInit): Promise<Response> {
      const method = String(init?.method || 'GET').toUpperCase();
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      stub.calls.push({ method, path: requestPath, body });
      if (stub.failNext) {
        const error = stub.failNext;
        stub.failNext = null;
        throw error;
      }

      const query = requestPath.slice(requestPath.indexOf('?') + 1);
      const params = new URLSearchParams(query);
      // Two tables, same rules. `daily_plans` is keyed by plan_date where
      // `cycles` is keyed by cycle_id; everything else about them is identical.
      const isPlans = requestPath.startsWith('/rest/v1/daily_plans');
      if (isPlans && options.plansTable === false) {
        return new Response(JSON.stringify({ code: 'PGRST205', message: "Could not find the table 'public.daily_plans' in the schema cache" }), { status: 404 });
      }
      const table = (isPlans ? stub.plans : stub.rows) as Array<Record<string, unknown> & { owner: string; updated_at: string }>;
      const keyColumn = isPlans ? 'plan_date' : 'cycle_id';

      if (method === 'POST') {
        const payload = (Array.isArray(body) ? body : [body]) as Array<Record<string, unknown> & { owner: string }>;
        for (const row of payload) {
          // Mirrors `cycles_insert_own` / `cycles_update_own`.
          if (!stub.session || row.owner !== stub.session.userId) {
            return new Response(JSON.stringify({ message: 'new row violates row-level security policy' }), { status: 403 });
          }
          const index = table.findIndex((existing) => existing.owner === row.owner && existing[keyColumn] === row[keyColumn]);
          const stored = { ...row, updated_at: new Date().toISOString() };
          if (index >= 0) table[index] = stored;
          else table.push(stored);
        }
        return new Response('', { status: 201 });
      }

      if (method === 'DELETE') {
        const owner = (params.get('owner') || '').startsWith('eq.') ? (params.get('owner') as string).slice(3) : '';
        const beforeFilter = params.get('plan_date') || '';
        const before = beforeFilter.startsWith('lt.') ? beforeFilter.slice(3) : '';
        // Mirrors `daily_plans_delete_own`: only your own rows, and a client
        // that forgets to say whose rows it means gets nothing, not everyone's.
        if (!stub.session || owner !== stub.session.userId) {
          return new Response(JSON.stringify({ message: 'violates row-level security policy' }), { status: 403 });
        }
        for (let index = table.length - 1; index >= 0; index -= 1) {
          const row = table[index];
          if (row.owner !== owner) continue;
          if (before && String((row as Record<string, unknown>).plan_date || '') >= before) continue;
          table.splice(index, 1);
        }
        return new Response(null, { status: 204 });
      }

      const ownerFilter = params.get('owner') || '';
      const excluded = ownerFilter.startsWith('neq.') ? ownerFilter.slice(4) : '';
      const dateFilter = params.get('plan_date') || '';
      const since = dateFilter.startsWith('gte.') ? dateFilter.slice(4) : '';
      const visible = table
        .filter((row) => !excluded || row.owner !== excluded)
        .filter((row) => !since || String(row.plan_date || '') >= since)
        .sort((left, right) => (left.updated_at < right.updated_at ? 1 : -1));
      const select = (params.get('select') || '').split(',');
      const limited = params.get('limit') === '1' ? visible.slice(0, 1) : visible;
      const projected = limited.map((row) => {
        const out: Record<string, unknown> = {};
        for (const column of select) if (column in row) out[column] = (row as unknown as Record<string, unknown>)[column];
        return out;
      });
      return new Response(JSON.stringify(projected), { status: 200, headers: { 'content-type': 'application/json' } });
  }

  return stub;
}

type Stub = ReturnType<typeof makeStub>;

function bodyRequests(stub: Stub): Array<{ method: string; path: string }> {
  return stub.calls.filter((call) => call.method === 'GET' && call.path.includes('markdown'));
}
function planBodyRequests(stub: Stub): Array<{ method: string; path: string }> {
  return stub.calls.filter((call) => call.method === 'GET' && call.path.includes('payload'));
}
function probeRequests(stub: Stub): Array<{ method: string; path: string }> {
  return stub.calls.filter((call) => call.method === 'GET' && !call.path.includes('markdown') && !call.path.includes('payload'));
}
function planPushes(stub: Stub): Array<{ method: string; path: string; body?: any }> {
  return stub.calls.filter((call) => call.method === 'POST' && call.path.startsWith('/rest/v1/daily_plans'));
}
function cyclePushes(stub: Stub): Array<{ method: string; path: string; body?: any }> {
  return stub.calls.filter((call) => call.method === 'POST' && call.path.startsWith('/rest/v1/cycles'));
}
/** One per `syncTeamOnce`: the cheap single-row probe on `cycles`. */
function cycleProbes(stub: Stub): Array<{ method: string; path: string }> {
  return stub.calls.filter((call) => call.method === 'GET' && call.path.startsWith('/rest/v1/cycles') && call.path.includes('limit=1'));
}
function planDeletes(stub: Stub): Array<{ method: string; path: string }> {
  return stub.calls.filter((call) => call.method === 'DELETE' && call.path.startsWith('/rest/v1/daily_plans'));
}

/**
 * The events `fs.watch` would deliver, delivered on demand. "A burst produces
 * one push" is a claim about the debouncer, and driving the real watcher would
 * make it a claim about how quickly the OS coalesces inotify events instead.
 */
function makeFakeWatch() {
  const dirs: string[] = [];
  let listener: ((filename: string) => void) | null = null;
  return {
    dirs,
    emit: (filename: string): void => listener?.(filename),
    watchDir: (dir: string, onChange: (filename: string) => void) => {
      dirs.push(dir);
      listener = onChange;
      return {
        close: () => {
          listener = null;
        },
      };
    },
  };
}

/** The same trick for the in-process local-change bus. */
function makeFakeBus() {
  let listener: ((kind: 'today_plan') => void) | null = null;
  return {
    emit: (): void => listener?.('today_plan'),
    subscribe: (next: (kind: 'today_plan') => void) => {
      listener = next;
      return () => {
        listener = null;
      };
    },
  };
}

/** Poll a predicate. Only used where a real OS watcher is in the loop. */
async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

// --- suites ------------------------------------------------------------------

async function main(): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-os-team-sync-test-'));
  const vault = path.join(tmp, 'vault');
  const cycles = path.join(vault, '20_CYCLES');
  fs.mkdirSync(cycles, { recursive: true });
  fs.writeFileSync(path.join(cycles, `${MINE_ID}.md`), cycleFile('8.24-9.6', '- **MIT** 我自己的要务'), 'utf8');
  writeConfig(tmp, vault);
  fs.writeFileSync(path.join(tmp, '.env'), '');

  const originalCwd = process.cwd();
  process.chdir(tmp);

  const bridge = await import('../../src/team/session-bridge.js');
  const sync = await import('../../src/team/sync.js');
  const cache = await import('../../src/team/cache.js');
  const { loadConfig } = await import('../../src/config/load-config.js');
  const cycleFileModule = await import('../../src/cycles/file.js');
  const memory = await import('../../src/storage/memory.js');
  const feedback = await import('../../src/todo/feedback.js');
  const todayPlan = await import('../../src/todo/today-plan.js');
  const { todayInTimezone, addDays } = await import('../../src/utils/date.js');

  const config = loadConfig('config/config.yaml');
  const teamCache = (): string => path.join(tmp, 'data', 'team-cache');
  const localCycleFiles = (): string[] => fs.readdirSync(cycles).sort();

  try {
    await testDegradedModes();
    await testPollingIsCheap();
    await testPullAndCacheLayout();
    await testLocalWinsOverRemote();
    await testRenameKeepsCache();
    await testDailyPlans();
    await testWriteGuards();
    await testUiServer();
    await testConsoleRendering();
    // These four run last on purpose: they wipe and reseed data/team-cache,
    // which the suites above share.
    await testInstantPush();
    await testSlowDirectoryDegrades();
    await testSingleFlight();
    await testVersionedApply();
    await testRetention();
  } finally {
    bridge.setTeamSessionProviderForTests(null);
    process.chdir(originalCwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);

  // --- 1. no supabase / not signed in / no team / offline -------------------

  async function testDegradedModes(): Promise<void> {
    console.log('\n--- degraded modes ---');

    // No auth module at all (what this branch looks like before LEO-282 lands).
    bridge.setTeamSessionProviderForTests(null);
    const noModule = await sync.syncTeamOnce(config);
    check('with no team module, sync reports disabled instead of throwing', noModule.status === 'disabled', noModule.status);
    check('a disabled sync makes no requests and writes no cache', !fs.existsSync(teamCache()));

    const unconfigured = makeStub({ configured: false });
    bridge.setTeamSessionProviderForTests(unconfigured);
    const off = await sync.syncTeamOnce(config);
    check('unconfigured Supabase -> disabled', off.status === 'disabled', off.status);
    check('unconfigured Supabase makes no request', unconfigured.calls.length === 0, String(unconfigured.calls.length));
    check('unconfigured Supabase explains itself', off.reason.includes('SUPABASE_URL'), off.reason);

    const signedOut = makeStub({ session: null });
    bridge.setTeamSessionProviderForTests(signedOut);
    const out = await sync.syncTeamOnce(config);
    check('signed out -> signed_out, no request', out.status === 'signed_out' && signedOut.calls.length === 0, out.status);

    const noTeam = makeStub({ session: { userId: SELF_ID, email: 'a@b.c', accessToken: 't', teamId: null, memberId: 'leon' } });
    bridge.setTeamSessionProviderForTests(noTeam);
    const solo = await sync.syncTeamOnce(config);
    check('no team -> no_team, no request', solo.status === 'no_team' && noTeam.calls.length === 0, solo.status);

    // Offline: the transport throws, and everything local keeps working.
    const offline = makeStub();
    offline.failNext = new Error('fetch failed');
    bridge.setTeamSessionProviderForTests(offline);
    const broken = await sync.syncTeamOnce(config);
    check('a transport failure is reported, not thrown', broken.status === 'error', broken.status);
    check('the transport error text is kept for the UI', broken.reason.includes('fetch failed'), broken.reason);

    // The point of all four: local editing is unaffected in every one of them.
    cycleFileModule.writeSection(config, MINE_ID, 'retro', '断网时写的 retro', 'user');
    const afterOffline = cycleFileModule.readCycle(config, MINE_ID);
    check('local write works while sync is down', afterOffline?.sections.retro?.content === '断网时写的 retro', String(afterOffline?.sections.retro?.content));
    check('local read still lists the cycle while sync is down', cycleFileModule.listCycles(config).some((doc) => doc.id === MINE_ID));

    const view = await sync.readTeamViewState(config);
    check('a failed sync still leaves the console in a ready state with an error line', view.status === 'ready', view.status);
    check('the view surfaces the last transport error', view.lastError.includes('fetch failed'), view.lastError);
  }

  // --- 2. an unchanged remote costs one single-row request ------------------

  async function testPollingIsCheap(): Promise<void> {
    console.log('\n--- polling ---');
    fs.rmSync(teamCache(), { recursive: true, force: true });

    const stub = makeStub({
      rows: [
        { owner: MATE_ID, cycle_id: MATE_CYCLE_ID, mode: 'biweekly', markdown: cycleFile('8.24-9.6', '- 企鹅的要务'), updated_at: '2026-08-24T10:00:00.000Z' },
      ],
    });
    bridge.setTeamSessionProviderForTests(stub);

    const first = await sync.syncTeamOnce(config);
    check('first tick sees a change and pulls', first.status === 'ok' && first.changed && first.pulled === 1, JSON.stringify(first));

    stub.calls.length = 0;
    const second = await sync.syncTeamOnce(config);
    check('an unchanged remote reports no change', second.status === 'ok' && !second.changed && second.pulled === 0, JSON.stringify(second));
    check('an unchanged remote fetches no markdown', bodyRequests(stub).length === 0, JSON.stringify(bodyRequests(stub)));
    check('an unchanged remote fetches no plan payloads', planBodyRequests(stub).length === 0, JSON.stringify(planBodyRequests(stub)));
    check('an unchanged remote costs exactly one probe request per table', probeRequests(stub).length === 2, JSON.stringify(probeRequests(stub)));
    for (const { path: probe } of probeRequests(stub)) {
      check('the probe reads one row of one column', probe.includes('select=updated_at') && probe.includes('limit=1'), probe);
      check('the probe never joins members', !probe.includes('members'), probe);
    }

    // Our own push moves the team's max(updated_at). The probe excludes our own
    // rows precisely so that does not force a teammate re-download.
    fs.writeFileSync(path.join(cycles, `${MINE_ID}.md`), cycleFile('8.24-9.6', '- **MIT** 改过的要务', '2026-08-25T08:00:00.000Z'), 'utf8');
    stub.calls.length = 0;
    const afterOwnWrite = await sync.syncTeamOnce(config);
    check('our own push is uploaded', afterOwnWrite.pushed === 1, JSON.stringify(afterOwnWrite));
    check('our own push does not trigger a teammate re-download', !afterOwnWrite.changed && bodyRequests(stub).length === 0, JSON.stringify(bodyRequests(stub)));

    stub.calls.length = 0;
    const idle = await sync.syncTeamOnce(config);
    check('an unchanged local file is not re-uploaded every tick', idle.pushed === 0 && !stub.calls.some((call) => call.method === 'POST'), JSON.stringify(stub.calls));

    // A teammate writes: the probe moves, bodies are fetched again.
    stub.rows.push({
      owner: MATE_ID,
      cycle_id: MATE_OLD_CYCLE_ID,
      mode: 'biweekly',
      markdown: cycleFile('6.1-6.14', '- 企鹅的上个周期', '2026-06-14T09:00:00.000Z'),
      updated_at: '2026-08-26T10:00:00.000Z',
    });
    stub.calls.length = 0;
    const third = await sync.syncTeamOnce(config);
    // Two rows come back in the body, but only the new one is *applied*: the
    // other is the byte-for-byte row we already hold at the same server
    // version, and re-writing it would be a no-op with a disk write attached.
    // See the versioned-apply suite for why that is the rule and not a saving.
    check('a moved watermark pulls again', third.changed && third.pulled === 1, JSON.stringify(third));
    check('a moved watermark fetches markdown exactly once', bodyRequests(stub).length === 1, JSON.stringify(bodyRequests(stub)));
  }

  // --- 3. cache layout ------------------------------------------------------

  async function testPullAndCacheLayout(): Promise<void> {
    console.log('\n--- cache layout ---');
    const mateDir = path.join(teamCache(), MATE_ID);
    check('teammate cycles are cached under data/team-cache/<owner uuid>/', fs.existsSync(path.join(mateDir, `${MATE_CYCLE_ID}.md`)));
    check('the cache directory is named by uuid, not by member_id', !fs.existsSync(path.join(teamCache(), 'penguin')));
    check('the cached markdown is the teammate\'s file verbatim', fs.readFileSync(path.join(mateDir, `${MATE_CYCLE_ID}.md`), 'utf8').includes('企鹅的要务'));

    // The invariant that matters most: none of this reached 20_CYCLES.
    check('teammate cycles never land in 20_CYCLES/', localCycleFiles().join(',') === `${MINE_ID}.md`, localCycleFiles().join(','));
    check('listCycles still only reports my own cycle', cycleFileModule.listCycles(config).map((doc) => doc.id).join(',') === MINE_ID);

    const cached = cache.listCachedCycles(MATE_ID);
    check('cached cycles are parsed for the page, newest first', cached.length === 2 && cached[0].id === MATE_CYCLE_ID, JSON.stringify(cached.map((doc) => doc.id)));
    check('a cached cycle exposes its sections', Boolean(cached[0].sections['要务']), JSON.stringify(Object.keys(cached[0].sections)));

    const view = await sync.readTeamViewState(config);
    check('the view lists the teammate', view.members.length === 1 && view.members[0].userId === MATE_ID, JSON.stringify(view.members.map((m) => m.userId)));
    check('the teammate label comes from members, not from cycles', view.members[0].label === '企鹅', view.members[0].label);
    check('the view never lists me as a teammate', !view.members.some((member) => member.userId === SELF_ID));
    check('the view carries a sync time for the read-only banner', /^\d{4}-\d{2}-\d{2}T/.test(view.syncedAt), view.syncedAt);
  }

  // --- 4. local wins -------------------------------------------------------

  async function testLocalWinsOverRemote(): Promise<void> {
    console.log('\n--- local is the source of truth ---');

    const localBefore = fs.readFileSync(path.join(cycles, `${MINE_ID}.md`), 'utf8');
    const stub = makeStub({
      rows: [
        // An old copy of my own cycle, as if another machine pushed it, plus the
        // teammate rows. Neither may touch my local file.
        { owner: SELF_ID, cycle_id: MINE_ID, mode: 'biweekly', markdown: cycleFile('8.24-9.6', '- 远端的旧版本', '2020-01-01T00:00:00.000Z'), updated_at: '2030-01-01T00:00:00.000Z' },
        { owner: MATE_ID, cycle_id: MINE_ID, mode: 'biweekly', markdown: cycleFile('8.24-9.6', '- 企鹅的同名周期'), updated_at: '2026-08-27T10:00:00.000Z' },
      ],
    });
    bridge.setTeamSessionProviderForTests(stub);
    const result = await sync.syncTeamOnce(config);
    check('sync succeeds with a remote copy of my own cycle present', result.status === 'ok', JSON.stringify(result));
    check(
      'a newer remote row for my own cycle does not overwrite my local file',
      fs.readFileSync(path.join(cycles, `${MINE_ID}.md`), 'utf8') === localBefore,
    );
    const bodyQuery = bodyRequests(stub)[0]?.path || '';
    check('the body query excludes my own rows at the source', bodyQuery.includes(`owner=neq.${SELF_ID}`), bodyQuery);
    check('my own uuid is never given a cache directory', !fs.existsSync(path.join(teamCache(), SELF_ID)));
    check(
      'a teammate cycle with the same id as mine is cached separately',
      fs.readFileSync(path.join(teamCache(), MATE_ID, `${MINE_ID}.md`), 'utf8').includes('企鹅的同名周期'),
    );

    // Belt and braces: even called directly, the cache writer refuses.
    let refusedSelf = '';
    try {
      cache.writeCachedCycle(config, SELF_ID, SELF_ID, MINE_ID, '# not mine to cache');
    } catch (error) {
      refusedSelf = error instanceof Error ? error.message : String(error);
    }
    check('the cache writer refuses to cache my own cycle', refusedSelf.includes('Refusing to cache your own cycle'), refusedSelf);

    for (const badOwner of ['penguin', '../../vault/20_CYCLES', '', '..']) {
      let refused = '';
      try {
        cache.writeCachedCycle(config, SELF_ID, badOwner, MINE_ID, '# escape');
      } catch (error) {
        refused = error instanceof Error ? error.message : String(error);
      }
      check(`the cache writer refuses a non-uuid owner: ${badOwner || '(empty)'}`, refused.includes('non-uuid owner'), refused);
    }
    check('nothing escaped into 20_CYCLES/', localCycleFiles().join(',') === `${MINE_ID}.md`, localCycleFiles().join(','));
  }

  // --- 5. rename ------------------------------------------------------------

  async function testRenameKeepsCache(): Promise<void> {
    console.log('\n--- rename ---');
    const before = cache.listCachedCycles(MATE_ID).length;
    check('the teammate has cached cycles before the rename', before > 0, String(before));

    const stub = makeStub({
      rows: [
        { owner: MATE_ID, cycle_id: MATE_CYCLE_ID, mode: 'biweekly', markdown: cycleFile('8.24-9.6', '- 改名后写的要务'), updated_at: '2026-09-01T10:00:00.000Z' },
      ],
      members: [
        { userId: SELF_ID, memberId: 'leon', displayName: 'Leon' },
        // Same person, both labels changed. Nothing keys off either.
        { userId: MATE_ID, memberId: 'pengpeng', displayName: '胖企鹅' },
      ],
    });
    bridge.setTeamSessionProviderForTests(stub);
    await sync.syncTeamOnce(config);

    const view = await sync.readTeamViewState(config);
    check('after a rename the teammate is still one person, not two', view.members.length === 1, JSON.stringify(view.members.map((m) => m.label)));
    check('the new label is shown', view.members[0].label === '胖企鹅', view.members[0].label);
    check('the cache is still filed under the uuid', fs.existsSync(path.join(teamCache(), MATE_ID)));
    check('no directory was created for either label', !fs.existsSync(path.join(teamCache(), 'penguin')) && !fs.existsSync(path.join(teamCache(), 'pengpeng')));
    check(
      'cycles pulled before the rename are still attached to the same member',
      view.members[0].cycles.some((doc) => doc.id === MATE_OLD_CYCLE_ID),
      JSON.stringify(view.members[0].cycles.map((doc) => doc.id)),
    );
    check(
      'and the newly pulled content landed in the same directory',
      fs.readFileSync(path.join(teamCache(), MATE_ID, `${MATE_CYCLE_ID}.md`), 'utf8').includes('改名后写的要务'),
    );

    // A member whose labels we never learned still renders.
    const unlabeled = makeStub({ rows: [], members: [{ userId: SELF_ID, memberId: 'leon', displayName: 'Leon' }] });
    bridge.setTeamSessionProviderForTests(unlabeled);
    await sync.syncTeamOnce(config);
    const fallbackView = await sync.readTeamViewState(config);
    check(
      'a cached owner with no members row still gets a label',
      fallbackView.members.some((member) => member.userId === MATE_ID && member.label.length > 0),
      JSON.stringify(fallbackView.members.map((m) => m.label)),
    );
  }

  // --- 5b. daily plans --------------------------------------------------------

  async function testDailyPlans(): Promise<void> {
    console.log('\n--- daily plans ---');
    const today = todayInTimezone(config);
    const yesterday = addDays(today, -1);
    const matePlan = (date: string, text: string): PlanRow => ({
      owner: MATE_ID,
      plan_date: date,
      payload: { generated_at: `${date}T00:30:00.000Z`, todos: [{ rank: 1, text, candidateId: 'linear:CUTTO-1' }], feedback: { 'linear:CUTTO-1': 'complete' } },
      updated_at: `${date}T09:00:00.000Z`,
    });

    // My own plan: what the morning run wrote, plus one row I already ticked.
    const myPlanContent = JSON.stringify({
      todos: [{ rank: 1, text: '我的第一件事', candidateId: 'linear:LEO-1' }, { rank: 2, text: '第二件', candidateId: 'inbox:abc' }],
    });
    memory.writeLatestWorkflowOutput(config, 'daily_plan', today, myPlanContent);
    feedback.recordTodoFeedback(config, { date: today, event: 'complete', candidateId: 'linear:LEO-1', rank: 1 });

    const stub = makeStub({ rows: [], plans: [matePlan(today, '企鹅今天的事')] });
    bridge.setTeamSessionProviderForTests(stub);
    const first = await sync.syncTeamOnce(config);
    check('the tick pushes my plan and pulls the teammate plan', first.status === 'ok' && first.plansPushed === 1 && first.plansPulled === 1, JSON.stringify(first));

    const push = planPushes(stub)[0];
    const row = push?.body?.[0] || {};
    check('my plan is uploaded under my own uuid and its own date', row.owner === SELF_ID && row.plan_date === today && row.team_id === TEAM_ID, JSON.stringify(row).slice(0, 200));
    check('the uploaded payload carries the todos', (row.payload?.todos || []).length === 2, JSON.stringify(row.payload?.todos));
    check('the uploaded payload carries my ticked state', row.payload?.feedback?.['linear:LEO-1'] === 'complete', JSON.stringify(row.payload?.feedback));
    check('the upload is an upsert on the plan key', push.path.includes('on_conflict=team_id,owner,plan_date'), push.path);

    const cachedPlanPath = path.join(teamCache(), MATE_ID, 'daily', `${today}.json`);
    check('the teammate plan is cached under <owner uuid>/daily/<date>.json', fs.existsSync(cachedPlanPath), cachedPlanPath);
    check('plan json never lands next to the cycle markdown', !fs.existsSync(path.join(teamCache(), MATE_ID, `${today}.json`)));
    check('the plan cache does not show up as a cycle', cache.listCachedCycles(MATE_ID).every((doc) => doc.id !== today));
    check('nothing escaped into 20_CYCLES/', localCycleFiles().join(',') === `${MINE_ID}.md`, localCycleFiles().join(','));

    // Idle: nothing re-sent, nothing re-fetched.
    stub.calls.length = 0;
    const idle = await sync.syncTeamOnce(config);
    check('an unchanged plan is not re-uploaded', idle.plansPushed === 0 && planPushes(stub).length === 0, JSON.stringify(stub.calls));
    check('an unchanged remote fetches no plan payloads', idle.plansPulled === 0 && planBodyRequests(stub).length === 0, JSON.stringify(planBodyRequests(stub)));

    // One run stamps `generated_at` twice — `writeLatestWorkflowOutput` and
    // `writeWorkflowDetailCache` each call `new Date()` — so the pointer copy
    // and the cache copy of the *same* plan disagree by a few ms. When the
    // 21:30 review takes the pointer, the snapshot falls back to the cache and
    // the plan arrives carrying the other timestamp. Identical rows, identical
    // states, and under a hash that included `generated_at`, a second upsert
    // every single night. The spin makes the two stamps provably differ, so a
    // hash that regressed cannot pass this by landing in the same millisecond.
    while (Date.now() === Date.parse(memory.readLatestWorkflowOutput(config)?.generated_at || '')) {
      /* spin to the next millisecond */
    }
    memory.writeWorkflowDetailCache(config, 'daily_plan', today, myPlanContent);
    memory.writeLatestWorkflowOutput(config, 'daily_review', today, '## 今日回顾');
    stub.calls.length = 0;
    const afterReview = await sync.syncTeamOnce(config);
    // Guard against the vacuous pass: "pushed nothing" is only the right answer
    // while there is still a plan there to push.
    const afterReviewSnapshot = todayPlan.buildTodayPlanSnapshot(config);
    check(
      'the review moved the snapshot onto the cache copy, timestamp and all',
      afterReviewSnapshot?.todos.some((todo) => todo.candidateId === 'linear:LEO-1') === true &&
        afterReviewSnapshot?.generated_at !== push?.body?.[0]?.payload?.generated_at,
      JSON.stringify({ was: push?.body?.[0]?.payload?.generated_at, now: afterReviewSnapshot?.generated_at }),
    );
    check(
      'and an unchanged plan is still not re-uploaded, so the review costs no upsert',
      afterReview.plansPushed === 0 && planPushes(stub).length === 0,
      JSON.stringify(planPushes(stub).map((call) => call.body?.[0]?.payload?.generated_at)),
    );

    // Ticking a row is a change worth pushing: that is the whole point.
    feedback.recordTodoFeedback(config, { date: today, event: 'defer', candidateId: 'inbox:abc', rank: 2 });
    stub.calls.length = 0;
    const afterTick = await sync.syncTeamOnce(config);
    check('a feedback change re-uploads the plan', afterTick.plansPushed === 1, JSON.stringify(afterTick));
    check('the re-upload carries the new state', planPushes(stub)[0]?.body?.[0]?.payload?.feedback?.['inbox:abc'] === 'defer', JSON.stringify(planPushes(stub)[0]?.body));
    check('my own push does not trigger a teammate plan re-download', planBodyRequests(stub).length === 0, JSON.stringify(planBodyRequests(stub)));

    // The Today view.
    const view = await sync.readTeamTodayState(config);
    check('the today view is ready', view.status === 'ready' && view.today === today, JSON.stringify({ status: view.status, today: view.today }));
    const mate = view.members.find((member) => member.userId === MATE_ID);
    check('the teammate is listed with a plan', Boolean(mate?.plan), JSON.stringify(view.members.map((m) => m.label)));
    check('the teammate plan content reaches the view', JSON.stringify(mate?.plan?.payload).includes('企鹅今天的事'));
    check('a plan from today is not stale', mate?.stale === false, String(mate?.stale));
    check('the view never lists me', view.members.every((member) => member.userId !== SELF_ID));

    // Stale: her morning run hasn't happened, so her last plan is yesterday's.
    fs.rmSync(path.join(teamCache(), MATE_ID, 'daily'), { recursive: true, force: true });
    const staleStub = makeStub({ rows: [], plans: [{ ...matePlan(yesterday, '企鹅昨天的事'), updated_at: `${today}T01:00:00.000Z` }] });
    bridge.setTeamSessionProviderForTests(staleStub);
    await sync.syncTeamOnce(config);
    const staleView = await sync.readTeamTodayState(config);
    const staleMate = staleView.members.find((member) => member.userId === MATE_ID);
    check("yesterday's plan is still shown", JSON.stringify(staleMate?.plan?.payload).includes('企鹅昨天的事'), JSON.stringify(staleMate?.plan));
    check('and flagged stale', staleMate?.stale === true && staleMate?.plan?.date === yesterday, JSON.stringify({ stale: staleMate?.stale, date: staleMate?.plan?.date }));

    // A remote row under my own uuid is never cached, even if the filter is wrong.
    const selfRowStub = makeStub({ rows: [], plans: [matePlan(today, '企鹅今天的事'), { ...matePlan(today, '不该被缓存'), owner: SELF_ID, updated_at: `${today}T12:00:00.000Z` }] });
    bridge.setTeamSessionProviderForTests(selfRowStub);
    await sync.syncTeamOnce(config);
    check('my own remote row is never written to the cache', !fs.existsSync(path.join(teamCache(), SELF_ID)));
    check('the teammate plan is back for the console suite', fs.existsSync(cachedPlanPath));

    // A project that never ran the daily_plans migration: cycles keep syncing,
    // and the reason says which file to run rather than quoting PostgREST.
    const noTable = makeStub({
      rows: [{ owner: MATE_ID, cycle_id: MATE_CYCLE_ID, mode: 'biweekly', markdown: cycleFile('8.24-9.6', '- 没有 daily_plans 表时的要务'), updated_at: `${today}T14:00:00.000Z` }],
      plansTable: false,
    });
    bridge.setTeamSessionProviderForTests(noTable);
    const withoutTable = await sync.syncTeamOnce(config);
    check('a missing daily_plans table does not stop cycle sync', withoutTable.status === 'ok' && withoutTable.pulled === 1, JSON.stringify(withoutTable));
    check('and the reason points at the migration file', withoutTable.reason.includes('20260919000000_daily_plans.sql'), withoutTable.reason);
    check('the missing table is surfaced on the today view', (await sync.readTeamTodayState(config)).lastError.includes('daily_plans'));

    // A teammate who joined but has not pushed a plan yet is still listed.
    const NEWCOMER_ID = '44444444-4444-4444-8444-444444444444';
    const newcomerStub = makeStub({
      rows: [],
      plans: [matePlan(today, '企鹅今天的事')],
      members: [
        { userId: SELF_ID, memberId: 'leon', displayName: 'Leon' },
        { userId: MATE_ID, memberId: 'penguin', displayName: '企鹅' },
        { userId: NEWCOMER_ID, memberId: 'new', displayName: '新人' },
      ],
    });
    bridge.setTeamSessionProviderForTests(newcomerStub);
    newcomerStub.plans.push({ ...matePlan(today, '企鹅今天的事'), updated_at: `${today}T13:00:00.000Z` });
    await sync.syncTeamOnce(config);
    const withNewcomer = await sync.readTeamTodayState(config);
    const newcomer = withNewcomer.members.find((member) => member.userId === NEWCOMER_ID);
    check('a teammate with no plan yet is listed with plan: null', Boolean(newcomer) && newcomer?.plan === null, JSON.stringify(withNewcomer.members.map((m) => [m.label, Boolean(m.plan)])));
  }

  // --- 6. write guards ------------------------------------------------------

  async function testWriteGuards(): Promise<void> {
    console.log('\n--- write guards ---');
    const stub = makeStub();
    bridge.setTeamSessionProviderForTests(stub);

    await sync.assertLocalCycleWriteTarget(config, '');
    check('a write that names no owner targets my own vault and is allowed', true);
    await sync.assertLocalCycleWriteTarget(config, SELF_ID);
    check('a write that names me is allowed', true);

    let rejected = '';
    try {
      await sync.assertLocalCycleWriteTarget(config, MATE_ID);
    } catch (error) {
      rejected = error instanceof Error ? error.message : String(error);
    }
    check('a write aimed at a teammate is rejected', rejected.includes('只读'), rejected);

    let rejectedOther = '';
    try {
      await sync.assertLocalCycleWriteTarget(config, OTHER_TEAM_MATE_ID);
    } catch (error) {
      rejectedOther = error instanceof Error ? error.message : String(error);
    }
    check('a write aimed at an unknown uuid is rejected', rejectedOther.includes('只读'), rejectedOther);

    // And the remote refuses too, the way RLS does — the client assert is the
    // first of two layers, not the only one.
    const forged = await stub.supabaseFetch(config, '/rest/v1/cycles?on_conflict=team_id,owner,cycle_id', {
      method: 'POST',
      body: JSON.stringify([{ team_id: TEAM_ID, owner: MATE_ID, cycle_id: MINE_ID, mode: 'biweekly', markdown: '# forged' }]),
    });
    check('the remote rejects a row owned by someone else', forged.status === 403, String(forged.status));
  }

  // --- 7. through the real console server -----------------------------------

  async function testUiServer(): Promise<void> {
    console.log('\n--- console server ---');
    const auth = await import('../../src/ui/auth.js');
    const { startUiServer } = await import('../../src/ui/server.js');
    auth.resetSessionCacheForTests();
    auth.addUser('admin', 'admin-password-1', 'admin');

    // Newer than everything the earlier suites cached. Applying a pulled row is
    // versioned by the server clock now, so a fixture that wants to be seen has
    // to actually be the newest — the daily-plan suite above pulls rows stamped
    // with the real `today`, which a hardcoded 2026-09-02 would lose to.
    const stub = makeStub({
      rows: [
        {
          owner: MATE_ID,
          cycle_id: MATE_CYCLE_ID,
          mode: 'biweekly',
          markdown: cycleFile('8.24-9.6', '- 企鹅在控制台里的要务'),
          updated_at: `${addDays(todayInTimezone(config), 1)}T10:00:00.000Z`,
        },
      ],
    });
    bridge.setTeamSessionProviderForTests(stub);

    const controls = await startUiServer({ configPath: 'config/config.yaml', envPath: '.env', host: '127.0.0.1', port: 0, open: false });
    const base = controls.url;
    try {
      const login = await fetch(`${base}/api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'admin-password-1' }),
      });
      const cookie = cookieFrom(login.headers.get('set-cookie'));
      const authed = { cookie, 'content-type': 'application/json' };
      const readState = async (): Promise<any> => (await (await fetch(`${base}/api/state`, { headers: { cookie } })).json()) as any;
      const saveSection = async (body: unknown): Promise<{ status: number; body: any }> => {
        const response = await fetch(`${base}/api/cycles/section`, { method: 'POST', headers: authed, body: JSON.stringify(body) });
        return { status: response.status, body: (await response.json()) as any };
      };

      const synced = await (await fetch(`${base}/api/team/sync`, { method: 'POST', headers: authed, body: '{}' })).json() as any;
      check('the console can run a sync tick', synced?.ok === true && synced?.sync?.status === 'ok', JSON.stringify(synced?.sync));

      const state = await readState();
      check('state exposes a team block', Boolean(state?.team), JSON.stringify(Object.keys(state || {})));
      check('team status is ready when signed in with a team', state?.team?.view?.status === 'ready', String(state?.team?.view?.status));
      check('team members carry cached cycles for the switcher', (state?.team?.view?.members?.[0]?.cycles || []).length > 0, JSON.stringify(state?.team?.view?.members?.[0]?.cycles?.length));
      check('the teammate cycle content reaches the page', JSON.stringify(state?.team?.view?.members?.[0]?.cycles || []).includes('企鹅在控制台里的要务'));
      check('my own cycles are still listed separately', (state?.cycles?.items || []).some((item: any) => item.id === MINE_ID));

      const teamToday = (await (await fetch(`${base}/api/team/today`, { headers: { cookie } })).json()) as any;
      check('/api/team/today is ready when signed in with a team', teamToday?.ok === true && teamToday?.status === 'ready', JSON.stringify(teamToday).slice(0, 200));
      check('/api/team/today carries the teammate plan', JSON.stringify(teamToday?.members || []).includes('企鹅今天的事'), JSON.stringify(teamToday?.members).slice(0, 200));
      const todayPage = await (await fetch(`${base}/today`, { headers: { cookie } })).text();
      check('the Today page has the team panel', todayPage.includes('id="team-today"') && todayPage.includes('/api/team/today'));
      check(
        'the teammate cycle is not in my own cycle list',
        (state?.cycles?.items || []).every((item: any) => !JSON.stringify(item).includes('企鹅在控制台里的要务')),
      );

      // The read-only rule, on the write path.
      const mineBefore = fs.readFileSync(path.join(cycles, `${MINE_ID}.md`), 'utf8');
      const forged = await saveSection({ id: MINE_ID, section: 'retro', content: '不该写进去', owner: MATE_ID });
      check('a save that names a teammate as owner is refused', forged.body?.ok === false, JSON.stringify(forged.body).slice(0, 160));
      check('the refused save left my file byte-identical', fs.readFileSync(path.join(cycles, `${MINE_ID}.md`), 'utf8') === mineBefore);
      check(
        'the refused save left the teammate cache byte-identical',
        fs.readFileSync(path.join(teamCache(), MATE_ID, `${MATE_CYCLE_ID}.md`), 'utf8').includes('企鹅在控制台里的要务'),
      );

      // Regression: the existing editor still works, and now pushes.
      const saved = await saveSection({ id: MINE_ID, section: 'retro', content: '通过控制台写的 retro' });
      check('saving my own section still works', saved.status === 200 && saved.body?.ok === true, JSON.stringify(saved.body).slice(0, 160));
      check('the save is on disk', fs.readFileSync(path.join(cycles, `${MINE_ID}.md`), 'utf8').includes('通过控制台写的 retro'));
      check('the save reports the sync outcome', saved.body?.sync?.status === 'ok', JSON.stringify(saved.body?.sync));
      check(
        'the saved section was uploaded under my own uuid',
        stub.rows.some((row) => row.owner === SELF_ID && row.cycle_id === MINE_ID && row.markdown.includes('通过控制台写的 retro')),
        JSON.stringify(stub.rows.map((row) => `${row.owner}:${row.cycle_id}`)),
      );

      // Regression, and a bug that predates this change: the save handler
      // called `pushLocalCycle` directly, so a save landing during the 60s
      // tick had both paths read-modify-writing `state.json` independently —
      // whichever finished last silently dropped the other's work (a freshly
      // pulled watermark, or the push hash that stops a re-upload every
      // minute). Both go through the loop's queue now. With every request held
      // open, two jobs running at once would be visible as an overlap.
      stub.delayMs = 10;
      stub.maxConcurrent = 0;
      const [, concurrentSave] = await Promise.all([
        fetch(`${base}/api/team/sync`, { method: 'POST', headers: authed, body: '{}' }),
        saveSection({ id: MINE_ID, section: 'review', content: '与同步并发的保存' }),
      ]);
      stub.delayMs = 0;
      check('a save and a sync tick are never in flight together', stub.maxConcurrent === 1, String(stub.maxConcurrent));
      check('the concurrent save still succeeded locally', concurrentSave.body?.ok === true, JSON.stringify(concurrentSave.body).slice(0, 160));
      check(
        'and it still reached the remote',
        stub.rows.some((row) => row.owner === SELF_ID && row.markdown.includes('与同步并发的保存')),
        JSON.stringify(stub.rows.map((row) => `${row.owner}:${row.cycle_id}`)),
      );

      // Degraded: signing out must not break the editor.
      stub.session = null;
      const signedOutState = await readState();
      check('signed out, the team block says so', signedOutState?.team?.view?.status === 'signed_out', String(signedOutState?.team?.view?.status));
      check('signed out, no teammate cycles are offered', (signedOutState?.team?.view?.members || []).length === 0);
      check('signed out, my own cycles are still listed', (signedOutState?.cycles?.items || []).some((item: any) => item.id === MINE_ID));
      const offlineSave = await saveSection({ id: MINE_ID, section: 'retro', content: '登出后仍然能写' });
      check('signed out, saving my own section still works', offlineSave.body?.ok === true, JSON.stringify(offlineSave.body).slice(0, 160));
      check('signed out, a save that names any owner is refused', (await saveSection({ id: MINE_ID, section: 'retro', content: 'x', owner: MATE_ID })).body?.ok === false);

      stub.session = { userId: SELF_ID, email: 'a@b.c', accessToken: 't', teamId: null, memberId: 'leon' };
      const noTeamState = await readState();
      check('with no team, the team block says so', noTeamState?.team?.view?.status === 'no_team', String(noTeamState?.team?.view?.status));
      check('with no team, the reason is explained', String(noTeamState?.team?.view?.reason || '').includes('团队'), String(noTeamState?.team?.view?.reason));

      // Regression: the two neighbouring pages are untouched by all of this.
      const finalState = await readState();
      check('Review Strategy still lists its files', (finalState?.strategy?.files || []).length > 0);
      check('Decision Policy still resolves its notes file', String(finalState?.decisionPolicy?.notesPath || '').startsWith(vault));
      const policySave = await fetch(`${base}/api/decision-policy`, {
        method: 'POST',
        headers: authed,
        body: JSON.stringify({ policyMd: '# 决策规则\n- 先看长期影响\n' }),
      });
      check('Decision Policy still saves', policySave.status === 200);
      const strategySave = await fetch(`${base}/api/strategy`, {
        method: 'POST',
        headers: authed,
        body: JSON.stringify({ id: 'biweekly_strategy', markdown: '计划条目规则（下双周要务）：\n- 自定义\n' }),
      });
      check('Review Strategy still saves', strategySave.status === 200);
    } finally {
      await controls.stop();
    }
  }

  // --- 8. the shipped /cycles script ----------------------------------------

  async function testConsoleRendering(): Promise<void> {
    console.log('\n--- cycles page rendering ---');
    const page = await loadCyclesPage();

    const teamState = {
      status: 'ready',
      reason: '',
      cacheDir: '/tmp/data/team-cache',
      self: { userId: SELF_ID, memberId: 'leon', displayName: 'Leon' },
      syncedAt: '2026-09-02T10:00:00.000Z',
      lastCheckedAt: '2026-09-02T10:00:00.000Z',
      lastError: '',
      members: [
        {
          userId: MATE_ID,
          memberId: 'penguin',
          displayName: '企鹅',
          label: '企鹅',
          cycles: [
            {
              id: MATE_CYCLE_ID,
              startDate: '2026-08-24',
              cycle: '8.24-9.6',
              mode: 'biweekly',
              updatedAt: '2026-08-24T08:00:00.000Z',
              frontmatterError: '',
              sections: { 要务: { content: '- 企鹅的要务', source: 'planner', updatedAt: '2026-08-24T08:00:00.000Z' } },
            },
          ],
        },
      ],
    };
    const myCycles = {
      dir: '/tmp/vault/20_CYCLES',
      items: [
        {
          id: MINE_ID,
          startDate: '2026-08-24',
          cycle: '8.24-9.6',
          mode: 'biweekly',
          updatedAt: '2026-08-24T08:00:00.000Z',
          path: '/tmp/vault/20_CYCLES/' + MINE_ID + '.md',
          frontmatterError: '',
          sections: { 要务: { content: '- 我的要务', source: 'planner', updatedAt: '2026-08-24T08:00:00.000Z' } },
        },
      ],
    };

    page.setState({ cycles: myCycles, team: { view: teamState } });
    page.render();

    // Own view: exactly as before this change.
    check('my own view shows the editors', page.el('cycle-cards').hidden === false);
    page.editMode('retro');
    check('my own view keeps the save buttons', page.el('cycle-actions-retro').hidden === false);
    check('my own view is editable', page.el('cycle-md-retro').readOnly !== true);
    check('my own view shows no read-only banner', page.el('cycle-readonly').hidden === true);
    check('my own content is rendered', page.el('cycle-md-priorities').value === '- 我的要务', page.el('cycle-md-priorities').value);
    check('the member switcher is offered', page.el('cycle-members').hidden === false);
    check('the switcher shows me and the teammate', page.el('cycle-members').innerHTML.includes('企鹅') && page.el('cycle-members').innerHTML.includes('Leon'));
    check('the switcher is keyed by uuid, not by member_id', page.el('cycle-members').innerHTML.includes(MATE_ID) && !page.el('cycle-members').innerHTML.includes('"penguin"'));

    // A draft in my own view, to prove switching does not disturb it.
    page.el('cycle-md-retro').value = '还没保存的 retro';
    page.fire('cycle-md-retro', 'input');

    page.click('cycle-members', MATE_ID);
    check('the teammate view renders their cycle', page.el('cycle-md-priorities').value === '- 企鹅的要务', page.el('cycle-md-priorities').value);
    check('the teammate view hides every save control', ['priorities', 'retro', 'review'].every((key) => page.el('cycle-actions-' + key).hidden === true));
    check('the teammate view disables the save buttons too', ['priorities', 'retro', 'review'].every((key) => page.el('cycle-save-' + key).disabled === true));
    check('the teammate view makes the text read-only', ['priorities', 'retro', 'review'].every((key) => page.el('cycle-md-' + key).readOnly === true));
    const banner = page.el('cycle-readonly');
    check('the teammate view is labelled', banner.hidden === false && banner.textContent.includes('企鹅') && banner.textContent.includes('只读'), banner.textContent);
    check('the banner reports when it was synced', banner.textContent.includes('同步于'), banner.textContent);
    check(
      'the teammate view shows the cache dir, not my vault',
      page.el('cycle-file-path').textContent.includes(MATE_ID) && !page.el('cycle-file-path').textContent.includes('20_CYCLES'),
      page.el('cycle-file-path').textContent,
    );

    // Typing in a read-only view must not create a draft under a colliding id.
    page.el('cycle-md-retro').value = '试图改队友的';
    page.fire('cycle-md-retro', 'input');

    page.click('cycle-members', '');
    check('switching back restores my own cycle', page.el('cycle-md-priorities').value === '- 我的要务', page.el('cycle-md-priorities').value);
    check('my unsaved draft survived the round trip', page.el('cycle-md-retro').value === '还没保存的 retro', page.el('cycle-md-retro').value);
    page.editMode('retro');
    check('the save controls come back', page.el('cycle-actions-retro').hidden === false);
    check('the read-only banner goes away', page.el('cycle-readonly').hidden === true);

    // Teammate with nothing synced yet.
    page.setState({ cycles: myCycles, team: { view: { ...teamState, members: [{ ...teamState.members[0], cycles: [] }] } } });
    page.render();
    page.click('cycle-members', MATE_ID);
    check('an empty teammate gets an explicit empty state', page.el('cycle-detail-empty').hidden === false);
    check('the empty state names the teammate', page.el('cycle-detail-empty').textContent.includes('企鹅'), page.el('cycle-detail-empty').textContent);
    check('the empty state is not the "no cycle files at all" one', page.el('cycles-empty').hidden === true);
    check('the editors are hidden rather than showing a blank form', page.el('cycle-cards').hidden === true);

    // Not signed in: no switcher, and a line saying why.
    page.setState({ cycles: myCycles, team: { view: { ...teamState, status: 'signed_out', reason: '尚未登录团队账号，同步已暂停，本地读写不受影响。', members: [] } } });
    page.render();
    check('signed out, no owner is selectable', !page.el('cycle-members').innerHTML.includes('data-owner-id'), page.el('cycle-members').innerHTML);
    check('signed out, the reason is shown', page.el('cycle-team-status').textContent.includes('尚未登录'), page.el('cycle-team-status').textContent);
    page.editMode('retro');
    check('signed out, my own editors are untouched', page.el('cycle-cards').hidden === false && page.el('cycle-actions-retro').hidden === false);
    check('signed out, my own cycle still renders', page.el('cycle-md-priorities').value === '- 我的要务', page.el('cycle-md-priorities').value);

    // No team yet.
    page.setState({ cycles: myCycles, team: { view: { ...teamState, status: 'no_team', reason: '账号还没有加入团队，暂时看不到队友的周期，本地读写不受影响。', members: [] } } });
    page.render();
    check(
      'with no team, the switcher is empty and explained',
      !page.el('cycle-members').innerHTML.includes('data-owner-id') && page.el('cycle-team-status').textContent.includes('团队'),
    );

    // A failed sync while signed in still shows the teammate, flagged.
    page.setState({ cycles: myCycles, team: { view: { ...teamState, lastError: 'fetch failed' } } });
    page.render();
    check('a sync failure is surfaced on the page', page.el('cycle-team-status').textContent.includes('fetch failed'), page.el('cycle-team-status').textContent);
    check('a sync failure still lets me read the cached teammate data', page.el('cycle-members').hidden === false);
  }

  // --- 9. push on change ------------------------------------------------------

  /**
   * The latency half. An edit should leave the machine in about a second
   * whether it was made in the console, in Obsidian, or by the planner
   * subprocess — without turning "I held down cmd+S" into a request storm.
   */
  async function testInstantPush(): Promise<void> {
    console.log('\n--- push on change ---');
    fs.rmSync(teamCache(), { recursive: true, force: true });
    const minePath = path.join(cycles, `${MINE_ID}.md`);
    const today = todayInTimezone(config);
    // Long enough that the backstop tick can never fire inside a suite: every
    // push asserted below has to come from a watcher or the change bus.
    const noTicks = 3_600_000;

    const watch = makeFakeWatch();
    const bus = makeFakeBus();
    const stub = makeStub({ rows: [] });
    bridge.setTeamSessionProviderForTests(stub);
    const loop = sync.startTeamSync(() => config, { intervalMs: noTicks, debounceMs: 20, watchDir: watch.watchDir, subscribe: bus.subscribe });
    try {
      await loop.flush(); // the tick startTeamSync fires on start
      check('the watcher is pointed at the cycles directory', watch.dirs.length === 1 && watch.dirs[0] === cycleFileModule.cyclesDir(config), JSON.stringify(watch.dirs));

      // One editor save fires 2-4 events; a git checkout fires one per file.
      stub.calls.length = 0;
      for (let index = 0; index < 6; index += 1) {
        fs.writeFileSync(minePath, cycleFile('8.24-9.6', `- **MIT** 第 ${index} 次编辑`, `2026-09-1${index}T08:00:00.000Z`), 'utf8');
        watch.emit(`${MINE_ID}.md`);
      }
      await loop.flush();
      const pushes = cyclePushes(stub);
      check('a burst of file events produces exactly one push', pushes.length === 1, JSON.stringify(stub.calls.map((call) => `${call.method} ${call.path}`)));
      check(
        'the content is read at send time, so several edits collapse to the last',
        String(pushes[0]?.body?.[0]?.markdown || '').includes('第 5 次编辑'),
        String(pushes[0]?.body?.[0]?.markdown || '').slice(0, 160),
      );
      check('and no intermediate state was ever sent', !JSON.stringify(stub.calls).includes('第 2 次编辑'));

      // The noise a real fs.watch also reports.
      stub.calls.length = 0;
      watch.emit(`.${MINE_ID}.md.4321.1788888888888.tmp`); // writeFileAtomic's sibling
      watch.emit('README.md');
      watch.emit('.DS_Store');
      watch.emit('');
      await loop.flush();
      check(
        'temp files and non-cycle names push nothing',
        cyclePushes(stub).length === 0,
        JSON.stringify(stub.calls.map((call) => `${call.method} ${call.path}`)),
      );

      // An event for a file whose bytes did not move: the hash gate still holds.
      stub.calls.length = 0;
      watch.emit(`${MINE_ID}.md`);
      await loop.flush();
      check('an unchanged file is not re-sent just because it was touched', cyclePushes(stub).length === 0, JSON.stringify(stub.calls));

      // Regression (found writing this suite): a flush with nothing pending
      // used to wedge the runner for good. `drain()` stored its own promise
      // *after* the async body had already run to completion and cleared the
      // in-flight marker, so on an empty queue the marker stayed set forever
      // and every later push was silently swallowed — no error, no request,
      // sync just quietly stopped working until the process restarted.
      await loop.flush();
      await loop.flush();
      stub.calls.length = 0;
      fs.writeFileSync(minePath, cycleFile('8.24-9.6', '- **MIT** 空转之后写的', '2026-09-18T08:00:00.000Z'), 'utf8');
      watch.emit(`${MINE_ID}.md`);
      await loop.flush();
      check('a flush with an empty queue does not wedge the runner', cyclePushes(stub).length === 1, JSON.stringify(stub.calls.map((call) => `${call.method} ${call.path}`)));

      // The plan side, through the injected bus.
      memory.writeLatestWorkflowOutput(
        config,
        'daily_plan',
        today,
        JSON.stringify({ todos: [{ rank: 1, text: '起床', candidateId: 'inbox:a' }, { rank: 2, text: '写论文', candidateId: 'inbox:b' }] }),
      );
      await loop.flush();
      stub.calls.length = 0;
      feedback.recordTodoFeedback(config, { date: today, event: 'complete', candidateId: 'inbox:a', rank: 1 });
      bus.emit();
      feedback.recordTodoFeedback(config, { date: today, event: 'defer', candidateId: 'inbox:b', rank: 2 });
      bus.emit();
      feedback.recordTodoFeedback(config, { date: today, event: 'reopen', candidateId: 'inbox:b', rank: 2 });
      bus.emit();
      await loop.flush();
      const plans = planPushes(stub);
      check('three change events in one window produce exactly one plan push', plans.length === 1, JSON.stringify(stub.calls.map((call) => `${call.method} ${call.path}`)));
      check(
        'the snapshot is rebuilt at send time, so the last state is what goes out',
        plans[0]?.body?.[0]?.payload?.feedback?.['inbox:a'] === 'complete' && plans[0]?.body?.[0]?.payload?.feedback?.['inbox:b'] === undefined,
        JSON.stringify(plans[0]?.body?.[0]?.payload?.feedback),
      );
    } finally {
      loop.stop();
    }

    // The real wiring, with no bus injected: the todo ledger and the workflow
    // writer announce for themselves. This is the seam that keeps feedback.ts
    // and memory.ts from ever importing Supabase.
    const realStub = makeStub({ rows: [], plans: [] });
    bridge.setTeamSessionProviderForTests(realStub);
    const realLoop = sync.startTeamSync(() => config, { intervalMs: noTicks, debounceMs: 20, watchDir: watch.watchDir });
    try {
      await realLoop.flush();
      realStub.calls.length = 0;
      feedback.recordTodoFeedback(config, { date: today, event: 'complete', candidateId: 'inbox:b', rank: 2 });
      await realLoop.flush();
      check('recordTodoFeedback pushes the plan without a tick', planPushes(realStub).length === 1, JSON.stringify(realStub.calls.map((call) => `${call.method} ${call.path}`)));

      realStub.calls.length = 0;
      memory.writeLatestWorkflowOutput(config, 'daily_plan', today, JSON.stringify({ todos: [{ rank: 1, text: '新的第一件事', candidateId: 'inbox:c' }] }));
      await realLoop.flush();
      const afterRun = planPushes(realStub);
      check('a daily_plan workflow output pushes the plan without a tick', afterRun.length === 1, JSON.stringify(realStub.calls.map((call) => `${call.method} ${call.path}`)));
      check('and it carries the new plan', JSON.stringify(afterRun[0]?.body?.[0]?.payload?.todos).includes('新的第一件事'), JSON.stringify(afterRun[0]?.body?.[0]?.payload?.todos));

      realStub.calls.length = 0;
      memory.writeLatestWorkflowOutput(config, 'daily_review', today, '## 今日回顾');
      await realLoop.flush();
      check('a workflow output that is not a daily_plan pushes nothing', planPushes(realStub).length === 0, JSON.stringify(realStub.calls.map((call) => `${call.method} ${call.path}`)));

      // Put the plan output back for the suites below.
      memory.writeLatestWorkflowOutput(config, 'daily_plan', today, JSON.stringify({ todos: [{ rank: 1, text: '新的第一件事', candidateId: 'inbox:c' }] }));
      await realLoop.flush();
    } finally {
      realLoop.stop();
    }

    // End to end through the real fs.watch: an edit made outside this process
    // — Obsidian, the planner, a git checkout — leaves without a tick.
    const watchedStub = makeStub({ rows: [] });
    bridge.setTeamSessionProviderForTests(watchedStub);
    const watched = sync.startTeamSync(() => config, { intervalMs: noTicks, debounceMs: 20 });
    try {
      await watched.flush();
      watchedStub.calls.length = 0;
      fs.writeFileSync(minePath, cycleFile('8.24-9.6', '- **MIT** 在 Obsidian 里改的', '2026-09-19T08:00:00.000Z'), 'utf8');
      const arrived = await waitFor(() => cyclePushes(watchedStub).length > 0);
      check('a real file edit is pushed without waiting for a tick', arrived, JSON.stringify(watchedStub.calls.map((call) => `${call.method} ${call.path}`)));
      check(
        'and what arrived is the edit, not a stale body',
        watchedStub.rows.some((row) => row.owner === SELF_ID && row.markdown.includes('在 Obsidian 里改的')),
        JSON.stringify(watchedStub.rows.map((row) => `${row.owner}:${row.cycle_id}`)),
      );
    } finally {
      watched.stop();
    }

    // A watcher that cannot start — no inotify, an fd limit, a cycles directory
    // that does not exist yet — is a degraded mode, not a crash.
    const brokenWatch = (): { close: () => void } => {
      throw new Error('EMFILE: too many open files, watch');
    };
    const tickOnlyStub = makeStub({ rows: [] });
    bridge.setTeamSessionProviderForTests(tickOnlyStub);
    let startupError = '';
    let tickOnly: ReturnType<typeof sync.startTeamSync> | null = null;
    try {
      tickOnly = sync.startTeamSync(() => config, { intervalMs: noTicks, debounceMs: 20, watchDir: brokenWatch });
    } catch (error) {
      startupError = error instanceof Error ? error.message : String(error);
    }
    check('a watcher that cannot start does not throw', startupError === '' && Boolean(tickOnly), startupError);
    if (tickOnly) {
      try {
        const degraded = await tickOnly.runNow();
        check('and sync degrades to tick-only rather than stopping', degraded.status === 'ok', JSON.stringify(degraded));
        check('local editing is unaffected by a dead watcher', cycleFileModule.readCycle(config, MINE_ID)?.id === MINE_ID);
      } finally {
        tickOnly.stop();
      }
    }
  }

  // A directory the OS will not answer for must not take the service with it.
  //
  // LEO-314: `fs.watch` opens the watched directory with a synchronous `open()`
  // on the main thread, so a first-run permission check or a wedged volume froze
  // the whole event loop — service alive, port listening, no request answered.
  // The fix warms the path through the async API first; this asserts the two
  // things that must hold when that warm-up does not come back: the loop still
  // starts, and no watcher is installed.
  async function testSlowDirectoryDegrades(): Promise<void> {
    const slowWatch = makeFakeWatch();
    const slowStub = makeStub({ rows: [] });
    bridge.setTeamSessionProviderForTests(slowStub);
    const missing = { ...config, memory: { ...config.memory, repository_path: path.join(tmp, "nowhere") } };
    const started = Date.now();
    const slowLoop = sync.startTeamSync(() => missing, {
      intervalMs: 3_600_000,
      debounceMs: 20,
      watchDir: slowWatch.watchDir,
      watchWarmupMs: 40,
    });
    try {
      check('startTeamSync returns without waiting on the directory', Date.now() - started < 40);
      await slowLoop.flush();
      check(
        'an unreachable cycles directory installs no watcher',
        slowWatch.dirs.length === 0,
        JSON.stringify(slowWatch.dirs)
      );
      const degraded = await slowLoop.runNow();
      check('and the loop still runs on the tick', degraded.status === 'ok', JSON.stringify(degraded));
    } finally {
      slowLoop.stop();
    }
  }


  // --- 10. single flight ------------------------------------------------------

  /**
   * `state.json` has exactly one writer. Everything — the tick, the watcher,
   * the change bus, the console's 同步 button and its save handler — queues
   * behind the same runner.
   */
  async function testSingleFlight(): Promise<void> {
    console.log('\n--- single flight ---');
    const minePath = path.join(cycles, `${MINE_ID}.md`);
    const stub = makeStub({ rows: [] });
    bridge.setTeamSessionProviderForTests(stub);
    const loop = sync.startTeamSync(() => config, { intervalMs: 3_600_000, debounceMs: 20, watchDir: makeFakeWatch().watchDir });
    try {
      await loop.flush();
      stub.calls.length = 0;
      stub.maxConcurrent = 0;
      // Hold every request open, so two jobs running at once would be visible.
      stub.delayMs = 5;

      const first = loop.runNow();
      // Both of these are requested while the first is still in flight. They
      // must collapse into one further run: not two, and not zero.
      const second = loop.runNow();
      const third = loop.runNow();
      const results = await Promise.all([first, second, third]);
      check('every overlapping caller gets a real result', results.every((result) => result.status === 'ok'), JSON.stringify(results.map((result) => result.status)));
      check('three overlapping tick requests run exactly twice', cycleProbes(stub).length === 2, JSON.stringify(cycleProbes(stub).map((call) => call.path)));
      check('no two sync jobs are ever in flight together', stub.maxConcurrent === 1, String(stub.maxConcurrent));

      // Work that arrives mid-tick must not be dropped.
      fs.writeFileSync(minePath, cycleFile('8.24-9.6', '- **MIT** 同步进行中写的', '2026-09-20T08:00:00.000Z'), 'utf8');
      stub.calls.length = 0;
      stub.maxConcurrent = 0;
      const tick = loop.runNow();
      const push = loop.pushCycle(MINE_ID);
      await Promise.all([tick, push]);
      await loop.flush();
      check(
        'a push requested during a tick is not lost',
        stub.rows.some((row) => row.owner === SELF_ID && row.markdown.includes('同步进行中写的')),
        JSON.stringify(stub.rows.map((row) => `${row.owner}:${row.cycle_id}`)),
      );
      check('and it is sent once, not twice', cyclePushes(stub).length === 1, JSON.stringify(cyclePushes(stub).map((call) => call.path)));
      check('the overlapping push did not overlap', stub.maxConcurrent === 1, String(stub.maxConcurrent));

      stub.delayMs = 0;
      const state = JSON.parse(fs.readFileSync(path.join(teamCache(), 'state.json'), 'utf8')) as Record<string, unknown>;
      check('state.json came out of the storm intact', typeof state.watermark === 'string' && typeof state.pushed === 'object', JSON.stringify(Object.keys(state)));
    } finally {
      loop.stop();
    }
  }

  // --- 11. last writer wins, by the server clock ------------------------------

  /**
   * The correctness half. Arrival order is not authorship order: a retry, a
   * slow response overtaken by a fast one, and (in phase 2) a Realtime frame
   * racing a poll all deliver old rows after new ones.
   */
  async function testVersionedApply(): Promise<void> {
    console.log('\n--- versioned apply ---');
    fs.rmSync(teamCache(), { recursive: true, force: true });
    const cachedMarkdown = (): string => fs.readFileSync(path.join(teamCache(), MATE_ID, `${MATE_CYCLE_ID}.md`), 'utf8');
    const V1 = '2026-09-10T10:00:00.000000+00:00';
    const V2 = '2026-09-10T10:05:00.000000+00:00';
    const mateRow = (text: string, updatedAt: string): RemoteRow => ({
      owner: MATE_ID,
      cycle_id: MATE_CYCLE_ID,
      mode: 'biweekly',
      markdown: cycleFile('8.24-9.6', `- ${text}`),
      updated_at: updatedAt,
    });

    const stub = makeStub({ rows: [mateRow('新版本', V2)] });
    bridge.setTeamSessionProviderForTests(stub);
    const applied = await sync.syncTeamOnce(config);
    check('the first delivery of a row is applied', applied.pulled === 1 && cachedMarkdown().includes('新版本'), JSON.stringify(applied));

    // The same row, older. A retry that overtook a newer write, a rollback, a
    // second machine catching up: they all look exactly like this.
    stub.rows = [mateRow('旧版本', V1)];
    const older = await sync.syncTeamOnce(config);
    check('an older remote row does not overwrite a newer cached one', cachedMarkdown().includes('新版本'), cachedMarkdown().slice(0, 100));
    check('and it is not reported as pulled', older.pulled === 0, JSON.stringify(older));

    // Exactly the version we already hold, delivered a second time.
    stub.rows = [mateRow('重复投递', V2)];
    const duplicate = await sync.syncTeamOnce(config);
    check('a duplicate delivery of the cached version is a no-op', duplicate.pulled === 0 && cachedMarkdown().includes('新版本'), cachedMarkdown().slice(0, 100));

    // ...and this is versioning, not "never write again".
    stub.rows = [mateRow('更新的版本', '2026-09-10T10:06:00+00:00')];
    const newer = await sync.syncTeamOnce(config);
    check('a strictly newer row is still applied', newer.pulled === 1 && cachedMarkdown().includes('更新的版本'), cachedMarkdown().slice(0, 100));

    // The rule that must survive all of the above: the watermark tracks the
    // table, not what we chose to apply, so a pull that applied nothing does
    // not re-fetch the same bodies on the next tick forever.
    stub.rows = [mateRow('又一个旧版本', V1)];
    const rejected = await sync.syncTeamOnce(config);
    check('a rejected row still costs only the one body fetch', rejected.pulled === 0, JSON.stringify(rejected));
    stub.calls.length = 0;
    const settled = await sync.syncTeamOnce(config);
    check(
      'a pull that applied nothing still advanced the watermark',
      bodyRequests(stub).length === 0 && !settled.changed,
      JSON.stringify(stub.calls.map((call) => call.path)),
    );

    // Daily plans carry their version in the cached json instead of in state.
    const today = todayInTimezone(config);
    const planPath = path.join(teamCache(), MATE_ID, 'daily', `${today}.json`);
    const planStub = makeStub({
      rows: [],
      plans: [{ owner: MATE_ID, plan_date: today, payload: { todos: [{ rank: 1, text: '新计划', candidateId: 'x' }] }, updated_at: V2 }],
    });
    bridge.setTeamSessionProviderForTests(planStub);
    await sync.syncTeamOnce(config);
    check('the teammate plan is cached', fs.readFileSync(planPath, 'utf8').includes('新计划'));
    planStub.plans = [{ owner: MATE_ID, plan_date: today, payload: { todos: [{ rank: 1, text: '旧计划', candidateId: 'x' }] }, updated_at: V1 }];
    const stalePlan = await sync.syncTeamOnce(config);
    check(
      'an out-of-order daily plan is a no-op',
      stalePlan.plansPulled === 0 && fs.readFileSync(planPath, 'utf8').includes('新计划'),
      fs.readFileSync(planPath, 'utf8').slice(0, 120),
    );

    // The comparator itself. Every one of these is a way plain string or
    // millisecond comparison gets a real PostgREST timestamp wrong.
    check('trailing-zero trimming does not make two equal instants unequal', cache.isNewerVersion('2026-09-10T10:00:00.5+00:00', '2026-09-10T10:00:00.50+00:00') === false);
    check('microsecond precision is kept', cache.isNewerVersion('2026-09-10T10:00:00.000002+00:00', '2026-09-10T10:00:00.000001+00:00') === true);
    check('instants are compared across offsets, not strings', cache.isNewerVersion('2026-09-10T09:00:00+00:00', '2026-09-10T10:30:00+02:00') === true);
    check('an unreadable incoming version cannot overwrite a good cached one', cache.isNewerVersion('not-a-date', '2026-09-10T10:00:00+00:00') === false);
    check('a good version does beat an unreadable cached one', cache.isNewerVersion('2026-09-10T10:00:00+00:00', 'not-a-date') === true);
    check('the first version seen beats nothing cached', cache.isNewerVersion('2026-09-10T10:00:00+00:00', '') === true);
  }

  // --- 12. retention ----------------------------------------------------------

  async function testRetention(): Promise<void> {
    console.log('\n--- retention ---');
    fs.rmSync(teamCache(), { recursive: true, force: true });
    const today = todayInTimezone(config);
    const dailyDir = path.join(teamCache(), MATE_ID, 'daily');
    const cachedCycle = path.join(teamCache(), MATE_ID, `${MATE_CYCLE_ID}.md`);
    const statePath = path.join(teamCache(), 'state.json');

    fs.mkdirSync(dailyDir, { recursive: true });
    fs.writeFileSync(cachedCycle, cycleFile('8.24-9.6', '- 企鹅的历史周期'), 'utf8');
    for (const date of [today, addDays(today, -6), addDays(today, -7), addDays(today, -8), addDays(today, -40)]) {
      fs.writeFileSync(path.join(dailyDir, `${date}.json`), JSON.stringify({ date, updatedAt: `${date}T09:00:00+00:00`, payload: { todos: [] } }), 'utf8');
    }
    // Something in the shape a stray write would take. Retention deletes plans.
    fs.writeFileSync(path.join(dailyDir, 'notes.txt'), 'not a plan', 'utf8');

    const stub = makeStub({
      rows: [],
      plans: [
        { owner: SELF_ID, plan_date: addDays(today, -29), payload: { todos: [] }, updated_at: `${today}T09:00:00+00:00` },
        { owner: SELF_ID, plan_date: addDays(today, -31), payload: { todos: [] }, updated_at: `${today}T09:00:00+00:00` },
        { owner: MATE_ID, plan_date: addDays(today, -400), payload: { todos: [] }, updated_at: `${today}T09:00:00+00:00` },
      ],
    });
    bridge.setTeamSessionProviderForTests(stub);
    const first = await sync.syncTeamOnce(config);

    const remaining = fs.readdirSync(dailyDir).sort();
    check(
      'cached teammate plans older than 7 days are pruned',
      !remaining.includes(`${addDays(today, -8)}.json`) && !remaining.includes(`${addDays(today, -40)}.json`),
      remaining.join(','),
    );
    check(
      'plans inside the 7-day window are kept',
      [today, addDays(today, -6), addDays(today, -7)].every((date) => remaining.includes(`${date}.json`)),
      remaining.join(','),
    );
    check('the prune is reported', first.plansPruned === 2, String(first.plansPruned));
    check('the pruner leaves files that are not daily plans alone', remaining.includes('notes.txt'), remaining.join(','));
    check('cached cycles are never pruned — they are the review history', fs.existsSync(cachedCycle), cachedCycle);
    check('nothing outside data/team-cache was deleted', localCycleFiles().join(',') === `${MINE_ID}.md`, localCycleFiles().join(','));

    const deletes = planDeletes(stub);
    check('the first tick of the day deletes my own old remote plans', deletes.length === 1, JSON.stringify(stub.calls.map((call) => `${call.method} ${call.path}`)));
    check('the delete names my own uuid rather than relying on RLS alone', deletes[0]?.path.includes(`owner=eq.${SELF_ID}`), deletes[0]?.path);
    check('the delete uses a 30-day cutoff', deletes[0]?.path.includes(`plan_date=lt.${addDays(today, -30)}`), deletes[0]?.path);
    check('the tick reports the purge', first.plansPurged === true, JSON.stringify(first));
    check('rows inside the 30-day window survive', stub.plans.some((row) => row.plan_date === addDays(today, -29)), JSON.stringify(stub.plans.map((row) => row.plan_date)));
    check('rows outside it are gone', !stub.plans.some((row) => row.plan_date === addDays(today, -31)), JSON.stringify(stub.plans.map((row) => row.plan_date)));
    check("a teammate's old rows are left alone — they are not mine to delete", stub.plans.some((row) => row.owner === MATE_ID), JSON.stringify(stub.plans.map((row) => row.owner)));

    stub.calls.length = 0;
    const second = await sync.syncTeamOnce(config);
    check(
      'a second tick the same day does not delete again',
      planDeletes(stub).length === 0 && second.plansPurged === false,
      JSON.stringify(stub.calls.map((call) => `${call.method} ${call.path}`)),
    );
    check(
      'cycles are never deleted remotely',
      stub.calls.every((call) => !(call.method === 'DELETE' && call.path.startsWith('/rest/v1/cycles'))),
      JSON.stringify(stub.calls.map((call) => `${call.method} ${call.path}`)),
    );

    const state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as Record<string, unknown>;
    check('the purge date is recorded in the cache state', state.lastPlanPurgeDate === today, String(state.lastPlanPurgeDate));
    // Tomorrow, it runs again.
    state.lastPlanPurgeDate = addDays(today, -1);
    fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    stub.calls.length = 0;
    const nextDay = await sync.syncTeamOnce(config);
    check('a new day purges again', planDeletes(stub).length === 1 && nextDay.plansPurged === true, JSON.stringify(stub.calls.map((call) => `${call.method} ${call.path}`)));
  }
}

/**
 * The shipped /cycles script, evaluated against a DOM stub — the same technique
 * as console-model-picker.test.ts, and for the same reason: read-only rendering
 * is behaviour, and asserting it against the real script is the only way to
 * catch a save control that stays clickable.
 */
async function loadCyclesPage() {
  const { CYCLES_JS } = await import('../../src/ui/pages.js');

  interface StubElement {
    id: string;
    value: string;
    textContent: string;
    innerHTML: string;
    hidden: boolean;
    disabled: boolean;
    readOnly: boolean;
    dataset: Record<string, string>;
    listeners: Record<string, Array<(event: unknown) => void>>;
    addEventListener(type: string, handler: (event: unknown) => void): void;
    querySelectorAll(): unknown[];
    closest(): unknown;
    focus(): void;
    dispatchEvent(): void;
  }

  const elements = new Map<string, StubElement>();
  const makeElement = (id: string): StubElement => {
    const element: StubElement = {
      id,
      value: '',
      textContent: '',
      innerHTML: '',
      hidden: false,
      disabled: false,
      readOnly: false,
      dataset: {},
      listeners: {},
      addEventListener(type, handler) {
        (element.listeners[type] ||= []).push(handler);
      },
      querySelectorAll: () => [],
      closest: () => null,
      focus() {},
      dispatchEvent() {},
    };
    return element;
  };
  const get = (id: string): StubElement => {
    if (!elements.has(id)) elements.set(id, makeElement(id));
    return elements.get(id)!;
  };

  const documentStub = {
    getElementById: (id: string) => get(id),
    querySelectorAll: () => [] as unknown[],
    addEventListener() {},
    title: '',
  };
  const windowStub = {
    location: { search: '', pathname: '/console', hash: '' },
    history: { replaceState() {} },
    addEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
  };
  const storageStub = { getItem: () => null, setItem() {}, removeItem() {} };

  const factory = new Function(
    'document',
    'window',
    'location',
    'history',
    'sessionStorage',
    'localStorage',
    'fetch',
    'navigator',
    'setTimeout',
    'clearTimeout',
    'setInterval',
    'clearInterval',
    `${CYCLES_JS}
     return {
       renderCycles: () => renderCyclesPage(),
       selectCycleOwner,
       toggleCycleMode,
       // The page keeps { cycles, team }; the console kept the team view one
       // level deeper. Adapt here so the assertions read the same as before.
       setState: (next) => { cyclesData = { cycles: next.cycles, team: next.team && next.team.view }; },
     };`,
  );
  const api = factory(
    documentStub,
    windowStub,
    windowStub.location,
    windowStub.history,
    storageStub,
    storageStub,
    // The script kicks off a load on evaluation. Never resolving it keeps the
    // fixtures the test sets below from being raced by a stub response.
    () => new Promise(() => {}),
    { clipboard: {} },
    windowStub.setTimeout,
    windowStub.clearTimeout,
    windowStub.setInterval,
    windowStub.clearInterval,
  ) as { renderCycles: () => void; selectCycleOwner: (ownerId: string) => void; toggleCycleMode: (key: string) => void; setState: (next: unknown) => void };

  return {
    el: get,
    setState: api.setState,
    render: api.renderCycles,
    /** The switcher is delegated; call the handler the way a click would. */
    click: (_containerId: string, ownerId: string) => api.selectCycleOwner(ownerId),
    /**
     * A section with content opens in read mode, which has no save row. These
     * assertions are about whether my own cards *can* be written, so put the
     * card into edit mode first.
     */
    editMode: (key: string) => {
      if (get('cycle-md-' + key).hidden) api.toggleCycleMode(key);
    },
    fire: (id: string, type: string) => {
      for (const handler of get(id).listeners[type] || []) handler({ target: get(id) });
    },
  };
}

void main();
