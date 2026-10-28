/**
 * 日记 (LEO-350).
 *
 * One Markdown file per day under the app's own data dir, private. These pin the
 * store's contract: a write round-trips, an empty write clears the day, the
 * browse list is newest-first with a sane preview, and junk in the directory
 * does not blank it.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

import { AppConfigSchema, type AppConfig } from '../../src/config/schema.js';
import { deleteJournal, listJournal, readJournal, writeJournal } from '../../src/todo/journal.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ORIGINAL_CWD = process.cwd();

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(`    ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    process.chdir(ORIGINAL_CWD);
  }
}

function setup(): AppConfig {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-os-journal-'));
  process.chdir(work);
  const parsed = yaml.load(fs.readFileSync(path.join(REPO_ROOT, 'config', 'config.example.yaml'), 'utf8')) as Record<string, any>;
  parsed.user.timezone = 'UTC';
  return AppConfigSchema.parse(parsed);
}

test('a write round-trips, and the date keys the file', () => {
  const config = setup();
  assert.equal(readJournal(config, '2026-10-27'), null, 'nothing written yet');
  const saved = writeJournal(config, '2026-10-27', '今天把日记功能设计完了。\n还行。');
  assert.equal(saved?.content, '今天把日记功能设计完了。\n还行。');
  const read = readJournal(config, '2026-10-27');
  assert.equal(read?.content.trimEnd(), '今天把日记功能设计完了。\n还行。');
  assert.ok(read?.updated_at, 'carries an updated_at');
});

test('an empty or whitespace write clears the day rather than leaving a blank file', () => {
  const config = setup();
  writeJournal(config, '2026-10-27', 'something');
  assert.ok(readJournal(config, '2026-10-27'), 'there now');
  assert.equal(writeJournal(config, '2026-10-27', '   \n  '), null, 'whitespace returns no entry');
  assert.equal(readJournal(config, '2026-10-27'), null, 'and the day is gone');
  assert.deepEqual(listJournal(config), [], 'not left in the list');
});

test('the list is newest-first with a heading-stripped, clipped preview', () => {
  const config = setup();
  writeJournal(config, '2026-10-25', '# 周五\n忙了一天。');
  writeJournal(config, '2026-10-27', '\n\n第一行是空的前面。\n第二行。');
  writeJournal(config, '2026-10-26', 'x'.repeat(200));
  const list = listJournal(config);
  assert.deepEqual(list.map((entry) => entry.date), ['2026-10-27', '2026-10-26', '2026-10-25'], 'newest first');
  assert.equal(list[2]?.preview, '周五', 'leading # stripped, first non-empty line');
  assert.equal(list[0]?.preview, '第一行是空的前面。', 'leading blank lines skipped');
  assert.equal(list[1]?.preview.length, 81, '200 chars clipped to 80 + ellipsis');
});

test('delete removes the day; deleting a missing day is a no-op', () => {
  const config = setup();
  writeJournal(config, '2026-10-27', 'bye');
  assert.equal(deleteJournal(config, '2026-10-27'), true);
  assert.equal(readJournal(config, '2026-10-27'), null);
  assert.equal(deleteJournal(config, '2026-10-27'), false, 'nothing to remove');
});

test('a bad date is refused, and non-date files in the dir are ignored', () => {
  const config = setup();
  assert.throws(() => writeJournal(config, 'not-a-date', 'x'), /不是合法日期/);
  assert.equal(readJournal(config, 'not-a-date'), null);
  // A stray file in the store dir must not crash or pollute the list.
  const dir = path.resolve(config.journal.store_dir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), 'not a journal');
  writeJournal(config, '2026-10-27', 'real one');
  assert.deepEqual(listJournal(config).map((entry) => entry.date), ['2026-10-27'], 'only real dated entries');
});

test('weather and written-at are frozen into frontmatter and read back, body stays clean', () => {
  const config = setup();
  const meta = { writtenAt: '2026-10-28T14:30:00-04:00', weather: { code: 0, temp: 8, high: 10, low: 1, isDay: true, place: '蒙特利尔' } };
  writeJournal(config, '2026-10-28', '今天天气不错。', meta);
  const read = readJournal(config, '2026-10-28');
  assert.equal(read?.content.trimEnd(), '今天天气不错。', 'body has no frontmatter in it');
  assert.equal(read?.writtenAt, '2026-10-28T14:30:00-04:00');
  assert.deepEqual(read?.weather, { code: 0, temp: 8, high: 10, low: 1, isDay: true, place: '蒙特利尔' });
  assert.equal(listJournal(config)[0]?.preview, '今天天气不错。', 'preview is the body, not the frontmatter');
});

test('editing the body later keeps the first weather; a different snapshot does not overwrite it', () => {
  const config = setup();
  writeJournal(config, '2026-10-28', '早上写的。', { writtenAt: '2026-10-28T09:00:00-04:00', weather: { code: 0, temp: 5, place: '蒙特利尔' } });
  // Later edit carries a fresh (wrong, for this day) snapshot — must be ignored.
  const updated = writeJournal(config, '2026-10-28', '晚上又加了两句。', { writtenAt: '2026-10-28T22:00:00-04:00', weather: { code: 61, temp: 2, place: '蒙特利尔' } });
  assert.equal(updated?.writtenAt, '2026-10-28T09:00:00-04:00', 'the morning time stays frozen');
  assert.equal(updated?.weather?.temp, 5, 'the morning weather stays frozen');
  assert.equal(updated?.content, '晚上又加了两句。', 'but the body updates');
});

test('a plain entry with no frontmatter still reads, and malformed frontmatter keeps the body', () => {
  const config = setup();
  const dir = path.resolve(config.journal.store_dir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '2026-10-20.md'), '没有 frontmatter 的老日记。\n');
  assert.equal(readJournal(config, '2026-10-20')?.content.trimEnd(), '没有 frontmatter 的老日记。');
  fs.writeFileSync(path.join(dir, '2026-10-21.md'), '---\n: : broken\n---\n正文还在。\n');
  const broken = readJournal(config, '2026-10-21');
  assert.equal(broken?.content.trimEnd(), '正文还在。', 'body survives bad frontmatter');
  assert.equal(broken?.weather, undefined, 'and no weather is invented');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
