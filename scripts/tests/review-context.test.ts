/**
 * The 总结 is written from completion, 计划外 and the retro, judged by the
 * 7 Habits (2026-11-02).
 *
 * Run: tsx scripts/tests/review-context.test.ts
 */
import assert from 'node:assert/strict';

import { buildReviewContext, cycleProgress, renderProgress } from '../../src/cycles/review-context.js';

const PRIORITIES = [
  '### 工作-UX designer',
  '- 作品集个站：部署上线 **MIT** ❌',
  '- 回捞用户 (CUTTO-1250) ✅',
  '- 小精灵换图标 (CUTTO-1347) 🚧',
  '- AG1 Feedback Session',
  '### 名利-built in public',
  '- 每天速写 1h ❌',
  '- X 日更 🚧',
  '### 计划外新增',
  '- 用 Claude 剪一个视频 ✅',
].join('\n');

const groups = cycleProgress(PRIORITIES);
assert.deepEqual(groups.map((group) => [group.done, group.partial, group.missed, group.unmarked]), [[1, 1, 1, 1], [0, 1, 1, 0]], 'per OKR group, 计划外新增 left out');
assert.deepEqual(groups[0]!.mit, ['作品集个站：部署上线（❌）']);
const rendered = renderProgress(groups);
assert.match(rendered, /全部 6 条：完成 1，部分完成 2，完成率 17%/);
assert.match(rendered, /未标 1/);

const context = buildReviewContext({ priorities: PRIORITIES, unplanned: '配置 skill（1 天，1h）', habits: '要事第一' });
assert.match(context, /高效能人士的七个习惯/);
assert.match(context, /配置 skill（1 天，1h）/);
assert.match(context, /只点名真正相关的一两个习惯/);
assert.match(context, /## 七个习惯[\s\S]*要事第一/);

console.log('review-context tests passed');
