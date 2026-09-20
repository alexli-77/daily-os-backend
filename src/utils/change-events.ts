/**
 * An in-process "something local changed" bus, and nothing more.
 *
 * Team sync wants to push the today-plan snapshot the moment the ledger or the
 * workflow output moves, instead of up to a minute later. The obvious way to
 * get that — call the pusher from `recordTodoFeedback` / `writeLatestWorkflowOutput`
 * — points the dependency arrow the wrong way: the todo ledger and the memory
 * store are the bottom of the stack, and making them import `src/team/sync.ts`
 * would drag Supabase, sessions and the team cache into every CLI path that
 * only wanted to append a line to a jsonl file.
 *
 * So the low-level modules announce, and whoever cares subscribes. The bus
 * knows nothing about sync; sync knows nothing about the ledger's internals.
 *
 * Emitting is best-effort by construction: a listener that throws must not turn
 * a successful local write into a failed one, which is the same rule the push
 * itself follows (see `pushLocalCycle` in src/team/sync.ts).
 */

/**
 * What moved. Only the today-plan snapshot for now — cycle files are watched on
 * disk instead (`fs.watch`), because they are also edited by hand in Obsidian
 * and by the planner subprocess, neither of which goes through this process.
 */
export type LocalChangeKind = 'today_plan';

export type LocalChangeListener = (kind: LocalChangeKind) => void;

const listeners = new Set<LocalChangeListener>();

/** Returns an unsubscribe function. Safe to call twice. */
export function onLocalChange(listener: LocalChangeListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function emitLocalChange(kind: LocalChangeKind): void {
  // Snapshot first: a listener is allowed to unsubscribe itself from inside
  // its own callback without perturbing this iteration.
  for (const listener of [...listeners]) {
    try {
      listener(kind);
    } catch {
      // Deliberately swallowed. See the header: the local write has already
      // succeeded, and a transport that cannot keep up is not its problem.
    }
  }
}

/** Test seam only: drop every subscription between suites. */
export function resetLocalChangeListenersForTests(): void {
  listeners.clear();
}
