import fs from 'node:fs';
import path from 'node:path';

/**
 * Where the UI server advertises its address and local auth token
 * (`data/runtime/ui.json`). Shared so the server (which writes it), the mac
 * companion, and the chat's MCP launcher (which reads it to call `/api`) all
 * agree on one path.
 *
 * `DAILY_OS_UI_RUNTIME_PATH` overrides it — a test that boots a real server
 * resolves this against its own cwd, and without the override would clobber the
 * live file and disconnect the running app.
 */
const DEFAULT_UI_RUNTIME_PATH = './data/runtime/ui.json';

export function uiRuntimePath(): string {
  return path.resolve(process.env.DAILY_OS_UI_RUNTIME_PATH || DEFAULT_UI_RUNTIME_PATH);
}

export interface UiRuntime {
  url: string;
  token: string;
}

/** The running server's base URL + local token, or null when not running. */
export function readUiRuntime(): UiRuntime | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(uiRuntimePath(), 'utf8')) as { url?: unknown; token?: unknown };
    if (typeof parsed.url === 'string' && parsed.url.trim() && typeof parsed.token === 'string' && parsed.token.trim()) {
      return { url: parsed.url, token: parsed.token };
    }
    return null;
  } catch {
    return null;
  }
}
