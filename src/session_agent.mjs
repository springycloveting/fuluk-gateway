import { Agent } from "@earendil-works/pi-agent-core";
import { getModel, getModels, getProviders, Type } from "@earendil-works/pi-ai";

const DEFAULT_MODEL_SPEC = "openai:gpt-5.2";

const SYSTEM_PROMPT = [
  "You are web-pi, the Session Gateway middle-layer assistant.",
  "The /api/nl endpoint sends user messages to you. Backend tool results are also sent back to you so you can produce the final user-facing answer.",
  "You can only operate Session Gateway sessions and rooms through the provided tools.",
  "You do not have shell, filesystem, project search, delete, or network tools. Refuse requests for those capabilities.",
  "Before acting, prefer checking current session state when the target or state is ambiguous.",
  "If the user clearly asks for a side-effect action such as stop, restart, create, switch, send text, or confirm permission, execute it with the appropriate tool.",
  "For stop requests that mention idle or completed sessions, only stop sessions whose taskState is completed unless the user names a specific target.",
  "When a session has needs_confirmation and the user asks to confirm, send Enter or a safe visible option with send_keys_to_session.",
  "When the user asks to summarize a session, read the needed output with get_session_output and summarize it in your final answer. Do not ask the user to inspect raw output.",
  "",
  "Room capabilities:",
  "- Use list_rooms to see all rooms and their member sessions.",
  "- Use create_room to create a new room for coordinating multiple sessions.",
  "- Use assign_session_to_room to add a session to a room with an optional role.",
  "- Use send_room_message to broadcast a message to all/role-specific/specific sessions in a room.",
  "- Use list_room_messages to see the message history in a room.",
  "- When the user asks to coordinate sessions or run multi-agent workflows, suggest using rooms.",
  "",
  "Workflow capabilities:",
  "- Use setup_workflow_room to create a complete workflow environment with room, role-assigned sessions, and workflow run in one call.",
  "- Use list_workflow_templates to see available workflow templates.",
  "- Use list_workflows to inspect workflow runs in a room or active workflow runs globally.",
  "- Use create_workflow_run to create a workflow in an existing room.",
  "- Use start_workflow_run to start workflow execution.",
  "- Use get_workflow_supervisor to inspect PM supervision observations, issues, and interventions.",
  "- Use tick_workflow_supervisor when the user asks to supervise/check a workflow immediately.",
  "- Use update_workflow_supervisor_policy to tune PM supervision policy such as stall timeout, cooldown, intervention budget, and PM Agent enablement.",
  "- When user mentions '非docker模式', '主机模式', or 'host模式', set deploymentMode to 'host'.",
  "- When user specifies role kinds like 'coder用claude' or 'planner用codex', create sessions with matching kind.",
  "- When user provides project folder path, use it as project (cwd) for all sessions.",
  "- When user describes a task goal after '任务目标是' or similar, use it as the workflow objective.",
  "",
  "Never answer only with generic text such as '操作已完成' when backend output is available. Use the backend output to answer the user's actual request.",
  "Keep final answers concise and mention the concrete sessions you acted on.",
  "IMPORTANT: Be extremely concise. Answer in 1-3 sentences max. No explanations or elaborations unless explicitly asked. Direct answers only."
].join("\n");

