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
    isSupabaseConfigured: (): boolean => stub.configured,
    readTeamSession: () => stub.session,
    listTeamMembers: async () => {
      if (stub.memberListError) throw stub.memberListError;
      return stub.members;
    },
    supabaseFetch: async (_config: unknown, requestPath: string, init?: RequestInit): Promise<Response> => {
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
    },
  };
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
    check('a moved watermark pulls again', third.changed && third.pulled === 2, JSON.stringify(third));
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
    memory.writeLatestWorkflowOutput(
      config,
      'daily_plan',
      today,
      JSON.stringify({ todos: [{ rank: 1, text: '我的第一件事', candidateId: 'linear:LEO-1' }, { rank: 2, text: '第二件', candidateId: 'inbox:abc' }] }),
    );
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

    const stub = makeStub({
      rows: [
        { owner: MATE_ID, cycle_id: MATE_CYCLE_ID, mode: 'biweekly', markdown: cycleFile('8.24-9.6', '- 企鹅在控制台里的要务'), updated_at: '2026-09-02T10:00:00.000Z' },
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
