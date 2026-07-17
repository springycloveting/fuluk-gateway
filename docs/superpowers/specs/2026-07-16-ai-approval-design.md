# AI 审批引擎 (AI Approval Engine) — 设计文档

- **状态**: Draft (待实现)
- **日期**: 2026-07-16
- **关联**: 升级现有 "All Yes" 功能(`public/auto_yes.js` + `public/app.js` 中的 `maybeAutoYes` / `autoYesAllSessions` / `sendAutoYes`,以及 `src/server.mjs` 中的 `detectTaskState` / `hasConfirmationPrompt`)

## 1. 背景与目标

当前的 "All Yes" 是**纯前端、盲批**的:只要终端输出里出现确认请求(`1) yes` / `a) allow` / opencode 权限栏等),就立即发送同意键,**完全没有风险意识** —— 包括 `docker system prune -f` 这类危险操作。

本设计引入一个 **AI 审批引擎**,在弹出 yes 请求时:

1. **规则过滤**:对候选命令做风险分级。
2. **高风险要求确认**:high-risk 不自动放行,弹窗让用户确认。
3. **记忆学习**:已放行过的 low/medium 命令自动记住,审核次数**越来越少**。
4. **硬底线绝不漏**:裸的 `docker system prune -f` 永远不会被静默放行(无论是规则还是学习)。
5. **上下文降级**:在 `docker ps` / `docker images` / `docker compose ps` 等前置检查**在场**时,`docker system prune -f` 可自动放行。

### 关键决策(已与用户确认)

| 维度 | 决定 |
|---|---|
| 运行位置 | **服务端引擎** + 前端确认弹窗 |
| 记忆模型 | **三级风险**(low/medium/high)+ **学习型 allowlist**;high-risk 有硬底线 |
| 上下文降级 | 检测到前置检查命令 → **自动放行**;裸 high-risk 永远要确认 |
| 与现有开关 | **并存为新模式**:`off` / `all-yes`(现状盲批)/ `ai-approval`(新) |
| 引擎流水线 | **方案 A:确定性优先 + AI 兜底** |

### 非目标 (Out of Scope)

- 不删除现有 `all-yes` 盲批模式(保留为逃生舱)。
- 不引入推送(WebSocket)审批通道;v1 走 pull(轮询)。
- 不做命令"通配泛化"学习(见 §4.2,泛化由规则正则负责)。
- 不自动点"否"(`auto_no`);拒绝一律走"强制确认"。

## 2. 架构与数据流

引擎是**服务端纯决策模块 + 一组新接口**。触发仍来自前端轮询(沿用现有 `findYesOption`/`hasConfirmationPrompt` 检测),但前端不再盲发 key,而是交给服务端裁决。

```
┌─────────────────────────── 前端 (app.js) ───────────────────────────┐
│ 输出轮询 → findYesOption() 检测到确认请求                              │
│   if (allYesMode === "all-yes")    → 现状:直接 sendAutoYes (不变)    │
│   if (allYesMode === "ai-approval")→ POST /api/sessions/:id/approve  │
│        传 { promptSignature }                                         │
└─────────────────────────────────┬────────────────────────────────────┘
                                  ▼
┌─────────────────────────── 服务端引擎 ───────────────────────────────┐
│ 1. tmux 重新捕获最新 output                                            │
│ 2. extractCandidateCommand(output) → 候选命令                          │
│ 3. evaluate():                                                        │
│      ① deny 否决  ② 硬底线 high(查 unlessContext)  ③ 学习 allowlist  │
│      ④ low 规则  ⑤ medium 规则  ⑥ 未知命令(+可选 AI 兜底)            │
│ 4. 裁决:                                                              │
│      auto_yes → 服务端直接 tmux send-keys                             │
│      needs_user_confirm → 落 pendingApproval,返回详情给前端           │
└─────────────────────────────────┬────────────────────────────────────┘
                                  ▼
┌─ auto 分支 ────────────┐     ┌─── needs_user_confirm 分支 ──────────┐
│ 前端刷输出 + 小 toast   │     │ 前端弹确认框:候选命令/风险/原因      │
│ "自动放行:xxx [low]"   │     │  [放行] [拒绝] [放行并记住]           │
└────────────────────────┘     │   ↓ 用户点选                          │
                               │ POST /approve/resolve {approvalId}    │
                               │   → 服务端 send-keys + 更新记忆        │
                               └───────────────────────────────────────┘
```

