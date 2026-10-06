/**
 * 2026-10-06: three of seven planned rows were Linear issues the user had left
 * out of the new cycle. Open in Linear, Urgent/High, weeks of carry-over — so
 * they outscored the cycle's own priorities. "Not in my cycle, not in my
 * weekly, why is it here."
 *
 * And the rows that did come from the cycle were rewritten with details lifted
 * from yesterday's plan and the previous cycle. The prompt now forbids that;
 * the prompt tests only guard that the rules stay in the prompt.
 *
 * 2026-10-07: the rows were clean, but the plan's note still said "CUTTO-1022
 * has dragged for weeks, close it today" — an issue the user had ticked done
 * that morning. Filtering the candidates was not enough while the raw Linear
 * list still went into the prompt beside them.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { anchorToCycle, normalizeCandidates } from '../../src/todo/scorer.js';
import { fitEvidenceToBudget } from '../../src/workflows/evidence-budget.js';
import type { Evidence } from '../../src/workflows/types.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NOW = new Date('2026-10-06T00:00:00');

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
  }
}

const issue = (identifier: string, extra: Record<string, unknown> = {}) => ({
  identifier,
  title: `${identifier} title`,
  priority: 1,
  state: { name: 'In Progress', type: 'started' },
  ...extra,
});

function pool(weeklyItems: string[] | null, issues: Array<Record<string, unknown>>): string[] {
  const evidence = {
    generated_at: '',
    date: '2026-10-06',
    sources: {
      linear: { state: 'available', data: { issues: { nodes: issues } } },
      ...(weeklyItems === null ? {} : { weekly_priorities: { state: 'available', data: { items: weeklyItems.map((item) => ({ item, okr: 'O' })) } } }),
    },
  } as unknown as Evidence;
  const candidates = normalizeCandidates({ config: {} as never, evidence, date: '2026-10-06', now: NOW });
  return anchorToCycle(candidates, evidence, NOW).map((candidate) => candidate.id);
}

test('an open Linear issue the cycle does not name is not today\'s work', () => {
  const ids = pool(['优化运营话术', '回捞用户'], [issue('ABC-1'), issue('ABC-2')]);
  assert.ok(!ids.some((id) => id.startsWith('linear:')), ids.join(', '));
  assert.equal(ids.filter((id) => id.startsWith('weekly:')).length, 2, 'the cycle\'s own lines stay');
});

test('an issue the cycle names stays, wherever in the line the key sits', () => {
  const ids = pool(['补齐 Demo（ABC-1）🚧', '其他'], [issue('ABC-1'), issue('ABC-2')]);
  assert.ok(ids.includes('linear:ABC-1'));
  assert.ok(!ids.includes('linear:ABC-2'));
});

test('the key match ignores case', () => {
  assert.ok(pool(['跟进 abc-7'], [issue('ABC-7')]).includes('linear:ABC-7'));
});

test('a hard deadline gets through even off-plan: overdue, or due within 24h', () => {
  const ids = pool(['别的事'], [
    issue('ABC-1', { dueDate: '2026-10-01' }),
    issue('ABC-2', { dueDate: '2026-10-06' }),
    issue('ABC-3', { dueDate: '2026-10-09' }),
  ]);
  assert.ok(ids.includes('linear:ABC-1'), 'overdue');
  assert.ok(ids.includes('linear:ABC-2'), 'due today');
  assert.ok(!ids.includes('linear:ABC-3'), 'three days out is not a hard deadline');
});

test('with no cycle 要务 there is nothing to anchor to, so nothing is dropped', () => {
  assert.ok(pool(null, [issue('ABC-1')]).includes('linear:ABC-1'), 'source missing');
  assert.ok(pool([], [issue('ABC-1')]).includes('linear:ABC-1'), 'cycle written but empty');
});

test('the prompt keeps its "only this candidate\'s own content" rule', () => {
  const prompt = fs.readFileSync(path.join(REPO_ROOT, 'prompts', 'daily_plan.md'), 'utf8');
  assert.match(prompt, /只用这条候选自己的内容/);
  assert.match(prompt, /昨天的计划不是今天的候选/);
  assert.match(prompt, /写得朴素也比编得具体好/);
});

test('an issue the cycle left out does not reach the plan prompt at all, only the anchored ones do', () => {
  const evidence = {
    generated_at: '',
    date: '2026-10-06',
    sources: {
      linear: { state: 'available', data: { items: [issue('ABC-1'), issue('ABC-2')] } },
      weekly_priorities: { state: 'available', data: { items: [{ item: '补齐 Demo（ABC-1）', okr: 'O' }] } },
    },
  } as unknown as Evidence;
  const candidates = normalizeCandidates({ config: {} as never, evidence, date: '2026-10-06', now: NOW });
  evidence.sources.todo_scored = { state: 'available', data: { top: anchorToCycle(candidates, evidence, NOW) } };

  const prompt = JSON.stringify(fitEvidenceToBudget(evidence, 'daily_plan').evidence);
  assert.ok(prompt.includes('ABC-1'), 'the anchored issue is still there, as a candidate');
  assert.ok(!prompt.includes('ABC-2'), 'nothing left for the note to bring up');
  assert.ok(JSON.stringify(fitEvidenceToBudget(evidence, 'daily_review').evidence).includes('ABC-2'), 'the review still sees every issue');
});

test('the prompt keeps the note to the rows it planned', () => {
  const prompt = fs.readFileSync(path.join(REPO_ROOT, 'prompts', 'daily_plan.md'), 'utf8');
  assert.match(prompt, /备注只谈今天排了的条目/);
  assert.match(prompt, /没进候选，就不是今天的事/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
