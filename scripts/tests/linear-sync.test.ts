/**
 * The work 要务 follow Linear once a day: done issues ticked, started ones added.
 *
 * Run: tsx scripts/tests/linear-sync.test.ts
 */
import assert from 'node:assert/strict';

import { applyLinear, linearIssues, type LinearIssue } from '../../src/cycles/linear-sync.js';

const PRIORITIES = [
  '### 工作-UX designer。投递北美本地工作',
  '- 作品集个站：部署上线 **MIT**',
  '- 回捞用户：持续邮件触达 (CUTTO-1250)',
  '- 内容赛道 skill 透出设计收尾确认 (CUTTO-1093)',
  '',
  '### 名利-UX&小画家',
  '- X 平台恢复日更',
].join('\n');

const issue = (identifier: string, stateType: string, title = identifier): LinearIssue => ({ identifier, title, stateType });

// Done in Linear: ticked. In review: left alone. Started and not named: added
// under the group that already names Linear issues. Unstarted: not pulled in.
{
  const issues = [
    issue('CUTTO-1250', 'completed'),
    issue('CUTTO-1093', 'started'),
    issue('CUTTO-1343', 'started', '增长 list 规划'),
    issue('CUTTO-1265', 'started', '分享链接页'),
    issue('CUTTO-1328', 'unstarted', '成片视觉优化'),
  ];
  const result = applyLinear(PRIORITIES, issues);
  assert.deepEqual(result.done, ['CUTTO-1250']);
  assert.deepEqual(result.added, ['CUTTO-1343', 'CUTTO-1265']);
  assert.ok(result.content.includes('- 回捞用户：持续邮件触达 (CUTTO-1250) ✅'));
  assert.ok(result.content.includes('(CUTTO-1093)\n- 增长 list 规划 (CUTTO-1343)\n- 分享链接页 (CUTTO-1265)\n'), 'at the end of the work group');
  assert.ok(!result.content.includes('成片视觉优化'));
  assert.ok(result.content.includes('### 名利-UX&小画家\n- X 平台恢复日更'), 'other groups untouched');

  // The next morning nothing changes: a second run is a no-op.
  const again = applyLinear(result.content, issues);
  assert.deepEqual([again.done, again.added], [[], []]);
  assert.equal(again.content.trim(), result.content.trim());
}

// A line already marked by the user is not re-marked; 🚧 turns into ✅.
{
  const content = '### 工作\n- A (CUTTO-1) ❌\n- B (CUTTO-2) 🚧';
  const result = applyLinear(content, [issue('CUTTO-1', 'completed'), issue('CUTTO-2', 'completed')]);
  assert.ok(result.content.includes('- A (CUTTO-1) ❌'));
  assert.ok(result.content.includes('- B (CUTTO-2) ✅'));
}

// No group names Linear issues: the one called 工作 takes new ones; none, nothing is added.
{
  const added = applyLinear('### 工作-设计师\n- 作品集\n\n### 自我\n- 读书', [issue('CUTTO-9', 'started', '新活')]);
  assert.ok(added.content.includes('- 作品集\n- 新活 (CUTTO-9)'));
  const none = applyLinear('### 自我\n- 读书', [issue('CUTTO-9', 'started', '新活')]);
  assert.deepEqual(none.added, []);
}

// The evidence source: active items and recently completed, each once.
{
  const issues = linearIssues({
    state: 'available',
    data: {
      items: [{ identifier: 'CUTTO-1', title: ' A ', state: { type: 'started' } }],
      recently_completed: [{ identifier: 'CUTTO-2', title: 'B', state: { type: 'completed' } }, { identifier: 'CUTTO-1', title: 'A', state: { type: 'started' } }],
    },
  } as never);
  assert.deepEqual(issues, [issue('CUTTO-1', 'started', 'A'), issue('CUTTO-2', 'completed', 'B')]);
  assert.deepEqual(linearIssues({ state: 'unavailable' } as never), []);
}

console.log('linear-sync tests passed');
