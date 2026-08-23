import path from "node:path";
import fs from "node:fs";

const CLI_KINDS = ["codex", "claude", "opencode", "pi-os"];
const DEFAULT_CLI_DEPLOYMENT = {
  codex: { mode: "host", dockerName: "worker-codex" },
  claude: { mode: "host", dockerName: "worker-claude" },
  opencode: { mode: "host", dockerName: "worker-opencode" },
  "pi-os": { mode: "host", dockerName: "" }
};

export function loadConfig() {
  const settingsPath =
    process.env.SESSION_GATEWAY_SETTINGS ??
    path.resolve(process.cwd(), "data", "session-gateway-settings.json");
  const runtimeSettingsEnabled = fs.existsSync(settingsPath);
  const runtimeSettings = loadRuntimeSettings(settingsPath);

  const authToken = loadAuthToken();

  return {
    host: process.env.HOST ?? "127.0.0.1",
    port: Number.parseInt(process.env.PORT ?? "8787", 10),
    authToken,
    allowRuntimeMode: process.env.SESSION_GATEWAY_ALLOW_RUNTIME === "true",
    settingsPath,
    runtimeSettingsEnabled,
    runtimeSettings,
    notificationWebhookUrl: process.env.SESSION_GATEWAY_WEBHOOK_URL ?? "",
    databasePath:
      process.env.SESSION_GATEWAY_DB ??
      path.resolve(process.cwd(), "data", "session-gateway.sqlite"),
    codeClipSessionsDir:
      process.env.SESSION_GATEWAY_CODECLIP_SESSIONS_DIR ??
      "/home/v6/work/CodeClip/data/sessions",
    defaultRuntimeCommand: process.env.SESSION_GATEWAY_RUNTIME ?? "/bin/bash",
    notificationPollMs: parsePositiveInt(process.env.SESSION_GATEWAY_NOTIFICATION_POLL_MS, 5_000),
    workflowSupervisorEnabled: process.env.SESSION_GATEWAY_WORKFLOW_SUPERVISOR_ENABLED !== "false",
    workflowSupervisorIntervalMs: parsePositiveInt(
      process.env.SESSION_GATEWAY_WORKFLOW_SUPERVISOR_INTERVAL_MS,
      runtimeSettings.workflowSupervisor?.intervalMs ?? 60_000
    ),
    workflowSupervisorStallMs: parsePositiveInt(
      process.env.SESSION_GATEWAY_WORKFLOW_SUPERVISOR_STALL_MS,
      runtimeSettings.workflowSupervisor?.stallMs ?? 15 * 60_000
    ),
    workflowSupervisorHardTimeoutMs: parsePositiveInt(
      process.env.SESSION_GATEWAY_WORKFLOW_SUPERVISOR_HARD_TIMEOUT_MS,
      runtimeSettings.workflowSupervisor?.hardTimeoutMs ?? 60 * 60_000
    ),
    workflowSupervisorCooldownMs: parsePositiveInt(
      process.env.SESSION_GATEWAY_WORKFLOW_SUPERVISOR_COOLDOWN_MS,
      runtimeSettings.workflowSupervisor?.sameActionCooldownMs ?? 10 * 60_000
    ),
    workflowSupervisorMaxInterventions: parsePositiveInt(
      process.env.SESSION_GATEWAY_WORKFLOW_SUPERVISOR_MAX_INTERVENTIONS,
      runtimeSettings.workflowSupervisor?.maxInterventionsPerAssignment ?? 3
    ),
    workflowSupervisorMaxSpawnedAgents: parsePositiveInt(
      process.env.SESSION_GATEWAY_WORKFLOW_SUPERVISOR_MAX_SPAWNED_AGENTS,
      runtimeSettings.workflowSupervisor?.maxSpawnedAgentsPerRoom ?? 3
    ),
    workflowSupervisorPmEnabled:
      process.env.SESSION_GATEWAY_WORKFLOW_SUPERVISOR_PM_ENABLED === "true" ||
      Boolean(runtimeSettings.workflowSupervisor?.pmAgentEnabled),
    submitKeyDelayMs: parsePositiveInt(process.env.SESSION_GATEWAY_SUBMIT_KEY_DELAY_MS, 80),
    cliStartupDelayMs: parsePositiveInt(process.env.SESSION_GATEWAY_CLI_STARTUP_DELAY_MS, 3000),
    submitKeys: {
      codex: process.env.SESSION_GATEWAY_CODEX_SUBMIT_KEY ?? "Enter",
      claude: process.env.SESSION_GATEWAY_CLAUDE_SUBMIT_KEY ?? "Enter",
      opencode: process.env.SESSION_GATEWAY_OPENCODE_SUBMIT_KEY ?? "Enter",
      "pi-os": process.env.SESSION_GATEWAY_PI_OS_SUBMIT_KEY ?? "Enter",
      runtime: process.env.SESSION_GATEWAY_RUNTIME_SUBMIT_KEY ?? "Enter"
    },
    cliCommands: {
      codex: splitCommand(process.env.SESSION_GATEWAY_CODEX_CMD ?? "docker exec -it worker-codex codex"),
      claude: splitCommand(process.env.SESSION_GATEWAY_CLAUDE_CMD ?? "docker exec -it worker-claude claude"),
      opencode: splitCommand(
        process.env.SESSION_GATEWAY_OPENCODE_CMD ?? "docker exec -it worker-opencode opencode"
      ),
      "pi-os": splitCommand(process.env.SESSION_GATEWAY_PI_OS_CMD ?? "pi-os")
    }
  };
}

