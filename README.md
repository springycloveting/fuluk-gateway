# Fuluk Gateway

<details open>
<summary>English</summary>

Fuluk Gateway is a Web and REST interface for long-running AI CLI sessions. It uses host `tmux` to manage `codex`, `claude`, `opencode`, and local shell sessions.

The recommended production deployment is a host-level `systemd` service. The gateway intentionally runs on the host so it can control host `tmux` and optionally run AI CLIs through `docker exec`.

## Features

- Web UI for session management
- REST API for programmatic control
- Natural language command interface with AI assistant (web-pi)
- Support for codex, claude, opencode, and runtime sessions
- Docker worker mode for AI CLI isolation
- SQLite-based session persistence

## Requirements

- Linux host with `tmux`
- Node.js 22+
- npm
- Optional: Docker, when using Docker worker mode for AI CLIs
- Optional: `codex`, `claude`, or `opencode` on the host when using non-Docker mode

## Quick Development Run

```bash
npm ci
SESSION_GATEWAY_TOKEN=dev-token npm run dev
```

Open `http://127.0.0.1:8787`, then set the same Bearer token in the Config dialog.

## Production Deployment With systemd

1. Clone the repository:

```bash
sudo git clone https://github.com/springycloveting/fuluk-gateway /opt/fuluk-gateway
cd /opt/fuluk-gateway
```

2. Install the service template:

```bash
sudo SERVICE_USER="$(id -un)" SERVICE_GROUP="$(id -gn)" ./deploy/install-systemd.sh
```

3. Edit the environment file and set a real token:

```bash
sudo editor /etc/fuluk-gateway/fuluk-gateway.env
```

At minimum, change:

```bash
SESSION_GATEWAY_TOKEN=change-me
```

4. Start and verify:

```bash
sudo systemctl start fuluk-gateway
sudo systemctl status fuluk-gateway
curl http://127.0.0.1:8787/health
```

5. View logs:

```bash
journalctl -u fuluk-gateway -f
```

## Production Paths

The provided templates use:

- Application: `/opt/fuluk-gateway`
- Environment: `/etc/fuluk-gateway/fuluk-gateway.env`
- Data: `/var/lib/fuluk-gateway`
- Database: `/var/lib/fuluk-gateway/fuluk-gateway.sqlite`
- Web settings: `/var/lib/fuluk-gateway/fuluk-gateway-settings.json`

## Configuration

See [.env.example](.env.example) for all environment variables.

The Web Config dialog can also set:

- UI language and theme
- Browser-side Bearer token
- Codex/OpenCode/Claude deployment mode: Docker or host
- Docker container names
- Optional local OpenAI-compatible model for command parsing fallback

Saved Web settings affect newly created sessions. Existing sessions keep the command they were created with.

## Worker Docker Mode

Docker worker mode keeps the gateway on the host and runs AI CLIs inside named worker containers:

```text
gateway -> host tmux -> docker exec -it <worker> <cli>
```

See [docker/README.md](docker/README.md) for worker image build and run commands.

If the systemd service user uses Docker worker mode, add that user to the `docker` group or otherwise grant Docker access.

## Web-pi AI Assistant

The gateway includes an AI assistant (web-pi) that processes natural language commands through the `/api/nl` endpoint. Configure the sessionAgent in runtime settings:

```json
{
  "sessionAgent": {
    "model": "JD:Kimi-K2.5",
    "models": {
      "JD": {
        "Kimi-K2.5": {
          "api": "openai",
          "baseUrl": "https://api.moonshot.cn/v1",
          "apiKey": "your-api-key"
        }
      }
    }
  }
}
```

The assistant is optimized for fast responses with thinking disabled and concise prompts.

## Useful Commands

```bash
npm run check
npm test
sudo systemctl restart fuluk-gateway
sudo journalctl -u fuluk-gateway -f
```

Detailed Web and REST usage is in [USAGE.md](USAGE.md).

</details>

<details>
<summary>中文</summary>

Fuluk Gateway 是一个面向长时间运行 AI CLI 会话的 Web 和 REST 接口。它使用宿主机上的 `tmux` 来管理 `codex`、`claude`、`opencode` 以及本地 shell 会话。

