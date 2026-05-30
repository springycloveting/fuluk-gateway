# AI CLI Session Manager 使用说明

## 简介

AI CLI Session Manager 是一个通过 Web 界面和 REST API 管理 AI CLI 会话的工具。它使用 `tmux` 作为后端，支持管理 `codex`、`claude`、`opencode` 和本地 shell 会话。

## 启动服务

```bash
npm ci

# 开发/临时运行
SESSION_GATEWAY_TOKEN=your-secret-token npm run dev
```

服务将在 `http://127.0.0.1:8787` 启动。

生产环境不建议只靠交互式 `npm start` 长期运行。推荐使用仓库里的 systemd 模板：

```bash
sudo SERVICE_USER="$(id -un)" SERVICE_GROUP="$(id -gn)" ./deploy/install-systemd.sh
sudo editor /etc/session-gateway/session-gateway.env
sudo systemctl start session-gateway
sudo systemctl status session-gateway
```

默认生产路径：

- 应用目录：`/opt/session-gateway`
- 环境文件：`/etc/session-gateway/session-gateway.env`
- 数据目录：`/var/lib/session-gateway`

## 环境变量配置

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `HOST` | 服务器地址 | `127.0.0.1` |
| `PORT` | 服务器端口 | `8787` |
| `SESSION_GATEWAY_TOKEN` | API 认证令牌 | `dev-token` |
| `SESSION_GATEWAY_DB` | SQLite 数据库路径 | `data/session-gateway.sqlite` |
| `SESSION_GATEWAY_SETTINGS` | Web 配置保存路径 | `data/session-gateway-settings.json` |
| `SESSION_GATEWAY_RUNTIME` | runtime 类型默认命令 | `/bin/bash` |
| `SESSION_GATEWAY_CODEX_SUBMIT_KEY` | codex 会话发送后的提交键 | `Enter` |
| `SESSION_GATEWAY_CLAUDE_SUBMIT_KEY` | claude 会话发送后的提交键 | `Enter` |
| `SESSION_GATEWAY_OPENCODE_SUBMIT_KEY` | opencode 会话发送后的提交键 | `Enter` |
| `SESSION_GATEWAY_RUNTIME_SUBMIT_KEY` | runtime 会话发送后的提交键 | `Enter` |
| `SESSION_GATEWAY_SUBMIT_KEY_DELAY_MS` | 发送文本和提交键之间的延迟毫秒数 | `80` |

## 高级命令解析模式

Session Gateway 支持三种命令解析模式：

### 1. rules-only（默认）

纯规则解析，使用正则表达式匹配用户输入。速度快但不支持复杂语句。

### 2. rules-first-ai-fallback

先尝试规则解析，失败时调用本地 AI 模型解析。

配置示例（`data/session-gateway-settings.json`）：

```json
{
  "commandParser": {
    "mode": "rules-first-ai-fallback",
    "baseUrl": "http://127.0.0.1:11434/v1",
    "model": "qwen",
    "apiKey": "dummy"
  }
}
```

### 3. web-ai-agent-pi（高级模式）

使用 web-ai-agent-pi 服务进行命令解析，支持更自然的语言理解。

首先启动 web-ai-agent-pi 服务：

```bash
web-ai-agent-pi-server
```

然后配置 Session Gateway（`data/session-gateway-settings.json`）：

```json
{
  "commandParser": {
    "mode": "web-ai-agent-pi",
    "webAiAgentPiUrl": "http://127.0.0.1:8786",
    "webAiAgentPiToken": "your-token"
  }
}
```

环境变量：
- `WEB_AI_AGENT_PI_PORT` - web-ai-agent-pi 服务端口（默认 8786）
- `WEB_AI_AGENT_PI_TOKEN` - 认证 token

## 会话状态通知

Session Gateway 会在会话任务状态发生指定变化时发送通知：

- `in_progress` -> `completed`（界面显示“已停止”）
- `in_progress` -> `needs_confirmation`（界面显示“需要确认”）

事件 JSON：

```json
{
  "type": "session_task_state_changed",
  "previousTaskState": "in_progress",
  "taskState": "needs_confirmation",
  "changedAt": "2026-05-28T00:00:00.000Z",
  "session": { "id": "...", "name": "test2" }
}
```

