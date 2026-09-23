/**
 * Cycle files: the local markdown source of truth for one cycle (LEO-276).
 *
 * Independent, tsx-runnable:  npx tsx scripts/tests/cycle-file.test.ts
 *
 * Every later issue in this project reads and writes these files, so the format
 * has to survive the things that are actually in them: Chinese text, full-width
 * punctuation, emoji, `(LEO-197)` issue ids and `**MIT**` emphasis. The other
 * half of the contract is ownership — 要务 is planner-written, retro is
 * hand-written, review is AI-written — so writing one section must leave the
 * other two byte-identical, including their recorded source and timestamp.
 *
 * Everything runs against a temp vault; no real config or vault is touched.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

import { AppConfigSchema, type AppConfig } from '../../src/config/schema.js';
import {
  buildCycleId,
  cycleFilePath,
  cyclesDir,
  deleteCycle,
  listCycles,
  parseCycleId,
  parseCycleMarkdown,
  readCycle,
  serializeCycleMarkdown,
  writeCycle,
  writeSection,
} from '../../src/cycles/file.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

type TestFn = () => void | Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];
function test(name: string, fn: TestFn): void {
  tests.push({ name, fn });
}

const CREATED: string[] = [];

/** A config whose vault points at a fresh temp directory. */
function tempConfig(): { config: AppConfig; vault: string } {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-os-cycles-'));
  CREATED.push(vault);
  const parsed = yaml.load(fs.readFileSync(path.join(REPO_ROOT, 'config', 'config.example.yaml'), 'utf8')) as Record<string, any>;
  parsed.memory.repository_path = vault;
  return { config: AppConfigSchema.parse(parsed), vault };
}

const ID = '2026-08-24_8.24-9.6';

/** A cycle file with everything that has ever broken a naive parser in it. */
const SAMPLE = [
  '---',
  'cycle: 8.24-9.6',
  'mode: biweekly',
  'run_id: c1d24341-1349-4345-a11e-cd6fd1fd2347',
  "updated_at: '2026-09-07T10:00:00Z'",
  'sections:',
  "  要务: {source: planner, updated_at: '2026-09-07T10:00:00Z'}",
  "  retro: {source: user, updated_at: '2026-09-07T09:00:00Z'}",
  "  review: {source: ai, updated_at: '2026-09-07T11:00:00Z'}",
  '---',
  '',
  '## 要务',
  '1. [O1] 英文简历 v1 完成，发起至少 5 家定向申请或内推 **MIT**',
  '2. [O2] 9/1 账本快照后校准三个数 (LEO-102) (LEO-197)',
  '3. [O3] 小红书 3 篇 —— 「只工作不上班」🚀（含全角括号：（对照组））',
  '',
  '## retro',
  '状态：还行 😮‍💨',
  '- 做得好：羽毛球没断',
  '- 待改进：O1 只推进了 30%',
  '',
  '## review',
  'AI：本双周的瓶颈在 O1，不是时间不够，是**决策没做**。',
  '',
].join('\n');

// --- format: round trip ------------------------------------------------------

test('parse -> serialize -> parse is lossless, including CJK, full-width punctuation and emoji', () => {
  const first = parseCycleMarkdown(SAMPLE, ID);
  const once = serializeCycleMarkdown(first);
  const second = parseCycleMarkdown(once, ID);
  const twice = serializeCycleMarkdown(second);

  assert.equal(twice, once, 'serialization must be stable');
  assert.deepEqual(second.sections, first.sections);
  assert.deepEqual(second.blocks, first.blocks);
  assert.equal(second.cycle, '8.24-9.6');
  assert.equal(second.mode, 'biweekly');
  assert.equal(second.runId, 'c1d24341-1349-4345-a11e-cd6fd1fd2347');
  assert.equal(second.updatedAt, '2026-09-07T10:00:00Z');
  assert.equal(second.startDate, '2026-08-24');

  for (const fragment of ['🚀', '（对照组）', '😮‍💨', '「只工作不上班」', '——']) {
    assert.ok(once.includes(fragment), `lost ${fragment} on the way through`);
  }
});

