/**
 * Editing a past day's rows from 往日.
 *
 * Independent, tsx-runnable:  npx tsx scripts/tests/past-day-edit.test.ts
 *
 * Until now every plan-row edit was stamped with the day the service received
 * it, so the 往日 view was read-only on purpose: ticking yesterday's row would
 * have recorded a completion on *today's* sheet. `/api/today/todo-feedback` now
 * takes an optional `date`. These tests pin what that may and may not do:
 *
 *   - the edit lands on the named day and nowhere else
 *   - no `date` still means today, so every existing caller is unchanged
 *   - a day after today is refused, and so is anything that reschedules
 *     (顺延, 删除, pinning to a time) on a day that is over
 *   - a capture's inbox status follows a past tick only when no later day has
 *     already said how the row was left
 *   - `/api/day/plan` says `editable`, which is how the client knows the
 *     service understands `date` at all
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

import { AppConfigSchema } from '../../src/config/schema.js';
import { appendDailyMemory } from '../../src/storage/memory.js';
import { listTodoFeedback, resolveFeedbackDate } from '../../src/todo/feedback.js';
import { handleTodoInboxCommand, listTodoInboxItems } from '../../src/todo/inbox.js';
import { addDays, todayInTimezone } from '../../src/utils/date.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ORIGINAL_CWD = process.cwd();
let failures = 0;

async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`  ✗ ${name}\n    ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  }
}

// --- the rule ------------------------------------------------------------------

async function testResolveFeedbackDate(): Promise<void> {
  console.log('\n--- resolveFeedbackDate ---');
  const today = '2026-10-23';
  await check('no date is today, as before', () => {
    assert.deepEqual(resolveFeedbackDate(undefined, 'defer', today), { ok: true, date: today, past: false });
    assert.deepEqual(resolveFeedbackDate('', 'place', today), { ok: true, date: today, past: false });
  });
  await check('today named explicitly allows every event', () => {
    assert.deepEqual(resolveFeedbackDate(today, 'remove', today), { ok: true, date: today, past: false });
  });
  await check('a past day takes a tick, a correction, a text edit and an undo', () => {
    for (const event of ['complete', 'partial', 'missed', 'update', 'reopen']) {
      assert.deepEqual(resolveFeedbackDate('2026-10-21', event, today), { ok: true, date: '2026-10-21', past: true }, event);
    }
  });
  await check('a past day refuses what reschedules', () => {
    for (const event of ['defer', 'remove', 'place', 'unplace']) {
      assert.equal(resolveFeedbackDate('2026-10-21', event, today).ok, false, event);
    }
  });
  await check('a day after today is refused', () => {
    assert.equal(resolveFeedbackDate('2026-10-24', 'complete', today).ok, false);
  });
  await check('garbage is refused rather than read as today', () => {
    assert.equal(resolveFeedbackDate('yesterday', 'complete', today).ok, false);
    assert.equal(resolveFeedbackDate('2026-13-45', 'complete', today).ok, false);
    assert.equal(resolveFeedbackDate(20261021, 'complete', today).ok, false);
  });
}

// --- the endpoint ----------------------------------------------------------------

async function testEndpoint(): Promise<void> {
  console.log('\n--- /api/today/todo-feedback with date ---');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-os-past-edit-'));
  const parsed = yaml.load(fs.readFileSync(path.join(REPO_ROOT, 'config', 'config.example.yaml'), 'utf8')) as Record<string, any>;
  parsed.memory.repository_path = path.join(tmp, 'vault');
  parsed.todo_inbox.ledger_path = path.join(tmp, 'todo-inbox.jsonl');
  parsed.todo_inbox.vault_path = path.join(tmp, 'todo-inbox.md');
  fs.mkdirSync(path.join(tmp, 'config'), { recursive: true });
  fs.mkdirSync(parsed.memory.repository_path, { recursive: true });
  fs.writeFileSync(path.join(tmp, 'config', 'config.yaml'), yaml.dump(parsed), 'utf8');
  fs.writeFileSync(path.join(tmp, '.env'), '');

  process.chdir(tmp);
  // Same reason as cycle-create.test.ts: a test server must never overwrite the
  // running service's address file.
  const originalRuntimePath = process.env.DAILY_OS_UI_RUNTIME_PATH;
  process.env.DAILY_OS_UI_RUNTIME_PATH = path.join(tmp, 'data', 'runtime', 'ui.json');
  const config = AppConfigSchema.parse(parsed);
  const today = todayInTimezone(config);
  const yesterday = addDays(today, -1);

  const captured = handleTodoInboxCommand(config, { type: 'capture', text: '写周报' }, { source: 'test', messageId: 'm1' });
  const captureId = captured.items?.[0]?.id;
  assert.ok(captureId, 'capture returned an item');
  appendDailyMemory(
    config,
    'daily_plan',
    yesterday,
    JSON.stringify({
      todos: [
        { rank: 1, text: '第一件', candidateId: 'linear:T-1', minutes: 30 },
        { rank: 2, text: '第二件', candidateId: 'linear:T-2', minutes: 30 },
        { rank: 3, text: '写周报', candidateId: `todo_inbox:${captureId}`, minutes: 30 },
      ],
    }),
  );

  const { startUiServer } = await import('../../src/ui/server.js');
  const controls = await startUiServer({ configPath: 'config/config.yaml', envPath: '.env', host: '127.0.0.1', port: 0, open: false });
  const headers = { Authorization: `Bearer ${controls.token}`, 'content-type': 'application/json' };
  const post = async (body: Record<string, unknown>): Promise<any> =>
    (await fetch(`${controls.url}/api/today/todo-feedback`, { method: 'POST', headers, body: JSON.stringify(body) })).json();
  const day = async (date: string): Promise<any> => (await fetch(`${controls.url}/api/day/plan?date=${date}`, { headers })).json();
  const inboxStatus = (): string | undefined => listTodoInboxItems(config).find((item) => item.id === captureId)?.status;

  try {
    await check('a tick sent with yesterday\'s date lands on yesterday', async () => {
      const result = await post({ candidateId: 'linear:T-1', rank: 1, event: 'complete', date: yesterday });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.date, yesterday);
      assert.equal((await day(yesterday)).feedback['linear:T-1'], 'complete');
      assert.equal(listTodoFeedback(config).some((entry) => entry.candidateId === 'linear:T-1' && entry.date === today), false);
    });

    await check('a past day can be corrected and taken back', async () => {
      await post({ candidateId: 'linear:T-2', rank: 2, event: 'missed', date: yesterday });
      assert.equal((await day(yesterday)).feedback['linear:T-2'], 'missed');
      await post({ candidateId: 'linear:T-2', rank: 2, event: 'reopen', date: yesterday });
      assert.equal((await day(yesterday)).feedback['linear:T-2'], undefined);
    });

    await check('a past row can be reworded, and keeps its tick', async () => {
      const result = await post({ candidateId: 'linear:T-1', rank: 1, event: 'update', text: '第一件（改过）', note: '其实下午就做完了', date: yesterday });
      assert.equal(result.ok, true, JSON.stringify(result));
      const after = await day(yesterday);
      assert.equal(after.todos.find((todo: any) => todo.candidateId === 'linear:T-1')?.text, '第一件（改过）');
      assert.equal(after.notes['linear:T-1'], '其实下午就做完了');
      assert.equal(after.feedback['linear:T-1'], 'complete');
    });

    await check('no date still means today', async () => {
      await post({ candidateId: 'linear:T-9', rank: 1, event: 'complete' });
      const entry = listTodoFeedback(config).find((item) => item.candidateId === 'linear:T-9');
      assert.equal(entry?.date, today);
      assert.equal(entry?.source, 'console-today');
    });

    await check('rescheduling a day that is over is refused, and nothing is written', async () => {
      const before = listTodoFeedback(config).length;
      for (const event of ['defer', 'remove', 'place']) {
        const result = await post({ candidateId: 'linear:T-2', rank: 2, event, start: '10:00', date: yesterday });
        assert.equal(result.ok, false, event);
      }
      assert.equal((await post({ candidateId: 'linear:T-2', rank: 2, event: 'complete', date: addDays(today, 1) })).ok, false);
      assert.equal(listTodoFeedback(config).length, before);
    });

    await check('ticking yesterday\'s capture closes the capture', async () => {
      await post({ candidateId: `todo_inbox:${captureId}`, rank: 3, event: 'complete', date: yesterday });
      assert.equal(inboxStatus(), 'done');
      await post({ candidateId: `todo_inbox:${captureId}`, rank: 3, event: 'reopen', date: yesterday });
      assert.equal(inboxStatus(), 'open', 'a mis-tick on a past day can be taken back');
    });

    await check('marking yesterday 未做 does not reopen a capture finished today', async () => {
      await post({ candidateId: `todo_inbox:${captureId}`, rank: 1, event: 'complete' });
      assert.equal(inboxStatus(), 'done');
      await post({ candidateId: `todo_inbox:${captureId}`, rank: 3, event: 'missed', date: yesterday });
      assert.equal(inboxStatus(), 'done');
      assert.equal((await day(yesterday)).feedback[`todo_inbox:${captureId}`], 'missed');
    });

    await check('/api/day/plan says a past day is editable, so the client may send dates', async () => {
      assert.equal((await day(yesterday)).editable, true);
      assert.equal((await day(today)).editable, undefined);
    });
  } finally {
    await controls.stop();
    process.chdir(ORIGINAL_CWD);
    if (originalRuntimePath === undefined) delete process.env.DAILY_OS_UI_RUNTIME_PATH;
    else process.env.DAILY_OS_UI_RUNTIME_PATH = originalRuntimePath;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

await testResolveFeedbackDate();
await testEndpoint();
if (failures > 0) {
  console.error(`\n${failures} failed`);
  process.exit(1);
}
console.log('\npast-day edits: all passed');
