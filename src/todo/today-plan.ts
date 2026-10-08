import type { AppConfig } from '../config/schema.js';
import { scheduledSessionsFor } from '../cycles/schedule.js';
import { resolveDayShape } from '../user/rhythm.js';
import { readDailyPlanOutput } from '../storage/memory.js';
import { todayInTimezone } from '../utils/date.js';
import { extractDailyPlanTodos, type DailyPlanTodo } from '../workflows/summary.js';
import { listTodoFeedback } from './feedback.js';

/**
 * Plan rows the snapshot adds for the user's meal blocks (LEO-332). A meal is
 * time the user may move, shorten, skip or tick like any task, so it is a row,
 * pinned by default to the time in `user.rhythm.meal_blocks`. Never a scorer
 * candidate, never reconciled by the review, never pushed to teammates.
 */
export const RHYTHM_ROW_PREFIX = 'rhythm:';

export function isRhythmRow(candidateId: string): boolean {
  return candidateId.startsWith(RHYTHM_ROW_PREFIX);
}

function minutesBetween(start: string, end: string): number {
  const toMinutes = (clock: string): number => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));
  return toMinutes(end) - toMinutes(start);
}

/** One row per meal block, after the plan's own rows. */
function mealRows(config: AppConfig, date: string, after: number): Array<DailyPlanTodo & { start: string }> {
  // Under a 作息 the routine carries its own meals as fixed blocks, and these
  // rows would put lunch on the sheet twice. Otherwise the configured meals
  // only — not the day shape's default lunch for a config that set none.
  const blocks = resolveDayShape(config, date).routine ? [] : (config.user?.rhythm?.meal_blocks ?? []);
  const seen = new Set<string>();
  return blocks
    .filter((block) => minutesBetween(block.start, block.end) > 0)
    .flatMap((block) => {
      const candidateId = `${RHYTHM_ROW_PREFIX}meal:${block.label}`;
      if (seen.has(candidateId)) return [];
      seen.add(candidateId);
      return [{ candidateId, text: block.label, minutes: minutesBetween(block.start, block.end), start: block.start }];
    })
    .map((row, index) => ({ ...row, rank: after + index + 1 }));
}

function todayHabitSlots(config: AppConfig, date: string): Array<{ id: string; start: string; end: string; title: string; note?: string }> {
  return (resolveDayShape(config, date).routine?.slots ?? []).filter((slot) => slot.habit);
}

/** A row is a habit when it is a habit-slot row, or the plan put it inside one. */
function isHabitRow(candidateId: string, start: string | undefined, slots: Array<{ start: string; end: string }>): boolean {
  if (candidateId.startsWith(`${RHYTHM_ROW_PREFIX}habit:`)) return true;
  return Boolean(start && slots.some((slot) => slot.start <= start && start < slot.end));
}

/**
 * One row per habit slot of today's 作息 that the plan left empty, at the
 * slot's time and length. Habits are to-dos: ticked when done, dragged when
 * the day moves, deleted on a day they cannot happen (a flight, a sick day) —
 * a band behind the rows could be none of those.
 */
function habitRows(config: AppConfig, date: string, todos: DailyPlanTodo[]): Array<DailyPlanTodo & { start: string }> {
  const slots = todayHabitSlots(config, date);
  return slots
    .filter((slot) => !todos.some((todo) => todo.start && slot.start <= todo.start && todo.start < slot.end))
    .map((slot, index) => ({
      candidateId: `${RHYTHM_ROW_PREFIX}habit:${slot.id}`,
      text: slot.note ? `${slot.title}：${slot.note}` : slot.title,
      minutes: minutesBetween(slot.start, slot.end),
      start: slot.start,
      habit: true,
      rank: todos.length + 100 + index,
    }));
}

/**
 * Today's plan as one value: the ranked todos today's last `daily_plan` run
 * produced, with the user's own edits (estimate, order) folded in, plus the
 * complete / defer / update state per row for that day.
 *
 * Extracted from the console's `/api/today/plan` so the same object can be
 * handed to a teammate over team sync. The web page, the native clients and
 * the row a teammate reads must all be the same list, and the way to make
 * sure of that is to compute it in exactly one place.
 */
