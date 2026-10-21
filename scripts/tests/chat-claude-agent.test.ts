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
import { claudeAgentArgs, syncChatSkills } from '../../src/interaction/agent-mode.js';
import { readWorkflowPrompt, skillBody } from '../../src/agent/openai-agent.js';
import os from 'node:os';
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
  assert.equal(value(args, '--tools'), 'Read,Glob,Grep,Edit,Write,Skill');
  assert.equal(value(args, '--permission-mode'), 'acceptEdits');
  assert.equal(value(args, '--setting-sources'), 'project');
  assert.ok(args.includes('--strict-mcp-config'));
  assert.ok(!args.join(' ').includes('Bash'));
  assert.ok(!args.includes('--resume'));
}

// Read-only: no edit tools at all.
{
  const args = claudeAgentArgs(config('read-only'), session());
  assert.equal(value(args, '--tools'), 'Read,Glob,Grep,Skill');
  assert.equal(value(args, '--permission-mode'), 'default');
}

// Resumes its own session, never a Codex thread id.
assert.equal(value(claudeAgentArgs(config('workspace-write'), session('claude:abc')), '--resume'), 'abc');
assert.ok(!claudeAgentArgs(config('workspace-write'), session('019a-codex-thread')).includes('--resume'));

// The skills Daily OS ships land in the chat's project skills, and a stale copy is replaced.
{
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-os-chat-skills-'));
  const shipped = path.join(REPO_ROOT, 'prompts', 'skills');
  assert.deepEqual(syncChatSkills(vault, shipped), ['daily-plan']);
  const copy = path.join(vault, '.claude', 'skills', 'daily-plan', 'SKILL.md');
  const source = fs.readFileSync(path.join(shipped, 'daily-plan', 'SKILL.md'), 'utf8');
  assert.equal(fs.readFileSync(copy, 'utf8'), source);
  fs.writeFileSync(copy, 'edited by hand', 'utf8');
  syncChatSkills(vault, shipped);
  assert.equal(fs.readFileSync(copy, 'utf8'), source, 'a changed copy is put back');
  assert.deepEqual(syncChatSkills(vault, path.join(vault, 'missing')), [], 'no skills shipped: nothing, no throw');
}

// One SKILL.md: the frontmatter follows the open standard, and the scheduled run gets only the body.
{
  const text = fs.readFileSync(path.join(REPO_ROOT, 'prompts', 'skills', 'daily-plan', 'SKILL.md'), 'utf8');
  const front = text.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(front, 'starts with YAML frontmatter');
  const meta = yaml.load(front[1]) as { name: string; description: string };
  assert.equal(meta.name, 'daily-plan', 'name matches its folder');
  assert.ok(meta.description.length > 0 && meta.description.length <= 1024);
  assert.equal(readWorkflowPrompt('daily_plan'), skillBody(text));
  assert.ok(!readWorkflowPrompt('daily_plan').startsWith('---'));
  assert.ok(readWorkflowPrompt('daily_plan').startsWith('从今天的已评分候选中'));
}

console.log('chat-claude-agent tests passed');
