import { spawn } from 'node:child_process';

export interface CommandResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  /** True when the child was killed by a timeout rather than exiting on its own. */
  timedOut?: boolean;
  /**
   * When `timedOut`, which timer fired: 'idle' (no output for idleTimeoutMs) or
   * 'total' (the absolute timeoutMs ceiling). Lets a caller tell "the CLI went
   * silent — a hang" apart from "the CLI streamed past the hard cap".
   */
  timeoutKind?: 'idle' | 'total';
}

export function runCommand(
  command: string,
  args: string[],
  options: {
    timeoutMs?: number;
    /**
     * Kill the child when it produces no stdout/stderr for this long. Unlike the
     * absolute `timeoutMs`, this never fires on a slow-but-working run: as long as
     * the child keeps streaming bytes the window resets. A truly stuck child (a
     * `claude` CLI hung under launchd, #199) emits nothing and trips it fast. Use
     * with a streaming output format so the heartbeat exists.
     */
    idleTimeoutMs?: number;
    input?: string;
    env?: NodeJS.ProcessEnv;
    cwd?: string;
  } = {},
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env: options.env, cwd: options.cwd });
    let timedOut = false;
    let timeoutKind: 'idle' | 'total' | undefined;
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          timeoutKind = 'total';
          child.kill('SIGTERM');
        }, options.timeoutMs)
      : undefined;
    // The idle timer is armed at spawn (a child that never emits anything is the
    // hang we most want to catch) and re-armed on every chunk below.
    let idleTimer: NodeJS.Timeout | undefined;
    const armIdle = options.idleTimeoutMs
      ? () => {
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            timedOut = true;
            timeoutKind = 'idle';
            child.kill('SIGTERM');
          }, options.idleTimeoutMs);
        }
      : undefined;
    armIdle?.();
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      armIdle?.();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      armIdle?.();
    });
    const clearTimers = () => {
      if (timer) clearTimeout(timer);
      if (idleTimer) clearTimeout(idleTimer);
    };
    child.on('error', (error) => {
      clearTimers();
      resolve({ ok: false, code: null, stdout, stderr: stderr + error.message, timedOut, timeoutKind });
    });
    child.on('close', (code) => {
      clearTimers();
      // A SIGTERMed child writes nothing on its way out, so without this note
      // the caller sees a failure with two empty streams and no reason.
      const detail = timedOut
        ? `${stderr}\n[timeout] killed by ${timeoutKind} timeout (SIGTERM)`.trim()
        : stderr;
      resolve({ ok: code === 0 && !timedOut, code, stdout, stderr: detail, timedOut, timeoutKind });
    });
    // A child that exits before draining stdin makes this write fail with
    // EPIPE. Nothing listens on the stdin stream, so that becomes an uncaught
    // exception and takes the whole process down — the outcome is already
    // covered by the 'error' and 'close' handlers above, which resolve with
    // whatever the child managed to produce. Swallow it here so a short-lived
    // child cannot kill its caller.
    child.stdin.on('error', () => {});
    child.stdin.end(options.input ?? '');
  });
}

export async function commandExists(command: string, env?: NodeJS.ProcessEnv): Promise<boolean> {
  if (command.includes('/')) {
    const result = await runCommand(command, ['--version'], { timeoutMs: 5000, env });
    return result.ok;
  }
  const result = await runCommand('/usr/bin/env', ['which', command], { timeoutMs: 5000, env });
  return result.ok;
}