export interface TodayPlanSnapshot {
  /** The plan's own date. Today's for `buildTodayPlanSnapshot`; any day for `buildPlanSnapshotForDate`. */
  date: string;
  generated_at: string;
  todos: DailyPlanTodo[];
  /** Latest state per candidateId: complete | partial | defer | update. Absent = untouched. */
  feedback: Record<string, string>;
  /**
   * The last note left on each row, whatever event carried it.
   *
   * The ledger has held these since 记一条更新 shipped, but nothing read them
   * back — the note went in and was never seen again, which made the control
   * look like it had discarded what you typed.
   */
  notes: Record<string, string>;
}

/**
 * Sort by the user's saved order where one exists, the model's rank where it
 * doesn't. `index` breaks ties, so two rows that end up with the same key keep
 * the order they arrived in instead of swapping on every read.
 */
export function applyUserOrder(todos: DailyPlanTodo[], userRank: Map<string, number>): DailyPlanTodo[] {
  if (userRank.size === 0) return todos;
  return todos
    .map((todo, index) => ({ todo, key: userRank.get(todo.candidateId) ?? todo.rank, index }))
    .sort((left, right) => left.key - right.key || left.index - right.index)
    .map(({ todo }, index) => ({ ...todo, rank: index + 1 }));
}

/**
 * Null when today has no `daily_plan` output. Never throws on a bad ledger.
 *
 * Today's, not the most recent one: yesterday's plan shown as today's is how
 * someone works a day behind without noticing, so a day with no plan returns
 * null instead of reaching back. And today's, not the last workflow to run —
 * see `readDailyPlanOutput` (LEO-309).
 *
 * Every consumer therefore holds today's plan or nothing; none of them needs a
 * "this is from an earlier day" path, and `/api/today/plan` keeps its `stale`
 * flag only because the Mac client requires the field.
 */
export function buildTodayPlanSnapshot(config: AppConfig): TodayPlanSnapshot | null {
  const date = todayInTimezone(config);
  return buildPlanSnapshotForDate(config, date, readDailyPlanOutput(config, date), { mealRows: true });
}

/**
 * The same snapshot for any date — the past-days view reads it.
 *
 * One builder for both, so a past day shows exactly what its Today page
 * showed at the end of that day: the user's order, their estimate edits, and
 * the last state each row was left in. `output` lets the caller supply a plan
 * found somewhere other than `readDailyPlanOutput` (the detail cache it reads
 * is pruned to about a week; the daily memory file is not).
 */
