import assert from "node:assert/strict";
import test from "node:test";
import { createSessionAgentManager } from "../src/session_agent.mjs";

test("session agent exposes only Session Gateway tools and returns session lists", async () => {
  const fake = createFakeAgent(async (agent, emit) => {
    const tool = agent.state.tools.find((entry) => entry.name === "list_sessions");
    const result = await tool.execute("tool-1", {});
    emit({ type: "tool_execution_end", toolName: tool.name, result, isError: false });
    agent.state.messages.push({
      role: "assistant",
      content: [{ type: "text", text: "当前有 1 个会话。" }]
    });
  });
  const manager = createSessionAgentManager(
    { config: { runtimeSettings: { sessionAgent: {} } } },
    createOperations({
      async list_sessions() {
        return { sessions: [{ id: "s1", name: "main", taskState: "in_progress" }] };
      }
    }),
    { agent: fake }
  );

  const result = await manager.run("看看所有会话状态", {});

  assert.deepEqual(
    fake.state.tools.map((tool) => tool.name).sort(),
    [
      "assign_session_to_room",
      "create_room",
      "create_session",
      "create_workflow_run",
      "get_workflow_supervisor",
      "get_room",
      "get_session_output",
      "list_room_messages",
      "list_rooms",
      "list_sessions",
      "list_workflows",
      "list_workflow_templates",
      "restart_session",
      "send_keys_to_session",
      "send_room_message",
      "send_to_session",
      "setup_workflow_room",
      "start_workflow_run",
      "stop_session",
      "summarize_session_states",
      "switch_session",
      "tick_workflow_supervisor",
      "update_workflow_supervisor_policy"
    ].sort()
  );
  assert.equal(fake.state.tools.some((tool) => /shell|file|search|delete/i.test(tool.name)), false);
  assert.equal(result.command.type, "assistant");
  assert.equal(result.command.source, "web-pi");
  assert.equal(result.answer, "当前有 1 个会话。");
  assert.deepEqual(result.sessions, [{ id: "s1", name: "main", taskState: "in_progress" }]);
});

test("session agent switch action returns target session and output", async () => {
  const session = { id: "s2", name: "second", taskState: "completed" };
  let promptCount = 0;
  const fake = createFakeAgent(async (agent, emit) => {
    promptCount += 1;
    if (promptCount === 2) {
      agent.state.messages.push({
        role: "assistant",
        content: [{ type: "text", text: "已切到 second，并读取了最近输出。" }]
      });
      return;
    }
    const tool = agent.state.tools.find((entry) => entry.name === "switch_session");
    const result = await tool.execute("tool-1", { targetIndex: 2 });
    emit({ type: "tool_execution_end", toolName: tool.name, result, isError: false });
    agent.state.messages.push({
      role: "assistant",
      content: [{ type: "text", text: "已切到 second。" }]
    });
  });
  const manager = createSessionAgentManager(
    { config: { runtimeSettings: { sessionAgent: {} } } },
    createOperations({
      async switch_session() {
        return { session, output: "recent output" };
      }
    }),
    { agent: fake }
  );

  const result = await manager.run("切到第二个会话", {});

  assert.equal(result.answer, "已切到 second，并读取了最近输出。");
  assert.deepEqual(result.session, session);
  assert.equal(result.output, "recent output");
  assert.deepEqual(result.presentation, { updateTerminal: true });
  assert.equal(promptCount, 2);
});

test("session agent summary requests do not expose raw output to the UI", async () => {
  const session = { id: "s1", name: "main", taskState: "completed" };
  const prompts = [];
  const fake = createFakeAgent(async (agent, emit) => {
    prompts.push(agent.state.messages.at(-1).content);
    if (prompts.length === 2) {
      agent.state.messages.push({
        role: "assistant",
        content: [{ type: "text", text: "当前会话完成了测试并等待下一步。" }]
      });
      return;
    }
    const tool = agent.state.tools.find((entry) => entry.name === "get_session_output");
    const result = await tool.execute("tool-1", { currentSessionId: "main", lines: 50 });
    emit({ type: "tool_execution_end", toolName: tool.name, result, isError: false });
    agent.state.messages.push({
      role: "assistant",
      content: [{ type: "text", text: "操作已完成。" }]
    });
  });
  const manager = createSessionAgentManager(
    { config: { runtimeSettings: { sessionAgent: {} } } },
    createOperations({
      async get_session_output() {
        return { session, output: "very long raw terminal output" };
      }
    }),
    { agent: fake }
  );

  const result = await manager.run("查看当前会话，并进行总结", { currentSessionId: "main" });

  assert.equal(result.answer, "当前会话完成了测试并等待下一步。");
  assert.deepEqual(result.session, session);
  assert.equal("output" in result, false);
  assert.deepEqual(result.presentation, { updateTerminal: false });
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /Backend tool output for web-pi synthesis/);
  assert.match(prompts[1], /very long raw terminal output/);
});

