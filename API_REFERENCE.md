# Fuluk Gateway API Reference

> Version: 1.x
> Base URL: `http://host:port`

---

Fuluk Gateway 是一个 HTTP API 服务，用于管理运行在 tmux 中的 AI CLI 会话（codex, claude, opencode, pi-os）和本地 shell。

Fuluk Gateway is an HTTP API service for managing AI CLI sessions (codex, claude, opencode, pi-os) and local shells running in tmux.

<details>
<summary>English</summary>

## Overview

### Authentication

All API endpoints except `/health` require Bearer Token authentication:

```http
Authorization: Bearer <SESSION_GATEWAY_TOKEN>
```

### Response Format

- Success: HTTP 200/201 + JSON body
- Failure: HTTP 4xx/5xx + `{ "error": "error message" }`

---

## Endpoints

### Health Check

```http
GET /health
```

Check service status and tmux availability. No authentication required.

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

Get all sessions list, automatically refreshes status.

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
      "command": "codex",
      "commandArgs": [],
      "status": "running",
      "taskState": "in_progress",
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

Create a new session.

**Request Body:**
```json
{
  "kind": "codex | claude | opencode | pi-os | runtime",
  "name": "optional-session-name",
  "cwd": "/optional/working/directory",
  "project": "optional-project-name",
  "deploymentMode": "host | docker",
  "dockerName": "optional-container-name",
  "commandArgs": ["optional", "cli", "args"]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| kind | string | ✅ | Session type: codex, claude, opencode, pi-os, runtime |
| name | string | ❌ | Session name, default `{kind}-{uuid-first-8-chars}` |
| cwd | string | ❌ | Working directory, default depends on deployment mode |
| project | string | ❌ | Project identifier |
| deploymentMode | string | ❌ | Deployment mode: host (default) or docker |
| dockerName | string | ❌ | Docker container name, default `worker-{kind}` |
| commandArgs | string[] | ❌ | Additional CLI arguments |

**Response 201:**
```json
{
  "session": { /* Session Object */ }
}
```

**Error 400:**
```json
{
  "error": "kind must be codex, claude, opencode, pi-os, or runtime"
}
```

---

### Get Session Output

```http
GET /api/sessions/:id/output?lines=N&format=json&etag=XXX
```

Capture session terminal output.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| lines | number | 120 | Number of lines to capture (1-2000) |
| format | string | text | `text` or `json` |
| etag | string | - | Previous etag, for change detection |

**Response 200 (format=text):**
```text
Terminal output content...
```

**Response 200 (format=json, changed=true):**
```json
{
  "changed": true,
  "etag": "sha256-hash",
  "output": "Terminal output content..."
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

Send text input to session (automatically appends Enter key).

**Request Body:**
```json
{
  "text": "text to send"
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

Send tmux key sequences (no Enter appended).

**Request Body:**
```json
{
  "keys": ["Escape", "Enter"]
}
```

**Allowed keys:**
- Single characters: `A-Z`, `a-z`, `0-9`
- Control keys: `C-A` to `C-Z` (Ctrl+letter)
- Special keys: `Enter`, `Escape`, `Space`, `Tab`, `BTab`, `Up`, `Down`, `Left`, `Right`, `BSpace`, `DC`, `Home`, `End`, `PageUp`, `PageDown`

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

Restart session (stop then recreate).

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

Stop session (keep record).

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

Delete session (stop and remove record).

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

Execute natural language command.

**Request Body:**
```json
{
  "text": "Create codex session app in /workspace/app",
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
    "text": "message content"
  },
  "ok": true,
  "session": { /* Session Object */ },
  "output": "Output after sending..."
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
  "output": "Session output..."
}
```

**Response (help):**
```json
{
  "command": { "type": "help" },
  "help": "Help text..."
}
```

**Supported command types:**
| type | Description |
|------|-------------|
| create | Create session |
| list | List sessions |
| send | Send message |
| output | Get output |
| switch | Switch session |
| stop | Stop session |
| restart | Restart session |
| help | Show help |

---

### Get Input History

```http
GET /api/history?limit=N
```

Get input command history.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| limit | number | 200 | Maximum results (1-500) |

**Response 200:**
```json
{
  "history": [
    {
      "id": 1,
      "sessionId": "session-id",
      "sessionName": "codex-app",
      "text": "npm test",
      "createdAt": "2026-06-01T10:00:00.000Z"
    }
  ]
}
```

---

### Get Role Presets

```http
GET /api/role-presets
```

Get role preset list.

**Response 200:**
```json
{
  "rolePresets": [
    { "role": "planner", "prompt": "..." },
    { "role": "coder", "prompt": "..." }
  ]
}
```

---

### List Rooms

```http
GET /api/rooms
```

Get all rooms list.

**Response 200:**
```json
{
  "rooms": [
    {
      "id": "room-id",
      "name": "project-alpha",
      "createdAt": "2026-06-01T10:00:00.000Z"
    }
  ]
}
```

---

### Create Room

```http
POST /api/rooms
Content-Type: application/json
```

Create a new room.

**Request Body:**
```json
{
  "name": "project-alpha"
}
```

**Response 201:**
```json
{
  "room": {
    "id": "room-id",
    "name": "project-alpha",
    "createdAt": "2026-06-01T10:00:00.000Z"
  }
}
```

---

### Get Room

```http
GET /api/rooms/:roomId
```

Get room details.

**Response 200:**
```json
{
  "room": {
    "id": "room-id",
    "name": "project-alpha",
    "createdAt": "2026-06-01T10:00:00.000Z"
  }
}
```

---

### Delete Room

```http
DELETE /api/rooms/:roomId
```

Delete room.

**Response 200:**
```json
{
  "ok": true,
  "roomId": "room-id"
}
```

---

### Get Room Messages

```http
GET /api/rooms/:roomId/messages?limit=N
```

Get room message list.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| limit | number | 100 | Maximum results (1-500) |

**Response 200:**
```json
{
  "messages": [
    {
      "id": "msg-id",
      "roomId": "room-id",
      "source": "user",
      "senderSessionId": "session-id",
      "senderSessionName": "codex-app",
      "senderRole": "coder",
      "text": "Task completed",
      "parentMessageId": null,
      "createdAt": "2026-06-01T10:00:00.000Z"
    }
  ]
}
```

---

### List Room Workflows

```http
GET /api/rooms/:roomId/workflows
```

Get workflows in room.

**Response 200:**
```json
{
  "workflows": [
    {
      "id": "run-id",
      "roomId": "room-id",
      "objective": "Release v1.0",
      "status": "in_progress",
      "templateId": "template-id",
      "templateDefinition": { /* template definition */ },
      "createdAt": "2026-06-01T10:00:00.000Z"
    }
  ]
}
```

---

### Create Room Workflow

```http
POST /api/rooms/:roomId/workflows
Content-Type: application/json
```

Create workflow in room.

**Request Body:**
```json
{
  "objective": "Release v1.0",
  "templateId": "template-id"
}
```

**Response 201:**
```json
{
  "workflow": {
    "id": "run-id",
    "roomId": "room-id",
    "objective": "Release v1.0",
    "status": "pending",
    "templateId": "template-id",
    "createdAt": "2026-06-01T10:00:00.000Z"
  }
}
```

---

### List Workflow Templates

```http
GET /api/workflow-templates
```

Get workflow template list.

**Response 200:**
```json
{
  "templates": [
    {
      "id": "template-id",
      "name": "Review and publish",
      "description": "Review then publish",
      "definition": {
        "kind": "linear",
        "stages": []
      },
      "createdAt": "2026-06-01T10:00:00.000Z"
    }
  ]
}
```

---

### Create Workflow Template

```http
POST /api/workflow-templates
Content-Type: application/json
```

Create workflow template.

**Request Body:**
```json
{
  "name": "Review and publish",
  "description": "Review then publish",
  "stages": [
    {
      "id": "review",
      "role": "reviewer",
      "prompt": "Please review the code..."
    }
  ]
}
```

**Response 201:**
```json
{
  "template": { /* Template Object */ }
}
```

---

### Update Workflow Template

```http
PUT /api/workflow-templates/:templateId
Content-Type: application/json
```

Update workflow template.

**Request Body:**
```json
{
  "name": "Updated name",
  "stages": []
}
```

**Response 200:**
```json
{
  "template": { /* Updated Template Object */ }
}
```

---

### Delete Workflow Template

```http
DELETE /api/workflow-templates/:templateId
```

Delete workflow template (built-in templates cannot be deleted).

**Response 200:**
```json
{
  "ok": true
}
```

---

### Get Workflow Run

```http
GET /api/workflows/:runId
```

Get workflow run instance details.

**Response 200:**
```json
{
  "workflow": {
    "id": "run-id",
    "roomId": "room-id",
    "objective": "Release v1.0",
    "status": "in_progress",
    "templateId": "template-id",
    "templateDefinition": {
      "kind": "linear",
      "stages": []
    },
    "assignments": [
      {
        "id": "assignment-id",
        "stageId": "plan",
        "sessionId": "session-id",
        "status": "completed",
        "attempts": 1,
        "resultText": "[DONE] Planning completed"
      }
    ],
    "createdAt": "2026-06-01T10:00:00.000Z"
  }
}
```

---

### Start Workflow

```http
POST /api/workflows/:runId/start
Content-Type: application/json