推荐的生产部署方式是在宿主机级别运行 `systemd` 服务。网关会有意运行在宿主机上，这样它可以控制宿主机的 `tmux`，并且可以选择通过 `docker exec` 运行 AI CLI。

## 功能特性

- 会话管理 Web 界面
- 可编程控制的 REST API
- 自然语言命令接口与 AI 助手 (web-pi)
- 支持 codex、claude、opencode 和 runtime 会话
- Docker worker 模式实现 AI CLI 隔离
- 基于 SQLite 的会话持久化

## 环境要求

- 安装了 `tmux` 的 Linux 宿主机
- Node.js 22+
- npm
- 可选：Docker，用于 AI CLI 的 Docker worker 模式
- 可选：当使用非 Docker 模式时，宿主机上需要安装 `codex`、`claude` 或 `opencode`

## 快速开发运行

```bash
npm ci
SESSION_GATEWAY_TOKEN=dev-token npm run dev
```

打开 `http://127.0.0.1:8787`，然后在 Config 对话框中设置相同的 Bearer token。

## 使用 systemd 进行生产部署

1. 克隆仓库：

```bash
sudo git clone https://github.com/springycloveting/fuluk-gateway /opt/fuluk-gateway
cd /opt/fuluk-gateway
```

2. 安装服务模板：

```bash
sudo SERVICE_USER="$(id -un)" SERVICE_GROUP="$(id -gn)" ./deploy/install-systemd.sh
```

3. 编辑环境文件并设置真实 token：

```bash
sudo editor /etc/fuluk-gateway/fuluk-gateway.env
```

至少需要修改：

```bash
SESSION_GATEWAY_TOKEN=change-me
```

4. 启动并验证服务：

```bash
sudo systemctl start fuluk-gateway
sudo systemctl status fuluk-gateway
curl http://127.0.0.1:8787/health
```

5. 查看日志：

```bash
journalctl -u fuluk-gateway -f
```

## 生产路径

提供的模板使用以下路径：

- 应用程序：`/opt/fuluk-gateway`
- 环境文件：`/etc/fuluk-gateway/fuluk-gateway.env`
- 数据目录：`/var/lib/fuluk-gateway`
- 数据库：`/var/lib/fuluk-gateway/fuluk-gateway.sqlite`
- Web 设置：`/var/lib/fuluk-gateway/fuluk-gateway-settings.json`

## 配置

所有环境变量请参考 [.env.example](.env.example)。

Web Config 对话框也可以设置：

- UI 语言和主题
- 浏览器侧 Bearer token
- Codex/OpenCode/Claude 部署模式：Docker 或宿主机
- Docker 容器名称
- 可选的本地 OpenAI 兼容模型，用作命令解析回退

保存的 Web 设置会影响新创建的会话。已有会话会保留创建时使用的命令。

## Worker Docker 模式

Docker worker 模式会让网关保留在宿主机上运行，并在具名 worker 容器内运行 AI CLI：

```text
gateway -> host tmux -> docker exec -it <worker> <cli>
```

worker 镜像构建和运行命令请参考 [docker/README.md](docker/README.md)。

如果 `systemd` 服务用户使用 Docker worker 模式，请将该用户加入 `docker` 组，或通过其他方式授予 Docker 访问权限。

## Web-pi AI 助手

网关内置 AI 助手 (web-pi)，通过 `/api/nl` 端点处理自然语言命令。在运行时设置中配置 sessionAgent：

```json
{
  "sessionAgent": {
    "model": "JD:Kimi-K2.5",
    "models": {
      "JD": {
        "Kimi-K2.5": {
          "api": "openai",
          "baseUrl": "https://api.moonshot.cn/v1",
          "apiKey": "your-api-key"
        }
      }
    }
  }
}
```

助手已针对快速响应优化，禁用思考模式并使用精简提示词。

## 常用命令

```bash
npm run check
npm test
sudo systemctl restart fuluk-gateway
sudo journalctl -u fuluk-gateway -f
```

详细的 Web 和 REST 用法见 [USAGE.md](USAGE.md)。

</details>
