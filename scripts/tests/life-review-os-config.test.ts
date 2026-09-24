import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkLifeReviewOsConfig } from '../../src/skills/life-review-os-config.js';
import { runLifeReviewOsSkill } from '../../src/skills/life-review-os.js';
import { installSkillRepo, type SkillCommandRunner } from '../../src/skills/update.js';

// #218: an install seeded config.yaml from the template over a working setup,
// and every biweekly run after that died on its first Feishu call as
// `1770001 invalid param`. Two guards: the install carries a filled config
// forward, and a run refuses a template config with an error naming the field.

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lro-config-'));

const TEMPLATE = [
  'documents:',
  '  five_year_plan: YOUR_FIVE_YEAR_PLAN_TOKEN',
  '  weekly:',
  '    - year: 2026',
  '      token: YOUR_2026_WEEKLY_TOKEN',
  '      table_block_id: YOUR_2026_DOG_WEEKLY_TABLE_BLOCK_ID',
  '',
].join('\n');

const FILLED = [
  'documents:',
  // Optional documents may stay placeholders; only the weekly doc is required.
  '  five_year_plan: YOUR_FIVE_YEAR_PLAN_TOKEN',
  '  weekly:',
  '    - year: 2026',
  '      token: Abc123RealToken',
  '      table_block_id: Xyz789RealBlock',
  '',
].join('\n');

try {
  testCheckerFlagsTemplate();
  testCheckerAcceptsFilled();
  testCheckerPicksThisYearsDoc();
  await testRunRefusesTemplateConfig();
  await testInstallCarriesFilledConfigForward();
  await testInstallSkipsUnfilledPreviousConfig();
  console.log('life-review-os-config.test.ts: all tests passed');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

function write(name: string, text: string): string {
  const file = path.join(tmp, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
  return file;
}

function testCheckerFlagsTemplate(): void {
  const check = checkLifeReviewOsConfig(write('template/config.yaml', TEMPLATE), 2026);
  assert.deepEqual(check.unfilled, ['documents.weekly[2026].token', 'documents.weekly[2026].table_block_id']);
}

function testCheckerAcceptsFilled(): void {
  const check = checkLifeReviewOsConfig(write('filled/config.yaml', FILLED), 2026);
  assert.deepEqual(check.unfilled, [], 'optional five_year_plan placeholder is not an error');
  assert.equal(check.error, undefined);
}

function testCheckerPicksThisYearsDoc(): void {
  // 2025 is filled, 2026 is not: a run in 2026 reads the 2026 doc, so that is the one that matters.
  const text = [
    'documents:',
    '  weekly:',
    '    - year: 2026',
    '      token: YOUR_2026_WEEKLY_TOKEN',
    '      table_block_id: YOUR_2026_DOG_WEEKLY_TABLE_BLOCK_ID',
    '    - year: 2025',
    '      token: Real2025',
    '      table_block_id: Real2025Block',
    '',
  ].join('\n');
  const file = write('years/config.yaml', text);
  assert.equal(checkLifeReviewOsConfig(file, 2026).unfilled.length, 2);
  assert.equal(checkLifeReviewOsConfig(file, 2025).unfilled.length, 0);
}

async function testRunRefusesTemplateConfig(): Promise<void> {
  const root = path.join(tmp, 'skill-template');
  const marker = path.join(tmp, 'cli-was-invoked');
  // If the preflight lets it through, the fake CLI leaves a marker behind.
  write('skill-template/bin/life-review-os.mjs', `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'x'); console.log('{"ok":true}');\n`);
  write('skill-template/config.yaml', TEMPLATE);
  const entry = {
    id: 'weekly-review',
    provider: 'claude' as const,
    path: path.join(root, 'SKILL.md'),
    workdir: root,
    default_mode: 'biweekly',
    effects: ['read' as const, 'draft' as const, 'feishu_write' as const],
    require_confirmation_for: ['feishu_write' as const],
  };
  await assert.rejects(
    runLifeReviewOsSkill({ entry, mode: 'biweekly', provider: 'claude', userText: '', inputPackPath: path.join(tmp, 'input.md') }),
    (error: Error) => {
      assert.match(error.message, /还是模板/);
      assert.match(error.message, /table_block_id/, 'names the field');
      assert.ok(error.message.includes(path.join(root, 'config.yaml')), 'names the file');
      return true;
    },
  );
  assert.equal(fs.existsSync(marker), false, 'CLI never runs against a template config');
}

function fakeClone(): SkillCommandRunner {
  return async (_cmd, args) => {
    if (args[0] === 'clone') {
      const target = args[args.length - 1]!;
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, 'config.example.yaml'), TEMPLATE);
      fs.writeFileSync(path.join(target, 'SKILL.md'), '# weekly-review');
    }
    return { ok: true, stdout: '', stderr: '' };
  };
}

async function testInstallCarriesFilledConfigForward(): Promise<void> {
  const previous = write('old-install/config.yaml', FILLED);
  const dir = path.join(tmp, 'new-install');
  const r = await installSkillRepo(dir, { run: fakeClone(), seedFrom: [path.join(tmp, 'missing/config.yaml'), previous] });
  assert.equal(r.ok, true, r.message);
  assert.equal(fs.readFileSync(path.join(dir, 'config.yaml'), 'utf8'), FILLED, 'filled config carried over, not the template');
  assert.match(r.message, /沿用了之前的配置/);
}

async function testInstallSkipsUnfilledPreviousConfig(): Promise<void> {
  // Differs from TEMPLATE by one key, so the equality below proves which file was copied.
  const previous = write('old-template-install/config.yaml', TEMPLATE.replace('five_year_plan', 'five_year'));
  const dir = path.join(tmp, 'new-install-2');
  const r = await installSkillRepo(dir, { run: fakeClone(), seedFrom: [previous] });
  assert.equal(r.ok, true, r.message);
  assert.equal(fs.readFileSync(path.join(dir, 'config.yaml'), 'utf8'), TEMPLATE, 'an unfilled previous config is no better than the template');
  assert.match(r.message, /填入飞书文档 token/);
}
