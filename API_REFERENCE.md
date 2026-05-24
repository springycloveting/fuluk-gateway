# Session Gateway API Reference

> Version: 1.x
> Base URL: `http://host:port`

---

## Overview

Session Gateway 是一个 HTTP API 服务，用于管理运行在 tmux 中的 AI CLI 会话（codex, claude, opencode）和本地 shell。

### 认证

除 `/health` 端点外，所有 API 请求需要 Bearer Token 认证：

```http
Authorization: Bearer <SESSION_GATEWAY_TOKEN>
```

### 响应格式

- 成功：HTTP 200/201 + JSON body
- 失败：HTTP 4xx/5xx + `{ "error": "错误信息" }`

---

## Endpoints

### Health Check

```http
GET /health
```

检查服务状态和 tmux 可用性。无需认证。

**Response 200:**
```json
{
  "ok": true,
  "tmux": true
}
```

**Response 503:**
```json
{
  "ok": false,
  "tmux": false,
  "error": "tmux is required but was not found in PATH"
}
```

---

### List Sessions

```http
GET /api/sessions
```

获取所有会话列表，自动刷新状态。

**Response 200:**
```json
{
  "sessions": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "name": "codex-app",
      "kind": "codex",
      "cwd": "/workspace/app",
      "project": null,
      "tmuxSessionName": "codex-app",
      "command": "docker",
      "commandArgs": ["exec", "-w", "/work/codex-app", "-it", "worker-codex", "codex"],
      "status": "running",
      "createdAt": "2026-05-24T10:00:00.000Z",
      "updatedAt": "2026-05-24T10:30:00.000Z",
      "stoppedAt": null
    }
  ]
}
```

---

### Create Session

```http
POST /api/sessions
Content-Type: application/json
```

创建新会话。