**关键取舍**:
- **决策与发 key 都在服务端**:auto 分支由服务端直接 `tmux send-keys`,副作用集中;前端只负责"触发 + 弹窗"。记忆、规则、AI 全在一处,所有客户端共享同一份学习结果。
- **服务端自己用 tmux 重新捕获输出**(比前端陈旧轮询可靠;确认态下 pane 等待输入,输出稳定)。
- **后台会话**走和现状一样的循环(类似 `autoYesAllSessions`),逐个调 `/approve`。
- **纯决策函数可测**:`evaluate(...)` 无副作用,核心安全保证在单测里全覆盖。

## 3. 组件

| 文件 | 角色 | 说明 |
|---|---|---|
| `src/approval_engine.mjs` *(新)* | 纯决策 | `evaluate({candidate, output, memory, rules, aiClient?, now})` → decision;`extractCandidateCommand(output)`;内部 `classifyRisk` / `checkContext`。无副作用。 |
| `src/approval_rules.mjs` *(新)* | 规则数据 | `DEFAULT_RULES`、`normalizeRules()`(校验正则)、`matchRule()`。规则是数据,非逻辑。 |
| `src/approval_memory.mjs` *(新)* | 持久化记忆 | JSON 文件(默认 `data/approval-memory.json`),原子写(tmp+rename,对齐 settings 模式)。`lookup/rememberAllow/rememberDeny/list/remove`。 |
| `src/server.mjs` *(改)* | 新接口 | `POST /api/sessions/:id/approve`、`POST .../approve/resolve`、`GET/PUT /api/approval-config`、`GET /api/approval-memory`、`DELETE /api/approval-memory/:id`。 |
| `src/config.mjs` *(改)* | 配置 | runtimeSettings 加 `approval` 块;`normalizeApprovalSettings()` + `normalizeRules()`。AI 兜底**复用现有 commandParser/sessionAgent**,不新增模型配置。 |
| `public/app.js` + `public/approval_dialog.js` *(改/新)* | 前端 | `allYesMode` 加 `"ai-approval"` 档;确认弹窗组件;`maybeAutoYes`/`autoYesAllSessions` 分流到 `/approve`。 |
| `tests/approval_engine.test.mjs` *(新)* 等 | 测试 | 见 §8。 |

## 4. 数据结构

### 4.1 规则 schema(可经 `PUT /api/approval-config` 编辑)

```jsonc
{
  "version": 1,
  "highRisk": [
    // unlessContext: 命中此 context(前置检查在场)时,本 high 规则降级为 auto
    { "id": "docker-prune", "pattern": "docker\\s+system\\s+prune", "flags": "i",
      "unlessContext": "docker_checks", "label": "docker system prune" },
    { "id": "rm-rf", "pattern": "\\brm\\s+(-\\w*r\\w*f|-\\w*f\\w*r)\\b", "flags": "i" }
  ],
  "mediumRisk": [
    { "id": "docker-stop", "pattern": "docker\\s+(restart|stop|rm)\\s", "flags": "i" }
  ],
  "lowRisk": [
    { "id": "npm-safe", "pattern": "npm\\s+(install|ci|test|run)\\b", "flags": "i" },
    { "id": "read-only", "pattern": "\\b(ls|cat|grep|git\\s+(status|log|diff))\\b", "flags": "i" }
  ],
  "context": {
    "docker_checks": {
      "commands": ["docker ps", "docker images", "docker compose ps", "docker-compose ps"],
      "windowLines": 200,
      "requiredCount": 1
    }
  }
}
```

### 4.2 记忆 schema(学习型 allowlist / denylist)

```jsonc
{
  "version": 1,
  "allow": [
    { "id": "<uuid>", "command": "npm install", "signature": "<normalized cmd hash>",
      "risk": "low|medium", "createdAt": "<iso>", "approvedCount": 3, "source": "user|rule" }
  ],
  "deny":  [ { "id": "<uuid>", "command": "...", "createdAt": "<iso>", "source": "user" } ]
}
```

**三个关键安全约束(写进引擎,不是配置)**:

1. **学习只对 low/medium 生效**:`evaluate` 查 `allow` 时只认 `risk ∈ {low,medium}` 的条目;**high-risk 规则永远先于 allowlist 命中**,且写入时拒绝把 high-risk 命令存成"裸 allow"。→ 这是"绝不漏掉裸 prune -f"的硬底线。
2. **记忆按精确命令匹配**(normalized:折叠空白 + 小写),不做通配泛化。`npm install` 记一次,以后 `npm install` 自动放行;但不会让 `npm install; rm -rf` 滑过去。泛化由规则的正则负责。
3. **"放行并记住"对 high-risk 是 no-op**(不隐式变成裸放行);引导用户改加 context 规则。

### 4.3 decision 对象(引擎返回)

```jsonc
{
  "decision": "auto_yes" | "needs_user_confirm",   // 仅两态
  "risk": "low" | "medium" | "high" | "unknown",
  "candidate": "docker system prune -f",
  "key": "1",                                       // auto_yes 时服务端要发的 key
  "reason": "high-risk, but context 'docker_checks' satisfied",
  "ruleId": "docker-prune",
  "contextSatisfied": ["docker_checks"],
  "rememberable": false                             // high-risk → false
}
```

> 决策空间**只有两态**:`auto_yes` / `needs_user_confirm`。无 `auto_no`;拒绝走"强制确认"。

## 5. 判定顺序与 AI 角色

`evaluate()` 按**严格顺序**判定,每步要么给结论、要么进下一步。规则与记忆确定性优先;AI 只在"无确定性结论"时兜底。

```
输入: output, memory, rules, aiClient?, now

0. 提取候选     extractCandidateCommand(output);为空则 AI 提取兜底。
               仍为空 → needs_user_confirm("无法识别命令")   [fail-safe·前置]
1. deny 否决    candidate ∈ 学习 deny → needs_user_confirm("你之前拒绝过")   [终态]
2. high 硬底线  candidate 命中 high 规则 R:
     ├─ R.unlessContext 且该 context 满足(§5.1) → auto_yes("high 但 context 满足")
     └─ 否则 → needs_user_confirm, risk=high, rememberable=false          [终态·硬底线]
                  ⚠️ 此分支不查 allowlist,永不被学习绕过
3. 学习 allowlist  candidate ∈ allow 且 risk∈{low,medium} → auto_yes("已记住")
4. low 规则        命中 → auto_yes
5. medium 规则     命中 → needs_user_confirm, risk=medium, rememberable=true
                         (用户"放行并记住"后,以后走第 3 步 auto)  ← 审核递减来源
6. 未知命令(无规则/无记忆):
     ├─ AI 可用 → AI 给 {low,medium,high,unknown}:low→auto, 其余→confirm
     └─ AI 不可用 → needs_user_confirm, risk=unknown                      [fail-safe]
```

### 5.1 上下文判定

对某 context key(如 `docker_checks`):在 `output` 最近 `windowLines`(默认 200)行里找 `commands` 列表,**命中任意 `requiredCount`(默认 1)条即满足**。

- **默认 = 存在性判定**(确定性、可控):最近跑过 `docker ps`/`docker images`/`docker compose ps` 之一即满足。
- **可选 AI 开关 `contextRequiresCleanCheck`**(默认关):开启后多一步让 AI 看这些检查的*输出*是否"没问题"(没有正在跑的关键容器/没报错)再放行。判不准 → confirm。

### 5.2 AI 兜底的角色(严格有界)

AI 只在**没有确定性结论**时介入,且**永不越界硬底线**(`docker system prune` 在第 2 步已 return,AI 没机会说它"low"):

1. **命令提取**:乱糟糟的提示里抠出"CLI 想执行什么命令"(第 1、6 步)。
2. **风险分级**:对规则没覆盖的未知命令给 {low,medium,high,unknown}(第 6 步)。
3. **(可选)检查结果判定**:仅当 `contextRequiresCleanCheck` 开(§5.1)。

调用形态复用 `ai_parser.mjs` 的 OpenAI-compatible 模式(temp 0、JSON 输出、`/no_think`),输出 `{candidate, risk, reason, contextClean}`。AI 慢/挂 → fail-safe → confirm。

### 5.3 fail-safe 总原则