test('issue ids and markdown emphasis survive a round trip through disk', () => {
  const { config } = tempConfig();
  fs.mkdirSync(cyclesDir(config), { recursive: true });
  fs.writeFileSync(cycleFilePath(config, ID), SAMPLE, 'utf8');

  writeSection(config, ID, 'retro', '换一段手写的 retro', 'user');
  const priorities = readCycle(config, ID)?.sections['要务']?.content || '';

  assert.ok(priorities.includes('(LEO-102) (LEO-197)'), priorities);
  assert.ok(priorities.includes('**MIT**'), priorities);
  assert.ok(priorities.includes('1. [O1]'), 'the numbered list must not be renumbered or escaped');
});

test('a pending draft round-trips, then accept promotes it and discard clears it', () => {
  const { config } = tempConfig();
  fs.mkdirSync(cyclesDir(config), { recursive: true });
  fs.writeFileSync(cycleFilePath(config, ID), SAMPLE, 'utf8');

  // Stage a draft on the user-owned retro without touching its body.
  writeCycle(config, ID, { sections: { retro: { pendingDraft: { content: '规划生成的新 retro 草稿', source: 'planner' } } } });
  let doc = readCycle(config, ID)!;
  assert.ok(doc.sections.retro?.content.includes('羽毛球'), 'the body is left alone');
  assert.equal(doc.sections.retro?.pendingDraft?.content, '规划生成的新 retro 草稿');
  assert.equal(doc.sections.retro?.pendingDraft?.source, 'planner');

  // The draft survives a serialize/parse round trip (it lives in the frontmatter).
  const roundTripped = parseCycleMarkdown(serializeCycleMarkdown(doc), ID);
  assert.equal(roundTripped.sections.retro?.pendingDraft?.content, '规划生成的新 retro 草稿');

  // Accept: the body becomes the draft, the draft is cleared.
  const draft = doc.sections.retro!.pendingDraft!;
  writeCycle(config, ID, { sections: { retro: { content: draft.content, source: draft.source } } });
  doc = readCycle(config, ID)!;
  assert.equal(doc.sections.retro?.content, '规划生成的新 retro 草稿');
  assert.equal(doc.sections.retro?.pendingDraft, undefined, 'accept clears the draft');

  // Re-stage, then discard: the body stays, the draft is gone.
  writeCycle(config, ID, { sections: { retro: { pendingDraft: { content: '又一版草稿', source: 'planner' } } } });
  writeCycle(config, ID, { sections: { retro: { pendingDraft: null } } });
  doc = readCycle(config, ID)!;
  assert.equal(doc.sections.retro?.content, '规划生成的新 retro 草稿', 'discard leaves the body');
  assert.equal(doc.sections.retro?.pendingDraft, undefined, 'discard clears the draft');
});

test('section ownership is recorded per section, not per file', () => {
  const doc = parseCycleMarkdown(SAMPLE, ID);
  assert.equal(doc.sections['要务']?.source, 'planner');
  assert.equal(doc.sections.retro?.source, 'user');
  assert.equal(doc.sections.review?.source, 'ai');
  assert.equal(doc.sections.retro?.updatedAt, '2026-09-07T09:00:00Z');
  assert.equal(doc.sections.review?.updatedAt, '2026-09-07T11:00:00Z');
});

// --- format: tolerance -------------------------------------------------------

test('a cycle with only a retro parses, and the absent sections are absent (not empty)', () => {
  const doc = parseCycleMarkdown(['---', 'cycle: 8.24-9.6', 'sections:', '  retro: {source: user}', '---', '', '## retro', '只写了这一段', ''].join('\n'), ID);
  assert.equal(doc.sections.retro?.content, '只写了这一段');
  assert.equal(doc.sections.review, undefined);
  assert.equal(doc.sections['要务'], undefined);
  assert.ok(!serializeCycleMarkdown(doc).includes('## review'), 'must not invent an empty review section');
});