**Request Body:**
```json
{
  "kind": "codex | claude | opencode | runtime",
  "name": "optional-session-name",
  "cwd": "/optional/working/directory",
  "project": "optional-project-name",
  "deploymentMode": "docker | host",
  "dockerName": "optional-container-name",
  "commandArgs": ["optional", "cli", "args"]
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| kind | string | ✅ | 会话类型：codex, claude, opencode, runtime |
| name | string | ❌ | 会话名称，默认 `{kind}-{uuid前8位}` |
| cwd | string | ❌ | 工作目录，默认根据部署模式决定 |
| project | string | ❌ | 项目标识 |
| deploymentMode | string | ❌ | 部署模式：docker（默认）或 host |
| dockerName | string | ❌ | Docker 容器名，默认 `worker-{kind}` |
| commandArgs | string[] | ❌ | 额外的 CLI 参数 |

**Response 201:**
```json
{
  "session": { /* Session Object */ }
}
```

**Error 400:**
```json
{
  "error": "kind must be codex, claude, opencode, or runtime"
}
```

---

### Get Session Output

```http
GET /api/sessions/:id/output?lines=N&format=json&etag=XXX
```

捕获会话终端输出。

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| lines | number | 120 | 捕获行数（1-2000） |
| format | string | text | `text` 或 `json` |
| etag | string | - | 上次的 etag，用于检测变化 |

**Response 200 (format=text):**
```text
终端输出内容...
```

**Response 200 (format=json, changed=true):**
```json
{
  "changed": true,
  "etag": "sha256-hash",
  "output": "终端输出内容..."
}
```

**Response 200 (format=json, changed=false):**
```json
{
  "changed": false,
  "etag": "sha256-hash"
}
```

---

### Send Input to Session

```http
POST /api/sessions/:id/input
Content-Type: application/json
```

向会话发送文本输入（自动附加回车）。

**Request Body:**
```json
{
  "text": "要发送的文本"
}
```

**Response 200:**
```json
{
  "ok": true
}
```

---

### Send Keys to Session

```http
POST /api/sessions/:id/keys
Content-Type: application/json
```

发送 tmux 按键序列（不附加回车）。

**Request Body:**
```json
{
  "keys": ["Escape", "Enter"]
}
```

**允许的按键：**
- 单字符：`A-Z`, `a-z`, `0-9`
- 控制键：`C-A` 到 `C-Z`（Ctrl+字母）
- 特殊键：`Enter`, `Escape`, `Space`, `Tab`, `BTab`, `Up`, `Down`, `Left`, `Right`, `BSpace`, `DC`, `Home`, `End`, `PageUp`, `PageDown`

**Response 200:**
```json
{
  "ok": true
}
```

---

### Restart Session

```http
POST /api/sessions/:id/restart
```

重启会话（停止后重新创建）。

**Response 200:**
```json
{
  "session": { /* Session Object */ }
}
```

---

### Stop Session

```http
DELETE /api/sessions/:id
```

停止会话（保留记录）。

**Response 200:**
```json
{
  "ok": true
}
```

---

### Delete Session

```http
DELETE /api/sessions/:id/delete
```

删除会话（停止并移除记录）。

**Response 200:**
```json
{
  "ok": true
}
```

---

### Natural Language Command

```http
POST /api/nl
Content-Type: application/json
```

执行自然语言命令。

**Request Body:**
```json
{
  "text": "新建 codex 会话 app，目录 /workspace/app",
  "currentSessionId": "optional-current-session-id"
}
```

**Response (create):**
```json
{
  "command": {
    "type": "create",
    "input": {
      "kind": "codex",
      "cwd": "/workspace/app",
      "name": "app",
      "project": null
    }
  },
  "session": { /* Session Object */ }
}
```

**Response (send):**
```json
{
  "command": {
    "type": "send",
    "target": "session-name",
    "text": "消息内容"
  },
  "ok": true,
  "session": { /* Session Object */ },
  "output": "发送后的输出..."
}
```

**Response (list):**
```json
{
  "command": {
    "type": "list",
    "runningOnly": false
  },
  "sessions": [ /* Session Objects */ ]
}
```

**Response (output):**
```json
{
  "command": {
    "type": "output",
    "target": "session-name",
    "lines": 50
  },
  "session": { /* Session Object */ },
  "output": "会话输出..."
}
```

**Response (help):**
```json
{
  "command": { "type": "help" },
  "help": "帮助文本..."
}
```

**支持的命令类型：**
| type | 说明 |
|------|------|
| create | 创建会话 |
| list | 列出会话 |
| send | 发送消息 |
| output | 获取输出 |
| switch | 切换会话 |
| stop | 停止会话 |
| restart | 重启会话 |
| help | 显示帮助 |

---

### Get Configuration

```http
GET /api/config
```

获取运行时配置。

**Response 200:**
```json
{
  "settings": {
    "cliDeployment": {
      "codex": { "mode": "docker", "dockerName": "worker-codex" },
      "claude": { "mode": "docker", "dockerName": "worker-claude" },
      "opencode": { "mode": "docker", "dockerName": "worker-opencode" }
    },
    "commandParser": {
      "enabled": true,
      "mode": "rules-first-ai-fallback",
      "baseUrl": "http://127.0.0.1:8000",
      "model": "local-model",
      "apiKey": "user-api-key"
    }
  },
  "enabled": true
}
```

---

### Update Configuration

```http
PUT /api/config
Content-Type: application/json
```

更新运行时配置。

**Request Body:**
```json
{
  "settings": {
    "cliDeployment": {
      "codex": { "mode": "host" }
    },
    "commandParser": {
      "enabled": true,
      "baseUrl": "http://127.0.0.1:1234",
      "model": "new-model",
      "apiKey": "new-api-key"
    }
  }
}
```

**Response 200:**
```json
{
  "settings": { /* Updated Settings */ }
}
```

---

## Data Types

### Session Object

```typescript
interface Session {
  id: string;              // UUID
  name: string;            // 会话名称
  kind: "codex" | "claude" | "opencode" | "runtime";
  cwd: string;             // 工作目录
  project: string | null;  // 项目标识
  tmuxSessionName: string; // tmux 会话名（sg- 前缀）
  command: string;         // 主命令
  commandArgs: string[];   // 命令参数
  status: "running" | "stopped" | "missing";
  createdAt: string;       // ISO 8601
  updatedAt: string;       // ISO 8601
  stoppedAt: string | null; // ISO 8601
}
```

### Settings Object

```typescript
interface Settings {
  cliDeployment: {
    [kind: string]: {
      mode: "docker" | "host";
      dockerName: string;
    };
  };
  commandParser: {
    enabled: boolean;
    mode: "rules-first-ai-fallback" | "rules-only";
    baseUrl: string;
    model: string;
    apiKey: string;
  };
}
```

---

## Error Handling

| HTTP Status | 说明 |
|-------------|------|
| 400 | 请求参数错误 |
| 401 | 未认证或 token 无效 |
| 403 | 禁止访问 |
| 404 | 资源未找到 |
| 429 | 请求频率超限 |
| 500 | 服务器内部错误 |

错误响应格式：
```json
{
  "error": "错误描述信息"
}
```

---

## Rate Limiting

- 默认限制：100 请求/分钟/IP
- 超限响应：HTTP 429

---

## Security Headers

所有响应包含以下安全头：

```http
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
X-XSS-Protection: 1; mode=block
Referrer-Policy: strict-origin-when-cross-origin
```

---

## Environment Variables

| 变量 | 必填 | 说明 |
|------|------|------|
| SESSION_GATEWAY_TOKEN | ✅ | API 认证令牌 |
| HOST | ❌ | 监听地址，默认 127.0.0.1 |
| PORT | ❌ | 监听端口，默认 8787 |
| SESSION_GATEWAY_DB | ❌ | SQLite 数据库路径 |
| SESSION_GATEWAY_SETTINGS | ❌ | 设置文件路径 |
| SESSION_GATEWAY_ALLOW_RUNTIME | ❌ | 允许 runtime 模式，默认 false |
| SESSION_GATEWAY_RUNTIME | ❌ | runtime 默认命令，默认 /bin/bash |

---

## Plugin Development Notes

### 会话生命周期

```
创建 → running → [stopped] → [restart] → running
                  ↓
               [delete] → 移除记录