export function updateRuntimeSettings(config, input) {
  const next = normalizeRuntimeSettings(input, config.runtimeSettings);
  fs.mkdirSync(path.dirname(config.settingsPath), { recursive: true });
  fs.writeFileSync(config.settingsPath, `${JSON.stringify(next, null, 2)}\n`);
  config.runtimeSettingsEnabled = true;
  config.runtimeSettings = next;
  config.workflowSupervisorPmEnabled = Boolean(next.workflowSupervisor?.pmAgentEnabled);
  return next;
}

export function normalizeRuntimeSettings(input = {}, existing = {}) {
  const cliDeployment = {};
  const source = input.cliDeployment && typeof input.cliDeployment === "object" ? input.cliDeployment : {};
  const prevSettings = existing && typeof existing === "object" ? existing : {};

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

  return {
    cliDeployment,
    commandParser: normalizeCommandParser(input.commandParser, prevSettings.commandParser),
    notifications: normalizeNotifications(input.notifications),
    sessionAgent: normalizeSessionAgent(input.sessionAgent),
    workflowSupervisor: normalizeWorkflowSupervisor(input.workflowSupervisor)
  };
}

function normalizeWorkflowSupervisor(input = {}) {
  const current = input && typeof input === "object" ? input : {};
  return {
    pmAgentEnabled: Boolean(current.pmAgentEnabled),
    intervalMs: positiveNumber(current.intervalMs, 60_000),
    stallMs: positiveNumber(current.stallMs, 15 * 60_000),
    hardTimeoutMs: positiveNumber(current.hardTimeoutMs, 60 * 60_000),
    sameActionCooldownMs: positiveNumber(current.sameActionCooldownMs, 10 * 60_000),
    maxInterventionsPerAssignment: positiveNumber(current.maxInterventionsPerAssignment, 3),
    maxSpawnedAgentsPerRoom: positiveNumber(current.maxSpawnedAgentsPerRoom, 3)
  };
}

function normalizeSessionAgent(input = {}) {
  const current = input && typeof input === "object" ? input : {};
  return {
    model: typeof current.model === "string" ? current.model.trim() : "",
    apiKey: typeof current.apiKey === "string" ? current.apiKey.trim() : "",
    models: normalizeSessionAgentModels(current.models),
    resetOnConfigChange: Boolean(current.resetOnConfigChange)
  };
}

function normalizeSessionAgentModels(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const providers = {};
  for (const [provider, providerValue] of Object.entries(input)) {
    if (provider === "defaultModel" || provider === "default_model") continue;
    if (!providerValue || typeof providerValue !== "object" || Array.isArray(providerValue)) continue;
    const models = {};
    for (const [modelId, modelValue] of Object.entries(providerValue)) {
      const normalized = normalizeSessionAgentModel(provider, modelId, modelValue);
      if (normalized) models[modelId] = normalized;
    }
    providers[provider] = models;
  }
  return providers;
}

