/**
 * Countdown-day tests.
 *
 * Independent, dependency-free runner (run with:
 * `tsx scripts/tests/countdown.test.ts`). The interesting surface here is
 * calendar arithmetic, not storage: day spans across a daylight-saving change,
 * the next yearly occurrence when the anchor is 29 February, and which entries
 * the morning card is allowed to mention. The store itself is a JSON array.
 *
 * Runs inside a throwaway workdir (process.chdir) so the countdown file never
 * touches the real repo.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { AppConfig } from '../../src/config/schema.js';
import {
  cardCountdowns,
  countdownDaysLabel,
  deleteCountdown,
  diffCalendarDays,
  isCalendarDate,
  listCountdowns,
  readCountdowns,
  renderCountdownCardLine,
  resolveCountdown,
  saveCountdown,
  type Countdown,
} from '../../src/countdown/store.js';
import { todayInTimezone } from '../../src/utils/date.js';
import { formatWorkflowSummaryForFeishu } from '../../src/workflows/summary.js';

type TestFn = () => void | Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];
function test(name: string, fn: TestFn): void {
  tests.push({ name, fn });
}

const STORE = './data/runtime/countdowns.json';

function makeConfig(timezone = 'America/Toronto'): AppConfig {
  return {
    countdown: { store_path: STORE },
    user: { timezone },
    // `renderDailyPlanTodoSummary` reads this to build Linear links; the card
    // tests below go through it.
    sources: { linear: { workspace: '' } },
  } as unknown as AppConfig;
}

function withTmpWorkdir(fn: () => void): void {
  const cwd = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'countdown-'));
  fs.mkdirSync(path.join(dir, 'data', 'runtime'), { recursive: true });
  process.chdir(dir);
  try {
    fn();
  } finally {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** A stored entry, with everything the caller did not care about filled in. */