export function createSessionAgentManager(context, operations, options = {}) {
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
    // commandParser uses baseUrl + model, sessionAgent uses provider:model format
    // We create a custom "openai:command-parser" model entry
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
    const resolved = resolveSessionAgentModel(settings);
    const tools = createSessionAgentTools(operations);
    modelKey = settingsKey(settings);
    agent = new Agent({
      initialState: {
        systemPrompt: SYSTEM_PROMPT,
        model: resolved.model,
        thinkingLevel: "off",
        tools
      },
      getApiKey(provider) {
        return resolved.apiKeyByProvider.get(provider) ?? resolved.apiKey;
      },
      onPayload(payload, model) {
        return applyModelPayloadOptions(payload, model);
      },
      toolExecution: "sequential",
      sessionId: "session-gateway-global-nl-assistant"
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
    async run(text, request = {}) {
      operations.setCurrentRequest?.({ ...request, text });
      const currentAgent = await getAgent();
      const actions = [];
      const unsubscribe = currentAgent.subscribe((event) => {
        if (event.type !== "tool_execution_end") return;
        actions.push({
          tool: event.toolName,
          ok: !event.isError,
          details: event.result?.details ?? null
        });
      });
      try {
        if (typeof currentAgent.state?.tools !== "undefined") {
          currentAgent.state.tools = createSessionAgentTools(operations);
        }
        if (typeof currentAgent.state?.systemPrompt === "string") {
          const sessionState = await operations.summarize_session_states();
          const roomPrompt = buildRoomContextPrompt(request.roomContext);
          currentAgent.state.systemPrompt = `${SYSTEM_PROMPT}\n${roomPrompt}\n\nCurrent session state:\n${sessionState}`;
        }
        await currentAgent.prompt(buildUserPrompt(text, request));
        await synthesizeBackendOutput(currentAgent, text, request, actions);
        return buildAssistantResponse(currentAgent, actions, text);
      } finally {
        unsubscribe?.();
      }
    },
    reset() {
      agent?.reset?.();
      agent = null;
      modelKey = "";
    }
  };
}

async function synthesizeBackendOutput(agent, text, request, actions) {
  if (!shouldSendBackendOutputToWebPi(text, actions, agent)) return;
  const previousTools = agent.state?.tools;
  if (agent.state && typeof previousTools !== "undefined") {
    agent.state.tools = [];
  }
  try {
    await agent.prompt(buildBackendOutputPrompt(text, request, actions));
  } finally {
    if (agent.state && typeof previousTools !== "undefined") {
      agent.state.tools = previousTools;
    }
  }
}

function createSessionAgentTools(operations) {
  return [
    tool("List Sessions", "list_sessions", "List Session Gateway sessions and their current task states.", {
      runningOnly: Type.Optional(Type.Boolean()),
      includeOutputLines: Type.Optional(Type.Number({ minimum: 0, maximum: 200 }))
    }, operations.list_sessions),
    tool("Get Session Output", "get_session_output", "Read recent terminal output from a target session.", targetSchema({
      lines: Type.Optional(Type.Number({ minimum: 1, maximum: 500 }))
    }), operations.get_session_output),
    tool("Send Text", "send_to_session", "Send submitted text to a target session.", targetSchema({
      text: Type.String({ minLength: 1 })
    }), operations.send_to_session),
    tool("Send Keys", "send_keys_to_session", "Send whitelisted tmux keys such as Enter or Escape to a target session.", targetSchema({
      keys: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 8 })
    }), operations.send_keys_to_session),
    tool("Switch Session", "switch_session", "Return the target session and recent output so the UI can switch selection.", targetSchema({}), operations.switch_session),
    tool("Stop Session", "stop_session", "Stop a target Session Gateway session.", targetSchema({}), operations.stop_session),
    tool("Restart Session", "restart_session", "Restart a target Session Gateway session.", targetSchema({}), operations.restart_session),
    tool("Create Session", "create_session", "Create a new codex, claude, opencode, pi-os, or runtime session.", {
      kind: Type.String({ description: "codex, claude, opencode, pi-os, or runtime" }),
      name: Type.Optional(Type.String()),
      cwd: Type.Optional(Type.String()),
      project: Type.Optional(Type.String()),
      deployment: Type.Optional(Type.Object({
        mode: Type.Optional(Type.String({ description: "docker or host" })),
        dockerName: Type.Optional(Type.String())
      }))
    }, operations.create_session),
    tool("Summarize Session States", "summarize_session_states", "Read-only summary of sessions by task state.", {}, async () => {
      const summary = await operations.summarize_session_states();
      return { summary };
    }),
    tool("List Rooms", "list_rooms", "List all rooms and their member sessions.", {}, operations.list_rooms),
    tool("Create Room", "create_room", "Create a new room for coordinating multiple sessions.", {
      name: Type.String({ minLength: 1 }),
      objective: Type.Optional(Type.String()),
      project: Type.Optional(Type.String())
    }, operations.create_room),
    tool("Get Room", "get_room", "Get room details including member sessions.", {
      roomId: Type.Optional(Type.String()),
      roomName: Type.Optional(Type.String())
    }, operations.get_room),
    tool("Assign Session to Room", "assign_session_to_room", "Add a session to a room with an optional role.", {
      roomId: Type.Optional(Type.String()),
      roomName: Type.Optional(Type.String()),
      sessionId: Type.Optional(Type.String()),
      sessionName: Type.Optional(Type.String()),
      role: Type.Optional(Type.String()),
      rolePresetId: Type.Optional(Type.String()),
      rolePrompt: Type.Optional(Type.String()),
      injectRolePrompt: Type.Optional(Type.Boolean())
    }, operations.assign_session_to_room),
    tool("Send Room Message", "send_room_message", "Send a message to sessions in a room. Target mode can be 'all', 'role', or 'session'.", {
      roomId: Type.Optional(Type.String()),
      roomName: Type.Optional(Type.String()),
      text: Type.String({ minLength: 1 }),
      targetMode: Type.Optional(Type.String({ description: "all, role, or session" })),
      targetRole: Type.Optional(Type.String()),
      targetSessionIds: Type.Optional(Type.Array(Type.String())),
      fromSessionId: Type.Optional(Type.String())
    }, operations.send_room_message),
    tool("List Room Messages", "list_room_messages", "Get message history for a room.", {
      roomId: Type.Optional(Type.String()),
      roomName: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 500 }))
    }, operations.list_room_messages),
    tool("List Workflow Templates", "list_workflow_templates", "List available workflow templates for creating workflow runs.", {}, operations.list_workflow_templates),
    tool("List Workflows", "list_workflows", "List workflow runs in a room, or active workflow runs when no room is specified.", {
      roomId: Type.Optional(Type.String()),
      roomName: Type.Optional(Type.String()),
      activeOnly: Type.Optional(Type.Boolean())
    }, operations.list_workflows),
    tool("Create Workflow Run", "create_workflow_run", "Create a new workflow run in a room. Requires roomId and objective.", {
      roomId: Type.Optional(Type.String()),
      roomName: Type.Optional(Type.String()),
      objective: Type.String({ minLength: 1 }),
      templateId: Type.Optional(Type.String())
    }, operations.create_workflow_run),
    tool("Start Workflow Run", "start_workflow_run", "Start a workflow run to begin task assignment and execution.", {
      runId: Type.Optional(Type.String()),
      runName: Type.Optional(Type.String()),
      eventKey: Type.Optional(Type.String())
    }, operations.start_workflow_run),
    tool("Get Workflow Supervisor", "get_workflow_supervisor", "Read PM supervision status, observations, detected issues, and interventions for a workflow.", {
      runId: Type.String({ minLength: 1 })
    }, operations.get_workflow_supervisor),
    tool("Tick Workflow Supervisor", "tick_workflow_supervisor", "Run PM supervision once for a workflow now.", {
      runId: Type.String({ minLength: 1 })
    }, operations.tick_workflow_supervisor),
    tool("Update Workflow Supervisor Policy", "update_workflow_supervisor_policy", "Update PM supervision runtime policy. Durations are milliseconds.", {
      runId: Type.String({ minLength: 1 }),
      pmAgentEnabled: Type.Optional(Type.Boolean()),
      intervalMs: Type.Optional(Type.Number({ minimum: 0 })),
      stallMs: Type.Optional(Type.Number({ minimum: 0 })),
      hardTimeoutMs: Type.Optional(Type.Number({ minimum: 0 })),
      sameActionCooldownMs: Type.Optional(Type.Number({ minimum: 0 })),
      maxInterventionsPerAssignment: Type.Optional(Type.Number({ minimum: 0 })),
      maxSpawnedAgentsPerRoom: Type.Optional(Type.Number({ minimum: 0 }))
    }, operations.update_workflow_supervisor_policy),
    tool("Setup Workflow Room", "setup_workflow_room", "Create a complete workflow environment with room, role sessions, and workflow run. Use this when user wants to set up a multi-agent workflow project with specific roles and session kinds.", {
      project: Type.Optional(Type.String({ description: "Project directory path" })),
      objective: Type.String({ minLength: 1, description: "Workflow objective/task goal" }),
      roomId: Type.Optional(Type.String()),
      roomName: Type.Optional(Type.String()),
      roles: Type.Array(Type.Object({
        name: Type.String({ description: "Role name: coder, planner, tester, testerall, etc." }),
        kind: Type.Optional(Type.String({ description: "Session kind: claude, codex, opencode, pi-os, runtime" })),
        deploymentMode: Type.Optional(Type.String({ description: "host or docker" })),
        dockerName: Type.Optional(Type.String()),
        rolePrompt: Type.Optional(Type.String()),
        rolePresetId: Type.Optional(Type.String()),
        injectRolePrompt: Type.Optional(Type.Boolean())
      }), { minItems: 1 }),
      templateId: Type.Optional(Type.String()),
      autoStart: Type.Optional(Type.Boolean({ description: "Auto-start workflow after creation (default: true)" }))
    }, operations.setup_workflow_room)
  ];
}

