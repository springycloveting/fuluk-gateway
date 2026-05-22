import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { exactTmuxPaneTarget, exactTmuxSessionTarget, TmuxBackend } from "../src/tmux.mjs";

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

test("TmuxBackend uses per-session deployment input before global settings", () => {
  const tmux = new TmuxBackend({
    defaultRuntimeCommand: "/bin/bash",
    runtimeSettingsEnabled: true,
    runtimeSettings: {
      cliDeployment: {
        codex: { mode: "docker", dockerName: "global-codex" }
      }
    },
    cliCommands: {
      codex: ["docker", "exec", "-it", "worker-codex", "codex"]
    }
  });

  assert.deepEqual(
    tmux.resolveCreateCommand({
      kind: "codex",
      cwd: "/workspace/app",
      deployment: { mode: "host", dockerName: "ignored" }
    }),
    {
      command: "codex",
      args: [],
      cwdMode: "host"
    }
  );
  assert.deepEqual(
    tmux.resolveCreateCommand({
      kind: "codex",
      cwd: "/workspace/app",
      deployment: { mode: "docker", dockerName: "session-codex" }
    }),
    {
      command: "docker",
      args: ["exec", "-w", "/workspace/app", "-it", "session-codex", "codex"],
      cwdMode: "container"
    }
  );
  assert.deepEqual(
    tmux.resolveCreateCommand({
      kind: "codex",
      cwd: "/workspace/app",
      deployment: { mode: "docker" }
    }),
    {
      command: "docker",
      args: ["exec", "-w", "/workspace/app", "-it", "global-codex", "codex"],
      cwdMode: "container"
    }
  );
});

test("TmuxBackend creates missing host cwd before creating a session", async () => {
  const root = await mkdtemp(join(tmpdir(), "session-gateway-"));
  const cwd = join(root, "missing", "nested");
  const tmux = new TmuxBackend({
    defaultRuntimeCommand: "/bin/bash",
    runtimeSettingsEnabled: true,
    runtimeSettings: {
      cliDeployment: {
        runtime: { mode: "host" }
      }
    },
    cliCommands: {}
  });

  try {
    const commandSpec = tmux.resolveCreateCommand({ kind: "runtime", cwd });
    await tmux.validateCreateInput({ kind: "runtime", cwd }, commandSpec);

    assert.equal((await stat(cwd)).isDirectory(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tmux targets use exact session matching", () => {
  assert.equal(exactTmuxSessionTarget("localshell"), "=localshell");
  assert.equal(exactTmuxPaneTarget("localshell"), "=localshell:");
});
