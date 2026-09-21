import type { AppConfig } from '../config/schema.js';
import { readDailyPlanOutput } from '../storage/memory.js';
import { todayInTimezone } from '../utils/date.js';
import { extractDailyPlanTodos, type DailyPlanTodo } from '../workflows/summary.js';
import { listTodoFeedback } from './feedback.js';

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
  /** The plan's own date, always today: a snapshot exists only for today's plan. */
  date: string;
  generated_at: string;
  todos: DailyPlanTodo[];
  /** Latest state per candidateId: complete | partial | defer | update. Absent = untouched. */
  feedback: Record<string, string>;
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
  const today = todayInTimezone(config);
  const latest = readDailyPlanOutput(config, today);
  if (!latest) return null;

  const todos = extractDailyPlanTodos(latest.content);

  // Latest feedback per candidate for today, so a row the user already ticked
  // does not come back looking untouched.
  const feedback: Record<string, string> = {};
  const editedMinutes = new Map<string, number>();
  // The user's own ordering, latest write wins. Kept separate from `feedback`
  // because it is not a state a row can be *in* — it is where the row sits.
  const userRank = new Map<string, number>();
  for (const entry of listTodoFeedback(config)) {
    if (entry.date !== today) continue;
    if (entry.event === 'complete' || entry.event === 'partial' || entry.event === 'defer' || entry.event === 'update') {
      feedback[entry.candidateId] = entry.event;
    }
    if (entry.event === 'reorder') userRank.set(entry.candidateId, entry.rank);
    // Ledger order is append order, so a `reopen` after a tick wins and the row
    // comes back untouched. Deleting rather than recording `reopen` as a state:
    // "was completed and then wasn't" is history, and this map is the present.
    if (entry.event === 'reopen') delete feedback[entry.candidateId];
    // `!== undefined` and not truthiness: 0 is the recorded "back to unknown",
    // and treating it as absent would make an estimate impossible to unset.
    if (entry.minutes !== undefined) editedMinutes.set(entry.candidateId, entry.minutes);
  }

  return {
    date: latest.date ?? '',
    generated_at: latest.generated_at ?? '',
    // The user's edit wins over the model's guess, and is merged in here rather
    // than shipped as a second map: a client that renders `minutes` should not
    // have to know an override mechanism exists to render the right number.
    todos: applyUserOrder(
      todos.map((todo) => {
        const edited = editedMinutes.get(todo.candidateId);
        if (edited === undefined) return todo;
        if (edited > 0) return { ...todo, minutes: edited };
        const { minutes: _dropped, ...withoutEstimate } = todo;
        return withoutEstimate;
      }),
      userRank,
    ),
    feedback,
  };
}
