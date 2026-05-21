import path from "node:path";
import fs from "node:fs";

const CLI_KINDS = ["codex", "claude", "opencode"];
const DEFAULT_CLI_DEPLOYMENT = {
  codex: { mode: "docker", dockerName: "worker-codex" },
  claude: { mode: "docker", dockerName: "worker-claude" },
  opencode: { mode: "docker", dockerName: "worker-opencode" }
};

export function loadConfig() {
  const settingsPath =
    process.env.SESSION_GATEWAY_SETTINGS ??
    path.resolve(process.cwd(), "data", "session-gateway-settings.json");
  return {
    host: process.env.HOST ?? "127.0.0.1",
    port: Number.parseInt(process.env.PORT ?? "8787", 10),
    authToken: process.env.SESSION_GATEWAY_TOKEN ?? "dev-token",
    settingsPath,
    runtimeSettingsEnabled: fs.existsSync(settingsPath),
    runtimeSettings: loadRuntimeSettings(settingsPath),
    databasePath:
      process.env.SESSION_GATEWAY_DB ??
      path.resolve(process.cwd(), "data", "session-gateway.sqlite"),
    defaultRuntimeCommand: process.env.SESSION_GATEWAY_RUNTIME ?? "/bin/bash",
    submitKeyDelayMs: parsePositiveInt(process.env.SESSION_GATEWAY_SUBMIT_KEY_DELAY_MS, 80),
    submitKeys: {
      codex: process.env.SESSION_GATEWAY_CODEX_SUBMIT_KEY ?? "Enter",
      claude: process.env.SESSION_GATEWAY_CLAUDE_SUBMIT_KEY ?? "Enter",
      opencode: process.env.SESSION_GATEWAY_OPENCODE_SUBMIT_KEY ?? "Enter",
      runtime: process.env.SESSION_GATEWAY_RUNTIME_SUBMIT_KEY ?? "Enter"
    },
    cliCommands: {
      codex: splitCommand(process.env.SESSION_GATEWAY_CODEX_CMD ?? "docker exec -it worker-codex codex"),
      claude: splitCommand(process.env.SESSION_GATEWAY_CLAUDE_CMD ?? "docker exec -it worker-claude claude"),
      opencode: splitCommand(
        process.env.SESSION_GATEWAY_OPENCODE_CMD ?? "docker exec -it worker-opencode opencode"
      )
    }
  };
}

export function updateRuntimeSettings(config, input) {
  const next = normalizeRuntimeSettings(input);
  fs.mkdirSync(path.dirname(config.settingsPath), { recursive: true });
  fs.writeFileSync(config.settingsPath, `${JSON.stringify(next, null, 2)}\n`);
  config.runtimeSettingsEnabled = true;
  config.runtimeSettings = next;
  return next;
}

export function normalizeRuntimeSettings(input = {}) {
  const cliDeployment = {};
  const source = input.cliDeployment && typeof input.cliDeployment === "object" ? input.cliDeployment : {};

  for (const kind of CLI_KINDS) {
    const current = source[kind] && typeof source[kind] === "object" ? source[kind] : {};
    const fallback = DEFAULT_CLI_DEPLOYMENT[kind];
    const mode = current.mode === "host" || current.mode === "docker" ? current.mode : fallback.mode;
    const dockerName =
      typeof current.dockerName === "string" && current.dockerName.trim()
        ? current.dockerName.trim()
        : fallback.dockerName;
    cliDeployment[kind] = { mode, dockerName };
  }

  return { cliDeployment, commandParser: normalizeCommandParser(input.commandParser) };
}

function normalizeCommandParser(input = {}) {
  const current = input && typeof input === "object" ? input : {};
  const mode =
    current.mode === "rules-first-ai-fallback" || current.mode === "rules-only"
      ? current.mode
      : current.enabled
        ? "rules-first-ai-fallback"
      : "rules-only";
  const enabled = Boolean(current.enabled) && mode === "rules-first-ai-fallback";
  return {
    enabled,
    mode: enabled ? "rules-first-ai-fallback" : mode,
    baseUrl: typeof current.baseUrl === "string" ? current.baseUrl.trim().replace(/\/+$/, "") : "",
    model: typeof current.model === "string" ? current.model.trim() : "",
    apiKey: typeof current.apiKey === "string" ? current.apiKey.trim() : ""
  };
}

function splitCommand(value) {
  return value.trim().split(/\s+/).filter(Boolean);
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function loadRuntimeSettings(settingsPath) {
  try {
    return normalizeRuntimeSettings(JSON.parse(fs.readFileSync(settingsPath, "utf8")));
  } catch {
    return normalizeRuntimeSettings();
  }
}
