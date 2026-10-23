/**
 * LEO-345 Phase 1 — the chat's MCP write path.
 *
 * Covers: the tool arg→`/api` request mapping, the loopback caller's auth +
 * error surfacing, the `claude -p` wiring (mcp-config on → MCP tools, no
 * Edit/Write), and one real end-to-end: the built MCP server, spawned over
 * stdio by the SDK client, calling a stub HTTP service.
 *
 * Run: tsx scripts/tests/chat-mcp.test.ts
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { TOOLS, TOOL_ALLOW_NAMES, apiCaller } from '../../src/mcp/tools.js';
import { claudeAgentArgs, writeMcpConfig, mcpServerEntry, agentWorkdir } from '../../src/interaction/agent-mode.js';
import type { AppConfig } from '../../src/config/schema.js';
import type { FeishuSessionRecord } from '../../src/interaction/session-catalog.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

type TestFn = () => void | Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];
function test(name: string, fn: TestFn): void {
  tests.push({ name, fn });
}

const tool = (name: string) => TOOLS.find((t) => t.name === name)!;

// --- tool arg → request mapping -------------------------------------------

test('tools map to the right /api method + path', () => {
  assert.deepEqual(tool('get_state').request({}), { method: 'GET', path: '/api/state' });
  assert.deepEqual(tool('capture_todo').request({ text: '买菜' }), { method: 'POST', path: '/api/capture', body: { text: '买菜' } });
  assert.equal(tool('cycle_section').request({ id: 'x', section: '要务', content: 'c' }).path, '/api/cycles/section');
  assert.equal(tool('save_okr').request({ level: 'current', markdown: '#' }).path, '/api/okr');
});

test('allow-list names are mcp__daily-os__<tool>', () => {
  assert.ok(TOOL_ALLOW_NAMES.includes('mcp__daily-os__capture_todo'));
  assert.equal(TOOL_ALLOW_NAMES.length, TOOLS.length);
});

// --- loopback caller -------------------------------------------------------

test('apiCaller sends the bearer token and returns parsed JSON', async () => {
  const seen: { url?: string; auth?: string; body?: string } = {};
  const fakeFetch = (async (url: string, init: RequestInit) => {
    seen.url = url;
    seen.auth = (init.headers as Record<string, string>).authorization;
    seen.body = init.body as string;
    return new Response(JSON.stringify({ ok: true, echoed: true }), { status: 200 });
  }) as unknown as typeof fetch;
  const call = apiCaller({ url: 'http://127.0.0.1:9/', token: 'tok123' }, fakeFetch);
  const result = await call('POST', '/api/capture', { text: 'hi' });
  assert.equal(seen.url, 'http://127.0.0.1:9/api/capture');
  assert.equal(seen.auth, 'Bearer tok123');
  assert.deepEqual(JSON.parse(seen.body!), { text: 'hi' });
  assert.deepEqual(result, { ok: true, echoed: true });
});

test('apiCaller throws with the server error text on non-2xx', async () => {
  const fakeFetch = (async () => new Response(JSON.stringify({ error: '没有找到' }), { status: 400 })) as unknown as typeof fetch;
  const call = apiCaller({ url: 'http://x', token: 't' }, fakeFetch);
  await assert.rejects(call('POST', '/api/todo-inbox', {}), /没有找到/);
});

// --- claude -p wiring ------------------------------------------------------

function cfg(sandbox = 'read-only'): AppConfig {
  return { interaction: { feishu: { agent_mode: { sandbox } } }, llm: { model: 'default', provider: 'claude' } } as unknown as AppConfig;
}
const session = {} as FeishuSessionRecord;

test('with mcp-config: MCP tools allowed, Edit/Write dropped', () => {
  const args = claudeAgentArgs(cfg('read-only'), session, '/tmp/mcp.json');
  assert.ok(args.includes('--mcp-config') && args.includes('/tmp/mcp.json'), 'passes the config');
  const tools = args[args.indexOf('--tools') + 1];
  assert.ok(tools.includes('mcp__daily-os__capture_todo'), 'MCP tools in allow-list');
  assert.ok(!tools.includes('Edit') && !tools.includes('Write'), 'no raw file-edit tools');
});

test('without mcp-config: old filesystem behavior (fallback)', () => {
  const args = claudeAgentArgs(cfg('workspace-write'), session);
  assert.ok(!args.includes('--mcp-config'));
  const tools = args[args.indexOf('--tools') + 1];
  assert.ok(tools.includes('Edit') && tools.includes('Write'), 'writable sandbox keeps Edit/Write when no MCP');
});

test('writeMcpConfig returns null when the service is unreachable', () => {
  // null (not undefined — that would trigger the readUiRuntime() default).
  assert.equal(writeMcpConfig(null as unknown as never), null);
});

test('writeMcpConfig writes command/args/env for the running service', () => {
  const file = writeMcpConfig({ url: 'http://127.0.0.1:14573', token: 'abc' });
  assert.ok(file);
  const parsed = JSON.parse(fs.readFileSync(file!, 'utf8'));
  const server = parsed.mcpServers['daily-os'];
  assert.equal(server.args[0], mcpServerEntry());
  assert.equal(server.env.DAILY_OS_API_URL, 'http://127.0.0.1:14573');
  assert.equal(server.env.DAILY_OS_API_TOKEN, 'abc');
  fs.rmSync(file!, { force: true });
});

// --- workdir is the vault, never the service data root (secret exposure) ---

function cfgWorkdir(repositoryPath: string, workdir = ''): AppConfig {
  return {
    interaction: { feishu: { agent_mode: { workdir } } },
    memory: { repository_path: repositoryPath },
  } as unknown as AppConfig;
}

test('agentWorkdir defaults to the vault, not cwd (so config/.env stay unreadable)', () => {
  const vault = '/tmp/daily-os-test-vault/daily-os-memory';
  const resolved = agentWorkdir(cfgWorkdir(vault));
  assert.equal(resolved, vault, 'unset workdir → the vault path');
  assert.notEqual(resolved, process.cwd(), 'never the service data root (holds config/.env)');
});

test('agentWorkdir honours an explicit workdir', () => {
  assert.equal(agentWorkdir(cfgWorkdir('/v', '/custom/dir')), '/custom/dir');
});

// --- end-to-end: SDK client → spawned server → stub HTTP -------------------

test('the built MCP server lists its tools and calls through to /api', async () => {
  const entry = path.join(ROOT, 'dist', 'mcp', 'daily-os-mcp.js');
  if (!fs.existsSync(entry)) {
    throw new Error(`build first: ${entry} missing (npm run build)`);
  }

  const received: Array<{ method?: string; url?: string; auth?: string; body: string }> = [];
  const stub = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, text: '已写入', items: [] }));
    });
  });
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
  const port = (stub.address() as import('node:net').AddressInfo).port;

  const client = new Client({ name: 'test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: { ...process.env, DAILY_OS_API_URL: `http://127.0.0.1:${port}`, DAILY_OS_API_TOKEN: 'smoke-tok' },
  });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const names = listed.tools.map((t) => t.name).sort();
    assert.ok(names.includes('capture_todo') && names.includes('save_routines'), 'tools are exposed');
    assert.equal(listed.tools.length, TOOLS.length);

    const result = await client.callTool({ name: 'capture_todo', arguments: { text: '写周报' } });
    const hit = received.find((r) => r.url === '/api/capture');
    assert.ok(hit, 'the capture call reached /api/capture');
    assert.equal(hit!.method, 'POST');
    assert.equal(hit!.auth, 'Bearer smoke-tok');
    assert.deepEqual(JSON.parse(hit!.body), { text: '写周报' });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    assert.match(text, /已写入/, 'the /api reply flows back as tool output');
  } finally {
    await client.close().catch(() => {});
    stub.close();
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
      console.error(`    ${error instanceof Error ? error.stack || error.message : String(error)}`);
    }
  }
  console.log(`\nchat-mcp.test: ${passed}/${passed + failed} passed`);
  if (failed > 0) process.exit(1);
}

void run();
