import { Agent } from "@earendil-works/pi-agent-core";
import { getModel, getModels, getProviders } from "@earendil-works/pi-ai";

const DEFAULT_MODEL_SPEC = "openai:gpt-5.2";
const ALLOWED_STATUSES = new Set(["healthy", "watching", "intervention_required", "needs_replan", "needs_human"]);
const ALLOWED_ACTIONS = new Set([
  "observe_only",
  "remind",
  "redirect",
  "retry",
  "reassign",
  "request_replan",
  "spawn_agent",
  "pause_workflow",
  "escalate"
]);
const ASSIGNMENT_ACTIONS = new Set(["remind", "redirect", "retry", "reassign"]);

const SYSTEM_PROMPT = [
  "You are the Project Manager supervision agent for Session Gateway Room workflows.",
  "You do not write code, run tests, modify files, mark assignments complete, or change workflow state directly.",
  "You only inspect the provided ProjectSnapshot and detected issues, then decide whether a small intervention is needed.",
  "Prefer minimal intervention. Avoid repeating reminders. Respect the workflow plan and testing gates.",
  "Return only strict JSON. Do not wrap it in markdown.",
  "",
  "Allowed response shape:",
  "{",
  "  \"status\": \"healthy|watching|intervention_required|needs_replan|needs_human\",",
  "  \"summary\": \"short Chinese summary\",",
  "  \"actions\": [",
  "    {",
  "      \"type\": \"observe_only|remind|redirect|retry|reassign|request_replan|spawn_agent|pause_workflow|escalate\",",
  "      \"assignmentId\": \"optional assignment id\",",
  "      \"targetSessionId\": \"optional session id\",",
  "      \"targetRole\": \"optional role\",",
  "      \"reason\": \"why this action is needed\",",
  "      \"message\": \"instruction to send, required for remind/redirect\"",
  "    }",
  "  ]",
  "}"
].join("\n");

export function createProjectManagerAgent(context, options = {}) {
  let agent = options.agent ?? null;
  let modelKey = "";

  function getEffectiveSettings() {
    const sessionAgent = context.config.runtimeSettings?.sessionAgent ?? {};
    const commandParser = context.config.runtimeSettings?.commandParser ?? {};
    // Use sessionAgent settings if model is configured, otherwise fall back to commandParser
    if (sessionAgent.model && sessionAgent.model.trim()) {
      return sessionAgent;
    }
    // Convert commandParser settings to sessionAgent format
    const baseUrl = commandParser.baseUrl || "";
    const modelId = commandParser.model || "";
    const apiKey = commandParser.apiKey || "";
    if (!baseUrl || !modelId || !apiKey) {
      return { model: "", apiKey: "", models: {} };
    }
    return {
      model: "openai:command-parser",
      apiKey,
      models: {
        openai: {
          "command-parser": {
            api: "openai-completions",
            provider: "openai",
            baseUrl,
            id: modelId,
            name: modelId
          }
        }
      }
    };
  }

  async function buildAgent() {
    const settings = getEffectiveSettings();
    const resolved = resolveModel(settings);
    modelKey = settingsKey(settings);
    agent = new Agent({
      initialState: {
        systemPrompt: SYSTEM_PROMPT,
        model: resolved.model,
        thinkingLevel: "off",
        tools: []
      },
      getApiKey(provider) {
        return resolved.apiKeyByProvider.get(provider) ?? resolved.apiKey;
      },
      onPayload(payload, model) {
        return applyModelPayloadOptions(payload, model);
      },
      toolExecution: "sequential",
      sessionId: "session-gateway-project-manager"
    });
    return agent;
  }

  async function getAgent() {
    if (options.agent) return options.agent;
    const settings = getEffectiveSettings();
    const nextKey = settingsKey(settings);
    if (!agent || nextKey !== modelKey || settings.resetOnConfigChange) return buildAgent();
    return agent;
  }

  return {
    async decide(snapshot, detectedIssues = []) {
      const currentAgent = await getAgent();
      if (typeof currentAgent.state?.systemPrompt === "string") currentAgent.state.systemPrompt = SYSTEM_PROMPT;
      if (typeof currentAgent.state?.tools !== "undefined") currentAgent.state.tools = [];
      await currentAgent.prompt(buildManagerPrompt(snapshot, detectedIssues));
      const raw = assistantText([...((currentAgent.state?.messages) ?? [])].reverse().find((message) => message.role === "assistant"));
      const parsed = parseManagerDecision(raw);
      return validateManagerDecision(snapshot, parsed);
    },
    reset() {
      agent?.reset?.();
      agent = null;
      modelKey = "";
    }
  };
}