test('a file with no frontmatter reads instead of throwing', () => {
  const doc = parseCycleMarkdown('## retro\n手写的东西\n', ID);
  assert.equal(doc.sections.retro?.content, '手写的东西');
  assert.equal(doc.sections.retro?.source, 'unknown', 'an unrecorded owner is unknown, never a guess');
  assert.equal(doc.cycle, '8.24-9.6', 'the cycle label falls back to the one in the file name');
  assert.equal(doc.mode, 'biweekly');
});

test('broken frontmatter is reported, and the body is still readable', () => {
  const doc = parseCycleMarkdown(['---', 'cycle: 8.24-9.6', '  : : not yaml : [', 'sections: {', '---', '', '## retro', '正文还在', ''].join('\n'), ID);
  assert.ok(doc.frontmatterError, 'the parse failure must be surfaced, not swallowed');
  assert.equal(doc.sections.retro?.content, '正文还在');
});

test('an unterminated frontmatter block does not eat the document', () => {
  const doc = parseCycleMarkdown('---\ncycle: 8.24-9.6\n\n## retro\n正文\n', ID);
  assert.ok(doc.frontmatterError);
  assert.ok(JSON.stringify(doc.blocks).includes('正文'));
});

test('empty and junk input produce a document rather than an exception', () => {
  for (const input of ['', '\n\n', '---\n---\n', '不是 markdown', '---\n[1, 2, 3]\n---\n## retro\nx\n']) {
    const doc = parseCycleMarkdown(input, ID);
    assert.equal(doc.id, ID);
    assert.equal(typeof serializeCycleMarkdown(doc), 'string');
  }
});

test('YAML scalar coercion never turns a label into a number or a timestamp into a Date', () => {
  // Unquoted `9.6` is a YAML float and `2026-09-07T10:00:00Z` is a YAML
  // timestamp; a hand-edited file will have both.
  const doc = parseCycleMarkdown(['---', 'cycle: 9.6', 'mode: weekly', 'updated_at: 2026-09-07T10:00:00Z', '---', '', '## retro', 'x', ''].join('\n'), '2026-09-01_9.6');
  assert.equal(doc.cycle, '9.6');
  assert.equal(typeof doc.updatedAt, 'string');
  assert.ok(doc.updatedAt.startsWith('2026-09-07T10:00:00'));
});

test('an unrecognised mode is preserved rather than rewritten to the default', () => {
  const doc = parseCycleMarkdown('---\ncycle: Q3\nmode: quarterly\n---\n\n## review\nx\n', '2026-07-01_Q3');
  assert.equal(doc.mode, 'quarterly');
  assert.ok(serializeCycleMarkdown(doc).includes('mode: quarterly'));
});

test('an unknown heading is carried through untouched', () => {
  const { config } = tempConfig();
  fs.mkdirSync(cyclesDir(config), { recursive: true });
  fs.writeFileSync(cycleFilePath(config, ID), `${SAMPLE}\n## 其他笔记\n用户自己加的一段\n`, 'utf8');

  writeSection(config, ID, 'review', 'AI 重写的复盘', 'ai');
  const raw = fs.readFileSync(cycleFilePath(config, ID), 'utf8');
  assert.ok(raw.includes('## 其他笔记'), 'a heading we do not own must not be deleted');
  assert.ok(raw.includes('用户自己加的一段'));
});

test('a ## line inside a fenced code block does not split the document', () => {
  const doc = parseCycleMarkdown(['---', 'cycle: 8.24-9.6', '---', '', '## retro', '```md', '## 这不是标题', '```', '收尾', '', '## review', 'x', ''].join('\n'), ID);
  assert.ok(doc.sections.retro?.content.includes('## 这不是标题'));
  assert.ok(doc.sections.retro?.content.includes('收尾'));
  assert.equal(doc.sections.review?.content, 'x');
});

