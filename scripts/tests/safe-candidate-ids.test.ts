/**
 * 2026-10-05: five daily-plan reruns in a row "succeeded" and the Today page
 * showed nothing. A 要务 line contained Chinese curly quotes, the weekly
 * candidate id embedded the first 24 characters of it, and the model echoed
 * that id back with straight quotes, unescaped — so the plan JSON broke and
 * parsed to zero rows, while every run reported success.
 *
 * Two guards: ids carry no free text, and a plan whose JSON does not parse is
 * a failed attempt, not a saved plan.
 */
import assert from 'node:assert/strict';
import { idFragment, normalizeCandidates } from '../../src/todo/scorer.js';
import { workflowJsonError } from '../../src/workflows/summary.js';
import type { Evidence } from '../../src/workflows/types.js';

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

const NASTY = [
  '优化运营话术，以“核心卖点”为中心的入门工具 **MIT**',
  'Ship the "beta" build',
  'path\\with\\backslashes',
  '换行\n之后',
];

function evidence(sources: Evidence['sources']): Evidence {
  return { generated_at: '', date: '2026-10-06', sources } as Evidence;
}

function candidates(sources: Evidence['sources']) {
  return normalizeCandidates({ config: {} as never, evidence: evidence(sources), date: '2026-10-06' });
}

test('weekly ids carry a hash, not the text — nothing for the model to escape or tidy', () => {
  const ids = candidates({
    weekly_priorities: { state: 'available', data: { items: NASTY.map((item) => ({ item, okr: 'O' })) } },
  }).map((candidate) => candidate.id);
  assert.equal(ids.length, NASTY.length);
  for (const id of ids) assert.match(id, /^weekly:\d+:[0-9a-f]{8}$/, id);
});

test('an id echoed into a JSON plan parses, which is the thing that broke', () => {
  const [id] = candidates({ weekly_priorities: { state: 'available', data: { items: [{ item: NASTY[0] }] } } }).map((c) => c.id);
  // Exactly how the model wrote it back on 10-05: curly quotes "tidied" to
  // straight ones, then interpolated without escaping.
  const echoed = id!.replace(/[“”]/g, '"');
  const plan = `{"todos":[{"rank":1,"text":"x","candidateId":"${echoed}","minutes":45}]}`;
  assert.equal(JSON.parse(plan).todos[0].candidateId, id, 'parses, and still matches the candidate');
});

test('the same text gets the same id on every run, different text a different one', () => {
  assert.equal(idFragment(NASTY[0]!), idFragment(NASTY[0]!));
  assert.equal(idFragment(`  ${NASTY[0]}  `), idFragment(NASTY[0]!), 'surrounding whitespace is not a different item');
  assert.notEqual(idFragment(NASTY[0]!), idFragment(NASTY[1]!));
});

test('vault keeps a plain path, and hashes anything that is not one', () => {
  const ids = candidates({
    vault_scan: {
      state: 'available',
      data: {
        candidates: [
          { title: 'a', path: 'notes/2026/plan.md' },
          { title: 'b', path: 'notes/"quoted".md' },
          { title: '没有路径的“标题”' },
        ],
      },
    },
  }).map((candidate) => candidate.id);
  assert.deepEqual(ids[0], 'vault:notes/2026/plan.md');
  assert.match(ids[1]!, /^vault:[0-9a-f]{8}$/);
  assert.match(ids[2]!, /^vault:[0-9a-f]{8}$/);
});

test('the real 2026-10-05 output is reported as broken JSON', () => {
  const broken = '{"todos":[{"rank":1,"text":"起草","candidateId":"weekly:0:优化运营话术，以"核心卖点"为中心的入门","minutes":45}],"note":"x"}';
  assert.ok(workflowJsonError(broken), 'must not pass as a plan');
});

test('valid JSON is fine, including a day with no todos', () => {
  assert.equal(workflowJsonError('{"todos":[{"rank":1,"text":"a","candidateId":"linear:A-1"}]}'), null);
  assert.equal(workflowJsonError('{"todos":[],"note":"休息日"}'), null, 'a quiet day is not a failure');
  assert.equal(workflowJsonError('```json\n{"todos":[]}\n```'), null, 'a fenced block still counts');
});

test('prose is not judged here — it still falls through to the legacy render', () => {
  assert.equal(workflowJsonError('今天先把 PR 合了，然后……'), null);
});

test('JSON cut off mid-object is broken too', () => {
  assert.ok(workflowJsonError('{"todos":[{"rank":1,"text":"a"'));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
