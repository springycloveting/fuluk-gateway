# 项目房间工作流编排设计

## 1. 目标

在现有房间、Session 角色、房间消息和结果回调之上增加持久化工作流编排。房间助手的 LLM 负责理解目标、拆解任务和辅助判断；Session Gateway 服务端负责状态、依赖、重试、幂等和审计，不能让 LLM 仅靠上下文自行记忆流程。

首个内置模板覆盖：

```text
planner
  -> coder1..N（并行）
  -> tester1..N（任务级测试）
     -> 失败：退回原 coder
  -> testerall（整体功能测试）
     -> 失败：按 Finding 退回对应原 coder；跨任务问题交给 debugger
  -> security（代码审计 + 渗透测试）
     -> 失败：生成修复任务给 debugger
     -> 修复后重新执行 security
  -> completed

任一 Work Item 在同一门禁失败 3 次
  -> needs_human + 生成人工干预文档
```

## 2. 核心原则

1. **确定性编排，LLM 辅助决策**：服务端验证所有结构化输出并推进状态机。
2. **任务归属稳定**：测试失败默认返回创建该实现的原 Coder，避免上下文丢失。
3. **并行但有依赖**：无依赖的 Work Item 可并行；整体测试必须等待全部任务测试通过。
4. **失败次数按门禁隔离**：任务测试、整体测试、安全检查分别计数，不能混成一个全局数字。
5. **基础设施错误不算业务失败**：投递失败、Session 离线、超时先进入 `blocked` 并重投，不消耗三次机会。
6. **所有转移可审计且幂等**：每次状态变化写事件；重复 callback 不得重复推进。

## 3. 角色与职责

| 角色 | 最小数量 | 职责 | 允许的结果 |
|---|---:|---|---|
| `planner` | 1 | 生成任务图、依赖、验收标准和建议负责人 | `plan_ready`, `blocked` |
| `coder` | 1 | 实现 Work Item，提交变更摘要和验证证据 | `implemented`, `failed`, `blocked` |
| `tester` | 1 | 对一个或多个 Work Item 执行客户验收测试 | `passed`, `failed`, `blocked` |
| `testerall` | 1 | 对已集成结果执行端到端和回归测试 | `passed`, `failed`, `blocked` |
| `security` | 1 | 代码审计、依赖检查和授权范围内的渗透测试 | `passed`, `failed`, `blocked` |
| `debugger` | 1 | 修复跨任务缺陷和安全 Finding | `fixed`, `failed`, `blocked` |

启动前进行角色预检。缺少必需角色时 Workflow Run 保持 `draft`，不能部分启动。多个同角色 Session 默认按“最少活跃 Assignment”分配，允许 Planner 建议但不能指定不存在或离线的 Session。

## 4. 状态模型

### Workflow Run

```text
draft -> planning -> executing -> integration_testing -> security_review
      -> completed
      -> blocked
      -> needs_human
      -> cancelled
```

### Work Item

```text
planned -> ready -> coding -> task_testing -> passed
                   ^          |
                   | failed   |
                   +----------+

任一门禁第三次 failed -> needs_human
```

整体测试和安全检查属于 Run 级 Gate，但其 Finding 必须拆成 Work Item 级修复任务。若 Finding 能关联原实现任务，返工仍交给原 Coder；无法归属或跨模块的问题交给 Debugger。

## 5. 三次失败规则

- 计数键：`workflow_run_id + work_item_id + gate_kind`。
- Gate 返回 `failed` 时，先保存 Findings，再将 `attempt_count` 加一。
- 第 1、2 次失败：创建新的修复 Assignment，并附带全部历史 Findings 和差异。
- 第 3 次失败：Work Item 与 Workflow Run 转为 `needs_human`，停止自动投递。
- 人工决定只能是：`resume`、`reassign`、`skip_with_risk`、`cancel`。
- `resume` 必须创建新的 Attempt，不篡改历史计数；可由人工明确重置自动失败预算。

安全阶段采用同一规则。一次 Security Gate 可包含多个 Finding；同一轮审计只计一次失败，不按漏洞数量累加。

## 6. 持久化模型

建议在现有 SQLite Store 新增：

```text
workflow_definitions
  id, name, version, definition_json, created_at

workflow_runs
  id, room_id, definition_id, objective, status, current_stage,
  created_by, started_at, completed_at, version

workflow_work_items
  id, run_id, parent_id, title, description, acceptance_criteria_json,
  status, original_coder_session_id, priority, created_at, updated_at

workflow_dependencies
  work_item_id, depends_on_work_item_id

workflow_assignments
  id, run_id, work_item_id, gate_kind, role, session_id,
  attempt_no, status, dispatched_message_id, started_at, finished_at

workflow_findings
  id, run_id, work_item_id, assignment_id, severity, category,
  title, evidence, reproduction, status, created_at, resolved_at

workflow_events
  id, run_id, event_key, event_type, actor_session_id,
  payload_json, created_at

workflow_artifacts
  id, run_id, work_item_id, kind, path_or_url, metadata_json, created_at
```

