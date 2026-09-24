/**
 * The 记下 capture field must never silently swallow a todo.
 *
 * The field doubles as a command line ("完成 X", "删除 X"), so the endpoint runs
 * the text through parseTodoInboxCommand first. The bug: a normal todo that
 * merely *starts* with 完成 / 删除 / 暂缓 / … was read as a done/delete command,
 * found no matching open todo, no-op'd, and was lost — the user typed
 * "完成导师布置的论文任务，并且回复导师邮件。" and nothing was captured.
 *
 * resolveCaptureCommand honours a command only when its target names an existing
 * open todo; otherwise it captures verbatim. These tests pin both halves.
 *
 * Dependency-free runner: `tsx scripts/tests/todo-capture.test.ts`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { AppConfig } from '../../src/config/schema.js';
import type { TodoInboxItem } from '../../src/todo/inbox.js';
import {
  handleTodoInboxCommand,
  listTodoInboxItems,
  openTodoInboxItems,
  resolveCaptureCommand,
} from '../../src/todo/inbox.js';

type TestFn = () => void;
const tests: Array<{ name: string; fn: TestFn }> = [];
function test(name: string, fn: TestFn): void {
  tests.push({ name, fn });
}

function makeConfig(): AppConfig {
  return {
    todo_inbox: {
      enabled: true,
      ledger_path: './data/runtime/todo-inbox.jsonl',
      vault_path: './data/memory/daily-os-todo.md',
      vault_relative_path: '',
    },
    sources: { vault: { local_path: '' } },
  } as unknown as AppConfig;
}

function seed(config: AppConfig, items: Array<Partial<TodoInboxItem> & { id: string; status: TodoInboxItem['status']; text: string }>): void {
  const ledger = path.resolve(config.todo_inbox.ledger_path);
  fs.mkdirSync(path.dirname(ledger), { recursive: true });
  const now = '2026-09-24T12:00:00Z';
  const lines = items.map((item) => JSON.stringify({ created_at: now, updated_at: now, source: 'test', raw_text: item.text, type: 'todo', ...item }));
  fs.writeFileSync(ledger, lines.length ? `${lines.join('\n')}\n` : '', 'utf8');
}

/** Capture the way the endpoint does: resolve, then hand to the inbox. */
function capture(config: AppConfig, text: string) {
  return handleTodoInboxCommand(config, resolveCaptureCommand(config, text), { source: 'local-ui' });
}

function withTmpWorkdir(fn: () => void): void {
  const cwd = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-capture-'));
  fs.mkdirSync(path.join(dir, 'data', 'runtime'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'data', 'memory'), { recursive: true });
  process.chdir(dir);
  try {
    fn();
  } finally {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('THE BUG: a todo starting with 完成 is captured, not swallowed as a done command', () => {
  withTmpWorkdir(() => {
    const config = makeConfig();
    seed(config, []);
    const text = '完成导师布置的论文任务，并且回复导师邮件。';
    const command = resolveCaptureCommand(config, text);
    assert.equal(command.type, 'capture', 'no matching open todo → capture, not update');

    const result = capture(config, text);
    const open = openTodoInboxItems(config);
    assert.equal(open.length, 1, 'exactly one todo captured');
    assert.equal(open[0].text, text, 'the full text is captured verbatim');
    assert.ok((result.items || []).length === 1, 'the reply reports one written item, not a no-op');
  });
});

test('a real completion still works: 完成 <existing open todo> marks it done', () => {
  withTmpWorkdir(() => {
    const config = makeConfig();
    seed(config, [{ id: 'o-1', status: 'open', text: '缴纳学费' }]);
    const command = resolveCaptureCommand(config, '完成 缴纳学费');
    assert.equal(command.type, 'update', 'a matching target keeps command semantics');

    capture(config, '完成 缴纳学费');
    assert.deepEqual(openTodoInboxItems(config).map((item) => item.id), [], 'the existing todo is marked done');
    assert.equal(listTodoInboxItems(config).length, 1, 'no new todo was created');
  });
});

test('删除 / 暂缓 with no matching todo are captured too', () => {
  withTmpWorkdir(() => {
    const config = makeConfig();
    seed(config, []);
    assert.equal(resolveCaptureCommand(config, '删除旧的美签预约记录').type, 'capture');
    assert.equal(resolveCaptureCommand(config, '暂缓处理保险的事').type, 'capture');
    capture(config, '删除旧的美签预约记录');
    assert.equal(openTodoInboxItems(config).length, 1, 'it lands in the inbox');
  });
});

test('a plain todo (no command keyword) is captured, unchanged behavior', () => {
  withTmpWorkdir(() => {
    const config = makeConfig();
    seed(config, []);
    assert.equal(resolveCaptureCommand(config, '订羽毛球场地').type, 'capture');
    capture(config, '订羽毛球场地');
    assert.deepEqual(openTodoInboxItems(config).map((item) => item.text), ['订羽毛球场地']);
  });
});

let passed = 0;
let failed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(`    ${error instanceof Error ? error.message : String(error)}`);
  }
}
console.log(`\ntodo-capture.test: ${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
