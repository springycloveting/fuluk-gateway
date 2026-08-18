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
    args: ["exec", "-e", "TERM=screen-256color", "-w", "/workspace/test", "-it", "worker-opencode", "opencode"],
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
    command: "env",
    args: ["TERM=screen-256color", "opencode"],
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

test("TmuxBackend send submits text with the configured submit key", async () => {
  const calls = [];
  const tmux = new TmuxBackend(
    {
      defaultRuntimeCommand: "/bin/bash",
      submitKeyDelayMs: 0,
      submitKeys: { codex: "C-j" },
      cliCommands: {}
    },
    {
      run: async (command, args, timeoutMs) => {
        calls.push({ command, args, timeoutMs });
        return { stdout: "" };
      },
      sleep: async () => {}
    }
  );

  await tmux.send(
    {
      id: "session-1",
      kind: "codex",
      tmuxSessionName: "glass-to-ai"
    },
    "修改配置"
  );

  assert.deepEqual(calls, [
    {
      command: "tmux",
      args: ["has-session", "-t", "=glass-to-ai"],
      timeoutMs: 3000
    },
    {
      command: "tmux",
      args: ["send-keys", "-t", "=glass-to-ai:", "-l", "--", "修改配置"],
      timeoutMs: undefined
    },
    {
      command: "tmux",
      args: ["send-keys", "-t", "=glass-to-ai:", "C-j"],
      timeoutMs: undefined
    }
  ]);
});

test("TmuxBackend send can override the submit key delay per call", async () => {
  const sleeps = [];
  const tmux = new TmuxBackend(
    {
      defaultRuntimeCommand: "/bin/bash",
      submitKeyDelayMs: 80,
      submitKeys: { codex: "Enter" },
      cliCommands: {}
    },
    {
      run: async () => ({ stdout: "" }),
      sleep: async (ms) => {
        sleeps.push(ms);
      }
    }
  );

  await tmux.send(
    {
      id: "session-1",
      kind: "codex",
      tmuxSessionName: "glass-to-ai"
    },
    "long room prompt",
    { submitKeyDelayMs: 700 }
  );

  assert.deepEqual(sleeps, [700]);
});

test("TmuxBackend resize updates the tmux window size", async () => {
  const calls = [];
  const tmux = new TmuxBackend(
    {
      defaultRuntimeCommand: "/bin/bash",
      cliCommands: {}
    },
    {
      run: async (command, args, timeoutMs) => {
        calls.push({ command, args, timeoutMs });
        return { stdout: "" };
      }
    }
  );

  await tmux.resize(
    {
      id: "session-1",
      kind: "opencode",
      tmuxSessionName: "opencode-work"
    },
    132,
    40
  );

  assert.deepEqual(calls, [
    {
      command: "tmux",
      args: ["has-session", "-t", "=opencode-work"],
      timeoutMs: 3000
    },
    {
      command: "tmux",
      args: ["resize-window", "-t", "=opencode-work", "-x", "132", "-y", "40"],
      timeoutMs: undefined
    }
  ]);
});

test("TmuxBackend capture only falls back to alternate screen when current pane is empty", async () => {
  const calls = [];
  const outputs = ["   ", "\u001b[31malternate\u001b[0m"];
  const tmux = new TmuxBackend(
    {
      defaultRuntimeCommand: "/bin/bash",
      cliCommands: {}
    },
    {
      run: async (command, args, timeoutMs) => {
        calls.push({ command, args, timeoutMs });
        return { stdout: args[0] === "capture-pane" ? outputs.shift() ?? "" : "" };
      }
    }
  );

  const output = await tmux.capture(
    {
      id: "session-1",
      kind: "opencode",
      tmuxSessionName: "opencode-work"
    },
    300,
    { preserveEscapes: true, alternateScreen: true }
  );

  assert.equal(output, "\u001b[31malternate\u001b[0m");
  assert.deepEqual(calls.filter((call) => call.args[0] === "capture-pane").map((call) => call.args[1]), ["-ept", "-eapt"]);
});