function entry(overrides: Partial<Countdown> & { id: string; title: string; date: string }): Countdown {
  return {
    direction: 'until',
    repeat: 'none',
    pinned: false,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function seed(items: Countdown[]): void {
  fs.mkdirSync(path.dirname(path.resolve(STORE)), { recursive: true });
  fs.writeFileSync(path.resolve(STORE), JSON.stringify(items, null, 2), 'utf8');
}

// --- day arithmetic ---------------------------------------------------------

test('a day span is calendar days, not elapsed hours', () => {
  assert.equal(diffCalendarDays('2026-03-07', '2026-03-09'), 2, 'spring-forward weekend is still two days');
  assert.equal(diffCalendarDays('2026-11-01', '2026-11-02'), 1, 'fall-back night is still one day');
  assert.equal(diffCalendarDays('2026-03-09', '2026-03-07'), -2, 'backwards spans are negative');
  assert.equal(diffCalendarDays('2026-02-28', '2026-03-01'), 1, '2026 is not a leap year');
  assert.equal(diffCalendarDays('2024-02-28', '2024-03-01'), 2, '2024 is');
  assert.equal(diffCalendarDays('2026-12-31', '2027-01-01'), 1, 'across the year boundary');
});

test('only real calendar dates are accepted', () => {
  assert.equal(isCalendarDate('2026-02-28'), true);
  assert.equal(isCalendarDate('2024-02-29'), true, 'leap day exists in 2024');
  assert.equal(isCalendarDate('2026-02-29'), false, 'and not in 2026');
  assert.equal(isCalendarDate('2026-13-01'), false);
  assert.equal(isCalendarDate('2026-4-1'), false, 'zero-padding is required');
  assert.equal(isCalendarDate(''), false);
});

// --- yearly repeats ---------------------------------------------------------

test('a yearly entry points at the next occurrence and knows which one it is', () => {
  const birthday = entry({ id: 'b', title: '生日', date: '1990-07-20', repeat: 'yearly' });

  const before = resolveCountdown(birthday, '2026-07-01');
  assert.equal(before.occurrence, '2026-07-20', 'still ahead this year');
  assert.equal(before.daysLeft, 19);
  assert.equal(before.ordinal, 36);

  const onTheDay = resolveCountdown(birthday, '2026-07-20');
  assert.equal(onTheDay.occurrence, '2026-07-20', 'the day itself has not passed');
  assert.equal(onTheDay.daysLeft, 0);

  const after = resolveCountdown(birthday, '2026-07-21');
  assert.equal(after.occurrence, '2027-07-20', 'rolls to next year');
  assert.equal(after.ordinal, 37);
  assert.equal(after.daysLeft, 364);
});

test('a yearly entry anchored on 29 February falls back to the 28th', () => {
  const leap = entry({ id: 'l', title: '闰日', date: '2024-02-29', repeat: 'yearly' });

  const nonLeapYear = resolveCountdown(leap, '2027-01-01');
  assert.equal(nonLeapYear.occurrence, '2027-02-28', '2027 has no 29th');
  assert.equal(nonLeapYear.daysLeft, 58, 'and the day count is a number, not NaN');
  assert.equal(nonLeapYear.ordinal, 3);

  const leapYear = resolveCountdown(leap, '2028-01-01');
  assert.equal(leapYear.occurrence, '2028-02-29', '2028 has one, so use it');
  assert.equal(leapYear.ordinal, 4);
});

test('a one-off keeps counting after it passes', () => {
  const deadline = entry({ id: 'd', title: '截稿', date: '2026-03-01' });
  assert.equal(resolveCountdown(deadline, '2026-03-05').daysLeft, -4);
  assert.equal(resolveCountdown(deadline, '2026-03-05').ordinal, undefined, 'no anniversary without a repeat');
});

// --- labels -----------------------------------------------------------------

test('the day label says what direction the entry runs in', () => {
  const until = entry({ id: 'u', title: '机票', date: '2026-05-01' });
  const since = entry({ id: 's', title: '读博', date: '2025-05-01', direction: 'since' });

  assert.equal(countdownDaysLabel(resolveCountdown(until, '2026-04-08')), '还有 23 天');
  assert.equal(countdownDaysLabel(resolveCountdown(until, '2026-05-01')), '就是今天');
  assert.equal(countdownDaysLabel(resolveCountdown(until, '2026-05-10')), '已过去 9 天', 'a missed deadline is overdue');
  assert.equal(countdownDaysLabel(resolveCountdown(since, '2026-09-29')), '已经 516 天', 'a since-entry is not overdue');
});

// --- what reaches the morning card ------------------------------------------

test('the card takes pinned entries and anything inside 30 days, three at most', () => {
  const today = '2026-04-01';
  const items = [
    entry({ id: 'near', title: '近的', date: '2026-04-10' }),
    entry({ id: 'edge', title: '刚好三十天', date: '2026-05-01' }),
    entry({ id: 'far', title: '三十一天', date: '2026-05-02' }),
    entry({ id: 'pinned-far', title: '置顶但很远', date: '2027-01-01', pinned: true }),
    entry({ id: 'passed', title: '已经过去的', date: '2026-03-01' }),
  ].map((item) => resolveCountdown(item, today));

  const picked = cardCountdowns(items.sort((a, b) => (a.pinned === b.pinned ? a.daysLeft - b.daysLeft : a.pinned ? -1 : 1)));
  assert.deepEqual(
    picked.map((item) => item.id),
    ['pinned-far', 'near', 'edge'],
    'pinned first, then soonest; the 31st day and the passed one are out',
  );
});

test('a since-entry only reaches the card when pinned', () => {
  const today = '2026-04-01';
  const quiet = resolveCountdown(entry({ id: 'q', title: '读博', date: '2025-05-01', direction: 'since' }), today);
  const pinned = resolveCountdown(entry({ id: 'p', title: '读博', date: '2025-05-01', direction: 'since', pinned: true }), today);
  assert.deepEqual(cardCountdowns([quiet]), [], 'counting up is not "upcoming"');
  assert.deepEqual(cardCountdowns([pinned]).map((item) => item.id), ['p']);
});

test('the card line is empty when there is nothing to say', () => {
  withTmpWorkdir(() => {
    const config = makeConfig();
    assert.equal(renderCountdownCardLine(config, '2026-04-01'), '', 'no store at all');
    seed([entry({ id: 'far', title: '很远', date: '2027-01-01' })]);
    assert.equal(renderCountdownCardLine(config, '2026-04-01'), '', 'nothing inside the window');
  });
});

test('the card line reads as one strip of titles and day counts', () => {
  withTmpWorkdir(() => {
    seed([
      entry({ id: 'a', title: 'ICSE 截稿', date: '2026-04-24' }),
      entry({ id: 'b', title: '回国机票', date: '2026-04-10' }),
    ]);
    assert.equal(
      renderCountdownCardLine(makeConfig(), '2026-04-01'),
      '⏳ 回国机票 还有 9 天 · ICSE 截稿 还有 23 天',
    );
  });
});

// --- the card itself --------------------------------------------------------

test('the morning card carries the strip above the briefing', () => {
  withTmpWorkdir(() => {
    seed([entry({ id: 'a', title: 'ICSE 截稿', date: '2026-04-24' })]);
    const plan = JSON.stringify({ todos: [{ rank: 1, text: '写实验', candidateId: 'vault:1' }] });
    const card = formatWorkflowSummaryForFeishu('daily_plan', '2026-04-01', plan, undefined, makeConfig());
    assert.ok(card.startsWith('⏳ ICSE 截稿 还有 23 天\n'), `strip is the first line, got:\n${card}`);
    assert.ok(card.includes('🟡 **今日待办**'), 'and the briefing still follows');
  });
});

test('a card with no countdowns looks exactly like it did before', () => {
  withTmpWorkdir(() => {
    const plan = JSON.stringify({ todos: [{ rank: 1, text: '写实验', candidateId: 'vault:1' }] });
    const card = formatWorkflowSummaryForFeishu('daily_plan', '2026-04-01', plan, undefined, makeConfig());
    assert.ok(card.startsWith('🟡 **今日待办**'), `no empty line where the strip would be, got:\n${card}`);
  });
});

test('a config without a countdown block costs one line, not the card', () => {
  withTmpWorkdir(() => {
    const plan = JSON.stringify({ todos: [{ rank: 1, text: '写实验', candidateId: 'vault:1' }] });
    const legacy = { user: { timezone: 'America/Toronto' }, sources: { linear: { workspace: '' } } } as unknown as AppConfig;
    const card = formatWorkflowSummaryForFeishu('daily_plan', '2026-04-01', plan, undefined, legacy);
    assert.ok(card.includes('🟡 **今日待办**'), `the briefing still goes out, got:\n${card}`);
  });
});

// --- store ------------------------------------------------------------------

test('saving creates once and then updates in place', () => {
  withTmpWorkdir(() => {
    const config = makeConfig();
    const created = saveCountdown(config, { title: '答辩', date: '2029-06-01' });
    assert.equal(readCountdowns(config).length, 1);
    assert.equal(created.direction, 'until', 'defaults to counting down');
    assert.equal(created.repeat, 'none');
    assert.equal(created.pinned, false);

    const updated = saveCountdown(config, { id: created.id, title: '答辩', date: '2029-09-01', pinned: true });
    assert.equal(readCountdowns(config).length, 1, 'still one row');
    assert.equal(updated.date, '2029-09-01');
    assert.equal(updated.pinned, true);
    assert.equal(updated.created_at, created.created_at, 'creation time survives an edit');
    assert.ok(updated.updated_at >= created.updated_at, 'the edit stamp moved forward');
  });
});

test('saving refuses a blank title or an impossible date', () => {
  withTmpWorkdir(() => {
    const config = makeConfig();
    assert.throws(() => saveCountdown(config, { title: '  ', date: '2026-05-01' }), /标题/);
    assert.throws(() => saveCountdown(config, { title: '生日', date: '2026-02-30' }), /合法日期/);
    assert.equal(readCountdowns(config).length, 0, 'nothing was written');
  });
});

test('deleting an unknown id reports that instead of pretending', () => {
  withTmpWorkdir(() => {
    const config = makeConfig();
    const saved = saveCountdown(config, { title: '答辩', date: '2029-06-01' });
    assert.equal(deleteCountdown(config, 'nope'), false);
    assert.equal(readCountdowns(config).length, 1);
    assert.equal(deleteCountdown(config, saved.id), true);
    assert.equal(readCountdowns(config).length, 0);
  });
});

test('a row somebody hand-edited into nonsense drops out, the rest survive', () => {
  withTmpWorkdir(() => {
    const config = makeConfig();
    fs.mkdirSync(path.dirname(path.resolve(STORE)), { recursive: true });
    fs.writeFileSync(
      path.resolve(STORE),
      JSON.stringify([
        entry({ id: 'ok', title: '好的', date: '2026-05-01' }),
        { id: 'no-date', title: '没日期' },
        { id: 'bad-date', title: '坏日期', date: '2026-02-30' },
        { title: '没 id', date: '2026-05-01' },
        'not an object',
      ]),
      'utf8',
    );
    assert.deepEqual(readCountdowns(config).map((item) => item.id), ['ok']);
  });
});

test('a store that will not parse yields an empty list, not a crash', () => {
  withTmpWorkdir(() => {
    fs.mkdirSync(path.dirname(path.resolve(STORE)), { recursive: true });
    fs.writeFileSync(path.resolve(STORE), '{ this is not json', 'utf8');
    assert.deepEqual(readCountdowns(makeConfig()), []);
  });
});

test('the page order is pinned, then coming up, then gone by', () => {
  withTmpWorkdir(() => {
    seed([
      entry({ id: 'passed-old', title: '很久以前', date: '2026-01-01' }),
      entry({ id: 'soon', title: '快到了', date: '2026-04-05' }),
      entry({ id: 'passed-recent', title: '刚过去', date: '2026-03-30' }),
      entry({ id: 'later', title: '晚点', date: '2026-06-01' }),
      entry({ id: 'pinned', title: '置顶', date: '2026-12-25', pinned: true }),
    ]);
    assert.deepEqual(
      listCountdowns(makeConfig(), '2026-04-01').map((item) => item.id),
      ['pinned', 'soon', 'later', 'passed-recent', 'passed-old'],
    );
  });
});

// --- timezone ---------------------------------------------------------------

test("an entry dated today reads as 就是今天 in the user's own timezone", () => {
  // The bug this guards against is reading the day off a UTC ISO string: for a
  // stretch of every evening in the Americas, and every morning in Asia and
  // Oceania, the UTC day is not the user's day.
  for (const timezone of ['UTC', 'America/Toronto', 'Asia/Shanghai', 'Pacific/Auckland', 'America/Los_Angeles']) {
    withTmpWorkdir(() => {
      const config = makeConfig(timezone);
      seed([entry({ id: 'now', title: '今天', date: todayInTimezone(config) })]);
      const [resolved] = listCountdowns(config);
      assert.ok(resolved, `${timezone}: the entry is there`);
      assert.equal(resolved.daysLeft, 0, `${timezone}: today is zero days away`);
      assert.equal(countdownDaysLabel(resolved), '就是今天', `${timezone}: and reads that way`);
    });
  }
});

async function run(): Promise<void> {
  let passed = 0;
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed += 1;
      console.log(`  ✓ ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`  ✗ ${name}`);
      console.error(`    ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  console.log(`\ncountdown.test: ${passed}/${passed + failed} passed`);
  if (failed > 0) process.exit(1);
}

void run();
