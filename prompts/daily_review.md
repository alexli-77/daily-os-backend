复盘今天：把今天的实际进展逐条对照早上的今日安排（todo）。

你会收到这些输入：
- `Evidence.sources.daily_plan_todos`：今天早上生成的今日安排，`data.todos` 是一个数组，每项含 `candidateId`、`text`、`rank`。这是本次对账的基准清单。
- `Evidence.sources.todo_feedback`：今天用户在安排卡上勾选的反馈，`data.entries` 每项含 `candidateId` 和 `event`（`complete`＝已勾完成，`partial`＝用户自己标了「做了一部分、还没完」，`defer`＝已推迟）。
- 其余 Evidence 来源（Linear、Feishu、Vault、GitHub、todo_inbox 等）：今天全天的证据，用来判断每条 todo 到底推进到哪一步。

只输出一个 JSON 对象，不要输出任何解释、前言或 Markdown 代码块以外的文字。结构严格如下：

```json
{
  "reconciliation": [
    { "candidateId": "linear:LEO-1", "text": "把 LEO-1 推进到可验收", "status": "done", "evidence": "PR #42 已合并" }
  ],
  "carry_over": ["vault:xxx"],
  "note": "今天最大的亮点/风险一句话"
}
```

字段规则：
- `reconciliation`：对 `daily_plan_todos.todos` 里的每一条都要给出一行，`candidateId` 和 `text` 直接沿用安排里的原值，顺序按 `rank`。
- `status` 只能是三选一：
  - `done`＝今天已经闭环、有证据支持完成；
  - `progressed`＝有推进但还没闭环；
  - `open`＝今天基本没动或没有任何完成证据。
- **凡是在 `todo_feedback` 里 `event` 为 `complete` 的 `candidateId`，其 `status` 必须为 `done`，不得改判为 `progressed` 或 `open`。**
- **凡是 `event` 为 `partial` 的 `candidateId`，其 `status` 必须为 `progressed`。**
  用户已经亲口说了「做了一部分、还没完」，这是第一手信息：不要因为找不到外部证据就降成 `open`，
  也不要因为看起来收尾了就拔高成 `done`。
- `evidence`：一句话说明判断依据（来自哪个来源、看到什么）。没有证据时写“看不到完成证据”，并把 `status` 记为 `open`，绝不能凭空声称完成。
- `carry_over`：建议明天继续的 `candidateId` 列表，从 `status` 为 `open` 或 `progressed` 的项里选，
  通常就是仍值得继续推进的未闭环项。做了一半的事**尤其**该进这个列表——别因为它今天有进展就当成已经了结。
- `note`：可选，一句话记录今天最大的亮点或风险；不需要长篇复盘、不要分成多章。

边界：
- 如果 `daily_plan_todos` 缺失或为空（今天没跑今日安排），就输出 `{"reconciliation": [], "carry_over": []}`，系统会自动降级为旧版复盘格式。
- 不要新增安排里没有的条目，不要合并或删减条目。
- 判断要诚实：没有证据就是 `open`，不要为了好看而拔高状态。