### WebSocket

连接地址：

```text
ws://127.0.0.1:8787/api/session-events?token=SESSION_GATEWAY_TOKEN
```

服务端会在有 WebSocket 客户端连接时按 `SESSION_GATEWAY_NOTIFICATION_POLL_MS` 轮询会话状态，默认 `5000` 毫秒。

### Webhook

环境变量：

```bash
SESSION_GATEWAY_WEBHOOK_URL=https://example.com/session-webhook
```

也可以写入 `data/session-gateway-settings.json`：

```json
{
  "notifications": {
    "webhookUrl": "https://example.com/session-webhook"
  }
}
```

有 Webhook 配置时，服务端会自动轮询并向该 URL `POST` 事件 JSON。

## Web 界面使用

### 1. 访问界面

打开浏览器访问 `http://127.0.0.1:8787`

### 2. 配置认证令牌

点击顶部 `配置` / `Config`，在配置窗口里输入启动时设置的 `SESSION_GATEWAY_TOKEN`（开发默认是 `dev-token`，生产环境必须改成强随机值）。

### 3. 创建会话

点击顶部 `新建` / `Create`，在弹窗中选择：
- **类型**: codex / claude / opencode / runtime
- **名称**: 会话名称（可选，不填则自动生成）
- **目录**: 工作目录路径（必填）
- **项目**: 项目标识（可选）

点击 `新建` / `Create` 按钮创建会话。

### 4. 查看会话列表

点击顶部 `会话` / `Sessions` 打开会话抽屉。会话列表包含：
- 会话名称
- 类型（codex/claude/opencode/runtime）
- 状态（running/stopped/missing）
- 工作目录

点击 `刷新` / `Refresh` 刷新列表。

### 5. 与会话交互

点击左侧会话项选中后：
- **输出区域**: 显示终端输出内容
- **输入框**: 输入文本后点击 `发送` / `Send` 或按回车发送
- **重启 / Restart**: 重启会话
- **停止 / Stop**: 停止会话

### 6. 自然语言命令

点击顶部 `命令` / `Command`，在命令窗口中输入快捷命令。命令结果会显示在命令窗口内；只有查看输出/切换会话这类操作会同步更新主终端。

**同音字智能识别**

系统支持中文同音字自动映射，即使用户输入错误的同音字也能正确理解意图：

| 输入示例 | 识别为 | 说明 |
|----------|--------|------|
| `绘画列表` | `会话列表` | 自动纠正 |
| `绘话列表` | `会话列表` | 自动纠正 |
| `新建一个绘画` | `新建一个会话` | 自动纠正 |
| `列出所有绘话` | `列出所有会话` | 自动纠正 |

当前支持的同音字映射：
- `绘画` / `绘话` / `回话` / `汇话` / `会画` → `会话`
- `烈表` → `列表`
- `烈出` → `列出`
- `插询` / `差询` → `查询`
- `茶看` / `插看` → `查看`
- `云行` / `允行` → `运行`
- `床建` / `创贱` → `创建`
- `心建` / `新见` → `新建`
- `庭止` / `亭止` → `停止`
- `虫启` / `冲启` → `重启`
- `法送` / `发诵` → `发送`
- `经入` / `近入` → `进入`
- `且换` / `窃换` → `切换`

**命令示例**

| 命令示例 | 说明 |
|----------|------|
| `新建一个 codex 会话，目录 /workspace/app。` | 创建新会话 |
| `把这句话发给 claude-main：查看。` | 向指定会话发送文本 |
| `codex-1 最近输出。` | 获取会话输出 |
| `列出所有运行中的会话。` | 列出运行中的会话 |
| `停止 opencode-test。` | 停止会话 |
| `重启 session-name。` | 重启会话 |
| `进入 session-name。` | 切换到指定会话 |
| `建一个opencode会话，用/workspace/OPCAid文件夹，会话名称用opencode+文件夹名称` | 创建 opencode 会话，名称规范化为 `opencode-OPCAid` |

### 7. 配置界面

点击顶部 `配置` / `Config` 可以配置：

