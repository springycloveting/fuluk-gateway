---
name: agent-to-agent
description: Send messages between AI agent sessions via Session Gateway API. Use when user mentions "发送给某个会话", "告诉另一个agent", "agent通信", or needs to pass tasks/info to another running session.
---

# Agent-to-Agent Communication

通过 Session Gateway API 实现不同 AI Agent 会话之间的点对点消息传递。

## Quick Start

```bash
# 发送消息到目标会话
agent-send "会话名或ID" "你要发送的消息内容"
```

## 环境变量配置

在使用前，确保已设置以下环境变量：

```bash
export SESSION_GATEWAY_URL="http://127.0.0.1:8787"
export SESSION_GATEWAY_TOKEN="your-token-here"
```

## Workflows

### 1. 查找目标会话

发送前，先确认目标会话存在：

```bash
agent-list
```

输出示例：
```
ID: abc123, Name: codex-main, Status: running
ID: def456, Name: claude-worker, Status: running
```

### 2. 发送消息到目标会话

```bash
agent-send "claude-worker" "请检查 src/auth.mjs 文件的权限验证逻辑"
```

### 3. 查看目标会话输出

```bash
agent-output "claude-worker" 50
```

## API 接口详情

### 发送消息

```
POST /api/sessions/:id/input
Authorization: Bearer $SESSION_GATEWAY_TOKEN
Content-Type: application/json

{ "text": "消息内容" }
```

### 列出会话

```
GET /api/sessions
Authorization: Bearer $SESSION_GATEWAY_TOKEN
```

### 获取输出

```
GET /api/sessions/:id/output?lines=50
Authorization: Bearer $SESSION_GATEWAY_TOKEN
```

## 消息格式建议

为了让目标 Agent 更好理解消息，建议包含：

1. **发送者身份**: `[来自 codex-main]`
2. **具体任务**: 清晰描述需要做什么
3. **上下文**: 相关文件路径、错误信息等
4. **期望输出**: 需要返回什么信息

示例：
```
[来自 codex-main] 请帮我分析 src/auth.mjs 中的 isAuthorized 函数。
当前错误: Token 验证失败，错误码 401。
期望: 找出可能导致验证失败的原因。
```

## 注意事项

- 会话必须处于 `running` 状态才能接收消息
- 会话可以通过 ID 或名称(name)来标识
- 消息会直接发送到 tmux 终端，目标 Agent 会看到输入
- 不等待目标 Agent 响应，发送成功即返回

## 脚本工具

本 skill 包含以下可执行脚本：

| 脚本 | 用途 |
|------|------|
| `agent-send.mjs` | 发送消息到目标会话 |
| `agent-list.mjs` | 列出所有会话 |
| `agent-output.mjs` | 获取会话输出 |

## 详细文档

完整 API 参考见 [REFERENCE.md](REFERENCE.md)
