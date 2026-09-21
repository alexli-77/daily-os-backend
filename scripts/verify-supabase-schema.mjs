#!/usr/bin/env node
/**
 * LEO-281 verification: run the RLS assertions against a real Supabase project.
 *
 * This talks to the project over plain HTTP (PostgREST + GoTrue) so it needs no
 * dependencies. It only ever uses the anon key plus two signed-in test users,
 * which is exactly the surface a client has.
 *
 * Required environment:
 *   SUPABASE_URL                  https://<ref>.supabase.co
 *   SUPABASE_ANON_KEY             anon / publishable key
 *   SUPABASE_TEST_A_EMAIL         member A (e.g. leon)
 *   SUPABASE_TEST_A_PASSWORD
 *   SUPABASE_TEST_B_EMAIL         member B in the SAME team (e.g. penguin)
 *   SUPABASE_TEST_B_PASSWORD
 *
 * Optional:
 *   SUPABASE_TEST_OTHER_TEAM_ID   uuid of a team A does not belong to. Without
 *                                 it the cross-team read assertion is skipped
 *                                 rather than silently passing.
 *   SUPABASE_TEST_C_EMAIL         a third account that belongs to NO team, used
 *   SUPABASE_TEST_C_PASSWORD      to exercise create_team / join_team / leave_team
 *                                 (LEO-283). Without it those checks are skipped.
 *   SUPABASE_TEST_ALLOW_TEAM_CREATE=1
 *                                 also run create_team's success path. Off by
 *                                 default because `teams` has no delete policy,
 *                                 so every run would leave an orphan team row
 *                                 that no client can remove.
 *
 * When the required variables are missing the script exits 0 and prints exactly
 * which ones were absent. It never reports success for checks it did not run.
 */

const REQUIRED = [
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_TEST_A_EMAIL',
  'SUPABASE_TEST_A_PASSWORD',
  'SUPABASE_TEST_B_EMAIL',
  'SUPABASE_TEST_B_PASSWORD',
];

const missing = REQUIRED.filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.log('SKIPPED: Supabase verification did not run.');
  console.log(`Reason: missing environment variable(s): ${missing.join(', ')}`);
  console.log('');
  console.log('This is a skip, not a pass. Nothing about the remote schema or its');
  console.log('RLS policies has been verified. See supabase/README.md for how to');
  console.log('create the two test users and export these variables.');
  process.exit(0);
}

const BASE = process.env.SUPABASE_URL.replace(/\/+$/, '');
const ANON = process.env.SUPABASE_ANON_KEY;
const OTHER_TEAM_ID = process.env.SUPABASE_TEST_OTHER_TEAM_ID || '';

const results = [];
let failed = 0;
let skipped = 0;

function check(name, ok, detail = '') {
  results.push({ name, state: ok ? 'PASS' : 'FAIL', detail });
  if (!ok) failed += 1;
}

function skip(name, reason) {
  results.push({ name, state: 'SKIP', detail: reason });
  skipped += 1;
}

async function signIn(email, password) {
  const res = await fetch(`${BASE}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new Error(
      `sign-in failed for ${email}: ${res.status} ${body.error_description || body.msg || ''}`,
    );
  }
  return body.access_token;
}

async function rest(token, path, init = {}) {
  const res = await fetch(`${BASE}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: ANON,
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, ok: res.ok, body };
}

/** Call a security definer RPC. Returns the same shape as rest(). */
async function rpc(token, name, args) {
  return rest(token, `rpc/${name}`, { method: 'POST', body: JSON.stringify(args) });
}

/** The message a failed RPC came back with, whatever shape PostgREST used. */
function rpcMessage(res) {
  if (res.body && typeof res.body === 'object') return String(res.body.message || res.body.hint || '');
  return String(res.body || '');
}

/** A write is "blocked" when RLS rejects it or when it silently matches no row. */
function writeBlocked(res) {
  if (res.status === 401 || res.status === 403) return true;
  if (res.status === 409) return true; // conflict on someone else's primary key
  if (res.ok && Array.isArray(res.body) && res.body.length === 0) return true;
  return false;
}

/**
 * An INSERT that a policy refused — and nothing else. Deliberately narrower
 * than writeBlocked(): a 409 only says the primary key was taken, which for a
 * probe on a fixed sentinel key usually means an earlier run left its row
 * behind. Treating that as "RLS blocked it" is how a script goes on certifying
 * a policy it never actually exercised. The sweeps below try to make 409
 * impossible; if one happens anyway, it should be a visible failure, not a
 * pass.
 *
 * We do not instead vary the key per run: `plan_date` is a `date`, so the only
 * way to make it unique-per-run is to scatter probe rows across arbitrary
 * calendar days, which trades a detectable collision for undeletable litter in
 * a real user's table.
 */
