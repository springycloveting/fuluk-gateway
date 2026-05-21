import assert from "node:assert/strict";
import test from "node:test";
import { TmuxBackend } from "../src/tmux.mjs";

test("TmuxBackend maps AI CLIs to docker exec commands", () => {
  const tmux = new TmuxBackend({
    defaultRuntimeCommand: "/bin/bash",
    runtimeSettingsEnabled: true,
    runtimeSettings: {
      cliDeployment: {
        codex: { mode: "docker", dockerName: "worker-codex" },
        claude: { mode: "docker", dockerName: "worker-claude" },
        opencode: { mode: "docker", dockerName: "worker-opencode" }
      }
    },
    cliCommands: {
      codex: ["docker", "exec", "-it", "worker-codex", "codex"],
      claude: ["docker", "exec", "-it", "worker-claude", "claude"],
      opencode: ["docker", "exec", "-it", "worker-opencode", "opencode"]
    }
  });

  assert.deepEqual(tmux.resolveCreateCommand({ kind: "codex", cwd: "/workspace/app" }), {
    command: "docker",
    args: ["exec", "-w", "/workspace/app", "-it", "worker-codex", "codex"],
    cwdMode: "container"
  });
  assert.deepEqual(tmux.resolveCreateCommand({ kind: "claude", cwd: "/workspace/app" }), {
    command: "docker",
    args: ["exec", "-w", "/workspace/app", "-it", "worker-claude", "claude"],
    cwdMode: "container"
  });
  assert.deepEqual(tmux.resolveCreateCommand({ kind: "opencode", cwd: "/workspace/test" }), {
    command: "docker",
    args: ["exec", "-w", "/workspace/test", "-it", "worker-opencode", "opencode"],
    cwdMode: "container"
  });
  assert.deepEqual(tmux.resolveCreateCommand({ kind: "runtime", cwd: "/tmp" }), {
    command: "/bin/bash",
    args: [],
    cwdMode: "host"
  });
});

test("TmuxBackend maps AI CLIs to host commands", () => {
  const tmux = new TmuxBackend({
    defaultRuntimeCommand: "/bin/bash",
    runtimeSettingsEnabled: true,
    runtimeSettings: {
      cliDeployment: {
        codex: { mode: "host", dockerName: "worker-codex" },
        claude: { mode: "host", dockerName: "worker-claude" },
        opencode: { mode: "host", dockerName: "worker-opencode" }
      }
    },
    cliCommands: {
      codex: ["docker", "exec", "-it", "worker-codex", "codex"],
      claude: ["docker", "exec", "-it", "worker-claude", "claude"],
      opencode: ["docker", "exec", "-it", "worker-opencode", "opencode"]
    }
  });

  assert.deepEqual(tmux.resolveCreateCommand({ kind: "codex", cwd: "/workspace/app" }), {
    command: "codex",
    args: [],
    cwdMode: "host"
  });
  assert.deepEqual(tmux.resolveCreateCommand({ kind: "claude", cwd: "/workspace/app" }), {
    command: "claude",
    args: [],
    cwdMode: "host"
  });
  assert.deepEqual(tmux.resolveCreateCommand({ kind: "opencode", cwd: "/workspace/test" }), {
    command: "opencode",
    args: [],
    cwdMode: "host"
  });
});

test("TmuxBackend uses configured docker container names", () => {
  const tmux = new TmuxBackend({
    defaultRuntimeCommand: "/bin/bash",
    runtimeSettingsEnabled: true,
    runtimeSettings: {
      cliDeployment: {
        codex: { mode: "docker", dockerName: "codex-prod" },
        claude: { mode: "docker", dockerName: "claude-prod" },
        opencode: { mode: "docker", dockerName: "opencode-prod" }
      }
    },
    cliCommands: {
      codex: ["docker", "exec", "-it", "worker-codex", "codex"],
      claude: ["docker", "exec", "-it", "worker-claude", "claude"],
      opencode: ["docker", "exec", "-it", "worker-opencode", "opencode"]
    }
  });

  assert.deepEqual(tmux.resolveCreateCommand({ kind: "codex", cwd: "/workspace/app" }), {
    command: "docker",
    args: ["exec", "-w", "/workspace/app", "-it", "codex-prod", "codex"],
    cwdMode: "container"
  });
});