export function buildPlanSnapshotForDate(
  config: AppConfig,
  date: string,
  output: { date?: string; generated_at?: string; content: string } | null = readDailyPlanOutput(config, date),
  // Today's sheet only: 往日 replays a day as it was, and those days had no
  // meal rows (LEO-332).
  options: { mealRows?: boolean } = {},
): TodayPlanSnapshot | null {
  const latest = output;
  if (!latest) return null;

  const todos = extractDailyPlanTodos(latest.content);

  // Latest feedback per candidate for that day, so a row the user already ticked
  // does not come back looking untouched.
  const feedback: Record<string, string> = {};
  const notes: Record<string, string> = {};
  const editedMinutes = new Map<string, number>();
  // The user's own ordering, latest write wins. Kept separate from `feedback`
  // because it is not a state a row can be *in* — it is where the row sits.
  const userRank = new Map<string, number>();
  // Rows deleted from this day's sheet (LEO-329); `reopen` brings one back.
  const removed = new Set<string>();
  // Rows the user pinned to a time on the timeline (LEO-331); latest wins.
  // `null` records an explicit `unplace`, which a meal row needs to tell apart
  // from "never touched" (that one sits at its configured time).
  const pinned = new Map<string, string | null>();
  // The user's own wording for a row today (LEO-332); latest wins.
  const editedText = new Map<string, string>();
  // The colour the user gave a row today (LEO-334); `auto` clears it.
  const editedColor = new Map<string, string>();
  // The user's own MIT choice for a row today; latest wins.
  const editedMit = new Map<string, boolean>();
  for (const entry of listTodoFeedback(config)) {
    if (entry.date !== date) continue;
    if (entry.event === 'remove') removed.add(entry.candidateId);
    if (entry.event === 'place' && entry.start) pinned.set(entry.candidateId, entry.start);
    if (entry.event === 'unplace') pinned.set(entry.candidateId, null);
    if (entry.event === 'update' && entry.text?.trim()) editedText.set(entry.candidateId, entry.text.trim());
    if (entry.event === 'update' && entry.color) {
      if (entry.color === 'auto') editedColor.delete(entry.candidateId);
      else editedColor.set(entry.candidateId, entry.color);
    }
    if (entry.event === 'update' && typeof entry.mit === 'boolean') editedMit.set(entry.candidateId, entry.mit);
    if (entry.event === 'complete' || entry.event === 'partial' || entry.event === 'defer') {
      feedback[entry.candidateId] = entry.event;
    }
    // An edit says the row was touched, not that it was reopened: renaming or
    // recolouring a ticked row must leave it ticked.
    if (entry.event === 'update' && !(entry.candidateId in feedback)) feedback[entry.candidateId] = 'update';
    // Any event can carry one, not just `update` — ticking a row and saying why
    // is the same note. Latest wins, like every other field here.
    if (entry.note?.trim()) notes[entry.candidateId] = entry.note.trim();
    if (entry.event === 'reorder') userRank.set(entry.candidateId, entry.rank);
    // Ledger order is append order, so a `reopen` after a tick wins and the row
    // comes back untouched. Deleting rather than recording `reopen` as a state:
    // "was completed and then wasn't" is history, and this map is the present.
    if (entry.event === 'reopen') {
      delete feedback[entry.candidateId];
      removed.delete(entry.candidateId);
    }
    // `!== undefined` and not truthiness: 0 is the recorded "back to unknown",
    // and treating it as absent would make an estimate impossible to unset.
    if (entry.minutes !== undefined) editedMinutes.set(entry.candidateId, entry.minutes);
  }

  // The MIT the plan suggests: the rows the model marked, or — for a plan that
  // marked none, including every plan written before the field existed — its
  // first row, which the prompt asks to be the most important.
  const suggested = new Set(todos.filter((todo) => todo.mit).map((todo) => todo.candidateId));
  // Today's habit slots, for tagging the rows that sit in them as habits.
  const habitSlots = options.mealRows ? todayHabitSlots(config, date) : [];
  // Today's sheet only: a big rock from the cycle schedule sits at its reserved
  // time unless the user moved it (双周排期). 往日 replays the day as it was.
  const rockStart = new Map(
    options.mealRows
      ? scheduledSessionsFor(config, date).filter((session) => session.bigRock && session.start).map((session) => [session.itemKey, session.start!] as const)
      : [],
  );
  if (suggested.size === 0 && todos[0]) suggested.add(todos[0].candidateId);

  return {
    date: latest.date || date,
    generated_at: latest.generated_at ?? '',
    // The user's edit wins over the model's guess, and is merged in here rather
    // than shipped as a second map: a client that renders `minutes` should not
    // have to know an override mechanism exists to render the right number.
    todos: applyUserOrder(
      // A plan with no rows (a prose plan, a rest day's empty list) gets no meal
      // rows either: lunch alone is not a plan.
      [
        ...todos,
        ...(options.mealRows && todos.length > 0 ? mealRows(config, date, todos.length) : []),
        ...(options.mealRows && todos.length > 0 ? habitRows(config, date, todos) : []),
      ].filter((todo) => !removed.has(todo.candidateId)).map((row) => {
        const { start: defaultStart, ...plain } = row as DailyPlanTodo;
        const start = pinned.has(plain.candidateId) ? pinned.get(plain.candidateId) : (defaultStart ?? rockStart.get(plain.candidateId.split(':')[2] ?? ''));
        const text = editedText.get(plain.candidateId);
        const color = editedColor.get(plain.candidateId);
        const habit = isHabitRow(plain.candidateId, start ?? undefined, habitSlots);
        const userMit = editedMit.get(plain.candidateId);
        const mit = userMit ?? suggested.has(plain.candidateId);
        const todo = {
          ...plain,
          ...(start ? { start } : {}),
          ...(text ? { text } : {}),
          ...(color ? { color } : {}),
          // Only said when it is yes, or when the user said no: a row nobody
          // marked carries no field, which keeps the snapshot what it was.
          ...(mit || userMit !== undefined ? { mit } : {}),
          ...(userMit !== undefined ? { mitByUser: true } : {}),
          ...(habit ? { habit: true } : {}),
        };
        const edited = editedMinutes.get(todo.candidateId);
        if (edited === undefined) return todo;
        if (edited > 0) return { ...todo, minutes: edited };
        const { minutes: _dropped, ...withoutEstimate } = todo;
        return withoutEstimate;
      }),
      userRank,
    ),
    feedback,
    notes,
  };
}
