/**
 * The user's weekly rhythm: weekday awareness, rest-day damping, and the console's
 * resolved view.
 *
 * Independent, tsx-runnable:  npx tsx scripts/tests/rhythm.test.ts
 *
 * ## What was broken
 *
 * A user reported that Saturday got the same seven-item work plan as Tuesday.
 * The dimension did not exist anywhere in the system:
 *
 *   - `buildUserPrompt` injected `# Date\n2026-09-13` — the bare date, no weekday.
 *     The model had to derive "Saturday" itself, which is not a calculation to
 *     build a rule on.
 *   - `scoreCandidate` ranked on due date, Linear priority, board state,
 *     carry-over, OKR and customer signal. Nothing about the calendar week.
 *   - `grep -rn "工作日\|休息日\|workday\|working_hours" src prompts config`
 *     returned zero hits.
 *
 * So "plan less work on my rest days" was not a setting somebody had left off —
 * there was nowhere to put it.
 *
 * ## What these tests hold down
 *
 * Three layers, and the seams between them:
 *
 *   1. **The date knows its weekday** — and does so without being re-projected
 *      through a timezone, which would land on the wrong day for half the planet.
 *   2. **One resolution, two readers** — `resolveDayShape` is what the prompt
 *      section and the scorer both consult, so the console cannot promise a rest
 *      day that the ranking does not deliver.
 *   3. **Damping protects the day without hiding the fire** — work sources lose
 *      points on a rest day, but anything overdue or due today is exempt, and the
 *      user's own hand-written todos are never damped at all.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

import { AppConfigSchema, type AppConfig } from '../../src/config/schema.js';
import { buildUserPrompt } from '../../src/agent/openai-agent.js';
import {
  defaultRhythmMarkdown,
  ensureRhythmFile,
  normalizeRestDays,
  readRhythmNotes,
  renderRhythmPromptSection,
  resolveDayShape,
  rhythmNotesAreTemplate,
} from '../../src/user/rhythm.js';
import { scoreCandidate, type TodoCandidate, type TodoSource } from '../../src/todo/scorer.js';
import { DEFAULT_SCORER_WEIGHTS } from '../../src/todo/scorer-config.js';
import { weekdayCode, weekdayLabelZh } from '../../src/utils/date.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

type TestFn = () => void | Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];
function test(name: string, fn: TestFn): void {
  tests.push({ name, fn });
}

const CREATED: string[] = [];

/** A config whose memory vault is a fresh temp directory. */
function tempConfig(mutate: (raw: Record<string, any>) => void = () => {}): AppConfig {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-os-rhythm-'));
  CREATED.push(vault);
  const raw = yaml.load(fs.readFileSync(path.join(REPO_ROOT, 'config', 'config.example.yaml'), 'utf8')) as Record<string, any>;
  raw.memory.repository_path = vault;
  mutate(raw);
  return AppConfigSchema.parse(raw);
}

// 2026-09-12 is a Saturday and 2026-09-13 a Sunday; 2026-09-15 is a Tuesday.
const SATURDAY = '2026-09-12';
const SUNDAY = '2026-09-13';
const TUESDAY = '2026-09-15';

// --- layer 1: the date knows its own weekday --------------------------------

test('weekdayCode reads the weekday of the calendar date', () => {
  assert.equal(weekdayCode(SATURDAY), 'SAT');
  assert.equal(weekdayCode(SUNDAY), 'SUN');
  assert.equal(weekdayCode(TUESDAY), 'TUE');
  assert.equal(weekdayLabelZh(SATURDAY), '星期六');
});

