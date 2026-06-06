# Session Gateway Domain Language

## Room

承载同一项目的一组 Session、项目目标、消息和工作流。房间不是工作流本身，一个房间可以先后运行多个工作流实例。

## Session

一个可持续交互的 AI CLI 执行环境。Session 可以通过房间成员关系承担一个工作角色，但角色不等同于 Session 类型。

## Role Assignment

房间内 Session 承担的职责，例如 `planner`、`coder`、`tester`、`testerall`、`security`、`debugger`。同一角色可以由多个 Session 承担。

## Workflow Definition

可复用的项目交付流程模板，定义阶段、门禁、重试策略和角色要求，不保存某次具体执行的进度。

## Workflow Run

工作流定义在某个房间中的一次执行，拥有独立状态、任务图、事件和最终结果。

## Work Item

Planner 从项目目标拆解出的可交付工作单元。Work Item 保存负责人、依赖、验收标准和当前阶段，是失败重试及人工升级的最小归属单位。

## Assignment

Work Item 某一阶段与具体 Session 的绑定。重新测试或返工默认保持原 Coder Assignment，除非人工明确改派。

## Attempt

同一个 Work Item 在同一个门禁上的一次执行机会。门禁拒绝后计为一次失败；消息投递失败、Session 离线等基础设施错误不消耗业务 Attempt。

## Gate

决定工作流能否进入下一阶段的结构化检查，包括任务测试、整体测试和安全检查。Gate 只能返回 `passed`、`failed` 或 `blocked`。

## Finding

Tester 或 Security 产生的结构化问题记录。Finding 必须关联 Work Item，或明确标记为跨任务的 Workflow Run 级问题。

## Human Intervention

同一 Work Item 在同一门禁累计失败三次后进入的终止性等待状态。系统生成上下文文档并停止自动重试，直到客户给出继续、改派、跳过或终止决定。