`event_key` 唯一，用于 callback 幂等。`workflow_runs.version` 使用乐观锁，防止两个 callback 同时推进同一 Run。

## 7. Agent 输出协议

现有 `[DONE]/[FAIL]/[BLOCKED]/[BUG]` 文本适合展示，但编排必须在 callback metadata 中携带机器可读结果：

```json
{
  "fromSessionId": "session-id",
  "text": "[DONE] 已完成登录态修复并通过单元测试",
  "target": { "mode": "room" },
  "metadata": {
    "source": "workflow-result",
    "eventKey": "assignment-id:attempt-2:result",
    "workflowRunId": "run-id",
    "workItemId": "item-id",
    "assignmentId": "assignment-id",
    "outcome": "implemented",
    "artifacts": ["tests/auth.test.mjs"],
    "findings": []
  }
}
```

服务端必须校验：Session 是否为当前 Assignment 的执行者、Assignment 是否仍在等待结果、`outcome` 是否符合角色、引用的 Work Item 是否属于该 Run。

## 8. API 草案

```text
POST /api/rooms/:roomId/workflows
GET  /api/rooms/:roomId/workflows
GET  /api/workflows/:runId
POST /api/workflows/:runId/start
POST /api/workflows/:runId/cancel
POST /api/workflows/:runId/results
POST /api/workflows/:runId/interventions
GET  /api/workflows/:runId/events
GET  /api/workflows/:runId/artifacts
```

创建请求至少包含 `objective`、模板版本和角色绑定策略。`results` 接口与房间消息 callback 可共用底层 `acceptWorkflowResult()`，避免两套流转逻辑。

## 9. Planner 结构化输出

Planner 不直接发送自由文本给 Coder。它返回经 JSON Schema 校验的任务图：

```json
{
  "summary": "实现登录态刷新",
  "items": [
    {
      "clientKey": "api-refresh",
      "title": "增加 refresh API",
      "description": "...",
      "acceptanceCriteria": ["旧 access token 过期后可刷新"],
      "dependsOn": [],
      "suggestedRole": "coder"
    }
  ]
}
```

服务端拒绝循环依赖、空验收标准、重复 `clientKey` 和超过配置上限的任务数。计划需在 UI 中提供“人工确认后启动”和“自动启动”两种策略，默认人工确认。

## 10. 人工干预文档

第三次失败后生成：

```text
docs/workflow-interventions/<run-id>/<work-item-id>-<gate-kind>.md
```

文档包含：项目目标、任务与验收标准、原 Coder/当前负责人、三次 Attempt 摘要、每轮 Findings、相关文件和提交、已执行命令、失败证据、当前工作区状态、建议人工决策。文档路径写入 `workflow_artifacts` 并在房间时间线发布一条 `[BLOCKED]` 消息。

## 11. UI

房间页增加“工作流”视图：

- 顶部：Run 状态、阶段、开始/暂停/取消、人工确认计划。
- 主区：按依赖展示 Work Item，看板状态为待处理、开发中、测试中、返工、通过、需人工。
- 侧栏：角色 Session、负载、在线状态、当前 Assignment。
- 详情：Attempt 时间线、Findings、产出物、原 Coder、重试次数。
- `needs_human` 必须显示明确操作按钮，不能自动选择继续。

## 12. 实施顺序

1. **编排内核**：数据表、状态机、事件幂等、纯函数转移测试。
2. **结果接入**：扩展房间 callback metadata，验证执行者并接受结构化结果。
3. **Planner**：Schema 化任务图、依赖校验、人工确认计划。
4. **任务级闭环**：Coder -> Tester -> 原 Coder，验证三次失败升级。
5. **Run 级门禁**：TesterAll、Security、Debugger 修复循环。
6. **工作流 UI 与人工干预文档**。

## 13. 验收场景

1. 两个无依赖任务分别分给 `coder1`、`coder2`，可并行完成且不会重复投递。
2. `tester1` 拒绝任务 A 后，任务只返回任务 A 的原 Coder，不会随机改派。
3. 任务 A 第三次任务测试失败后生成干预文档，任务 B 的计数不受影响。
4. 所有任务通过前，`testerall` 不会收到 Assignment。
5. 整体测试 Finding 可关联原任务；跨任务 Finding 分给 Debugger。
6. Security 失败后修复完成，只重跑 Security Gate，不从 Planner 重新开始。
7. 重复发送同一个 `eventKey` 的 callback 只产生一次状态转移。
8. Session 离线导致投递失败时进入 `blocked`，不增加业务 Attempt。
9. 并发 callback 只能有一个基于当前 Run version 成功推进。
10. 人工 `skip_with_risk` 被永久记录，并进入最终交付报告。

## 14. 第一版边界

- 不让 Agent 任意修改工作流定义。
- 不自动执行无授权的外网渗透测试；Security Assignment 必须携带范围和允许的测试方法。
- 不以聊天文本解析作为唯一结果来源。
- 不支持运行中任意修改已执行的依赖图；变更计划需创建版本化修订并保留事件。
- 不把 Git commit 当作唯一完成证据，仍要求测试/审计产出物。