**任何不确定(提不出候选 / 无规则 / AI 挂 / context 判不准)→ 一律 `needs_user_confirm`。** 宁可多问一次,绝不静默放行危险操作。

## 6. 接口契约(全部走现有 Bearer 鉴权)

### `POST /api/sessions/:id/approve`

前端检测到确认请求时调用。服务端**自己用 tmux 重新捕获**最新输出;`promptSignature` 用于去重。

```jsonc
// 请求
{ "promptSignature": "<sig>", "lines": 250 }
// 响应 · auto 分支(服务端已发 key)
{ "handled": true, "decision": "auto_yes", "risk": "low",
  "candidate": "npm install", "key": "1", "reason": "matched low rule npm-safe" }
// 响应 · 需用户确认(服务端落 pendingApproval)
{ "handled": false, "decision": "needs_user_confirm", "risk": "high",
  "candidate": "docker system prune -f",
  "reason": "matched high rule docker-prune; 无前置检查",
  "rememberable": false, "approvalId": "<uuid>",
  "yesKey": "1", "noKey": "n",
  "hint": "先跑 docker ps / docker images 后即可自动放行" }
```

### `POST /api/sessions/:id/approve/resolve`

```jsonc
// 请求
{ "approvalId": "<uuid>", "choice": "yes" | "no" | "yes_remember" | "no_remember" }
// 响应
{ "resolved": true, "sentKey": "1", "remembered": true,
  "memoryNote": "added to allowlist (medium)" }
```

- `yes`/`no`:发 key,**不动记忆**。
- `yes_remember`:发 key;`rememberable=true` 时入 allow(risk=medium);**high-risk 时记忆操作 no-op** + note(硬底线)。
- `no_remember`:发 reject key + 入 deny。
- pendingApproval 有 TTL(默认 5 分钟)防堆积;服务端对同一 signature 做 cooldown 去重(对齐现有 `shouldSendAutoYes`)。

### `GET/PUT /api/approval-config`

看/改规则与开关(`aiFallback`、`contextRequiresCleanCheck`、`contextWindowLines`、`cooldownMs`、`pendingTtlMs`、`aiTimeoutMs`)。`PUT` 经 `normalizeRules` 校验正则。

### `GET /api/approval-memory` + `DELETE /api/approval-memory/:id`

看学习记忆 / 删某条("忘掉"→下次重新问)。

## 7. 前端 UX

**模式开关**:现有 All-Yes 控制(off / 仅当前会话 / 全部)加第三档 **AI 审批**。三选一循环:Off → All-Yes(现状盲批)→ AI 审批(新)。selected/background 区分沿用现有。

**分流**(`maybeAutoYes` / `autoYesAllSessions`):
- `all-yes` → 不变(盲 `sendAutoYes`)。
- `ai-approval` → 调 `POST /approve`。`handled:true` → 刷输出 + 小 toast「自动放行:npm install [low]」;`handled:false` → 弹确认框。

**确认弹窗**(`public/approval_dialog.js`,新组件):

```
┌─ codex-app 需要确认 ──────────────────────────┐
│ 风险: ● high                                  │
│ 命令: docker system prune -f                  │
│ 原因: 匹配 high 规则 docker-prune;未检测到前置检查 │
│ 提示: 先跑 docker ps / docker images 后即可自动放行 │
│                                               │
│   [放行]   [拒绝]   [放行并记住 (灰)]          │
└───────────────────────────────────────────────┘
```

- 风险色标 + 命令(等宽)+ 原因 + 可操作 hint。
- **放行 / 拒绝 / 放行并记住** 三键。`rememberable===false`(high)时第三键置灰,tooltip「高风险不可整体记住,请改加 context 规则」。
- 多会话同时 pending 时按会话堆叠/排队。

## 8. 错误处理(fail-safe)