// --- writes ------------------------------------------------------------------

test('writing retro leaves 要务 and review untouched, ownership and timestamps included', () => {
  const { config } = tempConfig();
  fs.mkdirSync(cyclesDir(config), { recursive: true });
  fs.writeFileSync(cycleFilePath(config, ID), SAMPLE, 'utf8');

  const before = readCycle(config, ID);
  writeSection(config, ID, 'retro', '新的手写复盘：这周被会议吃掉了', 'user', { now: '2026-09-08T00:00:00Z' });
  const after = readCycle(config, ID);

  assert.equal(after?.sections.retro?.content, '新的手写复盘：这周被会议吃掉了');
  assert.equal(after?.sections.retro?.source, 'user');
  assert.equal(after?.sections.retro?.updatedAt, '2026-09-08T00:00:00Z');

  assert.deepEqual(after?.sections['要务'], before?.sections['要务'], '要务 must be identical, timestamp included');
  assert.deepEqual(after?.sections.review, before?.sections.review, 'review must be identical, timestamp included');
  assert.equal(after?.updatedAt, '2026-09-08T00:00:00Z', 'the file-level timestamp does move');
});

test('a planner write does not restamp the hand-written retro as planner-owned', () => {
  const { config } = tempConfig();
  writeSection(config, ID, 'retro', '手写', 'user', { now: '2026-09-01T00:00:00Z' });
  writeSection(config, ID, '要务', '1. 计划一条', 'planner', { now: '2026-09-02T00:00:00Z' });

  const doc = readCycle(config, ID);
  assert.equal(doc?.sections.retro?.source, 'user');
  assert.equal(doc?.sections.retro?.updatedAt, '2026-09-01T00:00:00Z');
  assert.equal(doc?.sections['要务']?.source, 'planner');
});

test('writeSection creates the directory and the file, and derives the cycle from the id', () => {
  const { config, vault } = tempConfig();
  assert.ok(!fs.existsSync(path.join(vault, '20_CYCLES')), 'precondition: no cycles directory yet');

  const doc = writeSection(config, ID, '要务', '1. [O1] 英文简历 v1 **MIT**', 'planner', { now: '2026-09-07T10:00:00Z' });

  assert.equal(doc.cycle, '8.24-9.6');
  assert.equal(doc.mode, 'biweekly');
  assert.ok(fs.existsSync(path.join(vault, '20_CYCLES', `${ID}.md`)));
  assert.equal(readCycle(config, ID)?.sections['要务']?.content, '1. [O1] 英文简历 v1 **MIT**');
});

test('sections are written in 要务 / retro / review order whatever order they arrive in', () => {
  const { config } = tempConfig();
  writeSection(config, ID, 'review', 'AI', 'ai');
  writeSection(config, ID, 'retro', '手写', 'user');
  writeSection(config, ID, '要务', '计划', 'planner');

  const raw = fs.readFileSync(cycleFilePath(config, ID), 'utf8');
  assert.ok(raw.indexOf('## 要务') < raw.indexOf('## retro'), raw);
  assert.ok(raw.indexOf('## retro') < raw.indexOf('## review'), raw);
});

test('writeCycle merges: fields and sections left out keep their stored values', () => {
  const { config } = tempConfig();
  writeCycle(config, ID, { mode: 'biweekly', runId: 'run-1', sections: { retro: { content: '手写', source: 'user' } } }, { now: '2026-09-01T00:00:00Z' });
  writeCycle(config, ID, { sections: { review: { content: 'AI', source: 'ai' } } }, { now: '2026-09-02T00:00:00Z' });

  const doc = readCycle(config, ID);
  assert.equal(doc?.runId, 'run-1', 'run_id must survive a write that did not mention it');
  assert.equal(doc?.sections.retro?.content, '手写');
  assert.equal(doc?.sections.retro?.updatedAt, '2026-09-01T00:00:00Z');
  assert.equal(doc?.sections.review?.updatedAt, '2026-09-02T00:00:00Z');
});

