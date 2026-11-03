/**
 * The user's method skills reach the day (2026-11-03): the 柯维诊断 and its
 * 小实验 are kept and carried into the next cycle; the 8:00 plan and the 21:30
 * review read the skills named in `config.habits`; the chat gets a copy.
 *
 * Run: tsx scripts/tests/habits.test.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

import { AppConfigSchema, type AppConfig } from '../../src/config/schema.js';
import { buildCycleId, writeCycle } from '../../src/cycles/file.js';
import { currentExperiment, experimentFrom, extractHabitsFromDraft, generateCycleDiagnosis, openMits, readCycleHabits, writeCycleHabits } from '../../src/cycles/habits.js';
import { readCycle } from '../../src/cycles/file.js';
import { renderGuides, skillDescription, syncUserChatSkills } from '../../src/habits/guides.js';
import { buildUserPrompt } from '../../src/agent/openai-agent.js';
import { parseDailyPlanTodoPlan, parseDailyReviewReconciliation, planExtras } from '../../src/workflows/summary.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  ✗ ${name}\n    ${error instanceof Error ? error.stack : String(error)}`);
  }
}

function setup(): { config: AppConfig; skills: string } {
  const parsed = yaml.load(fs.readFileSync(path.join(REPO_ROOT, 'config', 'config.example.yaml'), 'utf8')) as Record<string, any>;
  parsed.memory.repository_path = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-os-habits-'));
  const skills = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-os-skills-'));
  fs.mkdirSync(path.join(skills, 'brain-cycle-check'));
  fs.writeFileSync(path.join(skills, 'brain-cycle-check', 'SKILL.md'), '---\nname: brain-cycle-check\ndescription: "按时间控检查任务落在哪个时段"\n---\n# 时段体检\n7-9 黄金时间，9-12 专注。');
  fs.mkdirSync(path.join(skills, 'stephen-covey'));
  fs.writeFileSync(path.join(skills, 'stephen-covey', 'SKILL.md'), '---\nname: stephen-covey\ndescription: >\n  柯维七习惯唯一入口\n  先诊断\n---\n# 柯维\n要事第一。');
  fs.writeFileSync(path.join(skills, 'stephen-covey', 'notes.md'), '旁注');
  fs.mkdirSync(path.join(skills, 'self', 'sharpen-the-saw'), { recursive: true });
  fs.writeFileSync(path.join(skills, 'self', 'sharpen-the-saw', 'SKILL.md'), '---\nname: sharpen-the-saw\n---\n四个维度');
  parsed.habits = { skills_dir: skills, daily_plan: ['brain-cycle-check'], daily_review: ['stephen-covey', 'missing-skill'], cycle_review: ['stephen-covey'], chat: ['stephen-covey', 'brain-cycle-check', 'self/sharpen-the-saw', '../escape'] };
  return { config: AppConfigSchema.parse(parsed), skills };
}

const DRAFT = [
  '## 📊 上周执行对比（10.19-11.1）',
  '一些对比',
  '---',
  '## 柯维诊断摘要',
  '**Q2 占比：约 30%（建议 ≥ 60%）**',
  '主要发现：',
  '- **Q1 挤压 Q2 严重**：作品集连续未启动。',
  '本双周小实验：',
  '- **每天上午前 2 小时锁定给作品集，不开飞书不看 Linear。** 验证 MIT 能否两周内上线。',
  '',
  '---',
  '## 双周趋势',
  '- 作品集连续 4 周未完成。',
  '',
  '## Linear 覆盖核对',
  '不该进诊断',
].join('\n');

await test('the 柯维诊断 and its 小实验 come out of a run draft; the trend comes along, the rest does not', () => {
  const habits = extractHabitsFromDraft(DRAFT)!;
  assert.ok(habits.diagnosis.startsWith('## 柯维诊断摘要'));
  assert.match(habits.diagnosis, /双周趋势/);
  assert.ok(!habits.diagnosis.includes('Linear 覆盖核对') && !habits.diagnosis.includes('上周执行对比'));
  assert.equal(habits.experiment, '每天上午前 2 小时锁定给作品集，不开飞书不看 Linear。 验证 MIT 能否两周内上线。');
  assert.equal(extractHabitsFromDraft('no diagnosis here'), null);
  assert.equal(experimentFrom('**本双周小实验**：先睡够 7 小时'), '先睡够 7 小时');
});

await test("the next cycle runs the last cycle's 小实验, and the plan is told it with the open MIT", () => {
  const { config } = setup();
  const today = new Date().toISOString().slice(0, 10);
  const start = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
  const before = new Date(Date.now() - 17 * 86400000).toISOString().slice(0, 10);
  const label = (iso: string, days: number) => {
    const from = new Date(`${iso}T00:00:00Z`);
    const to = new Date(from.getTime() + (days - 1) * 86400000);
    return `${from.getUTCMonth() + 1}.${from.getUTCDate()}-${to.getUTCMonth() + 1}.${to.getUTCDate()}`;
  };
  const previousId = buildCycleId(before, label(before, 14));
  const currentId = buildCycleId(start, label(start, 14));
  writeCycle(config, previousId, { cycle: label(before, 14), mode: 'biweekly' });
  writeCycle(config, currentId, { cycle: label(start, 14), mode: 'biweekly', sections: { '要务': { content: '### 工作\n- 作品集上线 **MIT**\n- 已经做完的 **MIT** ✅', source: 'user' } } });
  writeCycleHabits(config, previousId, { diagnosis: '## 柯维诊断摘要', experiment: '上午前 2 小时给作品集', source: 'run' });
  assert.deepEqual(currentExperiment(config, today), { experiment: '上午前 2 小时给作品集', from: label(before, 14) });
  assert.deepEqual(openMits(config, today), ['作品集上线']);
  assert.equal(readCycleHabits(config, previousId)?.source, 'run');
});

await test('生成总结 also writes the 柯维诊断, from completion, 计划外, retro, the last 小实验 and the user’s skill', async () => {
  const { config } = setup();
  const id = buildCycleId('2026-10-19', '10.19-11.1');
  writeCycle(config, id, { cycle: '10.19-11.1', mode: 'biweekly' });
  let asked = '';
  const saved = await generateCycleDiagnosis(config, readCycle(config, id)!, { priorities: '### 工作\n- 作品集 **MIT** ❌\n- 回捞 ✅', retro: '作品集点都没碰', unplanned: '配置 skill（1 天，1h）', fallbackGuide: '' }, async (prompt) => {
    asked = prompt;
    return '好的\n{"diagnosis": "## 柯维诊断摘要\\nQ2 占比 25%", "experiment": "上午 9-11 点只做作品集"}';
  });
  assert.equal(saved?.experiment, '上午 9-11 点只做作品集');
  assert.equal(readCycleHabits(config, id)?.diagnosis, '## 柯维诊断摘要\nQ2 占比 25%');
  for (const part of ['完成 1', '作品集点都没碰', '配置 skill', '要事第一', '"experiment"']) assert.ok(asked.includes(part), part);
  assert.equal(await generateCycleDiagnosis(config, readCycle(config, id)!, { priorities: '', retro: '', unplanned: '', fallbackGuide: '' }, async () => 'not json'), null, 'a broken answer writes nothing');
});

await test('the 8:00 plan and the 21:30 review get their skills as a 方法 section; a missing one is skipped', () => {
  const { config } = setup();
  const prompt = (workflow: 'daily_plan' | 'daily_review') => buildUserPrompt({ config, workflow, date: '2026-11-03', evidence: { sources: {} } as any, memory: {} as any });
  assert.match(prompt('daily_plan'), /# 方法（用户自己的 skill，按它判断）\n## brain-cycle-check\n# 时段体检/);
  assert.ok(!prompt('daily_plan').includes('description:'), 'frontmatter stripped');
  assert.match(prompt('daily_review'), /## stephen-covey/);
  assert.ok(!prompt('daily_review').includes('missing-skill'));
  assert.equal(renderGuides(config, []), '');
});

await test('the chat gets a copy of the named skills, with their descriptions', () => {
  const { config } = setup();
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-os-chat-'));
  const synced = syncUserChatSkills(config, workdir);
  assert.deepEqual(synced.map((skill) => skill.name), ['stephen-covey', 'brain-cycle-check', 'sharpen-the-saw'], 'a sub-folder one lands flat; a path out is refused');
  assert.ok(fs.existsSync(path.join(workdir, '.claude', 'skills', 'sharpen-the-saw', 'SKILL.md')));
  assert.equal(synced[0]!.description, '柯维七习惯唯一入口 先诊断');
  assert.equal(synced[1]!.description, '按时间控检查任务落在哪个时段');
  assert.ok(fs.existsSync(path.join(workdir, '.claude', 'skills', 'stephen-covey', 'notes.md')));
  assert.equal(skillDescription('no frontmatter'), '');
});

await test('今日要事 survives the rewrites, and the review keeps its 柯维视角', () => {
  const plan = parseDailyPlanTodoPlan('{"todos":[{"rank":1,"text":"做作品集","candidateId":"x"}],"note":"n","focus":"上午只做作品集"}')!;
  assert.equal(plan.focus, '上午只做作品集');
  assert.deepEqual(planExtras(plan), { note: 'n', focus: '上午只做作品集' });
  const review = parseDailyReviewReconciliation('{"reconciliation":[{"candidateId":"x","text":"t","status":"done","evidence":"e"}],"carry_over":[],"habits":"Q2 被计划外挤掉了"}')!;
  assert.equal(review.habits, 'Q2 被计划外挤掉了');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