| 故障 | 处理 |
|---|---|
| AI 调用超时/失败/乱码 | 包裹 + 超时(默认 8s);当作"AI 不可用" → 未知 → confirm |
| 提取不到候选命令 | 先 AI 提取;仍失败 → confirm |
| 记忆文件损坏/读不出 | 告警 + 当空记忆继续(不崩);原子写防写坏 |
| 记忆写入失败 | 即时动作(发 key)仍成功;记忆 best-effort,返 `remembered:false` |
| tmux 捕获失败 | 返回错误给前端,不自动任何动作 |
| tmux 发 key 失败 | `showError` 上报;resolve 时记忆已更新则保留 + log |
| 非法正则(`PUT /approval-config`) | `normalizeRules` 编译校验,PUT 时拒绝并指出哪条 |
| AI 输出枚举非法值 | 校验 → 未知 → confirm |
| resolve 未知/过期 approvalId | 410 + 消息,前端关弹窗 |
| 同会话并发/重复 resolve | 按 approvalId 幂等,二次 no-op |
| 引擎自身意外抛错 | `/approve` handler try/catch → 返 `needs_user_confirm`("manual review")+ log;前端用自己 `findYesOption` 的 key 兜底弹窗 |

## 9. 配置(`runtimeSettings.approval`)

```jsonc
{
  "enabled": true,
  "aiFallback": true,
  "contextRequiresCleanCheck": false,
  "contextWindowLines": 250,
  "cooldownMs": 10000,
  "pendingTtlMs": 300000,
  "aiTimeoutMs": 8000,
  "rules": { /* §4.1 */ },
  "memoryPath": "data/approval-memory.json"
}
```

- 环境变量:`SESSION_GATEWAY_APPROVAL_MEMORY`、`SESSION_GATEWAY_APPROVAL_AI_TIMEOUT_MS`(对齐现有 env 风格)。
- **AI 模型/key 复用现有 commandParser / sessionAgent,不新增**;两者都没配 → `aiFallback` 实质关闭 → 所有未知 → confirm。
- `config.mjs` 加 `normalizeApprovalSettings()` + `normalizeRules()`(校验正则),镜像现有 `normalize*` 风格。

## 10. 测试策略

引擎是纯函数 → 单测廉价且高价值,**大部分安全保证在这一层验证**:

**`tests/approval_engine.test.mjs`(核心,纯逻辑无 I/O)**:
- 裸 `docker system prune -f` → confirm/high/rememberable=false ✅(头条需求)
- 同命令 + 输出含 `docker ps`/`docker images`/`docker compose ps` → auto(含 `requiredCount` 变体)
- `rm -rf` 各变体 → high/confirm
- low(`npm install`/`git status`)→ auto;medium(`docker stop`)→ confirm/rememberable
- 学习 allowlist:medium 命令 `yes_remember` 后 → auto
- **防御纵深:把 prune 塞进 allow → 仍 confirm**(硬底线不被学习绕过)
- deny 否决:被拒命令即使命中 low → 仍 confirm
- 未知命令 AI 关 → confirm;AI 开(mock aiClient)→ low/medium/high/unknown 映射正确
- AI 返回垃圾/超时(mock reject)→ confirm
- **AI 永不越界:mock aiClient 对 prune 返 low → 仍 confirm**(Step2 先于 AI return)
- `extractCandidateCommand` 对 codex/opencode/claude 样例 → 正确候选;乱码 → null

**`tests/approval_rules.test.mjs`**:`normalizeRules` 拒绝非法正则;`matchRule` flags;`unlessContext` 关联。

**`tests/approval_memory.test.mjs`**(tmp 目录):CRUD、原子写无半成品、损坏 → 空回退、精确匹配归一化。

**`tests/approval_api.test.mjs`**(集成):auto 分支发正确 key;confirm 分支返 approvalId 且不发;resolve 的 yes/yes_remember;**high 的 yes_remember 发 key 但不更新记忆**;cooldown 去重;过期 approvalId→410;鉴权。

现有 `auto_yes.test.mjs` 不动;补一条 `all-yes` 路径不变的回归测试。

## 11. 验收场景

1. codex/opencode 会话出现 `docker system prune -f` 确认 → **弹 high-risk 确认框**,不自动放行。
2. 同会话先跑 `docker ps`(或 `docker images` / `docker compose ps`)→ 再次出现 prune 确认 → **自动放行** + toast。
3. `npm install` 确认 → **自动放行**(low)。
4. 一个 medium 命令首次 → 弹框 → 用户点"放行并记住" → 下次同命令 **自动放行**(审核递减)。
5. AI 关闭时未知命令 → 弹框(fail-safe),不崩、不盲批。