```

### tmux 会话命名

- 会话名通过 `sanitizeTmuxName()` 处理
- 只保留 `[A-Za-z0-9_.-]`
- 最大长度 80 字符
- 自动添加 `sg-` 前缀（内部）

### 工作目录默认值

| 部署模式 | 默认目录 |
|----------|----------|
| docker | `/work/{session-name}` |
| host | `/home/v6/work/{session-name}` |

### 命令解析优先级

1. 规则解析（`nl.mjs`）
2. AI 解析（`ai_parser.mjs`，如果启用）

---

## WebSocket (Future)

当前版本使用 HTTP 轮询。未来版本可能添加 WebSocket 支持实现实时输出推送。

---

## SDK Example

### JavaScript/TypeScript

```typescript
const client = new SessionGatewayClient({
  baseUrl: "http://localhost:8787",
  token: "your-token"
});

// 列出会话
const { sessions } = await client.listSessions();

// 创建会话
const session = await client.createSession({
  kind: "codex",
  name: "my-app",
  cwd: "/workspace/app"
});

// 发送输入
await client.sendInput(session.id, "npm test");

// 获取输出
const output = await client.getOutput(session.id, { lines: 100 });

// 自然语言命令
const result = await client.executeCommand("发送 npm test 到 codex-app");
```

---

## Changelog

### v1.0.0
- 初始版本
- 会话 CRUD 操作
- 自然语言命令解析
- 配置管理 API
- 安全加固（速率限制、认证、安全头）