test('a failed write leaves the previous file intact and no half-written leftovers', () => {
  const { config } = tempConfig();
  writeSection(config, ID, '要务', '原始内容', 'planner', { now: '2026-09-01T00:00:00Z' });
  const dir = cyclesDir(config);
  const before = fs.readFileSync(cycleFilePath(config, ID), 'utf8');

  fs.chmodSync(dir, 0o500); // read + execute: the directory can be listed, not written
  let threw = false;
  try {
    writeSection(config, ID, '要务', '这一次写不进去', 'planner', { now: '2026-09-02T00:00:00Z' });
  } catch {
    threw = true;
  } finally {
    fs.chmodSync(dir, 0o700);
  }

  assert.ok(threw, 'a write that cannot land must fail loudly');
  assert.equal(fs.readFileSync(cycleFilePath(config, ID), 'utf8'), before, 'the previous version must be intact');
  assert.deepEqual(fs.readdirSync(dir), [`${ID}.md`], 'no temp file may be left behind');
  assert.equal(readCycle(config, ID)?.sections['要务']?.content, '原始内容');
});

// --- listing, deleting, ids --------------------------------------------------

test('listCycles returns newest first and ignores files that are not cycles', () => {
  const { config } = tempConfig();
  writeSection(config, '2026-08-10_8.10-8.23', 'retro', 'a', 'user');
  writeSection(config, '2026-08-24_8.24-9.6', 'retro', 'b', 'user');
  writeSection(config, '2026-07-27_7.27-8.9', 'retro', 'c', 'user');
  fs.writeFileSync(path.join(cyclesDir(config), 'README.md'), '# not a cycle\n');
  fs.writeFileSync(path.join(cyclesDir(config), 'notes.txt'), 'x');

  const ids = listCycles(config).map((doc) => doc.id);
  assert.deepEqual(ids, ['2026-08-24_8.24-9.6', '2026-08-10_8.10-8.23', '2026-07-27_7.27-8.9']);
});

test('a corrupt cycle file does not break the listing', () => {
  const { config } = tempConfig();
  writeSection(config, ID, 'retro', 'ok', 'user');
  fs.writeFileSync(path.join(cyclesDir(config), '2026-09-07_9.7-9.20.md'), '---\n: : broken [\n---\n## retro\nx\n');

  const listed = listCycles(config);
  assert.equal(listed.length, 2);
  assert.ok(listed.some((doc) => doc.frontmatterError));
});

test('listing an absent directory is empty, not an error', () => {
  const { config } = tempConfig();
  assert.deepEqual(listCycles(config), []);
});

test('reading an absent cycle returns null; deleting it returns false', () => {
  const { config } = tempConfig();
  assert.equal(readCycle(config, ID), null);
  assert.equal(deleteCycle(config, ID), false);
  writeSection(config, ID, 'retro', 'x', 'user');
  assert.equal(deleteCycle(config, ID), true);
  assert.equal(readCycle(config, ID), null);
});

test('cycle label and file name map both ways', () => {
  assert.equal(buildCycleId('2026-08-24', '8.24-9.6'), ID);
  assert.deepEqual(parseCycleId(ID), { startDate: '2026-08-24', cycle: '8.24-9.6' });
  const { config } = tempConfig();
  const doc = writeSection(config, buildCycleId('2026-08-24', '8.24-9.6'), 'retro', 'x', 'user');
  assert.equal(path.basename(cycleFilePath(config, doc.id)), '2026-08-24_8.24-9.6.md');
  assert.equal(readCycle(config, doc.id)?.cycle, '8.24-9.6');
});