function tool(label, name, description, schema, execute) {
  const parameters = Type.Object(schema);
  return {
    label,
    name,
    description,
    parameters,
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      const details = await execute(params);
      return {
        content: [{ type: "text", text: JSON.stringify(details) }],
        details
      };
    }
  };
}

function targetSchema(extra) {
  return {
    target: Type.Optional(Type.String()),
    targetIndex: Type.Optional(Type.Number({ minimum: 1 })),
    currentSessionId: Type.Optional(Type.String()),
    ...extra
  };
}

function buildUserPrompt(text, request) {
  const currentSessionId =
    typeof request.currentSessionId === "string" && request.currentSessionId.trim()
      ? request.currentSessionId.trim()
      : null;
  return [
    `User request: ${text}`,
    `Current selected session id: ${currentSessionId ?? "none"}`,
    "Use tools when the request asks about or changes Session Gateway sessions.",
    "After tools return backend output, answer the user's actual request from that output."
  ].join("\n");
}

function buildRoomContextPrompt(roomContext) {
  if (!roomContext || typeof roomContext !== "object") return "";
  const lines = [
    "",
    "## Room Context (Group Chat Mode)",
    `You are operating as the room assistant for room "${roomContext.roomName}".`,
    `Current room ID: ${roomContext.roomId}`,
  ];
  if (roomContext.project) lines.push(`Project: ${roomContext.project}`);
  if (roomContext.objective) lines.push(`Objective: ${roomContext.objective}`);
  if (Array.isArray(roomContext.sessions) && roomContext.sessions.length) {
    lines.push("");
    lines.push("Room member sessions:");
    for (const s of roomContext.sessions) {
      const role = s.role ? ` [${s.role}]` : "";
      const status = s.status === "running" ? "●" : "○";
      lines.push(`  ${status} ${s.sessionName}${role}`);
    }
    lines.push("");
    lines.push("When the user asks to send a task or message to the room, use send_room_message.");
    lines.push("When the user asks to assign a role, use assign_session_to_room.");
    lines.push("When the user asks to CREATE A NEW WORKFLOW with specific roles and session kinds, use setup_workflow_room.");
    lines.push("IMPORTANT: If user says '创建一个工作流' with roles like 'coder用claude', 'planner用...' - this is a workflow setup request, use setup_workflow_room with the current roomId to create a workflow run in this room.");
  }
  return lines.join("\n");
}