test('the weekday does not shift with the process timezone', () => {
  // The date handed around by the workflows is already the user's *local*
  // calendar date. Re-projecting it through a zone is how "2026-09-12" in
  // America/Toronto becomes Friday the 11th — the exact off-by-one that would
  // make a Saturday rule fire on the wrong day for anyone west of UTC.
  const previous = process.env.TZ;
  try {
    for (const zone of ['UTC', 'America/Toronto', 'Asia/Shanghai', 'Pacific/Kiritimati']) {
      process.env.TZ = zone;
      assert.equal(weekdayCode(SATURDAY), 'SAT', `wrong weekday under TZ=${zone}`);
    }
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test('a malformed date is rejected rather than silently treated as a Thursday', () => {
  // `new Date('nonsense').getUTCDay()` is NaN, and `WEEKDAY_CODES[NaN]` is
  // undefined — which would flow onward as a day that matches no rest day at all.
  assert.throws(() => weekdayCode('not-a-date'), /not a YYYY-MM-DD date/);
});

// --- rest-day configuration -------------------------------------------------

test('rest days are matched case-insensitively and de-duplicated', () => {
  assert.deepEqual(normalizeRestDays(['SAT', 'sun']), ['SAT', 'SUN']);
  assert.deepEqual(normalizeRestDays(['Saturday', 'sunday']), ['SAT', 'SUN']);
  assert.deepEqual(normalizeRestDays(['SAT', 'SAT', 'Sat']), ['SAT']);
});

test('a typo in one rest day does not take the whole config down', () => {
  // This is hand-edited YAML. Throwing here would fail the morning plan over a
  // stray entry; the resolved preview in the console is where a dropped day
  // becomes visible.
  assert.deepEqual(normalizeRestDays(['SAT', 'funday', '', '   ']), ['SAT']);
});

// --- layer 2: one resolution, read by everyone ------------------------------

test('a configured rest day resolves as one', () => {
  const config = tempConfig();
  const shape = resolveDayShape(config, SATURDAY);
  assert.equal(shape.weekday, 'SAT');
  assert.equal(shape.isRestDay, true);
  assert.equal(shape.dayTypeLabel, '休息日');
  assert.equal(shape.workTaskCap, 1);
});

test('a work day resolves with no cap of its own', () => {
  const config = tempConfig();
  const shape = resolveDayShape(config, TUESDAY);
  assert.equal(shape.isRestDay, false);
  assert.equal(shape.dayTypeLabel, '工作日');
  // null, not 0 and not 7: on a work day the count is the decision-policy's to
  // decide. Returning a number here would quietly outrank the user's own rule.
  assert.equal(shape.workTaskCap, null);
});

test('disabling rhythm makes every day a work day again', () => {
  const config = tempConfig((raw) => {
    raw.user = { ...raw.user, rhythm: { enabled: false } };
  });
  const shape = resolveDayShape(config, SATURDAY);
  assert.equal(shape.enabled, false);
  assert.equal(shape.isRestDay, false);
  // The weekday is still reported — turning the rhythm off should not put the
  // prompt back to not knowing what day it is.
  assert.equal(shape.weekday, 'SAT');
});

test('someone who works weekends can empty the rest-day list', () => {
  const config = tempConfig((raw) => {
    raw.user = { ...raw.user, rhythm: { enabled: true, rest_days: [] } };
  });
  assert.equal(resolveDayShape(config, SATURDAY).isRestDay, false);
});

test('rest days need not be the weekend', () => {
  const config = tempConfig((raw) => {
    raw.user = { ...raw.user, rhythm: { enabled: true, rest_days: ['TUE'] } };
  });
  assert.equal(resolveDayShape(config, TUESDAY).isRestDay, true);
  assert.equal(resolveDayShape(config, SATURDAY).isRestDay, false);
});

// --- layer 3: the scorer ----------------------------------------------------

function candidate(source: TodoSource, extra: Partial<TodoCandidate> = {}): TodoCandidate {
  return { id: `${source}:x`, title: 'x', source, ...extra };
}

function score(item: TodoCandidate, date: string, config: AppConfig, now = new Date(`${date}T09:00:00Z`)) {
  return scoreCandidate(item, DEFAULT_SCORER_WEIGHTS, now, resolveDayShape(config, date));
}

test('THE CASE: on a rest day a work issue is damped, on a work day it is not', () => {
  const config = tempConfig();
  const issue = candidate('linear', { priority: 'High', stateName: 'In Progress', stateType: 'started' });

  const weekday = score(issue, TUESDAY, config);
  const weekend = score(issue, SATURDAY, config);

  assert.equal(weekday.breakdown.restDayDamping, undefined);
  assert.equal(weekend.breakdown.restDayDamping, DEFAULT_SCORER_WEIGHTS.restDayWorkDamping);
  assert.ok(weekend.score < weekday.score, 'the same issue must rank lower on a rest day');
});

test('a hand-written life todo overtakes a strong work issue on a rest day', () => {
  // The point of the whole feature, as a single comparison, and the ordering has
  // to flip *both* ways to mean anything: on Tuesday the work issue wins, on
  // Saturday "给大汪汪做饭" does. An assertion that only held on Saturday would
  // also pass if the damping had simply eaten the work week.
  //
  // The work side is deliberately a strong one — Urgent (20) + In Progress (15)
  // = 35, comfortably above manualCapture (20). A merely High-priority issue (12)
  // already loses to a hand-written todo on a Tuesday, so it could never show a
  // flip; picking that pair would have produced a green test that proved nothing.
  const config = tempConfig();
  const life = candidate('todo_inbox', { id: 'todo_inbox:1', title: '给大汪汪做饭' });
  const work = candidate('linear', {
    id: 'linear:1',
    priority: 'Urgent',
    stateName: 'In Progress',
    stateType: 'started',
  });

  assert.ok(score(life, TUESDAY, config).score < score(work, TUESDAY, config).score, 'work must win on a work day');
  assert.ok(score(life, SATURDAY, config).score > score(work, SATURDAY, config).score, 'life must win on a rest day');
});

test('an overdue work item is never damped — the one thing worth interrupting a Saturday', () => {
  const config = tempConfig();
  const overdue = candidate('linear', { dueDate: '2026-09-01' });
  const result = score(overdue, SATURDAY, config);
  assert.equal(result.breakdown.overdue, DEFAULT_SCORER_WEIGHTS.overdue);
  assert.equal(result.breakdown.restDayDamping, undefined);
});

test('an item due within 24h is not damped either', () => {
  const config = tempConfig();
  const dueToday = candidate('linear', { dueDate: SATURDAY });
  const result = score(dueToday, SATURDAY, config, new Date(`${SATURDAY}T00:00:00Z`));
  assert.equal(result.breakdown.dueWithin24h, DEFAULT_SCORER_WEIGHTS.dueWithin24h);
  assert.equal(result.breakdown.restDayDamping, undefined);
});

test('an item merely due within 72h IS damped — a rest day is not the deadline', () => {
  const config = tempConfig();
  const soon = candidate('linear', { dueDate: '2026-09-14' });
  const result = score(soon, SATURDAY, config, new Date(`${SATURDAY}T00:00:00Z`));
  assert.equal(result.breakdown.dueWithin72h, DEFAULT_SCORER_WEIGHTS.dueWithin72h);
  assert.equal(result.breakdown.restDayDamping, DEFAULT_SCORER_WEIGHTS.restDayWorkDamping);
});

test("the user's own sources are never damped", () => {
  const config = tempConfig();
  for (const source of ['todo_inbox', 'vault'] as TodoSource[]) {
    const result = score(candidate(source), SATURDAY, config);
    assert.equal(result.breakdown.restDayDamping, undefined, `${source} must not be damped`);
  }
});

test('weekly priorities are a work source and are damped', () => {
  const config = tempConfig();
  const result = score(candidate('weekly_priorities'), SATURDAY, config);
  assert.equal(result.breakdown.restDayDamping, DEFAULT_SCORER_WEIGHTS.restDayWorkDamping);
});

test('with rhythm disabled the scorer behaves exactly as before this feature', () => {
  const config = tempConfig((raw) => {
    raw.user = { ...raw.user, rhythm: { enabled: false } };
  });
  const issue = candidate('linear', { priority: 'Urgent' });
  const before = scoreCandidate(issue, DEFAULT_SCORER_WEIGHTS, new Date(`${SATURDAY}T09:00:00Z`));
  const after = score(issue, SATURDAY, config);
  assert.deepEqual(after.breakdown, before.breakdown);
  assert.equal(after.score, before.score);
});

test('a config with no user.rhythm at all degrades to a work day, it does not throw', () => {
  // The schema materialises `user.rhythm` for anything that went through
  // `loadConfig`, but `scoreCandidate` / `buildScoredTodos` are also reached with
  // hand-built config objects (the todo-scorer suite does exactly that). Throwing
  // on a missing key there would take down the whole morning plan for the sake of
  // a setting whose absence has an obvious meaning.
  const bare = { user: { display_name: 'U', timezone: 'UTC' } } as unknown as AppConfig;
  const shape = resolveDayShape(bare, SATURDAY);
  assert.equal(shape.enabled, false);
  assert.equal(shape.isRestDay, false);
  assert.equal(shape.weekday, 'SAT');
  assert.equal(renderRhythmPromptSection(bare, SATURDAY), '');
});

test('no dayShape at all is the same as a work day', () => {
  // `scoreCandidate` is called directly from a few places that have no config in
  // hand. Those must keep working, not crash and not silently damp.
  const result = scoreCandidate(candidate('linear'), DEFAULT_SCORER_WEIGHTS, new Date());
  assert.equal(result.breakdown.restDayDamping, undefined);
});

// --- the prompt -------------------------------------------------------------

function promptFor(config: AppConfig, date: string): string {
  return buildUserPrompt({
    config,
    workflow: 'daily_plan',
    date,
    evidence: { generated_at: `${date}T08:00:00.000Z`, date, sources: {} },
    memory: { repositoryPath: '', repository: [], longTerm: '', recentDaily: [] },
  });
}

test('the date line names the weekday, so the model never has to work it out', () => {
  const config = tempConfig();
  assert.match(promptFor(config, SATURDAY), /# Date\n2026-09-12 星期六/);
});

test('the date line still names the weekday when rhythm is off', () => {
  const config = tempConfig((raw) => {
    raw.user = { ...raw.user, rhythm: { enabled: false } };
  });
  const prompt = promptFor(config, SATURDAY);
  assert.match(prompt, /# Date\n2026-09-12 星期六/);
  assert.doesNotMatch(prompt, /（休息日）/);
  // Anchored to a line of its own: `daily_plan.md` mentions `# 作息` inline when
  // telling the model what to do with the section, and an unanchored match would
  // read that mention as the section itself and pass no matter what we inject.
  assert.doesNotMatch(prompt, /^# 作息$/m);
});

test('a rest day carries its cap into the prompt', () => {
  const config = tempConfig();
  const prompt = promptFor(config, SATURDAY);
  assert.match(prompt, /^# 作息$/m);
  assert.match(prompt, /今天是 星期六，属于休息日。/);
  assert.match(prompt, /工作任务最多 1 条/);
});

test('a cap of zero says so plainly instead of "最多 0 条"', () => {
  const config = tempConfig((raw) => {
    raw.user = { ...raw.user, rhythm: { enabled: true, rest_days: ['SAT'], work_task_cap_on_rest_days: 0 } };
  });
  const section = renderRhythmPromptSection(config, SATURDAY);
  assert.match(section, /不要安排任何工作任务/);
  assert.doesNotMatch(section, /最多 0 条/);
});

test('a work day gets the weekday but no rest-day instructions', () => {
  const config = tempConfig();
  const prompt = promptFor(config, TUESDAY);
  assert.match(prompt, /2026-09-15 星期二（工作日）/);
  assert.doesNotMatch(prompt, /工作任务最多/);
});

test("the user's own notes are carried in verbatim and declared to outrank the defaults", () => {
  const config = tempConfig();
  const files = ensureRhythmFile(config);
  fs.writeFileSync(files.notesPath, '# 作息\n\n## 固定占用\n\n- 周二、周四 19:00-21:00 教球，不可占用。\n', 'utf8');
  const section = renderRhythmPromptSection(config, SATURDAY);
  assert.match(section, /周二、周四 19:00-21:00 教球/);
  assert.match(section, /优先级高于上面的默认规则/);
});

test('an untouched template is not pasted into the prompt as if it said something', () => {
  // Seeding a template and then feeding it to the model would spend context on a
  // page of empty bullets and comment markers, and would make "the user has a
  // rhythm written" indistinguishable from "the user has never opened the page".
  const config = tempConfig();
  ensureRhythmFile(config);
  const section = renderRhythmPromptSection(config, SATURDAY);
  assert.doesNotMatch(section, /用户自己写的作息表/);
});

// --- the file and the console's read of it ----------------------------------

test('the template is seeded once and never overwrites what the user wrote', () => {
  const config = tempConfig();
  const files = ensureRhythmFile(config);
  assert.ok(fs.existsSync(files.notesPath));
  fs.writeFileSync(files.notesPath, '# 作息\n\n- 我的规则\n', 'utf8');
  ensureRhythmFile(config);
  assert.match(readRhythmNotes(config), /我的规则/);
});

test('the seeded template reports itself as a template', () => {
  assert.equal(rhythmNotesAreTemplate(defaultRhythmMarkdown()), true);
});

test('one real line is enough to stop being a template', () => {
  assert.equal(rhythmNotesAreTemplate('# 作息\n\n## 休息日\n\n- 只处理逾期的事。\n'), false);
});

test('a missing rhythm file reads as empty rather than throwing', () => {
  const config = tempConfig((raw) => {
    raw.user = { ...raw.user, rhythm: { enabled: true, file: 'does-not-exist.md' } };
  });
  assert.equal(readRhythmNotes(config), '');
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