function insertRejected(res) {
  return res.status === 401 || res.status === 403;
}

async function main() {
  const tokenA = await signIn(process.env.SUPABASE_TEST_A_EMAIL, process.env.SUPABASE_TEST_A_PASSWORD);
  const tokenB = await signIn(process.env.SUPABASE_TEST_B_EMAIL, process.env.SUPABASE_TEST_B_PASSWORD);

  // --- signup trigger ------------------------------------------------------
  const meB = await rest(tokenB, 'members?select=user_id,team_id,member_id');
  const rowsB = Array.isArray(meB.body) ? meB.body : [];
  const b = rowsB.find((r) => r.user_id) ?? null;
  check('signup trigger created a members row for user B', rowsB.length > 0);

  const meA = await rest(tokenA, 'members?select=user_id,team_id,member_id,display_name');
  const rowsA = Array.isArray(meA.body) ? meA.body : [];
  // Identify A by elimination: A is the row that is not B. Never by member_id,
  // which is exactly the mutable label this schema refuses to treat as identity.
  const a = rowsA.find((r) => r.user_id !== b?.user_id) ?? rowsA[0] ?? null;
  check(
    'signup trigger created a members row for user A',
    rowsA.length > 0 && Boolean(a?.member_id),
    `members visible to A: ${rowsA.length}`,
  );

  const teamA = a?.team_id ?? null;
  const teamB = b?.team_id ?? null;
  check('user A has been assigned to a team', Boolean(teamA), String(teamA));
  check('user A and user B share a team', Boolean(teamA) && teamA === teamB, `${teamA} vs ${teamB}`);

  const uidA = a?.user_id;
  const uidB = b?.user_id;
  const memberIdA = a?.member_id;
  const memberIdB = b?.member_id;

  // --- same-team read ------------------------------------------------------
  check(
    'user A sees every members row in the team',
    rowsA.some((r) => r.user_id === uidB),
    `A sees: ${rowsA.map((r) => r.member_id).join(', ')}`,
  );

  const teamsA = await rest(tokenA, 'teams?select=id');
  check(
    'user A sees exactly one team (their own)',
    Array.isArray(teamsA.body) && teamsA.body.length === 1 && teamsA.body[0].id === teamA,
  );

  // --- own write + updated_at ---------------------------------------------
  const probeCycle = `verify-${Date.now()}`;
  const probeUrl =
    `cycles?team_id=eq.${teamA}&owner=eq.${uidA}&cycle_id=eq.${encodeURIComponent(probeCycle)}`;
  const insertOwn = await rest(tokenA, 'cycles', {
    method: 'POST',
    headers: { prefer: 'return=representation' },
    body: JSON.stringify({
      team_id: teamA,
      cycle_id: probeCycle,
      mode: 'weekly',
      markdown: 'verify probe',
    }),
  });
  check('user A can write their own cycle', insertOwn.ok, `status ${insertOwn.status}`);
  const firstUpdatedAt = Array.isArray(insertOwn.body) ? insertOwn.body[0]?.updated_at : null;
  check(
    'owner defaults to the caller uuid, no member_id column is involved',
    Array.isArray(insertOwn.body) &&
      insertOwn.body[0]?.owner === uidA &&
      !('member_id' in (insertOwn.body[0] || {})),
    `owner ${Array.isArray(insertOwn.body) ? insertOwn.body[0]?.owner : 'n/a'}`,
  );

  if (insertOwn.ok) {
    await new Promise((r) => setTimeout(r, 1100));
    const touched = await rest(tokenA, probeUrl, {
      method: 'PATCH',
      headers: { prefer: 'return=representation' },
      body: JSON.stringify({ markdown: 'verify probe 2', updated_at: '2000-01-01T00:00:00Z' }),
    });
    const secondUpdatedAt = Array.isArray(touched.body) ? touched.body[0]?.updated_at : null;
    check(
      'updated_at is refreshed by the trigger and cannot be backdated',
      Boolean(firstUpdatedAt && secondUpdatedAt) &&
        new Date(secondUpdatedAt).getTime() > new Date(firstUpdatedAt).getTime(),
      `${firstUpdatedAt} -> ${secondUpdatedAt}`,
    );
  } else {
    skip('updated_at is refreshed by the trigger', 'own-write probe failed, nothing to update');
  }

  // --- renaming yourself is allowed, and does not orphan anything ----------
  // This is the point of keying cycles on `owner` instead of on the short name.
  const renamed = `${memberIdA}-renamed-${Date.now().toString(36)}`;
  const rename = await rest(tokenA, `members?user_id=eq.${uidA}`, {
    method: 'PATCH',
    headers: { prefer: 'return=representation' },
    body: JSON.stringify({ member_id: renamed }),
  });
  check(
    'user A can rename their own member_id',
    rename.ok && Array.isArray(rename.body) && rename.body[0]?.member_id === renamed,
    `status ${rename.status}`,
  );

  if (rename.ok && insertOwn.ok) {
    const afterRename = await rest(tokenA, `${probeUrl}&select=cycle_id,owner,markdown`);
    check(
      "renaming does not orphan user A's existing cycles",
      Array.isArray(afterRename.body) &&
        afterRename.body.length === 1 &&
        afterRename.body[0].owner === uidA,
      `rows found by owner after rename: ${Array.isArray(afterRename.body) ? afterRename.body.length : 'n/a'}`,
    );
    const writeAfterRename = await rest(tokenA, probeUrl, {
      method: 'PATCH',
      headers: { prefer: 'return=representation' },
      body: JSON.stringify({ markdown: 'still mine after the rename' }),
    });
    check(
      'user A can still write those cycles under the new name',
      writeAfterRename.ok && Array.isArray(writeAfterRename.body) && writeAfterRename.body.length === 1,
      `status ${writeAfterRename.status}`,
    );
  } else {
    skip("renaming does not orphan user A's existing cycles", 'rename or own-write probe failed');
    skip('user A can still write those cycles under the new name', 'rename or own-write probe failed');
  }

  // Restore the original label so the script is re-runnable.
  if (rename.ok) {
    await rest(tokenA, `members?user_id=eq.${uidA}`, {
      method: 'PATCH',
      body: JSON.stringify({ member_id: memberIdA }),
    });
  }

  // A rename may not collide with a label a teammate is currently using.
  const collide = await rest(tokenA, `members?user_id=eq.${uidA}`, {
    method: 'PATCH',
    headers: { prefer: 'return=representation' },
    body: JSON.stringify({ member_id: memberIdB }),
  });
  check(
    "user A cannot rename onto user B's label",
    writeBlocked(collide) || collide.status === 409,
    `status ${collide.status}`,
  );

  // --- cross-member write --------------------------------------------------
  const bCycles = await rest(tokenA, `cycles?select=cycle_id&owner=eq.${uidB}&limit=1`);
  const bCycleId = Array.isArray(bCycles.body) ? bCycles.body[0]?.cycle_id : null;

  if (bCycleId) {
    const hijack = await rest(
      tokenA,
      `cycles?team_id=eq.${teamA}&owner=eq.${uidB}&cycle_id=eq.${encodeURIComponent(bCycleId)}`,
      {
        method: 'PATCH',
        headers: { prefer: 'return=representation' },
        body: JSON.stringify({ markdown: 'HIJACKED BY VERIFY SCRIPT' }),
      },
    );
    check(
      "user A cannot update user B's existing cycle",
      writeBlocked(hijack),
      `status ${hijack.status}`,
    );
  } else {
    skip("user A cannot update user B's existing cycle", 'user B has no cycle row to attempt against');
  }

  // The old key-squatting attack, restated for the uuid key: A tries to plant a
  // row at a coordinate owned by B. `owner` is in the primary key, so this is
  // the only way to reach B's key space at all, and the insert policy blocks it.
  const squat = await rest(tokenA, 'cycles', {
    method: 'POST',
    headers: { prefer: 'return=representation' },
    body: JSON.stringify({
      team_id: teamA,
      owner: uidB,
      cycle_id: bCycleId || `squat-${Date.now()}`,
      mode: 'weekly',
      markdown: 'squat',
    }),
  });
  check(
    "user A cannot insert a cycle into user B's key space",
    writeBlocked(squat),
    `status ${squat.status}`,
  );

  const forged = await rest(tokenA, 'cycles', {
    method: 'POST',
    headers: { prefer: 'return=representation' },
    body: JSON.stringify({
      team_id: teamA,
      cycle_id: `forge-${Date.now()}`,
      mode: 'weekly',
      markdown: 'forge',
      owner: uidB,
    }),
  });
  check('user A cannot forge the owner column', writeBlocked(forged), `status ${forged.status}`);

  if (insertOwn.ok) {
    const giveAway = await rest(tokenA, probeUrl, {
      method: 'PATCH',
      headers: { prefer: 'return=representation' },
      body: JSON.stringify({ owner: uidB }),
    });
    check(
      'user A cannot reassign one of their own cycles to user B',
      writeBlocked(giveAway),
      `status ${giveAway.status}`,
    );
  } else {
    skip('user A cannot reassign one of their own cycles to user B', 'own-write probe failed');
  }

  // --- members row is locked down -----------------------------------------
  const switchTeam = await rest(tokenA, `members?user_id=eq.${uidA}`, {
    method: 'PATCH',
    headers: { prefer: 'return=representation' },
    body: JSON.stringify({ team_id: OTHER_TEAM_ID || '00000000-0000-0000-0000-000000000000' }),
  });
  check(
    'user A cannot move themselves into another team',
    writeBlocked(switchTeam) || switchTeam.status === 400,
    `status ${switchTeam.status}`,
  );

  const renameOther = await rest(tokenA, `members?user_id=eq.${uidB}`, {
    method: 'PATCH',
    headers: { prefer: 'return=representation' },
    body: JSON.stringify({ display_name: 'HIJACKED BY VERIFY SCRIPT', member_id: 'hijacked' }),
  });
  check(
    "user A cannot edit user B's members row",
    writeBlocked(renameOther),
    `status ${renameOther.status}`,
  );

  // --- cross-team read -----------------------------------------------------
  if (OTHER_TEAM_ID) {
    const crossCycles = await rest(tokenA, `cycles?select=cycle_id&team_id=eq.${OTHER_TEAM_ID}`);
    check(
      'user A reads nothing from a foreign team',
      Array.isArray(crossCycles.body) && crossCycles.body.length === 0,
      `status ${crossCycles.status}`,
    );
    const crossTeam = await rest(tokenA, `teams?select=id&id=eq.${OTHER_TEAM_ID}`);
    check(
      'user A cannot read a foreign teams row',
      Array.isArray(crossTeam.body) && crossTeam.body.length === 0,
    );

    // This is what the team_id condition on the write policies buys now that
    // member_id is gone: without it A could own a row inside a team A is not in
    // and that team would read it.
    const crossInsert = await rest(tokenA, 'cycles', {
      method: 'POST',
      headers: { prefer: 'return=representation' },
      body: JSON.stringify({
        team_id: OTHER_TEAM_ID,
        cycle_id: `cross-${Date.now()}`,
        mode: 'weekly',
        markdown: 'cross-team injection',
      }),
    });
    check(
      'user A cannot insert a cycle they own into a foreign team',
      writeBlocked(crossInsert),
      `status ${crossInsert.status}`,
    );

    if (insertOwn.ok) {
      const moveTeam = await rest(tokenA, probeUrl, {
        method: 'PATCH',
        headers: { prefer: 'return=representation' },
        body: JSON.stringify({ team_id: OTHER_TEAM_ID }),
      });
      check(
        'user A cannot move their own cycle into a foreign team',
        writeBlocked(moveTeam),
        `status ${moveTeam.status}`,
      );
    } else {
      skip('user A cannot move their own cycle into a foreign team', 'own-write probe failed');
    }
  } else {
    skip(
      'user A reads nothing from a foreign team',
      'SUPABASE_TEST_OTHER_TEAM_ID is not set, so there is no foreign team to read',
    );
    skip('user A cannot read a foreign teams row', 'SUPABASE_TEST_OTHER_TEAM_ID is not set');
    skip(
      'user A cannot insert a cycle they own into a foreign team',
      'SUPABASE_TEST_OTHER_TEAM_ID is not set; a made-up uuid would fail on the foreign key instead of on RLS',
    );
    skip(
      'user A cannot move their own cycle into a foreign team',
      'SUPABASE_TEST_OTHER_TEAM_ID is not set',
    );
  }

  // --- LEO-313: daily_plans ------------------------------------------------
  //
  // Same policy shape as cycles, on the key (team_id, owner, plan_date), so the
  // same attacks get re-run against it. Unlike the cycles block above, B writes
  // its own probe row instead of us reading whatever row B happens to own: a
  // teammate who has not synced a plan yet would otherwise turn every
  // cross-member assertion here into a skip, which is the failure mode this
  // whole script exists to avoid. B signs the write itself, so no policy is
  // being worked around to set it up.
  //
  // Two sentinel dates far outside any real plan, so a probe can never land on
  // a day either user actually synced. The second one exists only so the
  // owner-forging insert below cannot be refused by the primary key instead of
  // by the policy under test.
  const PLAN_DATE = '1970-01-02';
  const PLAN_DATE_FORGE = '1970-01-03';
  const planUrlA = `daily_plans?team_id=eq.${teamA}&owner=eq.${uidA}&plan_date=eq.${PLAN_DATE}`;
  const planUrlB = `daily_plans?team_id=eq.${teamB}&owner=eq.${uidB}&plan_date=eq.${PLAN_DATE}`;
  const planPayload = () => ({
    generated_at: new Date().toISOString(),
    todos: [],
    feedback: {},
  });

  // Sweeps that catch every row this block can create, on both sentinel dates
  // and in any team. Two reasons not to reuse planUrlA/planUrlB here:
  //   - they only cover PLAN_DATE, so a leftover PLAN_DATE_FORGE row would make
  //     the two inserts below fail on the primary key forever;
  //   - they pin team_id, and the "move into a foreign team" PATCH below moves
  //     A's row out of teamA whenever the policy it tests is broken.
  // The delete policy is `using (owner = auth.uid())` with no team clause, so
  // filtering on owner alone is both sufficient and the only filter that can
  // still reach a row that got away. B's sweep also picks up the row A forged
  // under B's uuid, which A itself has no right to delete.
  const planDates = `in.(${PLAN_DATE},${PLAN_DATE_FORGE})`;
  const planSweepA = `daily_plans?owner=eq.${uidA}&plan_date=${planDates}`;
  const planSweepB = `daily_plans?owner=eq.${uidB}&plan_date=${planDates}`;

  // A run that died before its cleanup leaves sentinel rows behind, and then
  // the inserts below fail on the primary key rather than on RLS.
  await rest(tokenA, planSweepA, { method: 'DELETE' });
  await rest(tokenB, planSweepB, { method: 'DELETE' });

  const planOwnA = await rest(tokenA, 'daily_plans', {
    method: 'POST',
    headers: { prefer: 'return=representation' },
    body: JSON.stringify({ team_id: teamA, plan_date: PLAN_DATE, payload: planPayload() }),
  });
  check(
    'user A can write their own daily_plans row, and owner defaults to their uuid',
    planOwnA.ok && Array.isArray(planOwnA.body) && planOwnA.body[0]?.owner === uidA,
    `status ${planOwnA.status}`,
  );

  const planOwnB = await rest(tokenB, 'daily_plans', {
    method: 'POST',
    headers: { prefer: 'return=representation' },
    body: JSON.stringify({ team_id: teamB, plan_date: PLAN_DATE, payload: planPayload() }),
  });
  check('user B can write their own daily_plans row', planOwnB.ok, `status ${planOwnB.status}`);

  if (planOwnB.ok) {
    const planRead = await rest(
      tokenA,
      `daily_plans?select=owner,plan_date&owner=eq.${uidB}&plan_date=eq.${PLAN_DATE}`,
    );
    check(
      "user A reads user B's daily_plans row",
      Array.isArray(planRead.body) &&
        planRead.body.length === 1 &&
        planRead.body[0].owner === uidB,
      `rows ${Array.isArray(planRead.body) ? planRead.body.length : 'n/a'}`,
    );

    const planHijack = await rest(tokenA, planUrlB, {
      method: 'PATCH',
      headers: { prefer: 'return=representation' },
      body: JSON.stringify({ payload: { hijacked: 'by verify script' } }),
    });
    check(
      "user A cannot update user B's daily_plans row",
      writeBlocked(planHijack),
      `status ${planHijack.status}`,
    );

    const planWipe = await rest(tokenA, planUrlB, {
      method: 'DELETE',
      headers: { prefer: 'return=representation' },
    });
    check(
      "user A cannot delete user B's daily_plans row",
      writeBlocked(planWipe),
      `status ${planWipe.status}`,
    );
    // A DELETE that RLS filtered down to no rows still returns 2xx, so the only
    // proof the row survived is reading it back.
    const planSurvived = await rest(
      tokenA,
      `daily_plans?select=owner&owner=eq.${uidB}&plan_date=eq.${PLAN_DATE}`,
    );
    check(
      "user B's daily_plans row is still there after A tried to delete it",
      Array.isArray(planSurvived.body) && planSurvived.body.length === 1,
      `rows ${Array.isArray(planSurvived.body) ? planSurvived.body.length : 'n/a'}`,
    );
  } else {
    skip("user A reads user B's daily_plans row", "user B's own-write probe failed");
    skip("user A cannot update user B's daily_plans row", "user B's own-write probe failed");
    skip("user A cannot delete user B's daily_plans row", "user B's own-write probe failed");
    skip(
      "user B's daily_plans row is still there after A tried to delete it",
      "user B's own-write probe failed",
    );
  }

  const planForge = await rest(tokenA, 'daily_plans', {
    method: 'POST',
    headers: { prefer: 'return=representation' },
    body: JSON.stringify({
      team_id: teamA,
      owner: uidB,
      plan_date: PLAN_DATE_FORGE,
      payload: planPayload(),
    }),
  });
  check(
    'user A cannot forge the owner column on daily_plans',
    insertRejected(planForge),
    `status ${planForge.status}`,
  );

  if (OTHER_TEAM_ID) {
    // Weak on purpose, and worth knowing it: "zero rows" is also what a
    // foreign team with no daily_plans at all returns, RLS or no RLS. Seeding
    // one over there would need either a session in that team or a
    // service_role key, and the second is not worth handing to this script.
    // README says which team to point SUPABASE_TEST_OTHER_TEAM_ID at.
    const planCrossRead = await rest(
      tokenA,
      `daily_plans?select=plan_date&team_id=eq.${OTHER_TEAM_ID}`,
    );
    check(
      'user A reads no daily_plans from a foreign team',
      Array.isArray(planCrossRead.body) && planCrossRead.body.length === 0,
      `status ${planCrossRead.status}`,
    );

    const planCrossInsert = await rest(tokenA, 'daily_plans', {
      method: 'POST',
      headers: { prefer: 'return=representation' },
      body: JSON.stringify({
        team_id: OTHER_TEAM_ID,
        plan_date: PLAN_DATE_FORGE,
        payload: planPayload(),
      }),
    });
    check(
      'user A cannot insert a daily_plans row they own into a foreign team',
      insertRejected(planCrossInsert),
      `status ${planCrossInsert.status}`,
    );

    if (planOwnA.ok) {
      const planMoveTeam = await rest(tokenA, planUrlA, {
        method: 'PATCH',
        headers: { prefer: 'return=representation' },
        body: JSON.stringify({ team_id: OTHER_TEAM_ID }),
      });
      check(
        'user A cannot move their own daily_plans row into a foreign team',
        writeBlocked(planMoveTeam),
        `status ${planMoveTeam.status}`,
      );
    } else {
      skip(
        'user A cannot move their own daily_plans row into a foreign team',
        "user A's own-write probe failed",
      );
    }
  } else {
    skip(
      'user A reads no daily_plans from a foreign team',
      'SUPABASE_TEST_OTHER_TEAM_ID is not set, so there is no foreign team to read',
    );
    skip(
      'user A cannot insert a daily_plans row they own into a foreign team',
      'SUPABASE_TEST_OTHER_TEAM_ID is not set; a made-up uuid would fail on the foreign key instead of on RLS',
    );
    skip(
      'user A cannot move their own daily_plans row into a foreign team',
      'SUPABASE_TEST_OTHER_TEAM_ID is not set',
    );
  }

  // --- LEO-283: the team lifecycle RPCs ------------------------------------
  //
  // These are `security definer`, so they run as the function owner and RLS
  // does not constrain them. Everything that keeps them safe is written inside
  // the function body, which means the assertions below are the only thing
  // standing between a change to that body and a cross-team data leak.

  // A is already in a team, so both of these must be refused whatever else is
  // true. This is the anti-hopping guard: it is what stops a member of team A
  // who obtains team B's invite code from walking across.
  const hopAttempt = await rpc(tokenA, 'join_team', { code: `verify-not-a-real-code-${Date.now()}` });
  check(
    'join_team refuses a caller who is already in a team',
    !hopAttempt.ok && /already belongs to a team/i.test(rpcMessage(hopAttempt)),
    `status ${hopAttempt.status} ${rpcMessage(hopAttempt)}`,
  );
  const secondTeam = await rpc(tokenA, 'create_team', { team_name: `verify-should-not-exist-${Date.now()}` });
  check(
    'create_team refuses a caller who is already in a team',
    !secondTeam.ok && /already belongs to a team/i.test(rpcMessage(secondTeam)),
    `status ${secondTeam.status} ${rpcMessage(secondTeam)}`,
  );
  const teamsAfterHop = await rest(tokenA, 'members?select=team_id&user_id=eq.' + uidA);
  check(
    'a refused join/create left user A in their original team',
    Array.isArray(teamsAfterHop.body) && teamsAfterHop.body[0]?.team_id === teamA,
    `${Array.isArray(teamsAfterHop.body) ? teamsAfterHop.body[0]?.team_id : 'n/a'} vs ${teamA}`,
  );

  const teamRowA = await rest(tokenA, `teams?select=id,invite_code&id=eq.${teamA}`);
  const inviteCodeA = Array.isArray(teamRowA.body) ? teamRowA.body[0]?.invite_code : null;
  check('user A can read their own team invite code', Boolean(inviteCodeA));
  check(
    'the invite code is long enough to be unguessable',
    typeof inviteCodeA === 'string' && inviteCodeA.length >= 24,
    `length ${typeof inviteCodeA === 'string' ? inviteCodeA.length : 'n/a'}`,
  );

  const hasC = Boolean(process.env.SUPABASE_TEST_C_EMAIL && process.env.SUPABASE_TEST_C_PASSWORD);
  if (hasC && inviteCodeA) {
    const tokenC = await signIn(process.env.SUPABASE_TEST_C_EMAIL, process.env.SUPABASE_TEST_C_PASSWORD);
    const meC = await rest(tokenC, 'members?select=user_id,team_id,member_id');
    const c = Array.isArray(meC.body) ? meC.body[0] : null;
    const uidC = c?.user_id;
    const memberIdC = c?.member_id;

    if (!uidC || c?.team_id) {
      skip('join_team lifecycle', 'user C must exist and belong to no team; it currently has team_id set');
    } else {
      // Give C a label nobody in A's team is using, so a join can only fail for
      // the reason under test rather than on unique (team_id, member_id).
      const labelC = `verify-c-${Date.now().toString(36)}`;
      await rest(tokenC, `members?user_id=eq.${uidC}`, {
        method: 'PATCH',
        body: JSON.stringify({ member_id: labelC }),
      });

      const badCode = await rpc(tokenC, 'join_team', { code: `definitely-not-a-code-${Date.now()}` });
      check(
        'join_team rejects a wrong invite code explicitly',
        !badCode.ok && /invalid invite code/i.test(rpcMessage(badCode)),
        `status ${badCode.status} ${rpcMessage(badCode)}`,
      );
      const stillNull = await rest(tokenC, `members?select=team_id&user_id=eq.${uidC}`);
      check(
        'a rejected join_team is not a silent success',
        Array.isArray(stillNull.body) && stillNull.body[0]?.team_id === null,
        `team_id ${Array.isArray(stillNull.body) ? stillNull.body[0]?.team_id : 'n/a'}`,
      );
      const emptyCode = await rpc(tokenC, 'join_team', { code: '   ' });
      check(
        'join_team rejects an empty invite code',
        !emptyCode.ok && /invite code is required/i.test(rpcMessage(emptyCode)),
        `status ${emptyCode.status} ${rpcMessage(emptyCode)}`,
      );
      const emptyName = await rpc(tokenC, 'create_team', { team_name: '  ' });
      check(
        'create_team rejects an empty team name',
        !emptyName.ok && /team name is required/i.test(rpcMessage(emptyName)),
        `status ${emptyName.status} ${rpcMessage(emptyName)}`,
      );

      const joined = await rpc(tokenC, 'join_team', { code: inviteCodeA });
      check('join_team accepts the real invite code', joined.ok && joined.body === teamA, `status ${joined.status} ${rpcMessage(joined)}`);

      if (joined.ok) {
        const cInTeam = await rest(tokenC, `members?select=team_id&user_id=eq.${uidC}`);
        check(
          'join_team actually moved the caller into the team',
          Array.isArray(cInTeam.body) && cInTeam.body[0]?.team_id === teamA,
        );
        const cReads = await rest(tokenC, 'members?select=user_id');
        check(
          'after joining, C reads the whole team roster',
          Array.isArray(cReads.body) && cReads.body.some((r) => r.user_id === uidA),
          `rows ${Array.isArray(cReads.body) ? cReads.body.length : 'n/a'}`,
        );
        const joinTwice = await rpc(tokenC, 'join_team', { code: inviteCodeA });
        check(
          'join_team refuses a second join even with the same code',
          !joinTwice.ok && /already belongs to a team/i.test(rpcMessage(joinTwice)),
          `status ${joinTwice.status} ${rpcMessage(joinTwice)}`,
        );

        const left = await rpc(tokenC, 'leave_team', {});
        check('leave_team succeeds', left.ok, `status ${left.status} ${rpcMessage(left)}`);
        const cAfterLeave = await rest(tokenC, `members?select=team_id&user_id=eq.${uidC}`);
        check(
          'after leaving, C has no team',
          Array.isArray(cAfterLeave.body) && cAfterLeave.body[0]?.team_id === null,
        );
        const cReadsNothing = await rest(tokenC, 'cycles?select=cycle_id');
        check(
          'after leaving, C reads no cycles at all',
          Array.isArray(cReadsNothing.body) && cReadsNothing.body.length === 0,
          `rows ${Array.isArray(cReadsNothing.body) ? cReadsNothing.body.length : 'n/a'}`,
        );
        const rotateOutside = await rpc(tokenC, 'rotate_invite_code', {});
        check(
          'rotate_invite_code refuses a caller with no team',
          !rotateOutside.ok && /does not belong to a team/i.test(rpcMessage(rotateOutside)),
          `status ${rotateOutside.status} ${rpcMessage(rotateOutside)}`,
        );
      } else {
        skip('join_team actually moved the caller into the team', 'the join itself failed');
        skip('leave_team succeeds', 'the join itself failed');
      }

      if (process.env.SUPABASE_TEST_ALLOW_TEAM_CREATE === '1') {
        const createdName = `verify-team-${Date.now().toString(36)}`;
        const created = await rpc(tokenC, 'create_team', { team_name: createdName });
        check('create_team returns a team uuid', created.ok && typeof created.body === 'string', `status ${created.status} ${rpcMessage(created)}`);
        if (created.ok) {
          // The property that no combination of policies could give us: the
          // creator is inside the team, in the same transaction as the insert.
          const cAfterCreate = await rest(tokenC, `members?select=team_id&user_id=eq.${uidC}`);
          check(
            'create_team puts the creator inside the new team',
            Array.isArray(cAfterCreate.body) && cAfterCreate.body[0]?.team_id === created.body,
          );
          const ownTeam = await rest(tokenC, 'teams?select=id,invite_code');
          const firstCode = Array.isArray(ownTeam.body) ? ownTeam.body[0]?.invite_code : null;
          check('the new team has an invite code', typeof firstCode === 'string' && firstCode.length >= 24);
          const rotated = await rpc(tokenC, 'rotate_invite_code', {});
          check('rotate_invite_code returns a different code', rotated.ok && rotated.body !== firstCode, `status ${rotated.status}`);
          await rpc(tokenC, 'leave_team', {});
          console.log(`NOTE: left behind team "${createdName}" — teams has no delete policy, remove it in the dashboard.`);
        }
      } else {
        skip('create_team returns a team uuid', 'SUPABASE_TEST_ALLOW_TEAM_CREATE is not 1; it would leave an undeletable team row');
        skip('create_team puts the creator inside the new team', 'SUPABASE_TEST_ALLOW_TEAM_CREATE is not 1');
        skip('rotate_invite_code returns a different code', 'SUPABASE_TEST_ALLOW_TEAM_CREATE is not 1');
      }

      // Restore C's label so the script stays re-runnable.
      if (memberIdC) {
        await rest(tokenC, `members?user_id=eq.${uidC}`, {
          method: 'PATCH',
          body: JSON.stringify({ member_id: memberIdC }),
        });
      }
    }
  } else {
    skip('join_team lifecycle', 'SUPABASE_TEST_C_EMAIL / SUPABASE_TEST_C_PASSWORD are not set, so no teamless account exists to join with');
  }

  // --- anon key with no session -------------------------------------------
  const anonRead = await fetch(`${BASE}/rest/v1/cycles?select=cycle_id`, {
    headers: { apikey: ANON, authorization: `Bearer ${ANON}` },
  });
  const anonBody = await anonRead.json().catch(() => null);
  check(
    'anon key without a session reads nothing',
    !anonRead.ok || (Array.isArray(anonBody) && anonBody.length === 0),
    `status ${anonRead.status}`,
  );

  // daily_plans is a separate table with its own policies, and at this point it
  // is known to hold at least A's and B's probe rows, so an empty result here
  // cannot be an empty table.
  const anonPlans = await fetch(`${BASE}/rest/v1/daily_plans?select=plan_date`, {
    headers: { apikey: ANON, authorization: `Bearer ${ANON}` },
  });
  const anonPlansBody = await anonPlans.json().catch(() => null);
  check(
    'anon key without a session reads no daily_plans',
    !anonPlans.ok || (Array.isArray(anonPlansBody) && anonPlansBody.length === 0),
    `status ${anonPlans.status}`,
  );

  // EXECUTE is revoked from PUBLIC and granted only to `authenticated`, so an
  // unauthenticated caller must not even reach the auth.uid() check inside.
  for (const [name, args] of [
    ['create_team', { team_name: 'anon should not get here' }],
    ['join_team', { code: 'anon should not get here' }],
    ['leave_team', {}],
    ['rotate_invite_code', {}],
  ]) {
    const anonRpc = await fetch(`${BASE}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: { apikey: ANON, authorization: `Bearer ${ANON}`, 'content-type': 'application/json' },
      body: JSON.stringify(args),
    });
    check(`anon key without a session cannot execute ${name}`, !anonRpc.ok, `status ${anonRpc.status}`);
  }

  // --- cleanup -------------------------------------------------------------
  if (insertOwn.ok) {
    await rest(tokenA, probeUrl, { method: 'DELETE' });
  }
  // Same two sweeps as before the block ran, for the same reasons: they cover
  // both sentinel dates and any team a row may have been moved or forged into.
  // Each session removes only rows it owns; A deleting B's is precisely what
  // the policy forbids, which is why the forged row is B's to clean up.
  await rest(tokenA, planSweepA, { method: 'DELETE' });
  await rest(tokenB, planSweepB, { method: 'DELETE' });
}

main()
  .then(() => {
    for (const r of results) {
      const detail = r.detail ? ` (${r.detail})` : '';
      console.log(`${r.state.padEnd(4)} ${r.name}${detail}`);
    }
    console.log('');
    console.log(
      `${results.length - failed - skipped} passed, ${failed} failed, ${skipped} skipped.`,
    );
    if (skipped > 0) {
      console.log('Skipped checks were NOT verified.');
    }
    process.exit(failed > 0 ? 1 : 0);
  })
  .catch((err) => {
    for (const r of results) {
      console.log(`${r.state.padEnd(4)} ${r.name}`);
    }
    console.error('');
    console.error(`ERROR: verification aborted: ${err.message}`);
    process.exit(1);
  });
