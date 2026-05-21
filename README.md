# Session Gateway

Session Gateway is a Web and REST interface for long-running AI CLI sessions. It uses host `tmux` to manage `codex`, `claude`, `opencode`, and local shell sessions.

The recommended production deployment is a host-level `systemd` service. The gateway intentionally runs on the host so it can control host `tmux` and optionally run AI CLIs through `docker exec`.

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
sudo git clone https://github.com/YOUR_ORG/YOUR_REPO /opt/session-gateway
cd /opt/session-gateway
```

2. Install the service template:

```bash
sudo SERVICE_USER="$(id -un)" SERVICE_GROUP="$(id -gn)" ./deploy/install-systemd.sh
```

3. Edit the environment file and set a real token:

```bash
sudo editor /etc/session-gateway/session-gateway.env
```

At minimum, change:

```bash
SESSION_GATEWAY_TOKEN=change-me
```

4. Start and verify:

```bash
sudo systemctl start session-gateway
sudo systemctl status session-gateway
curl http://127.0.0.1:8787/health
```

5. View logs:

```bash
journalctl -u session-gateway -f
```

## Production Paths

The provided templates use:

- Application: `/opt/session-gateway`
- Environment: `/etc/session-gateway/session-gateway.env`
- Data: `/var/lib/session-gateway`
- Database: `/var/lib/session-gateway/session-gateway.sqlite`
- Web settings: `/var/lib/session-gateway/session-gateway-settings.json`

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

## Useful Commands

```bash
npm run check
npm test
sudo systemctl restart session-gateway
sudo journalctl -u session-gateway -f
```

Detailed Web and REST usage is in [USAGE.md](USAGE.md).
