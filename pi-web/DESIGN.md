# pi-web 设计文档

## 项目定位

pi-web 是 Session Gateway 的 AI 插件子项目，提供增强的自然语言处理和事件驱动编排能力。

### 项目结构

```
~/work/Session_Gateway/          # 主项目 (web-ai-agent)
├── src/                         # Session Gateway 核心代码
├── public/                      # Web UI
├── pi-web/                      # AI 插件子项目
│   ├── DESIGN.md                # 本文档
│   ├── src/
│   │   ├── nlu/                 # 自然语言理解
│   │   ├── orchestrator/        # 事件驱动编排
│   │   └── server.ts            # HTTP 服务入口
│   └── package.json
└── API_REFERENCE.md             # Session Gateway API 文档
```

## 核心职责

### 1. 自然语言网关

替代 Session Gateway 的 `/api/nl` 端点，提供更强大的 NLU 能力。

#### NLU 架构

```
用户输入 → 规则匹配 → [匹配成功] → 执行命令
                    → [匹配失败] → AI 解析 → 执行命令
```

**规则优先 + AI 兜底**

- 规则层：扩展 Session Gateway 的 `nl.mjs` 规则，支持更多命令模式
- AI 层：使用 pi-ai 调用 LLM 进行意图识别和槽位填充

#### AI 模型支持

- 本地大模型（如 Ollama, LM Studio）
- 云端 API（如 OpenAI, Claude, GLM）
- 根据配置选择使用哪个模型

### 2. 事件驱动编排

监听 Session Gateway 的事件，触发预定义的编排动作。

#### 编排场景示例

**场景：用户确认流程**

```
1. Session Gateway 推送事件：会话状态变为 "waiting_confirmation"
2. pi-web 接收事件
3. pi-web 调用 Session Gateway API 读取会话最近 50 行输出
4. pi-web 使用 LLM 总结输出为摘要
5. pi-web 通过 Webhook 推送摘要到用户（如企业微信）
6. 用户查看通知，调用 pi-web API 提交确认/拒绝
7. pi-web 调用 Session Gateway API 发送 "yes/allow" 或 "NO/esc"
```

#### 事件来源

Session Gateway 会推送以下事件类型：
- 会话状态变化（running → waiting_confirmation → stopped → missing）

#### 编排规则

当前支持硬编码的预定义规则，未来可扩展为可配置的规则引擎。

## API 设计

### 对外 API

pi-web 镜像 Session Gateway 的 API，完全封装 Session Gateway。

用户不再直接调用 Session Gateway，而是通过 pi-web 的 API 进行所有操作。

**示例端点**：

```
GET    /api/sessions              # 列出会话
POST   /api/sessions              # 创建会话
GET    /api/sessions/:id/output   # 获取会话输出
POST   /api/sessions/:id/input    # 发送输入
POST   /api/nl                    # 自然语言命令（增强版）
POST   /api/approvals/:id/confirm # 确认待审批项
POST   /api/approvals/:id/reject  # 拒绝待审批项
```

### 内部通信

pi-web 调用 Session Gateway 的 API 执行实际操作：

```
pi-web → HTTP → Session Gateway API
```

事件获取方式待定（WebSocket 订阅 / API 轮询 / Webhook 推送）。

## 技术栈

- **语言**：TypeScript
- **运行环境**：宿主机服务（systemd）
- **存储**：内存存储（重启后数据丢失）
- **配置**：环境变量 + 配置文件
- **LLM 底座**：@earendil-works/pi-ai

## 配置项

```bash
# Session Gateway 连接
PI_WEB_GW_URL=http://localhost:8787
PI_WEB_GW_TOKEN=<session-gateway-token>

# LLM 配置
PI_WEB_LLM_PROVIDER=openai|anthropic|google|ollama
PI_WEB_LLM_MODEL=gpt-4|claude-3-opus|...
PI_WEB_LLM_API_KEY=<api-key>
PI_WEB_LLM_BASE_URL=http://localhost:11434  # Ollama 等本地模型

# Webhook 配置
PI_WEB_WEBHOOK_URL=https://qyapi.weixin.qq.com/...
PI_WEB_WEBHOOK_TOKEN=<webhook-token>

# 服务配置
PI_WEB_HOST=127.0.0.1
PI_WEB_PORT=8788
```

## 安全考虑

1. **API 认证**：所有 API 需要 Bearer Token 认证
2. **Session Gateway 隔离**：用户只能通过 pi-web 访问 Session Gateway，无法直接访问
3. **敏感信息**：API Key、Token 等通过环境变量传递，不记录日志
4. **速率限制**：继承 Session Gateway 的速率限制策略

## 开放问题

1. **事件获取方式**：pi-web 如何获取 Session Gateway 的事件？
   - WebSocket 订阅 SessionEventHub
   - API 轮询
   - Session Gateway Webhook 推送

2. **用户确认流程**：Webhook 推送到哪个服务？企业微信？Slack？自定义？

3. **编排规则扩展**：是否需要支持动态添加/修改编排规则？

4. **多租户支持**：是否需要支持多用户/多租户？