{}
```

Start workflow (begin executing first stage).

**Response 200:**
```json
{
  "workflow": { /* Updated Workflow Object */ }
}
```

---

### Advance Workflow

```http
POST /api/workflows/:runId/advance
Content-Type: application/json

{}
```

Advance workflow (reprocess incomplete assignments and continue).

**Response 200:**
```json
{
  "workflow": { /* Updated Workflow Object */ }
}
```

---

### Get Configuration

```http
GET /api/config
```

Get runtime configuration.

**Response 200:**
```json
{
  "settings": {
    "cliDeployment": {
      "codex": { "mode": "host", "dockerName": "worker-codex" },
      "claude": { "mode": "host", "dockerName": "worker-claude" },
      "opencode": { "mode": "host", "dockerName": "worker-opencode" },
      "pi-os": { "mode": "host", "dockerName": "" }
    },
    "commandParser": {
      "enabled": true,
      "mode": "rules-first-ai-fallback",
      "baseUrl": "http://127.0.0.1:8000",
      "model": "local-model",
      "apiKey": "user-api-key",
      "webAiAgentPiUrl": "",
      "webAiAgentPiToken": ""
    },
    "sessionAgent": {
      "model": "",
      "apiKey": "",
      "models": {},
      "resetOnConfigChange": false
    },
    "notifications": {
      "webhookUrl": ""
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

Update runtime configuration.

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
  name: string;            // Session name
  kind: "codex" | "claude" | "opencode" | "pi-os" | "runtime";
  cwd: string;             // Working directory
  project: string | null;  // Project identifier
  tmuxSessionName: string; // tmux session name (sg- prefix)
  command: string;         // Main command
  commandArgs: string[];   // Command arguments
  status: "running" | "stopped" | "missing";
  taskState: "in_progress" | "completed" | "needs_confirmation" | null;
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
    mode: "rules-first-ai-fallback" | "rules-only" | "web-ai-agent-pi";
    baseUrl: string;
    model: string;
    apiKey: string;
    webAiAgentPiUrl: string;
    webAiAgentPiToken: string;
  };
  sessionAgent: {
    model: string;
    apiKey: string;
    models: Record<string, Record<string, object>>;
    resetOnConfigChange: boolean;
  };
  notifications: {
    webhookUrl: string;
  };
}
```

---

## Error Handling

| HTTP Status | Description |
|-------------|-------------|
| 400 | Bad request / invalid parameters |
| 401 | Unauthorized / invalid token |
| 403 | Forbidden |
| 404 | Resource not found |
| 429 | Rate limit exceeded |
| 500 | Internal server error |

Error response format:
```json
{
  "error": "Error description"
}
```

---

## Rate Limiting

- Default limit: 100 requests/minute/IP
- Exceeded response: HTTP 429

---

## Security Headers

All responses include these security headers:

```http
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
X-XSS-Protection: 1; mode=block
Referrer-Policy: strict-origin-when-cross-origin
```

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| SESSION_GATEWAY_TOKEN | ✅ | API authentication token |
| HOST | ❌ | Listen address, default 127.0.0.1 |
| PORT | ❌ | Listen port, default 8787 |
| SESSION_GATEWAY_DB | ❌ | SQLite database path |
| SESSION_GATEWAY_SETTINGS | ❌ | Settings file path |
| SESSION_GATEWAY_ALLOW_RUNTIME | ❌ | Allow runtime mode, default false |
| SESSION_GATEWAY_RUNTIME | ❌ | Runtime default command, default /bin/bash |
| SESSION_GATEWAY_WEBHOOK_URL | ❌ | Task state change webhook URL |
| SESSION_GATEWAY_NOTIFICATION_POLL_MS | ❌ | Notification poll interval ms, default 5000 |
| SESSION_GATEWAY_SUBMIT_KEY_DELAY_MS | ❌ | Delay between text and submit key ms, default 80 |
| SESSION_GATEWAY_CLI_STARTUP_DELAY_MS | ❌ | CLI startup delay ms, default 3000 |
| SESSION_GATEWAY_CODEX_SUBMIT_KEY | ❌ | Codex session submit key, default Enter |
| SESSION_GATEWAY_CLAUDE_SUBMIT_KEY | ❌ | Claude session submit key, default Enter |
| SESSION_GATEWAY_OPENCODE_SUBMIT_KEY | ❌ | OpenCode session submit key, default Enter |
| SESSION_GATEWAY_PI_OS_SUBMIT_KEY | ❌ | pi-os session submit key, default Enter |
| SESSION_GATEWAY_RUNTIME_SUBMIT_KEY | ❌ | Runtime session submit key, default Enter |
| SESSION_GATEWAY_CODEX_CMD | ❌ | Codex command, default `docker exec -it worker-codex codex` |
| SESSION_GATEWAY_CLAUDE_CMD | ❌ | Claude command, default `docker exec -it worker-claude claude` |
| SESSION_GATEWAY_OPENCODE_CMD | ❌ | OpenCode command, default `docker exec -it worker-opencode opencode` |
| SESSION_GATEWAY_PI_OS_CMD | ❌ | pi-os command, default `pi-os` |

---

## Plugin Development Notes

### Session Lifecycle

```
Create → running → [stopped] → [restart] → running
                     ↓
                  [delete] → Remove record
```

### tmux Session Naming

- Session name processed by `sanitizeTmuxName()`
- Only keeps `[A-Za-z0-9_.-]`
- Max length 80 characters
- Auto-adds `sg-` prefix (internal)

### Default Working Directory

| Deployment Mode | Default Directory |
|-----------------|-------------------|
| docker | `/work/{session-name}` |
| host | `/home/v6/work/{session-name}` |

### Command Parsing Priority

1. Rules parsing (`nl.mjs`)
2. AI parsing (`ai_parser.mjs`, if enabled)

---

## WebSocket Events

### Connection URL

```text
ws://host:port/api/session-events?token=<SESSION_GATEWAY_TOKEN>
```

When connected, the server polls session status at `SESSION_GATEWAY_NOTIFICATION_POLL_MS` interval (default 5000ms) if there are WebSocket clients.

### Event Format

Events are pushed in JSON format:

```json
{
  "type": "session_task_state_changed",
  "previousTaskState": "in_progress",
  "taskState": "needs_confirmation",
  "changedAt": "2026-06-01T10:00:00.000Z",
  "session": {
    "id": "session-id",
    "name": "codex-app"
  }
}
```

### Event Types

| type | Description |
|------|-------------|
| `session_task_state_changed` | Session task state changed |
| `room_deleted` | Room deleted |

---

## SDK Example

### JavaScript/TypeScript

```typescript
const client = new SessionGatewayClient({
  baseUrl: "http://localhost:8787",
  token: "your-token"
});

// List sessions
const { sessions } = await client.listSessions();

// Create session
const session = await client.createSession({
  kind: "codex",
  name: "my-app",
  cwd: "/workspace/app"
});

// Send input
await client.sendInput(session.id, "npm test");

// Get output
const output = await client.getOutput(session.id, { lines: 100 });

// Natural language command
const result = await client.executeCommand("Send npm test to codex-app");
```

---

## Changelog

### v1.0.0
- Initial release
- Session CRUD operations
- Natural language command parsing
- Configuration management API
- Security hardening (rate limiting, authentication, security headers)

### v1.1.0
- Room management API
- Workflow template management API
- Workflow run instance management API
- WebSocket event streaming
- Input command history API
- Role presets API
- Task state tracking (taskState)
- Added pi-os session type
- Changed default deployment mode to host

</details>

<details>
<summary>中文</summary>

## 概述

### 认证

除 `/health` 端点外，所有 API 请求需要 Bearer Token 认证：

```http
Authorization: Bearer <SESSION_GATEWAY_TOKEN>
```

### 响应格式

- 成功：HTTP 200/201 + JSON body
- 失败：HTTP 4xx/5xx + `{ "error": "错误信息" }`

---

## 端点

### 健康检查

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

### 列出会话

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
      "command": "codex",
      "commandArgs": [],
      "status": "running",
      "taskState": "in_progress",
      "createdAt": "2026-05-24T10:00:00.000Z",
      "updatedAt": "2026-05-24T10:30:00.000Z",
      "stoppedAt": null
    }
  ]
}
```

---

### 创建会话

```http
POST /api/sessions
Content-Type: application/json
```

创建新会话。

**Request Body:**
```json
{
  "kind": "codex | claude | opencode | pi-os | runtime",
  "name": "optional-session-name",
  "cwd": "/optional/working/directory",
  "project": "optional-project-name",
  "deploymentMode": "host | docker",
  "dockerName": "optional-container-name",
  "commandArgs": ["optional", "cli", "args"]
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| kind | string | ✅ | 会话类型：codex, claude, opencode, pi-os, runtime |
| name | string | ❌ | 会话名称，默认 `{kind}-{uuid前8位}` |
| cwd | string | ❌ | 工作目录，默认根据部署模式决定 |
| project | string | ❌ | 项目标识 |
| deploymentMode | string | ❌ | 部署模式：host（默认）或 docker |
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
  "error": "kind must be codex, claude, opencode, pi-os, or runtime"
}
```

---

### 获取会话输出

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

### 发送输入到会话

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

### 发送按键到会话

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

### 重启会话

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

### 停止会话

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

### 删除会话

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

### 自然语言命令

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

### 获取输入历史

```http
GET /api/history?limit=N
```

获取输入命令历史记录。

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| limit | number | 200 | 返回条数上限（1-500） |

**Response 200:**
```json
{
  "history": [
    {
      "id": 1,
      "sessionId": "session-id",
      "sessionName": "codex-app",
      "text": "npm test",
      "createdAt": "2026-06-01T10:00:00.000Z"
    }
  ]
}
```

---

### 获取角色预设

```http
GET /api/role-presets
```

获取角色预设列表。

**Response 200:**
```json
{
  "rolePresets": [
    { "role": "planner", "prompt": "..." },
    { "role": "coder", "prompt": "..." }
  ]
}
```

---

### 列出房间

```http
GET /api/rooms
```

获取所有房间列表。

**Response 200:**
```json
{
  "rooms": [
    {
      "id": "room-id",
      "name": "project-alpha",
      "createdAt": "2026-06-01T10:00:00.000Z"
    }
  ]
}
```

---

### 创建房间

```http
POST /api/rooms
Content-Type: application/json
```

创建新房间。

**Request Body:**
```json
{
  "name": "project-alpha"
}
```

**Response 201:**
```json
{
  "room": {
    "id": "room-id",
    "name": "project-alpha",
    "createdAt": "2026-06-01T10:00:00.000Z"
  }
}
```

---

### 获取房间

```http
GET /api/rooms/:roomId
```

获取房间详情。

**Response 200:**
```json
{
  "room": {
    "id": "room-id",
    "name": "project-alpha",
    "createdAt": "2026-06-01T10:00:00.000Z"
  }
}
```

---

### 删除房间

```http
DELETE /api/rooms/:roomId
```

删除房间。

**Response 200:**
```json
{
  "ok": true,
  "roomId": "room-id"
}
```

---

### 获取房间消息

```http
GET /api/rooms/:roomId/messages?limit=N
```

获取房间消息列表。

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| limit | number | 100 | 返回条数上限（1-500） |

**Response 200:**
```json
{
  "messages": [
    {
      "id": "msg-id",
      "roomId": "room-id",
      "source": "user",
      "senderSessionId": "session-id",
      "senderSessionName": "codex-app",
      "senderRole": "coder",
      "text": "任务完成",
      "parentMessageId": null,
      "createdAt": "2026-06-01T10:00:00.000Z"
    }
  ]
}
```

---

### 列出房间工作流

```http
GET /api/rooms/:roomId/workflows
```

获取房间内的工作流列表。

**Response 200:**
```json
{
  "workflows": [
    {
      "id": "run-id",
      "roomId": "room-id",
      "objective": "发布 1.0 版本",
      "status": "in_progress",
      "templateId": "template-id",
      "templateDefinition": { /* 模板定义 */ },
      "createdAt": "2026-06-01T10:00:00.000Z"
    }
  ]
}
```

---

### 创建房间工作流

```http
POST /api/rooms/:roomId/workflows
Content-Type: application/json
```

在房间内创建工作流。

**Request Body:**
```json
{
  "objective": "发布 1.0 版本",
  "templateId": "template-id"
}
```

**Response 201:**
```json
{
  "workflow": {
    "id": "run-id",
    "roomId": "room-id",
    "objective": "发布 1.0 版本",
    "status": "pending",
    "templateId": "template-id",
    "createdAt": "2026-06-01T10:00:00.000Z"
  }
}
```

---

### 列出工作流模板

```http
GET /api/workflow-templates
```

获取工作流模板列表。

**Response 200:**
```json
{
  "templates": [
    {
      "id": "template-id",
      "name": "Review and publish",
      "description": "Review 后发布",
      "definition": {
        "kind": "linear",
        "stages": []
      },
      "createdAt": "2026-06-01T10:00:00.000Z"
    }
  ]
}
```

---

### 创建工作流模板

```http
POST /api/workflow-templates
Content-Type: application/json
```

创建工作流模板。

**Request Body:**
```json
{
  "name": "Review and publish",
  "description": "Review 后发布",
  "stages": [
    {
      "id": "review",
      "role": "reviewer",
      "prompt": "请审查代码..."
    }
  ]
}
```

**Response 201:**
```json
{
  "template": { /* Template Object */ }
}
```

---

### 更新工作流模板

```http
PUT /api/workflow-templates/:templateId
Content-Type: application/json
```

更新工作流模板。

**Request Body:**
```json
{
  "name": "Updated name",
  "stages": []
}
```

**Response 200:**
```json
{
  "template": { /* Updated Template Object */ }
}
```

---

### 删除工作流模板

```http
DELETE /api/workflow-templates/:templateId
```

删除工作流模板（内置模板不可删除）。

**Response 200:**
```json
{
  "ok": true
}
```

---

### 获取工作流运行实例

```http
GET /api/workflows/:runId
```

获取工作流运行实例详情。

**Response 200:**
```json
{
  "workflow": {
    "id": "run-id",
    "roomId": "room-id",
    "objective": "发布 1.0 版本",
    "status": "in_progress",
    "templateId": "template-id",
    "templateDefinition": {
      "kind": "linear",
      "stages": []
    },
    "assignments": [
      {
        "id": "assignment-id",
        "stageId": "plan",
        "sessionId": "session-id",
        "status": "completed",
        "attempts": 1,
        "resultText": "[DONE] 规划完成"
      }
    ],
    "createdAt": "2026-06-01T10:00:00.000Z"
  }
}
```

---

### 启动工作流

```http
POST /api/workflows/:runId/start
Content-Type: application/json

{}
```

启动工作流（开始执行第一个阶段）。

**Response 200:**
```json
{
  "workflow": { /* Updated Workflow Object */ }
}
```

---

### 推进工作流

```http
POST /api/workflows/:runId/advance
Content-Type: application/json

{}
```

继续推进工作流（重新处理未完成的 assignment 并继续流转）。

**Response 200:**
```json
{
  "workflow": { /* Updated Workflow Object */ }
}
```

---

### 获取配置

```http
GET /api/config
```

获取运行时配置。

**Response 200:**
```json
{
  "settings": {
    "cliDeployment": {
      "codex": { "mode": "host", "dockerName": "worker-codex" },
      "claude": { "mode": "host", "dockerName": "worker-claude" },
      "opencode": { "mode": "host", "dockerName": "worker-opencode" },
      "pi-os": { "mode": "host", "dockerName": "" }
    },
    "commandParser": {
      "enabled": true,
      "mode": "rules-first-ai-fallback",
      "baseUrl": "http://127.0.0.1:8000",
      "model": "local-model",
      "apiKey": "user-api-key",
      "webAiAgentPiUrl": "",
      "webAiAgentPiToken": ""
    },
    "sessionAgent": {
      "model": "",
      "apiKey": "",
      "models": {},
      "resetOnConfigChange": false
    },
    "notifications": {
      "webhookUrl": ""
    }
  },
  "enabled": true
}
```

---

### 更新配置

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

## 数据类型

### Session 对象

```typescript
interface Session {
  id: string;              // UUID
  name: string;            // 会话名称
  kind: "codex" | "claude" | "opencode" | "pi-os" | "runtime";
  cwd: string;             // 工作目录
  project: string | null;  // 项目标识
  tmuxSessionName: string; // tmux 会话名（sg- 前缀）
  command: string;         // 主命令
  commandArgs: string[];   // 命令参数
  status: "running" | "stopped" | "missing";
  taskState: "in_progress" | "completed" | "needs_confirmation" | null;
  createdAt: string;       // ISO 8601
  updatedAt: string;       // ISO 8601
  stoppedAt: string | null; // ISO 8601
}
```

### Settings 对象

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
    mode: "rules-first-ai-fallback" | "rules-only" | "web-ai-agent-pi";
    baseUrl: string;
    model: string;
    apiKey: string;
    webAiAgentPiUrl: string;
    webAiAgentPiToken: string;
  };
  sessionAgent: {
    model: string;
    apiKey: string;
    models: Record<string, Record<string, object>>;
    resetOnConfigChange: boolean;
  };
  notifications: {
    webhookUrl: string;
  };
}
```

---

## 错误处理

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

## 速率限制

- 默认限制：100 请求/分钟/IP
- 超限响应：HTTP 429

---

## 安全头

所有响应包含以下安全头：

```http
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
X-XSS-Protection: 1; mode=block
Referrer-Policy: strict-origin-when-cross-origin
```

---

## 环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| SESSION_GATEWAY_TOKEN | ✅ | API 认证令牌 |
| HOST | ❌ | 监听地址，默认 127.0.0.1 |
| PORT | ❌ | 监听端口，默认 8787 |
| SESSION_GATEWAY_DB | ❌ | SQLite 数据库路径 |
| SESSION_GATEWAY_SETTINGS | ❌ | 设置文件路径 |
| SESSION_GATEWAY_ALLOW_RUNTIME | ❌ | 允许 runtime 模式，默认 false |
| SESSION_GATEWAY_RUNTIME | ❌ | runtime 默认命令，默认 /bin/bash |
| SESSION_GATEWAY_WEBHOOK_URL | ❌ | 任务状态变化 Webhook URL |
| SESSION_GATEWAY_NOTIFICATION_POLL_MS | ❌ | 通知轮询间隔毫秒，默认 5000 |
| SESSION_GATEWAY_SUBMIT_KEY_DELAY_MS | ❌ | 发送文本和提交键之间的延迟毫秒，默认 80 |
| SESSION_GATEWAY_CLI_STARTUP_DELAY_MS | ❌ | CLI 启动等待延迟毫秒，默认 3000 |
| SESSION_GATEWAY_CODEX_SUBMIT_KEY | ❌ | codex 会话提交键，默认 Enter |
| SESSION_GATEWAY_CLAUDE_SUBMIT_KEY | ❌ | claude 会话提交键，默认 Enter |
| SESSION_GATEWAY_OPENCODE_SUBMIT_KEY | ❌ | opencode 会话提交键，默认 Enter |
| SESSION_GATEWAY_PI_OS_SUBMIT_KEY | ❌ | pi-os 会话提交键，默认 Enter |
| SESSION_GATEWAY_RUNTIME_SUBMIT_KEY | ❌ | runtime 会话提交键，默认 Enter |
| SESSION_GATEWAY_CODEX_CMD | ❌ | codex 命令，默认 `docker exec -it worker-codex codex` |
| SESSION_GATEWAY_CLAUDE_CMD | ❌ | claude 命令，默认 `docker exec -it worker-claude claude` |
| SESSION_GATEWAY_OPENCODE_CMD | ❌ | opencode 命令，默认 `docker exec -it worker-opencode opencode` |
| SESSION_GATEWAY_PI_OS_CMD | ❌ | pi-os 命令，默认 `pi-os` |

---

## 插件开发注意事项

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

## WebSocket 事件

### 连接地址

```text
ws://host:port/api/session-events?token=<SESSION_GATEWAY_TOKEN>
```

连接成功后，服务端会在有 WebSocket 客户端连接时按 `SESSION_GATEWAY_NOTIFICATION_POLL_MS` 轮询会话状态（默认 5000 毫秒）。

### 事件格式

事件以 JSON 格式推送：

```json
{
  "type": "session_task_state_changed",
  "previousTaskState": "in_progress",
  "taskState": "needs_confirmation",
  "changedAt": "2026-06-01T10:00:00.000Z",
  "session": {
    "id": "session-id",
    "name": "codex-app"
  }
}
```

### 事件类型

| type | 说明 |
|------|------|
| `session_task_state_changed` | 会话任务状态变化 |
| `room_deleted` | 房间被删除 |

---

## SDK 示例

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

## 更新日志

### v1.0.0
- 初始版本
- 会话 CRUD 操作
- 自然语言命令解析
- 配置管理 API
- 安全加固（速率限制、认证、安全头）

### v1.1.0
- 房间管理 API
- 工作流模板管理 API
- 工作流运行实例管理 API
- WebSocket 事件推送
- 输入命令历史 API
- 角色预设 API
- 任务状态追踪（taskState）
- 新增 pi-os 会话类型
- 默认部署模式改为 host

</details>
