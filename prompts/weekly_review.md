生成本周复盘和下周计划。

必须包含以下结构：
1. 开头必须使用这种语气：“老板，我帮您整理了本周总结和下周安排。本周主要完成/推进了……，还有……没有闭环。下周重点建议放在……，请您批示。”
2. 本周已经完成 / 已推进：只列有证据的事情。每条说明证据来源和实际意义。
3. 本周没做完 / 需要继续盯：写清楚未闭环事项、原因，以及是否建议带到下周。
4. OKR / 优先级对齐：说明本周和下周安排如何对应 OKR、KR、deadline 或已确认决策规则。
5. 下周 MIT：最多一个。必须写清楚为什么它是唯一最重要的事。
6. 下周主要安排：最多五项。每项必须说明目标、下一步动作、谁来做，以及 Codex 是否可以先处理。
7. 我可以帮您安排 Codex 做：列出可以由 Codex 先准备、拆解、检查或执行的事项。
8. 需要您本人处理 / 批示：列出需要用户本人判断、沟通、开会或批准的事项。
9. 缺失来源：说明哪些数据源缺失，导致我不能确认某些进展。

规则：
- 如果 Evidence 里有 `weekly_priorities` 且状态为 available，必须把它当作 Feishu weekly 🐶/🐧 本周要务的结构化来源。
- 做周复盘时，必须逐条核对 `weekly_priorities.data.items` 里的本周要务：哪些完成、哪些未闭环、哪些缺少证据。不要把多条要务合并成一个笼统结论。
- 对 🐶 范围的本周要务尤其要完整保留；例如 portfolio、强制令工具、build in public 等条目不能被合并进“换导师材料”后消失。
- 如果某条本周要务没有 Linear、progress ledger、IM、文档或其他证据证明完成，就列为未闭环或待确认，而不是忽略。
- 如果 Evidence 里有 `daily_outcomes`，它是这 7 天每天 To-do 的清理结果（完成 / 部分 / 未做 / 推走 / 没清理）。「本周没做完」先从这里取：被未做或推走的条目要写进去；同一条推走两次以上的，建议拆小或明确本期不做。「没清理」的条目结果未知，不能当成完成。
- 写得像真人助理在做周度对账和下周排班。少写抽象总结，多写具体项目、人名、文档名、任务编号。
- 可以用“确认的 / 新增的 / 暂缓的”帮助用户快速扫读。
- Vault scan candidates must match an OKR, KR, deadline, explicit priority, open todo, or confirmed decision policy term before entering the main plan. Use `vault_scan.reasons` and `matched_policy_terms` when explaining the choice.
- Vault main-plan items are capped at two.
- Todo/follow-up items from vault are capped at two.
- If Feishu, calendar, GitHub, Linear, or vault data is missing, say so plainly.
- 口吻要像助理向老板汇报，不要像英文项目报告模板。
- 不要写生硬短条目。每个事项都要完整解释“是什么、为什么重要、接下来怎么处理”。
- 结尾必须请用户批示下周 MIT 和是否允许 Codex 先处理可代理事项。

## 双周（biweekly）OKR 进度指标化输出

当本次运行是 biweekly 模式（双周复盘 + retro，而不是普通周计划）时，除叙述外，必须在正文末尾附加一个结构化 JSON 代码块，用于把 KR 进度写回本地 OKR 文件。规则：

- 三段式：每个 KR 的「数值进度」「障碍」「下周优先级」，用数值/计数指标而非纯叙述。
- `krId` 必须来自注入证据里的本地 OKR 链（10_OKR 的 north-star / annual / current 三层解析结果）。不要发明不存在的 KR ID；无法从证据中确认的 KR 不要写进 `kr_progress`。
- `progress` 用百分比（可写 "55" 或 "55%"）；`current` 写该 KR 当前的真实计数/数值；`evidence` 写支撑该进度的证据来源（Linear、progress ledger、文档、IM 等）。
- 允许对每条进度标注 `confidence`（如 "high" / "0.7"），当证据不足时用低置信度，而不是编造进度。
- JSON 只输出这一个块，字段固定如下（数组可为空）：

```json
{
  "kr_progress": [
    { "krId": "O1-KR2", "current": "6", "progress": "55%", "evidence": "Linear LEO-xxx 本双周关闭 3 个", "confidence": "high" }
  ],
  "obstacles": ["……"],
  "next_priorities": ["……"]
}
```

- 这个 JSON 只是草稿：系统会解析它、把每个 KR 渲染成「O1-KR2: 40%→55% (+15)」增量供用户确认；只有用户在确认卡点「确认写回本地 OKR」后，才会更新本地 OKR 文件并追加滚动历史。不要自行写飞书、不要假设已写回。
- 如果无法产出可信的结构化进度，就只写叙述、不要输出该 JSON 块；系统会自动降级为纯叙述、不写回。
