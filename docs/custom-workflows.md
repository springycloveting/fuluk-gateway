# 自定义工作流使用说明

## 功能概述

项目房间支持创建可复用的自定义工作流模板。模板定义多个顺序执行的阶段，每个阶段指定负责角色、执行模式、任务提示词和最大尝试次数。

工作流启动后，Session Gateway 会把阶段任务发送给房间中角色匹配且正在运行的会话。Agent 必须通过房间回调返回结果，系统才会记录阶段状态并继续流转。

现有的“标准项目交付”是内置模板，继续支持以下流程：

```text
Planner -> Coder -> Tester -> TesterAll
```

## 使用前准备

1. 在项目房间中创建或加入所需会话。
2. 为会话设置自定义角色，例如 `planner`、`coder`、`tester`、`publisher`。
3. 确认参与工作流的会话处于运行状态。
4. 自定义模板中的 `role` 必须与房间会话角色一致，不区分大小写。

如果某个阶段找不到对应的运行中会话，工作流会进入“需人工介入”状态。

## 创建模板

1. 打开项目群聊。
2. 进入“工作流”标签。
3. 点击“新建工作流”。
4. 点击“管理自定义模板”。
5. 点击“新建”。
6. 填写模板名称、说明和阶段定义。
7. 点击“保存模板”。

保存后，该模板会出现在新建工作流的“工作流模板”下拉框中。

## 阶段字段

阶段定义使用 JSON 数组。每个对象代表一个阶段：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | 是 | 阶段唯一标识，只建议使用字母、数字、点、下划线和短横线。 |
| `name` | 否 | UI 中显示的阶段名称；省略时使用 `id`。 |
| `role` | 是 | 执行该阶段的房间角色。 |
| `mode` | 否 | `one` 表示选择一个匹配会话；`all` 表示发送给全部匹配会话。默认 `one`。 |
| `prompt` | 是 | 发送给 Agent 的任务提示词。 |
| `maxAttempts` | 否 | 每个会话最多尝试次数，范围 1-10，默认 3。 |

阶段按数组顺序执行。当前版本不支持跳转、条件分支或 DAG 依赖。

## 提示词变量

`prompt` 支持以下变量：

| 变量 | 内容 |
| --- | --- |
| `{objective}` | 创建工作流时填写的项目目标。 |
| `{sessionName}` | 当前接收任务的会话名称。 |
| `{role}` | 当前阶段角色。 |
| `{previousResults}` | 之前已成功阶段的回传结果。 |

示例：

```text
你是 {sessionName}，角色为 {role}。
请根据以下目标完成开发：
{objective}

前序阶段结果：
{previousResults}
```

## 完整模板示例

以下模板执行“规划 -> 并行开发 -> 整体测试 -> 发布”流程：

```json
[
  {
    "id": "plan",
    "name": "需求规划",
    "role": "planner",
    "mode": "one",
    "maxAttempts": 3,
    "prompt": "请分析项目目标，拆分任务并给出验收标准：\n{objective}"
  },
  {
    "id": "build",
    "name": "并行开发",
    "role": "coder",
    "mode": "all",
    "maxAttempts": 3,
    "prompt": "你是 {sessionName}。请根据规划执行分配给你的开发任务。\n\n项目目标：\n{objective}\n\n规划结果：\n{previousResults}"
  },
  {
    "id": "verify",
    "name": "整体测试",
    "role": "testerall",
    "mode": "one",
    "maxAttempts": 3,
    "prompt": "请执行完整功能、端到端和回归测试。\n\n项目目标：\n{objective}\n\n开发结果：\n{previousResults}"
  },
  {
    "id": "publish",
    "name": "发布",
    "role": "publisher",
    "mode": "one",
    "maxAttempts": 2,
    "prompt": "测试已经通过，请执行发布并记录版本和产物位置。\n\n前序结果：\n{previousResults}"
  }
]
```

对应房间至少需要以下运行中角色：

```text
planner: 1 个
coder: 1 个或多个
testerall: 1 个
publisher: 1 个
```

## 创建并启动工作流

1. 进入项目群聊的“工作流”标签。
2. 点击“新建工作流”。
3. 填写项目目标。
4. 选择自定义模板。
5. 保持“创建后立即交给 Planner”选中，可在创建后自动启动。该文字对自定义模板表示“立即启动首个阶段”，首阶段不要求必须是 Planner。
6. 点击“创建工作流”。

创建时会保存一份模板快照。之后修改或删除模板，不会改变已经创建的工作流。

