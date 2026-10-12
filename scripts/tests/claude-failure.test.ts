/**
 * `describeClaudeFailure` — the reason a failed `claude -p` run records.
 *
 * The stream opens with SessionStart hook events; the old message was the first
 * slice of stdout, so the ledger kept hook noise and never the reason.
 *
 * Run: tsx scripts/tests/claude-failure.test.ts
 */
import assert from 'node:assert/strict';

import { describeClaudeFailure } from '../../src/agent/claude-agent.js';

const hook = JSON.stringify({ type: 'system', subtype: 'hook_started', hook_name: 'SessionStart:startup', output: 'x'.repeat(800) });

// Expired login: the fix, plus the CLI's own words.
{
  const stdout = [
    hook,
    JSON.stringify({ type: 'system', subtype: 'init' }),
    JSON.stringify({ type: 'assistant', error: 'authentication_failed', message: { content: [] } }),
    JSON.stringify({ type: 'result', subtype: 'success', is_error: true, api_error_status: 401, result: 'Failed to authenticate. API Error: 401 OAuth access token has expired.' }),
  ].join('\n');
  const reason = describeClaudeFailure(stdout, '');
  assert.ok(reason.startsWith('Claude Code 登录过期了'), reason);
  assert.ok(reason.includes('/login'));
  assert.ok(reason.includes('OAuth access token has expired'));
  assert.ok(!reason.includes('hook_started'));
}

// Any other error result: its text, not the hook events in front of it.
{
  const stdout = [hook, JSON.stringify({ type: 'result', is_error: true, result: 'Credit balance is too low' })].join('\n');
  assert.equal(describeClaudeFailure(stdout, ''), 'Credit balance is too low');
}

// No result event: stderr first, then raw stdout, as before.
assert.equal(describeClaudeFailure('not json', 'boom'), 'boom');
assert.equal(describeClaudeFailure('not json', ''), 'not json');

console.log('claude-failure tests passed');
