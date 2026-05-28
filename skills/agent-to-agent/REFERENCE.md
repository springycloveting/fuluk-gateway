# Session Gateway API Reference

本文档详细描述 Session Gateway 的 API 接口，供 agent-to-agent 通信使用。

## 认证

所有 API 请求（除 `/health` 外）需要 Bearer Token 认证：

```
Authorization: Bearer $SESSION_GATEWAY_TOKEN
```

## 会话模型

```typescript
interface Session {
  id: string;           // UUID
  name: string;         // 会话名称
  kind: 'codex' | 'claude' | 'opencode' | 'pi-os' | 'runtime';
  cwd: string;          // 工作目录
  project: string | null;
  status: 'running' | 'stopped' | 'missing';
  taskState: 'in_progress' | 'completed' | 'needs_confirmation';
  command: string;      // 启动命令
  commandArgs: string[];
  createdAt: string;    // ISO 时间戳
  updatedAt: string;
}
```

## API 端点

### GET /health

健康检查，无需认证。

**响应：**
```json
{ "ok": true, "tmux": true }
```

### GET /api/sessions

列出所有会话。

**响应：**
```json
{
  "sessions": [
    {
      "id": "abc123...",
      "name": "codex-main",
      "kind": "codex",
      "status": "running",
      "taskState": "in_progress",
      ...
    }
  ]
}
```

### POST /api/sessions

创建新会话。

**请求体：**
```json
{
  "kind": "codex",
  "name": "my-session",        // 可选，默认自动生成
  "cwd": "/workspace/app",     // 可选
  "project": "my-project",     // 可选
  "deploymentMode": "docker",  // 可选: docker | host
  "commandArgs": []            // 可选
}
```

**响应：**
```json
{
  "session": { ... }
}
```

### GET /api/sessions/:id/output

获取会话输出。

**查询参数：**
- `lines` - 输出行数，默认 50

**响应：** 纯文本输出

### POST /api/sessions/:id/input

向会话发送输入。**这是 agent-to-agent 通信的核心接口。**

**请求体：**
```json
{
  "text": "消息内容"
}
```

**响应：**
```json
{ "ok": true }
```

### POST /api/sessions/:id/restart

重启会话。

**响应：**
```json
{
  "session": { ... }
}
```

### DELETE /api/sessions/:id

停止会话（不删除）。

**响应：**
```json
{ "ok": true }
```

### DELETE /api/sessions/:id/delete

删除会话。

**响应：**
```json
{ "ok": true }
```

### GET /api/sessions/:id/history

获取会话输入历史。

**查询参数：**
- `limit` - 最大条目数，默认 100

**响应：**
```json
{
  "history": [
    {
      "id": 1,
      "sessionId": "abc123",
      "text": "npm test",
      "createdAt": "2024-01-01T00:00:00.000Z"
    }
  ]
}
```

### POST /api/nl

自然语言命令接口。

**请求体：**
```json
{
  "text": "发送 测试完成 给 claude-worker",
  "currentSessionId": "abc123"  // 可选，当前会话ID
}
```

**响应：**
```json
{
  "command": {
    "type": "send",
    "target": "claude-worker",
    "text": "测试完成"
  },
  "ok": true,
  "session": { ... },
  "output": "..."
}
```

## WebSocket 事件

连接 `/api/session-events` 可接收实时事件：

```javascript
const ws = new WebSocket('ws://host:port/api/session-events?token=TOKEN');
ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  // data.type: 'session_task_state_changed'
  // data.session: 会话对象
  // data.taskState: 新状态
  // data.previousTaskState: 之前状态
};
```

## 错误响应

错误时返回：

```json
{
  "error": "错误描述"
}
```

常见错误码：
- `400` - 请求参数错误
- `401` - 未授权
- `404` - 会话不存在
- `429` - 请求过于频繁
- `500` - 服务器错误