## 执行模式

### `one`

系统从角色匹配的运行中会话中选择一个会话执行阶段。适用于规划、最终测试、审批和发布。

### `all`

系统向所有角色匹配的运行中会话分别创建 assignment。所有会话都返回 `[DONE]` 后，工作流才进入下一阶段。

任意会话返回失败时，只重试该会话的 assignment，不会要求已经成功的同阶段会话重复执行。

## Agent 回传要求

Agent 在完成阶段任务后，必须调用任务消息中提供的房间回调 API。仅在终端中打印完成结论不会推动工作流。

回传文本必须以以下状态之一开头：

| 状态 | 含义 |
| --- | --- |
| `[DONE]` | 当前 assignment 成功。 |
| `[FAIL]` | 当前 assignment 失败，可按最大次数重试。 |
| `[BUG]` | 按失败处理，可按最大次数重试。 |
| `[BLOCKED]` | 当前 assignment 被阻塞。 |

示例：

```text
[DONE]
- 完成内容：实现发布流程
- 产出物：dist/app.tar.gz
- 验证证据：测试 120/120 通过
```

回传中的 `parentMessageId` 必须引用当前 assignment 的任务消息。系统使用它关联工作流、阶段和执行会话。

## 失败与人工介入

当 Agent 返回 `[FAIL]`、`[BUG]` 或 `[BLOCKED]` 时，系统会为原会话创建下一次尝试。

达到阶段的 `maxAttempts` 后：

1. 工作流状态变为“需人工介入”。
2. 项目房间收到 `[BLOCKED]` 系统消息。
3. 系统停止自动推进，等待人工处理。

## 继续流转

“继续流转”用于以下场景：

- Agent 已完成工作，但没有执行 callback。
- 服务重启后需要补处理房间中已经存在的结果。
- pending assignment 需要重新提醒。

对已投递但未回传的 assignment，系统会重新发送提醒，并明确要求调用 callback。该操作具有结果幂等保护，已经处理的回传不会重复推进阶段。

## 编辑和删除模板

在“管理自定义模板”窗口中：

- 从“已有模板”选择模板，可修改名称、说明和阶段 JSON。
- 点击“新建”可清空表单并载入示例阶段。
- 点击“删除”可删除自定义模板。
- 内置“标准项目交付”不可编辑或删除。

删除模板不会删除使用该模板创建的工作流，因为运行实例保存了模板快照。

## API

### 列出模板

```http
GET /api/workflow-templates
```

### 创建模板

```http
POST /api/workflow-templates
Content-Type: application/json

{
  "name": "Review and publish",
  "description": "Review 后发布",
  "stages": []
}
```

### 修改模板

```http
PUT /api/workflow-templates/:templateId
```

### 删除模板

```http
DELETE /api/workflow-templates/:templateId
```

### 使用模板创建工作流

```http
POST /api/rooms/:roomId/workflows
Content-Type: application/json

{
  "objective": "发布 1.0 版本",
  "templateId": "template-id"
}
```

### 启动工作流

```http
POST /api/workflows/:runId/start
Content-Type: application/json

{}
```

### 补处理和继续流转

```http
POST /api/workflows/:runId/advance
Content-Type: application/json

{}
```

所有 API 请求均需携带 Session Gateway Bearer Token。

## 常见问题

### 阶段启动后没有会话收到任务

检查：

1. 模板 `role` 是否与房间角色完全对应。
2. 对应会话是否为运行状态。
3. 工作流是否已启动。
4. assignment 的投递状态是否为 `sent`。

### Agent 已完成但工作流仍是 pending

通常是 Agent 没有执行 callback。查看项目群聊是否存在带 `source: agent-result` 的回传消息，然后点击“继续流转”重新提醒。

### `all` 阶段一直不进入下一阶段

`all` 要求该阶段的全部目标会话成功。检查是否有某个会话仍为 pending、failed 或漏掉 callback。

### 修改模板后，旧工作流没有变化

这是预期行为。工作流在创建时保存模板快照，防止运行中的编排因模板修改而发生变化。请使用新模板创建新的工作流。

## 当前限制

- 只支持阶段顺序执行。
- 支持阶段内单会话或同角色并行。
- 不支持条件分支、循环、跳转和 DAG 依赖。
- 不支持在模板中直接指定某个固定 session，只能按角色选择。
- `one` 模式当前选择一个匹配的运行中会话，不提供 UI 手动指定。
- 模板阶段 JSON 编辑器暂不提供拖拽式可视化设计。