test("TmuxBackend capture can read a scrolled history window", async () => {
  const calls = [];
  const tmux = new TmuxBackend(
    {
      defaultRuntimeCommand: "/bin/bash",
      cliCommands: {}
    },
    {
      run: async (command, args, timeoutMs) => {
        calls.push({ command, args, timeoutMs });
        return { stdout: "history window" };
      }
    }
  );

  const output = await tmux.capture(
    {
      id: "session-1",
      kind: "opencode",
      tmuxSessionName: "opencode-work"
    },
    80,
    { offset: 40 }
  );

  assert.equal(output, "history window");
  assert.deepEqual(calls, [
    {
      command: "tmux",
      args: ["has-session", "-t", "=opencode-work"],
      timeoutMs: 3000
    },
    {
      command: "tmux",
      args: ["capture-pane", "-pt", "=opencode-work:", "-S", "-120", "-E", "-40"],
      timeoutMs: undefined
    }
  ]);
});

test("TmuxBackend capture can preserve terminal escapes and alternate screen", async () => {
  const calls = [];
  const tmux = new TmuxBackend(
    {
      defaultRuntimeCommand: "/bin/bash",
      cliCommands: {}
    },
    {
      run: async (command, args, timeoutMs) => {
        calls.push({ command, args, timeoutMs });
        return { stdout: "\u001b[32mmenu\u001b[0m" };
      }
    }
  );

  const output = await tmux.capture(
    {
      id: "session-1",
      kind: "opencode",
      tmuxSessionName: "opencode-work"
    },
    300,
    { preserveEscapes: true, alternateScreen: true }
  );

  assert.equal(output, "\u001b[32mmenu\u001b[0m");
  assert.deepEqual(calls, [
    {
      command: "tmux",
      args: ["has-session", "-t", "=opencode-work"],
      timeoutMs: 3000
    },
    {
      command: "tmux",
      args: ["capture-pane", "-ept", "=opencode-work:", "-S", "-300"],
      timeoutMs: undefined
    }
  ]);
});

test("TmuxBackend sendKeys translates wheel keys into SGR mouse sequences at pane center", async () => {
  const calls = [];
  const tmux = new TmuxBackend(
    {
      defaultRuntimeCommand: "/bin/bash",
      cliCommands: {}
    },
    {
      run: async (command, args, timeoutMs) => {
        calls.push({ command, args, timeoutMs });
        if (args[0] === "display-message") return { stdout: "120,40" };
        return { stdout: "" };
      }
    }
  );

  await tmux.sendKeys(
    {
      id: "session-1",
      kind: "opencode",
      tmuxSessionName: "opencode-work"
    },
    ["WheelUpPane"]
  );

  assert.deepEqual(calls, [
    {
      command: "tmux",
      args: ["has-session", "-t", "=opencode-work"],
      timeoutMs: 3000
    },
    {
      command: "tmux",
      args: ["display-message", "-p", "-t", "=opencode-work:", "#{pane_width},#{pane_height}"],
      timeoutMs: undefined
    },
    {
      command: "tmux",
      args: ["send-keys", "-t", "=opencode-work:", "-l", "--", "\u001b[<64;61;21M"],
      timeoutMs: undefined
    }
  ]);
});

test("TmuxBackend sendKeys splits plain keys and wheel keys into separate tmux calls", async () => {
  const calls = [];
  const tmux = new TmuxBackend(
    {
      defaultRuntimeCommand: "/bin/bash",
      cliCommands: {}
    },
    {
      run: async (command, args, timeoutMs) => {
        calls.push({ command, args, timeoutMs });
        if (args[0] === "display-message") return { stdout: "100,30" };
        return { stdout: "" };
      }
    }
  );

  await tmux.sendKeys(
    {
      id: "session-1",
      kind: "opencode",
      tmuxSessionName: "opencode-work"
    },
    ["WheelDownPane", "Enter"]
  );

  assert.deepEqual(calls, [
    {
      command: "tmux",
      args: ["has-session", "-t", "=opencode-work"],
      timeoutMs: 3000
    },
    {
      command: "tmux",
      args: ["send-keys", "-t", "=opencode-work:", "Enter"],
      timeoutMs: undefined
    },
    {
      command: "tmux",
      args: ["display-message", "-p", "-t", "=opencode-work:", "#{pane_width},#{pane_height}"],
      timeoutMs: undefined
    },
    {
      command: "tmux",
      args: ["send-keys", "-t", "=opencode-work:", "-l", "--", "\u001b[<65;51;16M"],
      timeoutMs: undefined
    }
  ]);
});
