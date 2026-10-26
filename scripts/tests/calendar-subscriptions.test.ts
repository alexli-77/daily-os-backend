/**
 * Subscribed calendars (sources.ics_calendars) — read from the calendar, not retold.
 *
 * Independent, tsx-runnable:  npx tsx scripts/tests/calendar-subscriptions.test.ts
 *
 * 2026-10-26: the AG1 program calendar reached Daily OS only through the chat,
 * a day off. These pin the feed reading (recurrence, a moved instance, an
 * excluded date, a two-day all-day event, times in another zone), the
 * exclusion of Cleaning, and that an event becomes a fixed block of its day
 * that the template gives way to — and that the chat is handed the list.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

import { AppConfigSchema, type AppConfig } from '../../src/config/schema.js';
import { occurrencesBetween, parseIcs } from '../../src/calendar/ics.js';
import { calendarBlocksFor, calendarEvents, refreshCalendarSubscriptions, upcomingCalendarLines } from '../../src/calendar/subscriptions.js';
import { buildNowContext } from '../../src/interaction/agent-mode.js';
import { changeDayOverride, routineForDate, writeRoutines } from '../../src/user/routine.js';
import { fixedScheduleFor } from '../../src/cycles/fixed-schedule.js';
import { appendDailyMemory } from '../../src/storage/memory.js';
import { readDayHistory } from '../../src/todo/day-history.js';
import { recordTodoFeedback } from '../../src/todo/feedback.js';

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

// The shapes Google publishes, from the AG1 feed of 2026-10-26.
const FEED = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'X-WR-TIMEZONE:Asia/Tokyo',
  'BEGIN:VEVENT',
  'DTSTART;TZID=Asia/Tokyo:20261012T150000',
  'DTEND;TZID=Asia/Tokyo:20261012T170000',
  'RRULE:FREQ=WEEKLY;WKST=MO;UNTIL=20261130T145959Z;BYDAY=MO',
  'EXDATE;TZID=Asia/Tokyo:20261019T150000',
  'UID:feedback@google.com',
  'SUMMARY:Feedback Session',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'DTSTART;TZID=Asia/Tokyo:20261014T130000',
  'DTEND;TZID=Asia/Tokyo:20261014T150000',
  'RECURRENCE-ID;TZID=Asia/Tokyo:20261012T150000',
  'UID:feedback@google.com',
  'SUMMARY:Feedback Session',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'DTSTART;VALUE=DATE:20261019',
  'DTEND;VALUE=DATE:20261021',
  'UID:retreat@google.com',
  'SUMMARY:AG1 Retreat',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'DTSTART:20261027T053000Z',
  'DTEND:20261027T070000Z',
  'UID:mentoring@google.com',
  'SUMMARY:Mentoring Session with',
  '  a guest',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'DTSTART;TZID=Asia/Tokyo:20261002T140000',
  'DTEND;TZID=Asia/Tokyo:20261002T170000',
  'RRULE:FREQ=WEEKLY;UNTIL=20261219T145959Z;INTERVAL=1;BYDAY=FR',
  'UID:cleaning@google.com',
  'SUMMARY:Cleaning',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'DTSTART:20261028T010000Z',
  'DTEND:20261028T020000Z',
  'UID:cancelled@google.com',
  'STATUS:CANCELLED',
  'SUMMARY:Called off',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

const URL_ = 'https://calendar.example.test/ag1/basic.ics';

function freshConfig(): AppConfig {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-os-ics-'));
  process.chdir(dir);
  const parsed = yaml.load(fs.readFileSync(path.join(REPO_ROOT, 'config', 'config.example.yaml'), 'utf8')) as Record<string, any>;
  parsed.memory.repository_path = path.join(dir, 'vault');
  parsed.todo_inbox.ledger_path = path.join(dir, 'todo-inbox.jsonl');
  parsed.todo_inbox.vault_path = path.join(dir, 'todo-inbox.md');
  parsed.user.timezone = 'Asia/Tokyo';
  parsed.user.rhythm.meal_blocks = [];
  parsed.sources.ics_calendars = [{ name: 'AG1 Batch 3 Program Calendar', label: 'AG1', url: URL_, exclude: ['Cleaning'] }];
  fs.mkdirSync(parsed.memory.repository_path, { recursive: true });
  return AppConfigSchema.parse(parsed);
}

const fakeFetch = (body: string, status = 200) =>
  (async () => new Response(body, { status })) as unknown as typeof fetch;

try {
  console.log('\n--- reading the feed ---');
  const events = parseIcs(FEED);
  const tokyo = occurrencesBetween(events, '2026-10-12', '2026-10-31', 'Asia/Tokyo');
  const on = (date: string) => tokyo.filter((event) => event.date === date).map((event) => `${event.start ?? '全天'} ${event.title}`);
  await check('a weekly series lands on its Mondays, at its own wall time', () => {
    assert.deepEqual(on('2026-10-26'), ['15:00 Feedback Session']);
  });
  await check('an instance moved to another day replaces its Monday, and an excluded date is skipped', () => {
    assert.deepEqual(on('2026-10-12'), []);
    assert.deepEqual(on('2026-10-14'), ['13:00 Feedback Session']);
    assert.deepEqual(on('2026-10-19'), ['全天 AG1 Retreat'], 'no Feedback Session on the retreat Monday');
  });
  await check('a two-day all-day event is on both days, and not on the third', () => {
    assert.ok(on('2026-10-20').includes('全天 AG1 Retreat'));
    assert.ok(!on('2026-10-21').includes('全天 AG1 Retreat'));
  });
  await check('a UTC time is converted, and a folded title is joined', () => {
    assert.deepEqual(on('2026-10-27'), ['14:30 Mentoring Session with a guest']);
  });
  await check('a cancelled event is left out', () => {
    assert.ok(!tokyo.some((event) => event.title === 'Called off'));
  });
  await check('read from Toronto, the same session is at Toronto time', () => {
    const toronto = occurrencesBetween(events, '2026-10-26', '2026-10-26', 'America/Toronto').map((event) => `${event.start} ${event.title}`);
    assert.deepEqual(toronto, ['02:00 Feedback Session']);
  });

  console.log('\n--- the subscription ---');
  const config = freshConfig();
  await check('nothing is read before the first fetch, and a refused fetch keeps saying why', async () => {
    assert.deepEqual(calendarEvents(config, '2026-10-26', '2026-10-26'), []);
    const failed = await refreshCalendarSubscriptions(config, { force: true, fetchImpl: fakeFetch('<html>sign in</html>') });
    assert.equal(failed.updated, 0);
    assert.match(upcomingCalendarLines(config).status[0]!, /还没拉到/);
  });
  await check('after a fetch, Cleaning is left out and titles carry the label once', async () => {
    const result = await refreshCalendarSubscriptions(config, { force: true, fetchImpl: fakeFetch(FEED) });
    assert.equal(result.updated, 1);
    const titles = calendarEvents(config, '2026-10-19', '2026-10-31').map((event) => `${event.date} ${event.shownTitle}`);
    assert.ok(titles.includes('2026-10-26 AG1 Feedback Session'));
    assert.ok(titles.includes('2026-10-19 AG1 Retreat'), 'not "AG1 AG1 Retreat"');
    assert.ok(!titles.some((title) => title.includes('Cleaning')), JSON.stringify(titles));
  });
  await check('a refresh inside the window does not fetch again; a later failure keeps the good copy', async () => {
    let calls = 0;
    const counting = (async () => {
      calls += 1;
      return new Response('nope', { status: 500 });
    }) as unknown as typeof fetch;
    await refreshCalendarSubscriptions(config, { fetchImpl: counting });
    assert.equal(calls, 0);
    await refreshCalendarSubscriptions(config, { force: true, fetchImpl: counting });
    assert.equal(calls, 1);
    assert.equal(calendarEvents(config, '2026-10-26', '2026-10-26').length, 1, 'still has the copy');
    assert.match(upcomingCalendarLines(config).status[0]!, /最近一次失败：HTTP 500/);
  });

  console.log('\n--- in the day ---');
  const blocks = [
    { id: 'work', start: '13:00', end: '18:00', title: '作品集', kind: 'slot' as const },
    { id: 'dinner', start: '18:00', end: '19:00', title: '晚饭', kind: 'fixed' as const },
  ];
  writeRoutines(config, {
    periods: [{ id: 'p', name: '秋', from: '2026-10-01', to: '2026-12-31', categories: [], rules: [], dayTypes: [{ label: '每天', weekdays: ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'], modes: [{ label: '一种', blocks }] }] }],
  });
  await check('an event is a fixed block of its day, and the template gives way under it', () => {
    const day = routineForDate(config, '2026-10-26')!;
    assert.deepEqual(day.blocks.map((block) => [block.start, block.end, block.title]), [
      ['13:00', '15:00', '作品集'],
      ['15:00', '17:00', 'AG1 Feedback Session'],
      ['17:00', '18:00', '作品集'],
      ['18:00', '19:00', '晚饭'],
    ]);
  });
  await check('an all-day event takes the working day', () => {
    assert.ok(routineForDate(config, '2026-10-20')!.blocks.some((block) => block.title === 'AG1 Retreat（全天）' && block.start === '09:00' && block.end === '18:00'));
  });
  await check('Friday has no Cleaning block — it is not the user\'s', () => {
    assert.ok(!routineForDate(config, '2026-10-30')!.blocks.some((block) => block.title.includes('Cleaning')));
  });
  await check('the event is a 固定日程 row of the day, with the 日历 tag when no category is named', () => {
    const rows = fixedScheduleFor(config, '2026-10-26');
    const row = rows.find((candidate) => candidate.title === 'AG1 Feedback Session');
    assert.ok(row, JSON.stringify(rows.map((candidate) => candidate.title)));
    assert.match(row!.candidateId, /^rhythm:block:cal-[0-9a-f]+$/);
    assert.deepEqual([row!.start, row!.end, row!.minutes, row!.text], ['15:00', '17:00', 120, 'AG1 Feedback Session']);
    assert.equal(row!.category, '日历', 'the built-in tag when no 作息 category is named');
  });
  await check('on the sheet it can be ticked like any to-do', () => {
    appendDailyMemory(config, 'daily_plan', '2026-10-26', JSON.stringify({ todos: [{ rank: 1, text: '写作品集', candidateId: 'linear:A-1' }] }));
    const row = readDayHistory(config, '2026-10-26').todos.find((todo) => todo.text === 'AG1 Feedback Session');
    assert.ok(row, 'on the day');
    recordTodoFeedback(config, { date: '2026-10-26', event: 'complete', candidateId: row!.candidateId, rank: row!.rank, source: 'test' });
    assert.equal(readDayHistory(config, '2026-10-26').feedback[row!.candidateId], 'complete');
  });
  await check('stretched for the day, it is still a row, at its new length', () => {
    const id = calendarBlocksFor(config, '2026-11-02')[0]!.id;
    // What the 日 view sends when the block is dragged: no kind, no category.
    changeDayOverride(config, '2026-11-02', { type: 'edit', block: { id, start: '15:00', end: '18:00', title: 'AG1 Feedback Session', kind: 'fixed' } });
    const block = routineForDate(config, '2026-11-02')!.blocks.find((candidate) => candidate.id === id)!;
    assert.deepEqual([block.start, block.end, block.kind], ['15:00', '18:00', 'slot']);
    assert.ok(fixedScheduleFor(config, '2026-11-02').some((row) => row.blockId === id && row.minutes === 180));
  });
  await check('an edit saved as a band before this is read back as a row', () => {
    const id = calendarBlocksFor(config, '2026-11-09')[0]!.id;
    const routines = JSON.parse(fs.readFileSync(path.join(config.memory.repository_path, '00_System', 'routines.json'), 'utf8'));
    routines.dayOverrides['2026-11-09'] = { hidden: [], edits: [{ id, start: '15:00', end: '18:00', title: 'AG1 Feedback Session', kind: 'fixed' }], clears: [] };
    writeRoutines(config, routines);
    assert.equal(routineForDate(config, '2026-11-09')!.blocks.find((candidate) => candidate.id === id)?.kind, 'slot');
  });
  await check('the event can still be hidden for the day, and stays hidden after the feed is fetched again', async () => {
    const id = calendarBlocksFor(config, '2026-10-27')[0]!.id;
    changeDayOverride(config, '2026-10-27', { type: 'hide', blockId: id });
    await refreshCalendarSubscriptions(config, { force: true, fetchImpl: fakeFetch(FEED) });
    assert.ok(!routineForDate(config, '2026-10-27')!.blocks.some((block) => block.id === id));
  });

  console.log('\n--- in the chat ---');
  await check('every chat turn is handed the events, with date and weekday', () => {
    const now = buildNowContext(config) as { events?: string[]; event_sources?: string[] };
    assert.ok(Array.isArray(now.events));
    assert.ok(now.event_sources?.[0]?.includes('不含 Cleaning'), JSON.stringify(now.event_sources));
  });
  await check('the lines say the weekday next to the date', () => {
    const lines = upcomingCalendarLines({ ...config, user: { ...config.user } } as AppConfig, 400, 400).lines;
    assert.ok(lines.includes('10/26 星期一 15:00-17:00 AG1 Feedback Session'), JSON.stringify(lines.slice(0, 6)));
  });
} finally {
  process.chdir(ORIGINAL_CWD);
}
if (failures > 0) {
  console.error(`\n${failures} failed`);
  process.exit(1);
}
console.log('\ncalendar-subscriptions: all passed');