export function validateManagerDecision(snapshot, input) {
  const errors = [];
  const status = typeof input?.status === "string" && ALLOWED_STATUSES.has(input.status)
    ? input.status
    : "watching";
  if (input?.status && !ALLOWED_STATUSES.has(input.status)) errors.push(`Invalid PM status: ${input.status}`);
  const summary = typeof input?.summary === "string" ? input.summary.trim().slice(0, 1000) : "";
  const actions = Array.isArray(input?.actions) ? input.actions.slice(0, 8) : [];
  if (!Array.isArray(input?.actions)) errors.push("PM decision actions must be an array");

  const assignments = new Map((snapshot.assignments ?? []).map((assignment) => [assignment.id, assignment]));
  const members = new Map((snapshot.members ?? []).map((member) => [member.sessionId, member]));
  const normalizedActions = [];

  for (const [index, action] of actions.entries()) {
    const type = typeof action?.type === "string" ? action.type : "";
    if (!ALLOWED_ACTIONS.has(type)) {
      errors.push(`Invalid PM action at index ${index}: ${type || "missing"}`);
      continue;
    }
    const assignmentId = stringOrNull(action.assignmentId);
    const targetSessionId = stringOrNull(action.targetSessionId);
    const targetRole = stringOrNull(action.targetRole);
    const reason = stringOrNull(action.reason);
    const message = stringOrNull(action.message);
    const assignment = assignmentId ? assignments.get(assignmentId) : null;

    if (ASSIGNMENT_ACTIONS.has(type)) {
      if (!assignmentId || !assignment) {
        errors.push(`PM action ${type} references an unknown assignment`);
        continue;
      }
      if (assignment.status !== "pending" || assignment.resultMessageId) {
        errors.push(`PM action ${type} cannot target a finished assignment`);
        continue;
      }
    }
    if (type === "spawn_agent" && assignmentId && !assignment) {
      errors.push("PM action spawn_agent references an unknown assignment");
      continue;
    }
    if (type === "spawn_agent" && assignment && (assignment.status !== "pending" || assignment.resultMessageId)) {
      errors.push("PM action spawn_agent cannot target a finished assignment");
      continue;
    }
    if (targetSessionId && !members.has(targetSessionId)) {
      errors.push(`PM action ${type} references a session outside the room`);
      continue;
    }
    if ((type === "remind" || type === "redirect") && !message) {
      errors.push(`PM action ${type} requires message`);
      continue;
    }
    if (type === "spawn_agent" && !targetRole) {
      errors.push("PM action spawn_agent requires targetRole");
      continue;
    }

    normalizedActions.push({
      type,
      assignmentId,
      targetSessionId: targetSessionId ?? assignment?.sessionId ?? null,
      targetRole,
      reason,
      message
    });
  }

  return {
    ok: errors.length === 0,
    errors,
    decision: {
      status,
      summary,
      actions: normalizedActions
    }
  };
}

export function parseManagerDecision(text) {
  const value = String(text ?? "").trim();
  if (!value) throw new Error("PM decision is empty");
  try {
    return JSON.parse(value);
  } catch {
    const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
    if (fenced) return JSON.parse(fenced);
    const object = value.match(/\{[\s\S]*\}/)?.[0];
    if (object) return JSON.parse(object);
    throw new Error("PM decision is not valid JSON");
  }
}

function buildManagerPrompt(snapshot, detectedIssues) {
  return [
    "ProjectSnapshot:",
    JSON.stringify(snapshot, null, 2),
    "",
    "DetectedIssues:",
    JSON.stringify(detectedIssues, null, 2),
    "",
    "Return strict JSON only."
  ].join("\n");
}

function stringOrNull(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function assistantText(message) {
  if (!message?.content) return "";
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function resolveModel(settings = {}) {
  const registry = parseSettingsRegistry(settings.models);
  const modelSpec = settings.model || DEFAULT_MODEL_SPEC;
  const { provider, modelId } = splitModelSpec(modelSpec);
  const custom = registry.get(provider)?.get(modelId);
  const model = custom?.model ?? resolveBuiltInModel(provider, modelId);
  const apiKey = custom?.apiKey || settings.apiKey || "";
  return {
    model,
    apiKey,
    apiKeyByProvider: new Map([[model.provider, apiKey]])
  };
}

function parseSettingsRegistry(models = {}) {
  const registry = new Map();
  if (!models || typeof models !== "object" || Array.isArray(models)) return registry;
  for (const [provider, providerValue] of Object.entries(models)) {
    if (!providerValue || typeof providerValue !== "object" || Array.isArray(providerValue)) continue;
    const providerModels = new Map();
    for (const [modelId, entry] of Object.entries(providerValue)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      providerModels.set(modelId, {
        model: {
          id: entry.id || modelId,
          name: entry.name || modelId,
          api: entry.api,
          provider: entry.provider || provider,
          baseUrl: entry.baseUrl,
          reasoning: Boolean(entry.reasoning),
          input: Array.isArray(entry.input) && entry.input.length ? entry.input : ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: entry.contextWindow || 128000,
          maxTokens: entry.maxTokens || 4096,
          headers: entry.headers || {}
        },
        apiKey: entry.apiKey || ""
      });
    }
    registry.set(provider, providerModels);
  }
  return registry;
}

function splitModelSpec(modelSpec) {
  const separator = modelSpec.indexOf(":");
  if (separator === -1) throw new Error(`sessionAgent.model must use provider:model-id format. Received: ${modelSpec}`);
  return { provider: modelSpec.slice(0, separator), modelId: modelSpec.slice(separator + 1) };
}

function resolveBuiltInModel(provider, modelId) {
  if (!getProviders().includes(provider)) throw new Error(`Unknown sessionAgent model provider: ${provider}`);
  const model = getModel(provider, modelId);
  if (!model) {
    const examples = getModels(provider).slice(0, 10).map((entry) => entry.id).join(", ");
    throw new Error(`Unknown sessionAgent model ${provider}:${modelId}. Available examples: ${examples}`);
  }
  return model;
}

function settingsKey(settings = {}) {
  return JSON.stringify({
    model: settings.model || DEFAULT_MODEL_SPEC,
    apiKey: settings.apiKey || "",
    models: settings.models || {}
  });
}

function applyModelPayloadOptions(payload, model) {
  if (!payload || typeof payload !== "object") return undefined;
  const next = { ...payload };
  if (model?.maxTokens && typeof next.max_tokens === "number") {
    next.max_tokens = Math.min(next.max_tokens, model.maxTokens);
  }
  if (model?.provider === "JD" && model?.id?.toLowerCase().includes("kimi")) {
    next.thinking = { type: "disabled" };
  }
  return next;
}