test("session agent confirmation can send Enter through the key tool", async () => {
  const sent = [];
  const fake = createFakeAgent(async (agent, emit) => {
    const tool = agent.state.tools.find((entry) => entry.name === "send_keys_to_session");
    const result = await tool.execute("tool-1", { target: "test2", keys: ["Enter"] });
    emit({ type: "tool_execution_end", toolName: tool.name, result, isError: false });
    agent.state.messages.push({
      role: "assistant",
      content: [{ type: "text", text: "已确认 test2。" }]
    });
  });
  const manager = createSessionAgentManager(
    { config: { runtimeSettings: { sessionAgent: {} } } },
    createOperations({
      async send_keys_to_session(params) {
        sent.push(params);
        return { ok: true, session: { id: "s2", name: "test2" }, keys: params.keys };
      }
    }),
    { agent: fake }
  );

  const result = await manager.run("允许 test2", {});

  assert.deepEqual(sent, [{ target: "test2", keys: ["Enter"] }]);
  assert.equal(result.session.name, "test2");
});

test("session agent exposes PM supervisor workflow tools", async () => {
  const calls = [];
  const fake = createFakeAgent(async (agent, emit) => {
    const statusTool = agent.state.tools.find((entry) => entry.name === "get_workflow_supervisor");
    const status = await statusTool.execute("tool-1", { runId: "run-1" });
    emit({ type: "tool_execution_end", toolName: statusTool.name, result: status, isError: false });

    const policyTool = agent.state.tools.find((entry) => entry.name === "update_workflow_supervisor_policy");
    const policy = await policyTool.execute("tool-2", {
      runId: "run-1",
      pmAgentEnabled: true,
      stallMs: 300000,
      maxInterventionsPerAssignment: 2
    });
    emit({ type: "tool_execution_end", toolName: policyTool.name, result: policy, isError: false });

    agent.state.messages.push({
      role: "assistant",
      content: [{ type: "text", text: "已查看 run-1 的 PM 监督状态，并把卡住判定调整为 5 分钟。" }]
    });
  });
  const manager = createSessionAgentManager(
    { config: { runtimeSettings: { sessionAgent: {} } } },
    createOperations({
      async get_workflow_supervisor(params) {
        calls.push(["get", params]);
        return {
          workflow: { id: "run-1", status: "executing" },
          supervisor: { enabled: true, observations: [], interventions: [] }
        };
      },
      async update_workflow_supervisor_policy(params) {
        calls.push(["update", params]);
        return {
          workflow: { id: "run-1", status: "executing" },
          supervisor: { options: { pmAgentEnabled: true, stallMs: 300000, maxInterventionsPerAssignment: 2 } }
        };
      }
    }),
    { agent: fake }
  );

  const result = await manager.run("检查 run-1 的 PM 监督状态，并把卡住判定改成 5 分钟", {});

  assert.equal(result.answer, "已查看 run-1 的 PM 监督状态，并把卡住判定调整为 5 分钟。");
  assert.deepEqual(calls, [
    ["get", { runId: "run-1" }],
    ["update", { runId: "run-1", pmAgentEnabled: true, stallMs: 300000, maxInterventionsPerAssignment: 2 }]
  ]);
});

function createOperations(overrides = {}) {
  return {
    setCurrentRequest() {},
    async list_sessions() {
      return { sessions: [] };
    },
    async get_session_output() {
      return { output: "" };
    },
    async send_to_session() {
      return { ok: true };
    },
    async send_keys_to_session() {
      return { ok: true };
    },
    async switch_session() {
      return { session: null, output: "" };
    },
    async stop_session() {
      return { ok: true };
    },
    async restart_session() {
      return { session: null };
    },
    async create_session() {
      return { session: null };
    },
    async summarize_session_states() {
      return "{}";
    },
    async list_rooms() {
      return { rooms: [] };
    },
    async create_room() {
      return { room: null };
    },
    async get_room() {
      return { room: null };
    },
    async assign_session_to_room() {
      return { room: null, membership: null, session: null };
    },
    async send_room_message() {
      return { message: null };
    },
    async list_room_messages() {
      return { room: null, messages: [] };
    },
    async list_workflow_templates() {
      return { templates: [] };
    },
    async list_workflows() {
      return { workflows: [] };
    },
    async create_workflow_run() {
      return { workflow: null, room: null };
    },
    async start_workflow_run() {
      return { workflow: null };
    },
    async get_workflow_supervisor() {
      return { workflow: null, supervisor: null };
    },
    async tick_workflow_supervisor() {
      return { workflow: null, result: null };
    },
    async update_workflow_supervisor_policy() {
      return { workflow: null, supervisor: null };
    },
    async setup_workflow_room() {
      return { room: null, sessions: [], workflow: null };
    },
    ...overrides
  };
}

function createFakeAgent(onPrompt) {
  const listeners = new Set();
  const agent = {
    state: {
      systemPrompt: "",
      tools: [],
      messages: [],
      errorMessage: undefined
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async prompt(input) {
      this.state.messages.push({ role: "user", content: input });
      const emit = (event) => {
        for (const listener of listeners) listener(event);
      };
      await onPrompt(this, emit);
    },
    reset() {
      this.state.messages = [];
    }
  };
  return agent;
}