function normalizeSessionAgentModel(provider, modelId, input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const api = typeof input.api === "string" ? input.api.trim() : "";
  const baseUrl =
    typeof input.baseUrl === "string"
      ? input.baseUrl.trim().replace(/\/+$/, "")
      : typeof input.base_url === "string"
        ? input.base_url.trim().replace(/\/+$/, "")
        : "";
  if (!api || !baseUrl) return null;
  const contextWindow = positiveNumber(input.contextWindow ?? input.context_window, 128000);
  const maxTokens = positiveNumber(input.maxTokens ?? input.max_tokens, 4096);
  const headers = normalizeStringMap(input.headers);
  return {
    id: typeof input.id === "string" && input.id.trim() ? input.id.trim() : modelId,
    name: typeof input.name === "string" && input.name.trim() ? input.name.trim() : modelId,
    api,
    provider: typeof input.provider === "string" && input.provider.trim() ? input.provider.trim() : provider,
    baseUrl,
    reasoning: Boolean(input.reasoning),
    input: normalizeModelInput(input.input),
    contextWindow,
    maxTokens,
    headers,
    apiKey:
      typeof input.apiKey === "string"
        ? input.apiKey.trim()
        : typeof input.api_key === "string"
          ? input.api_key.trim()
          : ""
  };
}

function normalizeStringMap(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const output = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string") output[key] = value;
  }
  return output;
}

function normalizeModelInput(input) {
  if (!Array.isArray(input)) return ["text"];
  const values = input.filter((value) => value === "text" || value === "image");
  return values.length ? values : ["text"];
}

function positiveNumber(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function normalizeNotifications(input = {}) {
  const current = input && typeof input === "object" ? input : {};
  return {
    webhookUrl: typeof current.webhookUrl === "string" ? current.webhookUrl.trim() : ""
  };
}

function normalizeCommandParser(input = {}, existing = {}) {
  const current = input && typeof input === "object" ? input : {};
  const prev = existing && typeof existing === "object" ? existing : {};
  const mode =
    current.mode === "rules-first-ai-fallback" ||
    current.mode === "rules-only" ||
    current.mode === "web-ai-agent-pi"
      ? current.mode
      : current.enabled
        ? "rules-first-ai-fallback"
        : "rules-only";
  const enabled = Boolean(current.enabled) && mode !== "rules-only";
  return {
    enabled,
    mode: enabled ? mode : "rules-only",
    baseUrl: resolveConfigField(current.baseUrl, prev.baseUrl, { stripTrailingSlash: true }),
    model: resolveConfigField(current.model, prev.model),
    apiKey: resolveConfigField(current.apiKey, prev.apiKey),
    webAiAgentPiUrl: resolveConfigField(current.webAiAgentPiUrl, prev.webAiAgentPiUrl, { stripTrailingSlash: true }),
    webAiAgentPiToken: resolveConfigField(current.webAiAgentPiToken, prev.webAiAgentPiToken)
  };
}

// Resolve a config field whose value may be supplied partially. The web UI's
// save flow sends the form's current field values verbatim, so a blank field
// (e.g. when a user only edits the bearer token) must not clobber an already
// configured LLM endpoint. A non-empty incoming value always overrides, so a
// user can still switch providers; only blank/absent inputs fall back to the
// previously persisted value.
function resolveConfigField(incoming, prev, options = {}) {
  const value = pickNonBlank(incoming, prev);
  if (!value) return "";
  if (options.stripTrailingSlash) return value.replace(/\/+$/, "");
  return value;
}

function pickNonBlank(incoming, prev) {
  if (typeof incoming === "string" && incoming.trim()) return incoming.trim();
  if (typeof prev === "string" && prev.trim()) return prev.trim();
  return "";
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

function loadAuthToken() {
  const token = process.env.SESSION_GATEWAY_TOKEN;

  if (!token) {
    console.error("ERROR: SESSION_GATEWAY_TOKEN environment variable is required");
    console.error("Generate a secure token with:");
    console.error("  node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"");
    process.exit(1);
  }

  const insecureDefaults = ["dev-token", "change-me", "test", "password", "secret"];
  if (insecureDefaults.includes(token)) {
    console.error("ERROR: SESSION_GATEWAY_TOKEN uses an insecure default value");
    console.error("Please set a unique, random token");
    console.error("Generate one with:");
    console.error("  node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"");
    process.exit(1);
  }

  if (token.length < 16) {
    console.warn("WARNING: SESSION_GATEWAY_TOKEN is shorter than recommended (minimum 16 characters)");
  }

  return token;
}
