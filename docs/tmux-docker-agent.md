# tmux + Docker Agent 实现方案

## 概述

Session Gateway 通过 tmux 管理运行在 Docker 容器内的 AI CLI agent（codex、claude、opencode）。每个 agent 会话对应一个独立的 tmux session，通过 `docker exec` 命令在指定容器中启动 agent 进程。

## 架构

```
┌─────────────────────────────────────────────────────────────┐
│                    Session Gateway                          │
├─────────────────────────────────────────────────────────────┤
│  Web UI (HTTP)  ←→  REST API  ←→  TmuxBackend  ←→  tmux    │
└─────────────────────────────────────────────────────────────┘
                                              ↓
                                    ┌─────────────────┐
                                    │ Docker Container │
                                    │  (worker-codex)  │
                                    │  ┌─────────────┐ │
                                    │  │  codex CLI  │ │
                                    │  └─────────────┘ │
                                    └─────────────────┘
```

## 部署模式

支持两种部署模式：

| 模式 | 说明 | 工作目录 |
|------|------|----------|
| `docker` | 在 Docker 容器内运行 agent | `/work/{session-name}` |
| `host` | 直接在宿主机运行 agent | `/home/v6/work/{session-name}` |

## 会话创建流程

### 1. 前端请求

```javascript
// public/app.js - createSession()
const body = {
  kind: "codex",                    // agent 类型
  name: "my-session",               // 会话名称（可选）
  cwd: "/workspace/project",        // 工作目录（可选）
  deploymentMode: "docker",         // 部署模式
  dockerName: "worker-codex"        // Docker 容器名
};
await api("/api/sessions", { method: "POST", body: JSON.stringify(body) });
```

### 2. 命令解析

`TmuxBackend.resolveCreateCommand()` 根据部署模式构建启动命令：

```javascript
// src/tmux.mjs
resolveCreateCommand(input) {
  // runtime 类型：直接运行 shell
  if (input.kind === "runtime") {
    return { command: "/bin/bash", args: [], cwdMode: "host" };
  }

  const deployment = input.deployment;

  // host 模式：直接运行 CLI
  if (deployment?.mode === "host") {
    return {
      command: input.kind,  // "codex" | "claude" | "opencode"
      args: [],
      cwdMode: "host"
    };
  }

  // docker 模式：通过 docker exec 运行
  const dockerName = deployment?.dockerName ?? "worker-codex";
  return {
    command: "docker",
    args: ["exec", "-it", "-w", input.cwd, dockerName, input.kind],
    cwdMode: "container"
  };
}
```

### 3. 目录准备

```javascript
// src/tmux.mjs
async validateCreateInput(input, commandSpec) {
  if (commandSpec.cwdMode === "host") {
    // 宿主机模式：直接创建目录
    await ensureDirectoryExists(input.cwd);
  }
  if (commandSpec.cwdMode === "container") {
    // 容器模式：通过 docker exec 创建目录
    await run("docker", ["exec", container, "mkdir", "-p", cwd]);
  }
}
```

### 4. tmux 会话创建

```javascript
// src/tmux.mjs
async create(record) {
  // 1. 构建完整命令
  const shellCommand = [record.command, ...record.commandArgs].join(" ");
  // 例如: "docker exec -it -w /work/my-session worker-codex codex"

  // 2. 创建 tmux session（后台运行）
  await run("tmux", ["new-session", "-d", "-s", "sg-my-session"]);

  // 3. 发送启动命令
  await run("tmux", ["send-keys", "-t", "sg-my-session", "-l", "--", shellCommand]);
  await run("tmux", ["send-keys", "-t", "sg-my-session", "Enter"]);
}
```

## 工作目录处理

### withDockerWorkdir 函数

自动将工作目录注入到 `docker exec` 命令中：

```javascript
// src/tmux.mjs
function withDockerWorkdir(args, cwd) {
  if (args[0] !== "exec") return args;
  // ["exec", "-it", "worker-codex", "codex"]
  // → ["exec", "-w", "/work/my-session", "-it", "worker-codex", "codex"]
  return ["exec", "-w", cwd, ...args.slice(1)];
}
```

### 默认工作目录

```javascript
// src/server.mjs
function defaultCwdForSession(name, cwdMode) {
  const folder = sanitizeTmuxName(name);
  const baseDir = cwdMode === "container" ? "/work" : "/home/v6/work";
  return path.posix.join(baseDir, folder);
}
```

## 输入输出交互

### 发送输入

```javascript
// src/tmux.mjs
async send(record, text) {
  // 1. 发送文本（-l 保持特殊字符）
  await run("tmux", ["send-keys", "-t", target, "-l", "--", text]);

  // 2. 延迟后发送回车
  await sleep(80);  // submitKeyDelayMs
  await run("tmux", ["send-keys", "-t", target, "Enter"]);
}
```

### 捕获输出

```javascript
// src/tmux.mjs
async capture(record, lines = 100) {
  const output = await run("tmux", [
    "capture-pane", "-p", "-t", target,
    "-S", `-${lines}`  // 从底部向上追溯 N 行
  ]);
  return output;
}
```

## 配置

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `SESSION_GATEWAY_CODEX_CMD` | `docker exec -it worker-codex codex` | codex 启动命令 |
| `SESSION_GATEWAY_CLAUDE_CMD` | `docker exec -it worker-claude claude` | claude 启动命令 |
| `SESSION_GATEWAY_OPENCODE_CMD` | `docker exec -it worker-opencode opencode` | opencode 启动命令 |
| `SESSION_GATEWAY_SUBMIT_KEY_DELAY_MS` | `80` | 发送回车前的延迟 |

### 运行时配置文件

`data/session-gateway-settings.json`:

```json
{
  "cliDeployment": {
    "codex": {
      "mode": "docker",
      "dockerName": "worker-codex"
    },
    "claude": {
      "mode": "host",
      "dockerName": "worker-claude"
    }
  }
}
```

## 会话名称处理

tmux session 名称需要符合命名规范（仅字母、数字、下划线、连字符、点）：

```javascript
// src/utils.mjs
function sanitizeTmuxName(name) {
  return name.replace(/[^a-zA-Z0-9_\-.]/g, "_").slice(0, 80);
}

// Session Gateway 自动添加 "sg-" 前缀
// 用户输入: "my-codex-session"
// tmux 名: "sg-my-codex-session"
```

## 完整命令示例

创建一个名为 "feature-auth" 的 codex 会话：

```bash
# 1. 创建目录（如果不存在）
docker exec worker-codex mkdir -p /work/feature-auth

# 2. 创建 tmux session
tmux new-session -d -s sg-feature-auth

# 3. 发送启动命令
tmux send-keys -t sg-feature-auth:0 -l -- "docker exec -it -w /work/feature-auth worker-codex codex"
tmux send-keys -t sg-feature-auth:0 Enter

# 4. 捕获输出
tmux capture-pane -p -t sg-feature-auth:0 -S -100

# 5. 发送输入
tmux send-keys -t sg-feature-auth:0 -l -- "查看当前文件结构"
tmux send-keys -t sg-feature-auth:0 Enter
```

## 注意事项

1. **容器必须运行**：Docker 容器需要事先启动并保持运行状态
2. **工作目录挂载**：`/work` 目录需要挂载到宿主机，以便持久化数据
3. **终端尺寸**：创建会话后会自动调整 tmux 窗口大小以匹配 Web 终端
4. **进程生命周期**：停止会话时只会 kill tmux session，不会影响容器本身