function buildBackendOutputPrompt(text, request, actions) {
  const currentSessionId =
    typeof request.currentSessionId === "string" && request.currentSessionId.trim()
      ? request.currentSessionId.trim()
      : null;
  return [
    "Backend tool output for web-pi synthesis:",
    `Original user request: ${text}`,
    `Current selected session id: ${currentSessionId ?? "none"}`,
    "Do not call tools. Use the backend output below to produce the final answer.",
    "If the user asked for a summary, summarize the session output directly in Chinese.",
    "If an action was performed, state the concrete result. Do not say only '操作已完成'.",
    truncateForModel(JSON.stringify(actions.map((action) => ({
      tool: action.tool,
      ok: action.ok,
      details: action.details
    })), null, 2), 40000)
  ].join("\n\n");
}

function buildAssistantResponse(agent, actions, requestText = "") {
  const assistant = [...(agent.state?.messages ?? [])].reverse().find((message) => message.role === "assistant");
  const answer = assistantText(assistant);
  const merged = mergeActionDetails(actions, requestText);
  const updateTerminal = shouldUpdateTerminal(actions, requestText);
  return {
    command: { type: "assistant", source: "web-pi" },
    ok: !agent.state?.errorMessage,
    answer,
    actions,
    presentation: { updateTerminal },
    ...merged
  };
}

function mergeActionDetails(actions, requestText = "") {
  const output = {};
  for (const action of actions) {
    const details = action.details;
    if (!details || typeof details !== "object") continue;
    if (details.session) output.session = details.session;
    if (typeof details.output === "string" && shouldExposeActionOutput(action, requestText)) {
      output.output = details.output;
    }
    if (Array.isArray(details.sessions)) output.sessions = details.sessions;
  }
  return output;
}

function shouldUpdateTerminal(actions, requestText = "") {
  if (isSummaryIntent(requestText)) return false;
  return actions.some((action) => shouldExposeActionOutput(action, requestText));
}

function shouldExposeActionOutput(action, requestText = "") {
  if (isSummaryIntent(requestText)) return false;
  return action.tool === "get_session_output" || action.tool === "switch_session" || action.tool === "send_to_session";
}

function isSummaryIntent(text = "") {
  return /总结|摘要|概括|归纳|summary|summari[sz]e|recap/i.test(String(text));
}

function shouldSendBackendOutputToWebPi(text, actions, agent) {
  if (!actions.length) return false;
  if (isSummaryIntent(text)) return true;
  const answer = assistantText([...((agent.state?.messages) ?? [])].reverse().find((message) => message.role === "assistant"));
  if (/^(?:操作已完成|已完成|完成|done|completed)[。.!！\s]*$/iu.test(answer)) return true;
  return actions.some((action) => action.details && typeof action.details === "object" && "output" in action.details);
}

function truncateForModel(text, maxChars) {
  const value = String(text ?? "");
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n\n[truncated ${value.length - maxChars} chars]`;
}

function assistantText(message) {
  if (!message?.content) return "";
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function resolveSessionAgentModel(settings = {}) {
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
