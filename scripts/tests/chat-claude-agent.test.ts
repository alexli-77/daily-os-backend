/**
 * Free chat on `claude -p`: what the run is allowed to touch.
 *
 * Run: tsx scripts/tests/chat-claude-agent.test.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

import { AppConfigSchema, type AppConfig } from '../../src/config/schema.js';
import { claudeAgentArgs } from '../../src/interaction/agent-mode.js';
import type { FeishuSessionRecord } from '../../src/interaction/session-catalog.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function config(sandbox: 'read-only' | 'workspace-write'): AppConfig {
  const parsed = yaml.load(fs.readFileSync(path.join(REPO_ROOT, 'config', 'config.example.yaml'), 'utf8')) as Record<string, any>;
  parsed.llm = { ...(parsed.llm || {}), provider: 'claude', model: 'default' };
  parsed.interaction.feishu.agent_mode = { ...(parsed.interaction.feishu.agent_mode || {}), enabled: true, sandbox };
  return AppConfigSchema.parse(parsed);
}

const session = (id?: string) => ({ codex_session_id: id }) as unknown as FeishuSessionRecord;
const value = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

// Writable: file tools only, edits accepted, no Bash, no user settings, no MCP.
{
  const args = claudeAgentArgs(config('workspace-write'), session());
  assert.equal(value(args, '--tools'), 'Read,Glob,Grep,Edit,Write');
  assert.equal(value(args, '--permission-mode'), 'acceptEdits');
  assert.equal(value(args, '--setting-sources'), 'project');
  assert.ok(args.includes('--strict-mcp-config'));
  assert.ok(!args.join(' ').includes('Bash'));
  assert.ok(!args.includes('--resume'));
}

// Read-only: no edit tools at all.
{
  const args = claudeAgentArgs(config('read-only'), session());
  assert.equal(value(args, '--tools'), 'Read,Glob,Grep');
  assert.equal(value(args, '--permission-mode'), 'default');
}

// Resumes its own session, never a Codex thread id.
assert.equal(value(claudeAgentArgs(config('workspace-write'), session('claude:abc')), '--resume'), 'abc');
assert.ok(!claudeAgentArgs(config('workspace-write'), session('019a-codex-thread')).includes('--resume'));

console.log('chat-claude-agent tests passed');