- 界面语言：中文 / English
- 明亮/黑暗主题
- Bearer token：保存在浏览器本地，用于请求 API
- Codex / OpenCode / Claude Code 部署方式：Docker / 非 Docker
- Docker 模式下的容器名称
- 命令解析：可选接入本地 OpenAI-compatible 模型。模型只返回固定 JSON 动作，后端只执行白名单功能。

部署配置会保存到 `SESSION_GATEWAY_SETTINGS` 指向的 JSON 文件，默认是 `data/session-gateway-settings.json`。保存后仅影响新建会话；已有会话继续使用创建时的命令。

非 Docker 模式会在宿主机工作目录下直接运行对应命令：`codex`、`opencode`、`claude`。

## REST API 使用

所有 API（除 `/health` 外）需要在请求头中携带认证令牌：

```
Authorization: Bearer your-secret-token
```

### 健康检查

```bash
curl http://127.0.0.1:8787/health
```

响应：
```json
{"ok": true, "tmux": true}
```

### 列出所有会话

```bash
curl -H "Authorization: Bearer dev-token" \
  http://127.0.0.1:8787/api/sessions
```

### 创建会话

```bash
curl -X POST \
  -H "Authorization: Bearer dev-token" \
  -H "Content-Type: application/json" \
  -d '{"kind": "runtime", "cwd": "/tmp", "name": "my-shell"}' \
  http://127.0.0.1:8787/api/sessions
```

### 获取会话输出

```bash
curl -H "Authorization: Bearer dev-token" \
  "http://127.0.0.1:8787/api/sessions/my-shell/output?lines=100"
```

### 发送输入

```bash
curl -X POST \
  -H "Authorization: Bearer dev-token" \
  -H "Content-Type: application/json" \
  -d '{"text": "ls -la"}' \
  http://127.0.0.1:8787/api/sessions/my-shell/input
```

### 重启会话

```bash
curl -X POST \
  -H "Authorization: Bearer dev-token" \
  http://127.0.0.1:8787/api/sessions/my-shell/restart
```

### 停止会话

```bash
curl -X DELETE \
  -H "Authorization: Bearer dev-token" \
  http://127.0.0.1:8787/api/sessions/my-shell
```

### 自然语言命令

```bash
curl -X POST \
  -H "Authorization: Bearer dev-token" \
  -H "Content-Type: application/json" \
  -d '{"text": "列出所有运行中的会话。"}' \
  http://127.0.0.1:8787/api/nl
```

## 会话类型说明

| 类型 | 命令 | 说明 |
|------|------|------|
| `codex` | `codex` | OpenAI Codex CLI |
| `claude` | `claude` | Anthropic Claude CLI |
| `opencode` | `opencode` | OpenCode CLI |
| `runtime` | `/bin/bash` | 本地 shell 会话 |

## 注意事项

1. **tmux 依赖**: 系统必须安装 tmux
2. **CLI 验证**: 创建 codex/claude/opencode 会话时，会检查对应命令是否存在
3. **Node.js 版本**: 需要 Node.js 22+（`node:sqlite` 是实验性功能）
4. **实时输出**: 输出内容直接从 tmux 捕获，不存储为持久数据
5. **会话状态**: 列出会话时会自动刷新状态（running/stopped/missing）

## 故障排查

### tmux 未安装

```bash
sudo apt install tmux
```

### Node.js 版本不对

```bash
source ~/.nvm/nvm.sh
nvm use 22
```

### 端口被占用

修改端口：
```bash
PORT=9000 SESSION_GATEWAY_TOKEN=dev-token npm run dev
```

### 认证失败

确保请求头中的令牌与启动时设置的 `SESSION_GATEWAY_TOKEN` 一致。

### Web Send 后只换行不执行

Gateway 会先发送字面文本，再单独发送提交键。默认提交键是 `Enter`。

如果某个 Codex CLI / tmux / 终端组合仍把 `Enter` 当作换行，可以尝试指定 Codex 提交键：

```bash
SESSION_GATEWAY_CODEX_SUBMIT_KEY=C-m SESSION_GATEWAY_TOKEN=dev-token npm run dev
```

`SESSION_GATEWAY_CODEX_SUBMIT_KEY` 的值会原样传给 `tmux send-keys`，例如 `Enter`、`C-m`、`C-j`。
