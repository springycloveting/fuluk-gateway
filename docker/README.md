# Worker Docker Images

These images are intended to stay running while Session Gateway controls AI CLI sessions through host `tmux`.

Gateway command flow:

```text
gateway -> host tmux -> docker exec -it <worker> <cli>
```

## Build

```bash
docker build -t worker-codex-image docker/worker-codex
docker build -t worker-claude-image docker/worker-claude
docker build -t worker-opencode-image docker/worker-opencode
```

## Run

Container names must match the gateway defaults:

```bash
docker run -d --name worker-codex -v /workspace:/workspace worker-codex-image
docker run -d --name worker-claude -v /workspace:/workspace worker-claude-image
docker run -d --name worker-opencode -v /workspace:/workspace worker-opencode-image
```

## Gateway Defaults

```bash
docker exec -it worker-codex codex
docker exec -it worker-claude claude
docker exec -it worker-opencode opencode
```

Override these with:

```bash
SESSION_GATEWAY_CODEX_CMD="docker exec -it worker-codex codex"
SESSION_GATEWAY_CLAUDE_CMD="docker exec -it worker-claude claude"
SESSION_GATEWAY_OPENCODE_CMD="docker exec -it worker-opencode opencode"
```