test('ids that would escape the cycles directory are rejected', () => {
  const { config } = tempConfig();
  for (const bad of ['../../../etc/passwd', '2026-08-24_../evil', '2026-08-24_a/b', 'not-an-id', '2026-08-24_', '2026-8-24_8.24-9.6']) {
    assert.equal(parseCycleId(bad), null, bad);
    assert.equal(readCycle(config, bad), null, bad);
    assert.throws(() => writeSection(config, bad, 'retro', 'x', 'user'), /Invalid cycle id/, bad);
    assert.throws(() => deleteCycle(config, bad), /Invalid cycle id/, bad);
  }
  assert.throws(() => buildCycleId('2026-8-24', '8.24-9.6'), /Invalid cycle id/);
});

test('an empty repository path falls back to the bundled default vault', () => {
  const parsed = yaml.load(fs.readFileSync(path.join(REPO_ROOT, 'config', 'config.example.yaml'), 'utf8')) as Record<string, any>;
  parsed.memory.repository_path = '';
  assert.equal(cyclesDir(AppConfigSchema.parse(parsed)), path.resolve('memory-vault', 'default', '20_CYCLES'));

  parsed.memory.repository_path = path.join(os.tmpdir(), 'daily-os-cycles-does-not-exist-4a1f');
  assert.equal(cyclesDir(AppConfigSchema.parse(parsed)), path.resolve('memory-vault', 'default', '20_CYCLES'));
});

/**
 * Two follow-up decisions on LEO-276, both about the same principle: a file that
 * is meant to be hand-edited must never lose what the parser did not understand.
 * These files live in an *untracked* vault directory — `git status` reports
 * `?? 10_OKR/` — so there is no version history to recover from.
 */

test('a write is refused when the frontmatter could not be parsed', () => {
  const { config, vault } = tempConfig();
  fs.mkdirSync(path.join(vault, '20_CYCLES'), { recursive: true });
  const file = path.join(vault, '20_CYCLES', `${ID}.md`);
  const broken = ['---', 'cycle: 8.24-9.6', 'sections: [unclosed', '---', '', '## retro', '手写内容不能丢'].join('\n');
  fs.writeFileSync(file, broken);

  assert.throws(
    () => writeSection(config, ID, 'review', 'AI 写的', 'ai'),
    /frontmatter could not be parsed/,
    'writing over unparseable frontmatter would discard every key it held',
  );
  assert.equal(fs.readFileSync(file, 'utf8'), broken, 'the file must be byte-identical after a refused write');
});

test('a readable file still writes normally — the guard is not blanket', () => {
  const { config } = tempConfig();
  writeSection(config, ID, 'retro', '状态：还行', 'user');
  const doc = writeSection(config, ID, 'review', 'AI 写的', 'ai');
  assert.equal(doc.sections.retro?.content, '状态：还行');
  assert.equal(doc.sections.review?.source, 'ai');
});

test('unknown frontmatter keys survive a write, like unknown headings do', () => {
  const { config, vault } = tempConfig();
  fs.mkdirSync(path.join(vault, '20_CYCLES'), { recursive: true });
  const file = path.join(vault, '20_CYCLES', `${ID}.md`);
  fs.writeFileSync(
    file,
    ['---', 'cycle: 8.24-9.6', 'mode: biweekly', 'obsidian_tags: [复盘, 2026Q3]', 'my_own_field: 保留我', '---', '', '## retro', '手写'].join('\n'),
  );

  writeSection(config, ID, 'review', 'AI 写的', 'ai');
  const after = yaml.load(fs.readFileSync(file, 'utf8').split('---')[1]) as Record<string, unknown>;
  assert.deepEqual(after.obsidian_tags, ['复盘', '2026Q3'], 'a key we never defined must not be dropped');
  assert.equal(after.my_own_field, '保留我');
  assert.equal(after.cycle, '8.24-9.6', 'and our own keys still work');
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
      console.error(`    ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const dir of CREATED) fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

void run();
