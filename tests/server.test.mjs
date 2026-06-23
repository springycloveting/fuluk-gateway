import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { dispatchPendingWorkflowAssignments, handleSessionGatewayRequest, reconcileWorkflowResults } from "../src/server.mjs";
import { SessionStore } from "../src/store.mjs";
import { createWorkflowSupervisor } from "../src/workflow_supervisor.mjs";

test("/api/nl output uses currentSessionId and returns JSON output", async () => {
  const session = {
    id: "session-1",
    name: "main",
    kind: "codex",
    status: "running",
    cwd: "/workspace/app",
    tmuxSessionName: "session-1"
  };
  const saved = [];
  const store = {
    findByIdOrName(value) {
      return value === session.id || value === session.name ? session : null;
    },
    saveOutput(sessionId, lines, text) {
      saved.push({ sessionId, lines, text });
    }
  };
  const captures = [];
  const tmux = {
    async capture(record, lines) {
      captures.push({ sessionId: record.id, lines });
      return "recent output";
    }
  };
  const req = Readable.from([JSON.stringify({ text: "查看会话", currentSessionId: "main" })]);
  req.method = "POST";
  req.url = "/api/nl";
  req.headers = {
    host: "localhost",
    authorization: "Bearer secret"
  };
  const res = {
    statusCode: null,
    headers: null,
    body: "",
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(body = "") {
      this.body = String(body);
    }
  };

  await handleSessionGatewayRequest(req, res, {
    config: {
      authToken: "secret",
      allowRuntimeMode: true,
      runtimeSettings: {},
      runtimeSettingsEnabled: false
    },
    store,
    tmux
  });

  assert.equal(res.statusCode, 200);
  assert.match(res.headers["content-type"], /application\/json/);
  assert.deepEqual(JSON.parse(res.body), {
    command: {
      type: "output",
      target: null,
      lines: 50,
      needsCurrentSession: true
    },
    session,
    output: "recent output"
  });
  assert.deepEqual(captures, [{ sessionId: "session-1", lines: 50 }]);
  assert.deepEqual(saved, [{ sessionId: "session-1", lines: 50, text: "recent output" }]);
});

test("/api/nl send can target a session by list position", async () => {
  const sessions = [
    { id: "session-1", name: "first", kind: "codex", status: "running", cwd: "/one", tmuxSessionName: "session-1" },
    { id: "session-2", name: "second", kind: "codex", status: "running", cwd: "/two", tmuxSessionName: "session-2" }
  ];
  const touched = [];
  const saved = [];
  const store = {
    list() {
      return sessions;
    },
    touch(sessionId) {
      touched.push(sessionId);
    },
    saveOutput(sessionId, lines, text) {
      saved.push({ sessionId, lines, text });
    },
    findByIdOrName() {
      throw new Error("current session should not be used for targetIndex send");
    }
  };
  const sent = [];
  const captures = [];
  const tmux = {
    async send(record, text) {
      sent.push({ sessionId: record.id, text });
    },
    async capture(record, lines) {
      captures.push({ sessionId: record.id, lines });
      return "sent output";
    }
  };
  const req = Readable.from([JSON.stringify({ text: "发送到第二个会话修改配置", currentSessionId: "first" })]);
  req.method = "POST";
  req.url = "/api/nl";
  req.headers = {
    host: "localhost",
    authorization: "Bearer secret"
  };
  const res = {
    statusCode: null,
    headers: null,
    body: "",
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(body = "") {
      this.body = String(body);
    }
  };

  await handleSessionGatewayRequest(req, res, {
    config: {
      authToken: "secret",
      allowRuntimeMode: true,
      runtimeSettings: {},
      runtimeSettingsEnabled: false,
      sendFollowupDelayMs: 0
    },
    store,
    tmux
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), {
    command: {
      type: "send",
      target: null,
      targetIndex: 2,
      text: "修改配置",
      needsCurrentSession: false
    },
    ok: true,
    session: sessions[1],
    output: "sent output"
  });
  assert.deepEqual(sent, [{ sessionId: "session-2", text: "修改配置" }]);
  assert.deepEqual(touched, ["session-2"]);
  assert.deepEqual(captures, [{ sessionId: "session-2", lines: 30 }]);
  assert.deepEqual(saved, [{ sessionId: "session-2", lines: 30, text: "sent output" }]);
});

test("/api/nl output can target a session by list position", async () => {
  const sessions = [
    { id: "session-1", name: "first", kind: "codex", status: "running", cwd: "/one", tmuxSessionName: "session-1" },
    { id: "session-2", name: "second", kind: "codex", status: "running", cwd: "/two", tmuxSessionName: "session-2" },
    { id: "session-3", name: "third", kind: "codex", status: "running", cwd: "/three", tmuxSessionName: "session-3" }
  ];
  const saved = [];
  const store = {
    list() {
      return sessions;
    },
    saveOutput(sessionId, lines, text) {
      saved.push({ sessionId, lines, text });
    },
    findByIdOrName() {
      throw new Error("current session should not be used for targetIndex output");
    }
  };
  const captures = [];
  const tmux = {
    async capture(record, lines) {
      captures.push({ sessionId: record.id, lines });
      return "third output";
    }
  };

  const { statusCode, body } = await postJson("/api/nl", {
    text: "查看第三个会话",
    currentSessionId: "session-1"
  }, {
    config: {
      authToken: "secret",
      allowRuntimeMode: true,
      runtimeSettings: {},
      runtimeSettingsEnabled: false
    },
    store,
    tmux
  });

  assert.equal(statusCode, 200);
  assert.deepEqual(JSON.parse(body), {
    command: {
      type: "output",
      target: null,
      targetIndex: 3,
      lines: 50,
      needsCurrentSession: false
    },
    session: sessions[2],
    output: "third output"
  });
  assert.deepEqual(captures, [{ sessionId: "session-3", lines: 50 }]);
  assert.deepEqual(saved, [{ sessionId: "session-3", lines: 50, text: "third output" }]);
});

test("/api/sessions output raw mode preserves terminal escapes", async () => {
  const session = {
    id: "session-1",
    name: "opencode",
    kind: "opencode",
    status: "running",
    cwd: "/workspace/app",
    tmuxSessionName: "session-1"
  };
  const captures = [];
  const saved = [];
  const store = {
    findByIdOrName(value) {
      return value === session.id || value === session.name ? session : null;
    },
    saveOutput(sessionId, lines, text) {
      saved.push({ sessionId, lines, text });
    }
  };
  const tmux = {
    async capture(record, lines, options) {
      captures.push({ sessionId: record.id, lines, options });
      return "\u001b[32mModel menu\u001b[0m";
    }
  };

  const { statusCode, body } = await getJson("/api/sessions/session-1/output?lines=300&format=json&raw=1", {
    config: {
      authToken: "secret",
      allowRuntimeMode: true,
      runtimeSettings: {},
      runtimeSettingsEnabled: false
    },
    store,
    tmux
  });

  assert.equal(statusCode, 200);
  const parsed = JSON.parse(body);
  assert.equal(parsed.changed, true);
  assert.equal(parsed.output, "\u001b[32mModel menu\u001b[0m");
  assert.equal(typeof parsed.etag, "string");
  assert.deepEqual(captures, [
    {
      sessionId: "session-1",
      lines: 300,
      options: { preserveEscapes: true, alternateScreen: true, offset: 0 }
    }
  ]);
  assert.deepEqual(saved, [{ sessionId: "session-1", lines: 300, text: "\u001b[32mModel menu\u001b[0m" }]);
});

test("/api/sessions output forwards capture offset", async () => {
  const session = {
    id: "session-1",
    name: "opencode",
    kind: "opencode",
    status: "running",
    cwd: "/workspace/app",
    tmuxSessionName: "session-1"
  };
  const captures = [];
  const saved = [];
  const store = {
    findByIdOrName(value) {
      return value === session.id || value === session.name ? session : null;
    },
    saveOutput(sessionId, lines, text) {
      saved.push({ sessionId, lines, text });
    }
  };
  const tmux = {
    async capture(record, lines, options) {
      captures.push({ sessionId: record.id, lines, options });
      return "history window";
    }
  };

  const { statusCode, body } = await getJson("/api/sessions/session-1/output?lines=80&offset=40&format=json&raw=1", {
    config: {
      authToken: "secret",
      allowRuntimeMode: true,
      runtimeSettings: {},
      runtimeSettingsEnabled: false
    },
    store,
    tmux
  });

  assert.equal(statusCode, 200);
  const parsed = JSON.parse(body);
  assert.equal(parsed.changed, true);
  assert.equal(parsed.output, "history window");
  assert.equal(typeof parsed.etag, "string");
  assert.deepEqual(captures, [
    {
      sessionId: "session-1",
      lines: 80,
      options: { preserveEscapes: true, alternateScreen: true, offset: 40 }
    }
  ]);
  assert.deepEqual(saved, []);
});

test("UI polling endpoints do not exhaust the default API rate limit", async () => {
  const session = {
    id: "session-1",
    name: "opencode",
    kind: "opencode",
    status: "running",
    cwd: "/workspace/app",
    tmuxSessionName: "session-1"
  };
  const store = {
    findByIdOrName(value) {
      return value === session.id || value === session.name ? session : null;
    },
    saveOutput() {}
  };
  const tmux = {
    async capture() {
      return "current output";
    }
  };
  const context = {
    config: {
      authToken: "secret",
      allowRuntimeMode: true,
      runtimeSettings: {},
      runtimeSettingsEnabled: false
    },
    store,
    tmux
  };

  let lastResponse = null;
  for (let index = 0; index < 110; index += 1) {
    lastResponse = await getJson("/api/sessions/session-1/output?lines=20&format=json", context);
  }

  assert.equal(lastResponse.statusCode, 200);
});

test("/api/sessions/:id/keys allows tmux mouse wheel keys", async () => {
  const session = {
    id: "session-1",
    name: "opencode",
    kind: "opencode",
    status: "running",
    cwd: "/workspace/app",
    tmuxSessionName: "session-1"
  };
  const sent = [];
  const store = {
    findByIdOrName(value) {
      return value === session.id || value === session.name ? session : null;
    },
    touch() {}
  };
  const tmux = {
    async sendKeys(record, keys) {
      sent.push({ sessionId: record.id, keys });
    }
  };

  const { statusCode, body } = await postJson(
    "/api/sessions/session-1/keys",
    { keys: ["WheelUpPane", "WheelDownPane"] },
    {
      config: {
        authToken: "secret",
        allowRuntimeMode: true,
        runtimeSettings: {},
        runtimeSettingsEnabled: false
      },
      store,
      tmux
    }
  );

  assert.equal(statusCode, 200);
  assert.deepEqual(JSON.parse(body), { ok: true });
  assert.deepEqual(sent, [{ sessionId: "session-1", keys: ["WheelUpPane", "WheelDownPane"] }]);
});

test("/api/sessions/:id/keys normalizes browser page keys to tmux keys", async () => {
  const session = {
    id: "session-1",
    name: "opencode",
    kind: "opencode",
    status: "running",
    cwd: "/workspace/app",
    tmuxSessionName: "session-1"
  };
  const sent = [];
  const touched = [];
  const store = {
    findByIdOrName(value) {
      return value === session.id || value === session.name ? session : null;
    },
    touch(sessionId) {
      touched.push(sessionId);
    }
  };
  const tmux = {
    async sendKeys(record, keys) {
      sent.push({ sessionId: record.id, keys });
    }
  };

  const { statusCode, body } = await postJson(
    "/api/sessions/session-1/keys",
    { keys: ["PageUp", "PageDown", "Enter"] },
    {
      config: {
        authToken: "secret",
        allowRuntimeMode: true,
        runtimeSettings: {},
        runtimeSettingsEnabled: false
      },
      store,
      tmux
    }
  );

  assert.equal(statusCode, 200);
  assert.deepEqual(JSON.parse(body), { ok: true });
  assert.deepEqual(sent, [{ sessionId: "session-1", keys: ["PPage", "NPage", "Enter"] }]);
  assert.deepEqual(touched, ["session-1"]);
});

test("/api/sessions/:id/resize resizes only the selected session", async () => {
  const session = {
    id: "session-1",
    name: "main",
    kind: "opencode",
    status: "running",
    cwd: "/workspace/app",
    tmuxSessionName: "session-1"
  };
  const resized = [];
  const touched = [];
  const { statusCode, body } = await postJson(
    "/api/sessions/main/resize",
    { cols: 132, rows: 40 },
    {
      config: {
        authToken: "secret",
        allowRuntimeMode: true,
        runtimeSettings: {},
        runtimeSettingsEnabled: false
      },
      store: {
        findByIdOrName(value) {
          return value === session.id || value === session.name ? session : null;
        },
        touch(sessionId) {
          touched.push(sessionId);
        }
      },
      tmux: {
        async resize(record, cols, rows) {
          resized.push({ sessionId: record.id, cols, rows });
        }
      }
    }
  );

  assert.equal(statusCode, 200);
  assert.deepEqual(JSON.parse(body), { ok: true });
  assert.deepEqual(resized, [{ sessionId: "session-1", cols: 132, rows: 40 }]);
  assert.deepEqual(touched, ["session-1"]);
});

test("/api/sessions/:id/resize rejects invalid terminal sizes", async () => {
  const session = {
    id: "session-1",
    name: "main",
    kind: "opencode",
    status: "running",
    cwd: "/workspace/app",
    tmuxSessionName: "session-1"
  };
  const resized = [];
  const { statusCode, body } = await postJson(
    "/api/sessions/main/resize",
    { cols: 10, rows: 40 },
    {
      config: {
        authToken: "secret",
        allowRuntimeMode: true,
        runtimeSettings: {},
        runtimeSettingsEnabled: false
      },
      store: {
        findByIdOrName(value) {
          return value === session.id || value === session.name ? session : null;
        }
      },
      tmux: {
        async resize(record, cols, rows) {
          resized.push({ sessionId: record.id, cols, rows });
        }
      }
    }
  );

  assert.equal(statusCode, 400);
  assert.match(JSON.parse(body).error, /cols must be an integer/);
  assert.deepEqual(resized, []);
});

test("/api/nl send can target a named session through the submitting send path", async () => {
  const glassSession = {
    id: "session-glass",
    name: "glass-to-ai",
    kind: "codex",
    status: "running",
    cwd: "/workspace/glass",
    tmuxSessionName: "glass-to-ai"
  };
  const touched = [];
  const saved = [];
  const store = {
    findByIdOrName(value) {
      return value === glassSession.id || value === glassSession.name ? glassSession : null;
    },
    touch(sessionId) {
      touched.push(sessionId);
    },
    saveOutput(sessionId, lines, text) {
      saved.push({ sessionId, lines, text });
    }
  };
  const sent = [];
  const captures = [];
  const tmux = {
    async send(record, text) {
      sent.push({ sessionId: record.id, text, submitted: true });
    },
    async capture(record, lines) {
      captures.push({ sessionId: record.id, lines });
      return "glass output";
    }
  };
  const req = Readable.from([JSON.stringify({ text: "发送到glass-to-ai会话修改配置", currentSessionId: "other" })]);
  req.method = "POST";
  req.url = "/api/nl";
  req.headers = {
    host: "localhost",
    authorization: "Bearer secret"
  };
  const res = {
    statusCode: null,
    headers: null,
    body: "",
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(body = "") {
      this.body = String(body);
    }
  };

  await handleSessionGatewayRequest(req, res, {
    config: {
      authToken: "secret",
      allowRuntimeMode: true,
      runtimeSettings: {},
      runtimeSettingsEnabled: false,
      sendFollowupDelayMs: 0
    },
    store,
    tmux
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), {
    command: {
      type: "send",
      target: "glass-to-ai",
      text: "修改配置",
      needsCurrentSession: false
    },
    ok: true,
    session: glassSession,
    output: "glass output"
  });
  assert.deepEqual(sent, [{ sessionId: "session-glass", text: "修改配置", submitted: true }]);
  assert.deepEqual(touched, ["session-glass"]);
  assert.deepEqual(captures, [{ sessionId: "session-glass", lines: 30 }]);
  assert.deepEqual(saved, [{ sessionId: "session-glass", lines: 30, text: "glass output" }]);
});

test("/api/nl send waits before returning 30 lines of current session output", async () => {
  const session = {
    id: "session-main",
    name: "main",
    kind: "codex",
    status: "running",
    cwd: "/workspace/main",
    tmuxSessionName: "main"
  };
  const sleeps = [];
  const saved = [];
  const store = {
    findByIdOrName(value) {
      return value === session.id || value === session.name ? session : null;
    },
    touch() {},
    saveOutput(sessionId, lines, text) {
      saved.push({ sessionId, lines, text });
    }
  };
  const calls = [];
  const tmux = {
    async send(record, text) {
      calls.push({ type: "send", sessionId: record.id, text });
    },
    async sleep(ms) {
      sleeps.push(ms);
      calls.push({ type: "sleep", ms });
    },
    async capture(record, lines) {
      calls.push({ type: "capture", sessionId: record.id, lines });
      return "after send";
    }
  };

  const { statusCode, body } = await postJson("/api/nl", {
    text: "发送 查看状态",
    currentSessionId: "main"
  }, {
    config: {
      authToken: "secret",
      allowRuntimeMode: true,
      runtimeSettings: {},
      runtimeSettingsEnabled: false
    },
    store,
    tmux
  });

  assert.equal(statusCode, 200);
  assert.equal(JSON.parse(body).output, "after send");
  assert.deepEqual(sleeps, [5000]);
  assert.deepEqual(calls, [
    { type: "send", sessionId: "session-main", text: "查看状态" },
    { type: "sleep", ms: 5000 },
    { type: "capture", sessionId: "session-main", lines: 30 }
  ]);
  assert.deepEqual(saved, [{ sessionId: "session-main", lines: 30, text: "after send" }]);
});

test("/api/sessions/:id/input records previous final answer before sending new instruction", async () => {
  const session = {
    id: "session-main",
    name: "main",
    kind: "codex",
    status: "running",
    cwd: "/workspace/main",
    tmuxSessionName: "main"
  };
  const calls = [];
  const store = {
    findByIdOrName(value) {
      return value === session.id || value === session.name ? session : null;
    },
    saveInput(sessionId, text) {
      calls.push({ type: "saveInput", sessionId, text });
    },
    touch(sessionId) {
      calls.push({ type: "touch", sessionId });
    }
  };
  const tmux = {
    async send(record, text) {
      calls.push({ type: "send", sessionId: record.id, text });
    }
  };
  const sessionRecorder = {
    async recordBeforeInput(record, text) {
      calls.push({ type: "record", sessionId: record.id, text });
    }
  };

  const { statusCode, body } = await postJson(
    "/api/sessions/session-main/input",
    { text: "继续实现" },
    {
      config: {
        authToken: "secret",
        allowRuntimeMode: true,
        runtimeSettings: {},
        runtimeSettingsEnabled: false
      },
      store,
      tmux,
      sessionRecorder
    }
  );

  assert.equal(statusCode, 200);
  assert.deepEqual(JSON.parse(body), { ok: true });
  assert.deepEqual(calls, [
    { type: "record", sessionId: "session-main", text: "继续实现" },
    { type: "send", sessionId: "session-main", text: "继续实现" },
    { type: "saveInput", sessionId: "session-main", text: "继续实现" },
    { type: "touch", sessionId: "session-main" }
  ]);
});

test("/api/sessions marks sessions that are waiting for confirmation", async () => {
  const sessions = [
    { id: "session-1", name: "needs-allow", kind: "codex", status: "running", cwd: "/one", tmuxSessionName: "one" },
    { id: "session-2", name: "working", kind: "codex", status: "running", cwd: "/two", tmuxSessionName: "two" },
    { id: "session-3", name: "done", kind: "runtime", status: "stopped", cwd: "/three", tmuxSessionName: "three" }
  ];
  const saved = [];
  const store = {
    list() {
      return sessions;
    },
    updateStatus() {},
    latestOutputSnapshot() {
      return null;
    },
    saveOutput(sessionId, lines, text) {
      saved.push({ sessionId, lines, text });
    }
  };
  const tmux = {
    async exists(record) {
      return record.status === "running";
    },
    async capture(record) {
      return record.id === "session-1" ? "allow?YES?\n1) yes\n2) no" : "still working";
    }
  };

  const { statusCode, body } = await getJson("/api/sessions", {
    config: {
      authToken: "secret",
      allowRuntimeMode: true,
      runtimeSettings: {},
      runtimeSettingsEnabled: false
    },
    store,
    tmux
  });

  assert.equal(statusCode, 200);
  const parsed = JSON.parse(body);
  assert.deepEqual(
    parsed.sessions.map((session) => ({ name: session.name, taskState: session.taskState })),
    [
      { name: "needs-allow", taskState: "needs_confirmation" },
      { name: "working", taskState: "in_progress" },
      { name: "done", taskState: "completed" }
    ]
  );
  assert.deepEqual(saved, [
    { sessionId: "session-1", lines: 80, text: "allow?YES?\n1) yes\n2) no" },
    { sessionId: "session-2", lines: 80, text: "still working" }
  ]);
});

test("/api/sessions recognizes allow variants in the latest 10 non-empty lines", async () => {
  const sessions = [
    { id: "session-1", name: "allow-dot", kind: "codex", status: "running", cwd: "/one", tmuxSessionName: "one" }
  ];
  const store = {
    list() {
      return sessions;
    },
    updateStatus() {},
    latestOutputSnapshot() {
      return null;
    },
    saveOutput() {}
  };
  const tmux = {
    async exists() {
      return true;
    },
    async capture() {
      return [
        "older line outside window",
        "padding 1",
        "padding 2",
        "padding 3",
        "padding 4",
        "padding 5",
        "padding 6",
        "padding 7",
        "padding 8",
        "1.Allow",
        "2.Allow once",
        "3.Allow allways"
      ].join("\n");
    }
  };

  const { statusCode, body } = await getJson("/api/sessions", {
    config: {
      authToken: "secret",
      allowRuntimeMode: true,
      runtimeSettings: {},
      runtimeSettingsEnabled: false
    },
    store,
    tmux
  });

  assert.equal(statusCode, 200);
  assert.equal(JSON.parse(body).sessions[0].taskState, "needs_confirmation");
});

test("/api/sessions recognizes opencode permission footer", async () => {
  const sessions = [
    { id: "session-1", name: "opencode-allow", kind: "opencode", status: "running", cwd: "/one", tmuxSessionName: "one" }
  ];
  const store = {
    list() {
      return sessions;
    },
    updateStatus() {},
    latestOutputSnapshot() {
      return null;
    },
    saveOutput() {}
  };
  const tmux = {
    async exists() {
      return true;
    },
    async capture() {
      return [
        "△ Permission required",
        "← Access external directory ~/.config/opencode",
        "Allow once   Allow always   Reject  ctrl+f fullscreen  ⇆ select  enter confirm"
      ].join("\n");
    }
  };

  const { statusCode, body } = await getJson("/api/sessions", {
    config: {
      authToken: "secret",
      allowRuntimeMode: true,
      runtimeSettings: {},
      runtimeSettingsEnabled: false
    },
    store,
    tmux
  });

  assert.equal(statusCode, 200);
  assert.equal(JSON.parse(body).sessions[0].taskState, "needs_confirmation");
});

test("/api/sessions marks unchanged output older than one minute as stopped", async () => {
  const staleTime = new Date(Date.now() - 61_000).toISOString();
  const sessions = [
    { id: "session-1", name: "idle", kind: "codex", status: "running", cwd: "/one", tmuxSessionName: "one" },
    { id: "session-2", name: "confirm", kind: "codex", status: "running", cwd: "/two", tmuxSessionName: "two" },
    { id: "session-3", name: "changed", kind: "codex", status: "running", cwd: "/three", tmuxSessionName: "three" }
  ];
  const saved = [];
  const store = {
    list() {
      return sessions;
    },
    updateStatus() {},
    latestOutputSnapshot(sessionId) {
      return {
        id: 1,
        sessionId,
        capturedAt: staleTime,
        lines: 80,
        text: sessionId === "session-2" ? "Allow once   Allow always   Reject" : "same output"
      };
    },
    saveOutput(sessionId, lines, text) {
      const snapshot = { id: 2, sessionId, capturedAt: new Date().toISOString(), lines, text };
      saved.push(snapshot);
      return snapshot;
    }
  };
  const tmux = {
    async exists() {
      return true;
    },
    async capture(record) {
      if (record.id === "session-2") return "Allow once   Allow always   Reject";
      if (record.id === "session-3") return "new output";
      return "same output";
    }
  };

  const { statusCode, body } = await getJson("/api/sessions", {
    config: {
      authToken: "secret",
      allowRuntimeMode: true,
      runtimeSettings: {},
      runtimeSettingsEnabled: false
    },
    store,
    tmux
  });

  assert.equal(statusCode, 200);
  const parsed = JSON.parse(body);
  assert.deepEqual(
    parsed.sessions.map((session) => ({ name: session.name, taskState: session.taskState })),
    [
      { name: "idle", taskState: "completed" },
      { name: "confirm", taskState: "needs_confirmation" },
      { name: "changed", taskState: "in_progress" }
    ]
  );
  assert.deepEqual(saved.map((snapshot) => snapshot.sessionId), ["session-3"]);
});

test("/api/sessions notifies when a session changes from in progress to stopped", async () => {
  const sessions = [
    { id: "session-1", name: "idle", kind: "codex", status: "running", cwd: "/one", tmuxSessionName: "one" }
  ];
  let captureCount = 0;
  const events = [];
  const webhookRequests = [];
  const context = {
    config: {
      authToken: "secret",
      allowRuntimeMode: true,
      runtimeSettings: {},
      runtimeSettingsEnabled: false,
      notificationWebhookUrl: "https://hooks.example/session"
    },
    store: {
      list() {
        return sessions;
      },
      updateStatus() {},
      latestOutputSnapshot() {
        return {
          id: 1,
          sessionId: "session-1",
          capturedAt: new Date(Date.now() - (captureCount > 0 ? 61_000 : 1_000)).toISOString(),
          lines: 80,
          text: "same output"
        };
      },
      saveOutput() {}
    },
    tmux: {
      async exists() {
        return true;
      },
      async capture() {
        captureCount += 1;
        return "same output";
      }
    },
    eventHub: {
      broadcast(event) {
        events.push(event);
      }
    },
    sessionTaskStates: new Map(),
    async fetchImpl(url, options) {
      webhookRequests.push({ url, body: JSON.parse(options.body) });
      return { ok: true };
    }
  };

  assert.equal((await getJson("/api/sessions", context)).statusCode, 200);
  assert.equal((await getJson("/api/sessions", context)).statusCode, 200);

  assert.equal(events.length, 1);
  assert.equal(events[0].type, "session_task_state_changed");
  assert.equal(events[0].previousTaskState, "in_progress");
  assert.equal(events[0].taskState, "completed");
  assert.equal(events[0].session.name, "idle");
  assert.equal(webhookRequests.length, 1);
  assert.equal(webhookRequests[0].url, "https://hooks.example/session");
  assert.equal(webhookRequests[0].body.taskState, "completed");
});

test("/api/sessions notifies when a session changes from in progress to needs confirmation", async () => {
  const sessions = [
    { id: "session-1", name: "confirm", kind: "opencode", status: "running", cwd: "/one", tmuxSessionName: "one" }
  ];
  let captureCount = 0;
  const events = [];
  const context = {
    config: {
      authToken: "secret",
      allowRuntimeMode: true,
      runtimeSettings: { notifications: { webhookUrl: "https://hooks.example/settings" } },
      runtimeSettingsEnabled: true
    },
    store: {
      list() {
        return sessions;
      },
      updateStatus() {},
      latestOutputSnapshot() {
        return {
          id: 1,
          sessionId: "session-1",
          capturedAt: new Date().toISOString(),
          lines: 80,
          text: captureCount > 0 ? "waiting" : "working"
        };
      },
      saveOutput(sessionId, lines, text) {
        return { id: 2, sessionId, capturedAt: new Date().toISOString(), lines, text };
      }
    },
    tmux: {
      async exists() {
        return true;
      },
      async capture() {
        captureCount += 1;
        return captureCount > 1 ? "Allow once   Allow always   Reject" : "working";
      }
    },
    eventHub: {
      broadcast(event) {
        events.push(event);
      }
    },
    sessionTaskStates: new Map(),
    async fetchImpl() {
      return { ok: true };
    }
  };

  assert.equal((await getJson("/api/sessions", context)).statusCode, 200);
  assert.equal((await getJson("/api/sessions", context)).statusCode, 200);

  assert.equal(events.length, 1);
  assert.equal(events[0].previousTaskState, "in_progress");
  assert.equal(events[0].taskState, "needs_confirmation");
  assert.equal(events[0].session.name, "confirm");
});

test("/api/nl switch can target a session by list position", async () => {
  const sessions = [
    { id: "session-1", name: "first", kind: "codex", status: "running", cwd: "/one", tmuxSessionName: "session-1" },
    { id: "session-2", name: "second", kind: "codex", status: "running", cwd: "/two", tmuxSessionName: "session-2" }
  ];
  const saved = [];
  const store = {
    list() {
      return sessions;
    },
    saveOutput(sessionId, lines, text) {
      saved.push({ sessionId, lines, text });
    }
  };
  const captures = [];
  const tmux = {
    async capture(record, lines) {
      captures.push({ sessionId: record.id, lines });
      return "second output";
    }
  };
  const req = Readable.from([JSON.stringify({ text: "切换到第二个会话", currentSessionId: "first" })]);
  req.method = "POST";
  req.url = "/api/nl";
  req.headers = {
    host: "localhost",
    authorization: "Bearer secret"
  };
  const res = {
    statusCode: null,
    headers: null,
    body: "",
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(body = "") {
      this.body = String(body);
    }
  };

  await handleSessionGatewayRequest(req, res, {
    config: {
      authToken: "secret",
      allowRuntimeMode: true,
      runtimeSettings: {},
      runtimeSettingsEnabled: false
    },
    store,
    tmux
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), {
    command: {
      type: "switch",
      target: null,
      targetIndex: 2
    },
    session: sessions[1],
    output: "second output"
  });
  assert.deepEqual(captures, [{ sessionId: "session-2", lines: 120 }]);
  assert.deepEqual(saved, [{ sessionId: "session-2", lines: 120, text: "second output" }]);
});

test("/api/sessions defaults missing docker cwd to /work/session-name", async () => {
  const records = [];
  const context = createCreateSessionContext({ cwdMode: "container", records });
  const { statusCode, body } = await postJson("/api/sessions", {
    kind: "codex",
    name: "web-ai-agent",
    deploymentMode: "docker",
    dockerName: "worker-codex"
  }, context);

  assert.equal(statusCode, 201);
  const parsed = JSON.parse(body);
  assert.equal(parsed.session.cwd, "/work/web-ai-agent");
  assert.equal(records[0].cwd, "/work/web-ai-agent");
  assert.deepEqual(records[0].commandArgs, ["exec", "-w", "/work/web-ai-agent", "-it", "worker-codex", "codex"]);
});

test("/api/sessions defaults missing host cwd to /home/v6/work/session-name", async () => {
  const records = [];
  const context = createCreateSessionContext({ cwdMode: "host", records });
  const { statusCode, body } = await postJson("/api/sessions", {
    kind: "runtime",
    name: "local-shell"
  }, context);

  assert.equal(statusCode, 201);
  const parsed = JSON.parse(body);
  assert.equal(parsed.session.cwd, "/home/v6/work/local-shell");
  assert.equal(records[0].cwd, "/home/v6/work/local-shell");
});

test("/api/nl create uses default cwd when command omits working directory", async () => {
  const records = [];
  const context = createCreateSessionContext({ cwdMode: "container", records });
  const { statusCode, body } = await postJson("/api/nl", {
    text: "新建一个 codex 会话 web-ai-agent",
    currentSessionId: null
  }, context);

  assert.equal(statusCode, 201);
  const parsed = JSON.parse(body);
  assert.equal(parsed.command.input.cwd, undefined);
  assert.equal(parsed.session.cwd, "/work/web-ai-agent");
  assert.equal(records[0].cwd, "/work/web-ai-agent");
});

test("/api/nl create applies non-docker text hints after command parsing", async () => {
  const records = [];
  const context = createCreateSessionContext({ records });
  const { statusCode, body } = await postJson("/api/nl", {
    text: "创建非docker模式的claude会话"
  }, context);

  assert.equal(statusCode, 201);
  const parsed = JSON.parse(body);
  assert.deepEqual(parsed.command.input.deployment, { mode: "host" });
  assert.equal(parsed.session.command, "claude");
  assert.match(parsed.session.cwd, /^\/home\/v6\/work\/claude-[A-Za-z0-9-]+$/);
  assert.equal(records[0].cwd, parsed.session.cwd);
});

test("/api/nl rejects AI parser create guesses without explicit create intent", async () => {
  const records = [];
  const context = createCreateSessionContext({ records });
  context.config.runtimeSettings = {
    commandParser: {
      enabled: true,
      baseUrl: "http://parser.test/v1",
      model: "parser"
    }
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    async json() {
      return {
        choices: [
          {
            message: {
              content: JSON.stringify({
                type: "create",
                input: { kind: "codex", name: "guessed-window", project: null }
              })
            }
          }
        ]
      };
    }
  });

  try {
    const { statusCode, body } = await postJson("/api/nl", {
      text: "整理一下当前项目结构",
      currentSessionId: "session-main"
    }, context);

    assert.equal(statusCode, 400);
    assert.match(JSON.parse(body).error, /explicit create-session request/);
    assert.equal(records.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("/api/sessions rejects runtime session when allowRuntimeMode is false", async () => {
  const records = [];
  const context = createCreateSessionContext({ records });
  context.config.allowRuntimeMode = false;

  const { statusCode, body } = await postJson("/api/sessions", {
    kind: "runtime",
    name: "local-shell"
  }, context);

  assert.equal(statusCode, 400);
  const parsed = JSON.parse(body);
  assert.match(parsed.error, /Runtime mode is disabled/);
  assert.equal(records.length, 0);
});

test("/api/sessions allows runtime session when allowRuntimeMode is true", async () => {
  const records = [];
  const context = createCreateSessionContext({ cwdMode: "host", records });
  context.config.allowRuntimeMode = true;

  const { statusCode, body } = await postJson("/api/sessions", {
    kind: "runtime",
    name: "local-shell"
  }, context);

  assert.equal(statusCode, 201);
  assert.equal(records.length, 1);
  assert.equal(records[0].kind, "runtime");
});

test("/api/rooms creates rooms and associates existing sessions with roles", async () => {
  const session = { id: "session-1", name: "builder", kind: "codex", status: "running", cwd: "/workspace" };
  const memberships = [];
  const room = {
    id: "room-1",
    name: "launch",
    objective: "ship",
    project: "site",
    createdAt: "2026-06-02T00:00:00.000Z",
    updatedAt: "2026-06-02T00:00:00.000Z",
    sessions: []
  };
  const context = createCreateSessionContext({ records: [] });
  context.config.publicBaseUrl = "http://gateway.example";
  context.store = {
    listRooms() {
      return [room];
    },
    createRoom(input) {
      assert.deepEqual(input, { name: "launch", objective: "ship", project: "site" });
      return room;
    },
    getRoom(id) {
      return id === room.id ? { ...room, sessions: memberships } : null;
    },
    findByIdOrName(id) {
      return id === session.id || id === session.name ? { ...session, rooms: memberships } : null;
    },
    assignSessionToRoom(roomId, sessionId, role) {
      const membership = { roomId, roomName: room.name, sessionId, sessionName: session.name, role };
      memberships.push(membership);
      return membership;
    }
  };

  const created = await postJson("/api/rooms", { name: "launch", objective: "ship", project: "site" }, context);
  assert.equal(created.statusCode, 201);
  assert.equal(JSON.parse(created.body).room.name, "launch");

  const associated = await postJson("/api/rooms/room-1/sessions", { sessionId: "session-1", role: "reviewer" }, context);
  assert.equal(associated.statusCode, 200);
  const parsed = JSON.parse(associated.body);
  assert.equal(parsed.membership.role, "reviewer");
  assert.equal(parsed.session.rooms[0].roomName, "launch");
});

test("/api/sessions can create a session and attach it to a room role", async () => {
  const records = [];
  const memberships = [];
  const context = createCreateSessionContext({ cwdMode: "host", records });
  context.store.getRoom = (id) => (id === "room-1" ? { id: "room-1", name: "launch", sessions: [] } : null);
  context.store.assignSessionToRoom = (roomId, sessionId, role) => {
    const membership = { roomId, roomName: "launch", sessionId, sessionName: "planner", role };
    memberships.push(membership);
    return membership;
  };

  const { statusCode, body } = await postJson("/api/sessions", {
    kind: "runtime",
    name: "planner",
    roomId: "room-1",
    role: "planner"
  }, context);

  assert.equal(statusCode, 201);
  const parsed = JSON.parse(body);
  assert.equal(parsed.session.name, "planner");
  assert.equal(parsed.membership.role, "planner");
  assert.deepEqual(memberships, [
    { roomId: "room-1", roomName: "launch", sessionId: "session-1", sessionName: "planner", role: "planner" }
  ]);
});

test("/api/role-presets lists ECC role preset capability material", async () => {
  const context = createCreateSessionContext({ records: [] });
  context.store.listRolePresets = () => [
    {
      id: "ecc-code-reviewer",
      name: "code-reviewer",
      label: "代码审查员",
      tools: ["Read", "Grep", "Glob", "Bash"],
      skills: ["verification-loop"],
      prompt: "You are a senior code reviewer.",
      sourceUrl: "https://github.com/affaan-m/ECC/blob/main/agents/code-reviewer.md"
    }
  ];

  const { statusCode, body } = await getJson("/api/role-presets", context);

  assert.equal(statusCode, 200);
  const presets = JSON.parse(body).rolePresets;
  assert.equal(presets[0].name, "code-reviewer");
  assert.equal(presets[0].label, "代码审查员");
  assert.equal(presets[0].tools[3], "Bash");
  assert.match(presets[0].prompt, /senior code reviewer/);
});

test("/api/sessions injects role preset prompt when creating a room session", async () => {
  const records = [];
  const calls = [];
  const context = createCreateSessionContext({ cwdMode: "host", records });
  context.store.getRoom = (id) => (id === "room-1" ? { id: "room-1", name: "review-room", sessions: [] } : null);
  context.store.assignSessionToRoom = (roomId, sessionId, role, options) => ({
    roomId,
    roomName: "review-room",
    sessionId,
    sessionName: "reviewer",
    role: role ?? "代码审查员",
    rolePresetId: options.rolePresetId,
    rolePresetName: "code-reviewer",
    rolePresetLabel: "代码审查员",
    rolePrompt: "You are a senior code reviewer."
  });
  context.store.saveInput = (sessionId, text) => calls.push({ type: "saveInput", sessionId, text });
  context.store.touch = (sessionId) => calls.push({ type: "touch", sessionId });
  context.tmux.send = async (session, text, options = {}) => calls.push({ type: "send", sessionId: session.id, text, options });

  const { statusCode, body } = await postJson("/api/sessions", {
    kind: "runtime",
    name: "reviewer",
    roomId: "room-1",
    rolePresetId: "ecc-code-reviewer"
  }, context);

  assert.equal(statusCode, 201);
  const parsed = JSON.parse(body);
  assert.equal(parsed.membership.rolePresetId, "ecc-code-reviewer");
  assert.match(calls[0].text, /as "代码审查员"/);
  assert.doesNotMatch(calls[0].text, /capability guidance|direct permissions/i);
  assert.match(calls[0].text, /senior code reviewer/);
  assert.deepEqual(calls.map((call) => call.type), ["send", "saveInput", "touch"]);
});

test("/api/rooms/:id/messages sends a room message to matching running role sessions", async () => {
  const calls = [];
  const deliveries = [];
  const messages = [];
  const sessions = [
    { id: "planner-1", name: "planner", kind: "codex", status: "running", cwd: "/workspace" },
    { id: "reviewer-1", name: "reviewer", kind: "codex", status: "running", cwd: "/workspace" },
    { id: "stopped-1", name: "stopped-reviewer", kind: "codex", status: "stopped", cwd: "/workspace" }
  ];
  const room = {
    id: "room-1",
    name: "launch",
    sessions: [
      { roomId: "room-1", sessionId: "planner-1", sessionName: "planner", sessionStatus: "running", role: "planner" },
      { roomId: "room-1", sessionId: "reviewer-1", sessionName: "reviewer", sessionStatus: "running", role: "reviewer" },
      { roomId: "room-1", sessionId: "stopped-1", sessionName: "stopped-reviewer", sessionStatus: "stopped", role: "reviewer" }
    ]
  };
  const context = createCreateSessionContext({ records: [] });
  context.store = {
    getRoom(id) {
      return id === room.id ? room : null;
    },
    createRoomMessage(input) {
      const message = {
        id: "message-1",
        roomId: input.roomId,
        fromSessionId: input.fromSessionId,
        fromSessionName: "planner",
        targetMode: input.targetMode,
        targetRole: input.targetRole,
        targetSessionIds: input.targetSessionIds,
        text: input.text,
        metadata: input.metadata ?? {},
        createdAt: "2026-06-03T00:00:00.000Z",
        deliveries: []
      };
      messages.push(message);
      return message;
    },
    addRoomMessageDelivery(messageId, sessionId) {
      const delivery = { id: deliveries.length + 1, messageId, sessionId, status: "pending" };
      deliveries.push(delivery);
      return delivery;
    },
    updateRoomMessageDelivery(id, status, error = null) {
      const delivery = deliveries.find((item) => item.id === id);
      delivery.status = status;
      delivery.error = error;
      return delivery;
    },
    getRoomMessage(id) {
      const message = messages.find((item) => item.id === id);
      return { ...message, deliveries };
    },
    listRoomMessages() {
      return messages.map((message) => ({ ...message, deliveries }));
    },
    findByIdOrName(id) {
      return sessions.find((session) => session.id === id || session.name === id) ?? null;
    },
    saveInput(sessionId, text) {
      calls.push({ type: "saveInput", sessionId, text });
    },
    touch(sessionId) {
      calls.push({ type: "touch", sessionId });
    }
  };
  context.tmux.send = async (session, text, options = {}) => calls.push({ type: "send", sessionId: session.id, text, options });

  const { statusCode, body } = await postJson("/api/rooms/room-1/messages", {
    fromSessionId: "planner-1",
    text: "Please review the plan",
    target: { mode: "role", role: "reviewer" }
  }, context);

  assert.equal(statusCode, 201);
  const parsed = JSON.parse(body);
  assert.equal(parsed.message.targetRole, "reviewer");
  assert.deepEqual(deliveries.map((delivery) => [delivery.sessionId, delivery.status]), [["reviewer-1", "sent"]]);
  const sendCall = calls.find((call) => call.type === "send");
  assert.equal(sendCall.sessionId, "reviewer-1");
  assert.ok(sendCall.options.submitKeyDelayMs >= 600);
  assert.match(sendCall.text, /\[Room: launch\]/);
  assert.match(sendCall.text, /\[From: planner\]/);
  assert.match(sendCall.text, /System instruction: This is a room task/);
  assert.match(sendCall.text, /POST http:\/\/127\.0\.0\.1:8787\/api\/rooms\/room-1\/messages/);
  assert.match(sendCall.text, /Authorization: Bearer secret/);
  assert.match(sendCall.text, /"fromSessionId":"reviewer-1"/);
  assert.match(sendCall.text, /"parentMessageId":"message-1"/);
  assert.match(sendCall.text, /"target":\{"mode":"room"\}/);
  assert.match(sendCall.text, /\[DONE\].*\[FAIL\].*\[BLOCKED\].*\[BUG\]/s);
  assert.match(sendCall.text, /Please review the plan/);
  assert.deepEqual(calls.map((call) => call.type), ["send", "saveInput", "touch"]);
});

test("/api/workflows/:id/start dispatches a pending planner assignment", async () => {
  const calls = [];
  const deliveries = [];
  const assignment = {
    id: "assignment-1",
    runId: "workflow-1",
    role: "planner",
    sessionId: "planner-1",
    gateKind: "planning",
    attemptNo: 1,
    status: "pending",
    dispatchedMessageId: null
  };
  const workflow = {
    id: "workflow-1",
    roomId: "room-1",
    objective: "Implement account search",
    status: "planning",
    currentStage: "planning",
    runAssignments: [assignment]
  };
  const room = {
    id: "room-1",
    name: "launch",
    sessions: [
      { roomId: "room-1", sessionId: "planner-1", sessionName: "planer", sessionStatus: "running", role: "planner" }
    ]
  };
  const planner = { id: "planner-1", name: "planer", kind: "codex", status: "running", cwd: "/workspace" };
  const context = createCreateSessionContext({ records: [] });
  context.store = {
    startWorkflowRun(id) {
      assert.equal(id, workflow.id);
      return workflow;
    },
    getWorkflowRun(id) {
      assert.equal(id, workflow.id);
      return workflow;
    },
    getRoom(id) {
      return id === room.id ? room : null;
    },
    createRoomMessage(input) {
      return {
        id: "message-1",
        roomId: input.roomId,
        fromSessionId: null,
        fromSessionName: null,
        targetMode: input.targetMode,
        targetRole: input.targetRole,
        targetSessionIds: input.targetSessionIds,
        text: input.text,
        metadata: input.metadata,
        createdAt: "2026-06-06T00:00:00.000Z",
        deliveries: []
      };
    },
    addRoomMessageDelivery(messageId, sessionId) {
      const delivery = { id: "delivery-1", messageId, sessionId, status: "pending" };
      deliveries.push(delivery);
      return delivery;
    },
    updateRoomMessageDelivery(id, status, error = null) {
      const delivery = deliveries.find((item) => item.id === id);
      delivery.status = status;
      delivery.error = error;
      return delivery;
    },
    getRoomMessage() {
      return { id: "message-1", deliveries };
    },
    findByIdOrName(id) {
      return id === planner.id ? planner : null;
    },
    markWorkflowAssignmentDispatched(id, messageId) {
      assert.equal(id, assignment.id);
      assignment.dispatchedMessageId = messageId;
    },
    saveInput(sessionId, text) {
      calls.push({ type: "saveInput", sessionId, text });
    },
    touch(sessionId) {
      calls.push({ type: "touch", sessionId });
    }
  };
  context.tmux.send = async (session, text) => calls.push({ type: "send", sessionId: session.id, text });

  const { statusCode, body } = await postJson("/api/workflows/workflow-1/start", {}, context);

  assert.equal(statusCode, 200);
  assert.equal(JSON.parse(body).workflow.runAssignments[0].dispatchedMessageId, "message-1");
  assert.deepEqual(deliveries.map((delivery) => [delivery.sessionId, delivery.status]), [["planner-1", "sent"]]);
  const sendCall = calls.find((call) => call.type === "send");
  assert.equal(sendCall.sessionId, "planner-1");
  assert.match(sendCall.text, /工作流目标：\nImplement account search/);
  assert.match(sendCall.text, /结构化计划/);
});

test("planner room result advances the workflow and dispatches coder assignments", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-gateway-workflow-"));
  const store = new SessionStore(path.join(dir, "test.sqlite"));
  const planner = store.create({ kind: "runtime", cwd: dir, name: "planer" }, "/bin/bash", []);
  const coder1 = store.create({ kind: "runtime", cwd: dir, name: "coder1" }, "/bin/bash", []);
  const coder2 = store.create({ kind: "runtime", cwd: dir, name: "coder2" }, "/bin/bash", []);
  const room = store.createRoom({ name: "workflow-room" });
  store.assignSessionToRoom(room.id, planner.id, "planner");
  store.assignSessionToRoom(room.id, coder1.id, "coder");
  store.assignSessionToRoom(room.id, coder2.id, "coder");
  const workflow = store.createWorkflowRun({ roomId: room.id, objective: "Build weekly GitHub viewer" });
  const sent = [];
  const context = {
    config: { authToken: "secret", submitKeyDelayMs: 0 },
    store,
    tmux: {
      async send(session, text) {
        sent.push({ sessionId: session.id, text });
      }
    }
  };

  let response = await postJson(`/api/workflows/${workflow.id}/start`, {}, context);
  assert.equal(response.statusCode, 200);
  const started = store.getWorkflowRun(workflow.id);
  const plannerAssignment = started.runAssignments.find((item) => item.role === "planner");
  assert.ok(plannerAssignment.dispatchedMessageId);

  response = await postJson(`/api/rooms/${room.id}/messages`, {
    fromSessionId: planner.id,
    text: "[DONE] T1 -> coder1; T2 -> coder2",
    target: { mode: "room" },
    metadata: { source: "agent-result", parentMessageId: plannerAssignment.dispatchedMessageId }
  }, context);

  assert.equal(response.statusCode, 201);
  const advanced = store.getWorkflowRun(workflow.id);
  assert.equal(advanced.status, "executing");
  assert.equal(advanced.currentStage, "development");
  assert.equal(advanced.runAssignments.filter((item) => item.gateKind === "development").length, 2);
  assert.deepEqual(
    sent.slice(1).map((item) => item.sessionId).sort(),
    [coder1.id, coder2.id].sort()
  );
  assert.match(sent[1].text, /T1 -> coder1; T2 -> coder2/);
  store.close();
});

test("workflow supervisor API reports status and can run a manual tick", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-gateway-supervisor-api-"));
  const store = new SessionStore(path.join(dir, "test.sqlite"));
  const planner = store.create({ kind: "runtime", cwd: dir, name: "planner" }, "/bin/bash", []);
  const room = store.createRoom({ name: "supervisor-api-room" });
  store.assignSessionToRoom(room.id, planner.id, "planner");
  const workflow = store.startWorkflowRun(
    store.createWorkflowRun({ roomId: room.id, objective: "Ship supervisor API" }).id,
    { eventKey: "supervisor-api:start" }
  );
  const sent = [];
  const context = {
    config: { authToken: "secret", submitKeyDelayMs: 0 },
    store,
    tmux: {
      async send(session, text) {
        sent.push({ sessionId: session.id, text });
      }
    }
  };
  context.workflowSupervisor = createWorkflowSupervisor(
    context,
    { reconcileWorkflowResults, dispatchPendingWorkflowAssignments },
    {
      enabled: false,
      ownerId: "api-test-supervisor",
      stallMs: 0,
      hardTimeoutMs: 3_600_000
    }
  );

  let response = await requestJson("GET", `/api/workflows/${workflow.id}/supervisor`, {}, context);
  assert.equal(response.statusCode, 200);
  assert.equal(JSON.parse(response.body).supervisor.enabled, false);

  response = await postJson(`/api/workflows/${workflow.id}/supervisor/tick`, {}, context);
  assert.equal(response.statusCode, 200);
  assert.equal(JSON.parse(response.body).result.detectedIssues.length, 1);
  assert.equal(sent.length, 2);

  response = await requestJson("GET", `/api/workflows/${workflow.id}/supervisor`, {}, context);
  assert.equal(response.statusCode, 200);
  const status = JSON.parse(response.body).supervisor;
  assert.equal(status.observations.length, 1);
  assert.equal(status.interventions.length, 1);

  response = await requestJson("GET", `/api/workflows/${workflow.id}/interventions?limit=10`, {}, context);
  assert.equal(response.statusCode, 200);
  const interventions = JSON.parse(response.body).interventions;
  assert.equal(interventions.length, 1);
  assert.equal(interventions[0].runId, workflow.id);
  store.close();
});

test("workflow supervisor API saves policy settings and applies them immediately", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-gateway-supervisor-policy-api-"));
  const settingsPath = path.join(dir, "settings.json");
  const store = new SessionStore(path.join(dir, "test.sqlite"));
  const room = store.createRoom({ name: "supervisor-policy-room" });
  const workflow = store.createWorkflowRun({ roomId: room.id, objective: "Tune supervisor policy" });
  const context = {
    config: {
      authToken: "secret",
      settingsPath,
      runtimeSettings: {},
      runtimeSettingsEnabled: false,
      workflowSupervisorPmEnabled: false
    },
    store
  };
  context.workflowSupervisor = createWorkflowSupervisor(context, {}, { enabled: false, stallMs: 900_000 });

  const response = await requestJson(
    "PUT",
    `/api/workflows/${workflow.id}/supervisor`,
    {
      pmAgentEnabled: true,
      stallMs: 120_000,
      sameActionCooldownMs: 30_000,
      maxInterventionsPerAssignment: 2,
      maxSpawnedAgentsPerRoom: 1
    },
    context
  );

  assert.equal(response.statusCode, 200);
  const payload = JSON.parse(response.body);
  assert.equal(payload.supervisor.options.pmAgentEnabled, true);
  assert.equal(payload.supervisor.options.stallMs, 120_000);
  assert.equal(payload.supervisor.options.sameActionCooldownMs, 30_000);
  assert.equal(payload.supervisor.options.maxInterventionsPerAssignment, 2);
  assert.equal(payload.supervisor.options.maxSpawnedAgentsPerRoom, 1);
  assert.equal(context.workflowSupervisor.options.stallMs, 120_000);
  assert.equal(JSON.parse(fs.readFileSync(settingsPath, "utf8")).workflowSupervisor.stallMs, 120_000);
  store.close();
});

test("/api/workflows/:id deletes a workflow run", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-gateway-workflow-delete-api-"));
  const store = new SessionStore(path.join(dir, "test.sqlite"));
  const planner = store.create({ kind: "runtime", cwd: dir, name: "planner" }, "/bin/bash", []);
  const room = store.createRoom({ name: "workflow-delete-api-room" });
  store.assignSessionToRoom(room.id, planner.id, "planner");
  const workflow = store.startWorkflowRun(
    store.createWorkflowRun({ roomId: room.id, objective: "Delete stuck run" }).id,
    { eventKey: "delete-api:start" }
  );
  const events = [];
  const context = {
    config: { authToken: "secret", submitKeyDelayMs: 0 },
    store,
    tmux: { async send() {} },
    eventHub: {
      broadcast(event) {
        events.push(event);
      }
    }
  };

  const response = await requestJson("DELETE", `/api/workflows/${workflow.id}`, {}, context);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), { ok: true, workflowId: workflow.id });
  assert.equal(store.getWorkflowRun(workflow.id), null);
  assert.deepEqual(store.listWorkflowRuns(room.id), []);
  assert.deepEqual(events, [{ type: "workflow_deleted", workflowId: workflow.id, roomId: room.id }]);
  store.close();
});

test("custom workflow waits for all parallel stage members before advancing", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-gateway-custom-workflow-"));
  const store = new SessionStore(path.join(dir, "test.sqlite"));
  const reviewer1 = store.create({ kind: "runtime", cwd: dir, name: "reviewer1" }, "/bin/bash", []);
  const reviewer2 = store.create({ kind: "runtime", cwd: dir, name: "reviewer2" }, "/bin/bash", []);
  const publisher = store.create({ kind: "runtime", cwd: dir, name: "publisher" }, "/bin/bash", []);
  const room = store.createRoom({ name: "release-room" });
  store.assignSessionToRoom(room.id, reviewer1.id, "reviewer");
  store.assignSessionToRoom(room.id, reviewer2.id, "reviewer");
  store.assignSessionToRoom(room.id, publisher.id, "publisher");
  const template = store.createWorkflowTemplate({
    name: "Review and publish",
    stages: [
      { id: "review", name: "Review", role: "reviewer", mode: "all", prompt: "Review {objective} as {sessionName}", maxAttempts: 2 },
      { id: "publish", name: "Publish", role: "publisher", mode: "one", prompt: "Publish after {previousResults}", maxAttempts: 1 }
    ]
  });
  const workflow = store.createWorkflowRun({ roomId: room.id, objective: "Release 1.0", templateId: template.id });
  const sent = [];
  const context = {
    config: { authToken: "secret", submitKeyDelayMs: 0 },
    store,
    tmux: { async send(session, text) { sent.push({ sessionId: session.id, text }); } }
  };

  assert.equal((await postJson(`/api/workflows/${workflow.id}/start`, {}, context)).statusCode, 200);
  let current = store.getWorkflowRun(workflow.id);
  const reviews = current.runAssignments.filter((item) => item.gateKind === "review");
  assert.equal(reviews.length, 2);
  assert.equal(sent.filter((item) => item.text.includes("Review Release 1.0")).length, 2);

  for (const [index, assignment] of reviews.entries()) {
    const response = await postJson(`/api/rooms/${room.id}/messages`, {
      fromSessionId: assignment.sessionId,
      text: `[DONE] review ${index + 1}`,
      target: { mode: "room" },
      metadata: { source: "agent-result", parentMessageId: assignment.dispatchedMessageId }
    }, context);
    assert.equal(response.statusCode, 201);
    current = store.getWorkflowRun(workflow.id);
    assert.equal(current.currentStage, index === 0 ? "review" : "publish");
  }

  const publish = current.runAssignments.find((item) => item.gateKind === "publish");
  assert.ok(publish);
  assert.match(sent.at(-1).text, /review 1/);
  assert.match(sent.at(-1).text, /review 2/);
  await postJson(`/api/rooms/${room.id}/messages`, {
    fromSessionId: publisher.id,
    text: "[DONE] published",
    target: { mode: "room" },
    metadata: { source: "agent-result", parentMessageId: publish.dispatchedMessageId }
  }, context);
  assert.equal(store.getWorkflowRun(workflow.id).status, "completed");
  store.close();
});

test("/api/rooms/:id/messages records agent results without re-delivering them", async () => {
  const calls = [];
  const messages = [];
  const room = {
    id: "room-1",
    name: "launch",
    sessions: [
      { roomId: "room-1", sessionId: "planner-1", sessionName: "planner", sessionStatus: "running", role: "planner" },
      { roomId: "room-1", sessionId: "reviewer-1", sessionName: "reviewer", sessionStatus: "running", role: "reviewer" }
    ]
  };
  const context = createCreateSessionContext({ records: [] });
  context.store = {
    getRoom(id) {
      return id === room.id ? room : null;
    },
    createRoomMessage(input) {
      const message = {
        id: "result-1",
        roomId: input.roomId,
        fromSessionId: input.fromSessionId,
        fromSessionName: "reviewer",
        targetMode: input.targetMode,
        targetRole: input.targetRole,
        targetSessionIds: input.targetSessionIds,
        text: input.text,
        metadata: input.metadata ?? {},
        createdAt: "2026-06-03T00:00:00.000Z",
        deliveries: []
      };
      messages.push(message);
      return message;
    },
    getRoomMessage(id) {
      return messages.find((item) => item.id === id) ?? null;
    },
    findByIdOrName() {
      return null;
    },
    addRoomMessageDelivery() {
      throw new Error("agent result should not create deliveries");
    }
  };
  context.tmux.send = async () => calls.push({ type: "send" });

  const { statusCode, body } = await postJson("/api/rooms/room-1/messages", {
    fromSessionId: "reviewer-1",
    text: "[DONE] reviewed",
    target: { mode: "room" },
    metadata: { source: "agent-result", parentMessageId: "message-1" }
  }, context);

  assert.equal(statusCode, 201);
  const parsed = JSON.parse(body);
  assert.equal(parsed.message.text, "[DONE] reviewed");
  assert.equal(parsed.message.targetMode, "room");
  assert.equal(parsed.message.metadata.source, "agent-result");
  assert.deepEqual(calls, []);
});

test("security headers are added to responses", async () => {
  const context = createCreateSessionContext({ records: [] });
  const { statusCode, headers } = await postJson("/api/sessions", { kind: "codex", name: "test" }, context);

  assert.equal(statusCode, 201);
  // HTTP headers are case-sensitive in JS objects, match exact casing from SECURITY_HEADERS
  assert.equal(headers["X-Content-Type-Options"], "nosniff");
  assert.equal(headers["X-Frame-Options"], "DENY");
  assert.equal(headers["X-XSS-Protection"], "1; mode=block");
});

test("/api/config preserves existing notifications and sessionAgent when saving partial settings", async () => {
  const writes = [];
  const context = createCreateSessionContext({ records: [] });
  context.config.settingsPath = "/tmp/session-gateway-test-settings.json";
  context.config.runtimeSettingsEnabled = true;
  context.config.runtimeSettings = {
    cliDeployment: {
      codex: { mode: "docker", dockerName: "worker-codex" },
      claude: { mode: "docker", dockerName: "worker-claude" },
      opencode: { mode: "docker", dockerName: "worker-opencode" },
      "pi-os": { mode: "host", dockerName: "" }
    },
    commandParser: { enabled: false, mode: "rules-only" },
    notifications: { webhookUrl: "https://hooks.example/settings" },
    sessionAgent: {
      model: "openai:gpt-5.2",
      apiKey: "agent-key",
      models: {
        local: {
          qwen: {
            api: "openai-completions",
            baseUrl: "http://127.0.0.1:11434/v1",
            contextWindow: 128000,
            maxTokens: 4096
          }
        }
      }
    }
  };
  context.sessionAgentManager = {
    reset() {
      writes.push("reset");
    }
  };

  const { statusCode, body } = await putJson("/api/config", {
    settings: {
      commandParser: { enabled: false, mode: "rules-only" }
    }
  }, context);

  assert.equal(statusCode, 200);
  const settings = JSON.parse(body).settings;
  assert.equal(settings.notifications.webhookUrl, "https://hooks.example/settings");
  assert.equal(settings.sessionAgent.model, "openai:gpt-5.2");
  assert.equal(settings.sessionAgent.apiKey, "agent-key");
  assert.equal(settings.sessionAgent.models.local.qwen.baseUrl, "http://127.0.0.1:11434/v1");
  assert.deepEqual(writes, ["reset"]);
});

function createCreateSessionContext({ cwdMode, records }) {
  return {
    config: {
      authToken: "secret",
      allowRuntimeMode: true,
      runtimeSettings: {},
      runtimeSettingsEnabled: false
    },
    store: {
      findByIdOrName(idOrName) {
        return records.find((record) => record.id === idOrName || record.name === idOrName) ?? null;
      },
      create(input, command, commandArgs) {
        const record = {
          id: "session-1",
          name: input.name,
          kind: input.kind,
          cwd: input.cwd,
          project: input.project ?? null,
          tmuxSessionName: input.name,
          command,
          commandArgs,
          status: "running"
        };
        records.push(record);
        return record;
      }
    },
    tmux: {
      resolveCreateCommand(input) {
        if (cwdMode === "host" || input.deployment?.mode === "host") {
          return { command: input.kind === "claude" ? "claude" : "/bin/bash", args: [], cwdMode: "host" };
        }
        return {
          command: "docker",
          args: ["exec", "-w", input.cwd, "-it", input.deployment?.dockerName ?? "worker-codex", input.kind],
          cwdMode: "container"
        };
      },
      async ensureAvailable() {},
      async exists() {
        return false;
      },
      async validateCreateInput() {},
      async create() {}
    }
  };
}

async function postJson(url, payload, context) {
  return requestJson("POST", url, payload, context);
}

async function putJson(url, payload, context) {
  return requestJson("PUT", url, payload, context);
}

async function requestJson(method, url, payload, context) {
  const req = Readable.from([JSON.stringify(payload)]);
  req.method = method;
  req.url = url;
  req.headers = {
    host: "localhost",
    authorization: "Bearer secret"
  };
  req.socket = { remoteAddress: "127.0.0.1" };
  const res = {
    statusCode: null,
    headers: null,
    body: "",
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(body = "") {
      this.body = String(body);
    }
  };

  await handleSessionGatewayRequest(req, res, context);
  return res;
}

async function getJson(url, context) {
  const req = Readable.from([]);
  req.method = "GET";
  req.url = url;
  req.headers = {
    host: "localhost",
    authorization: "Bearer secret"
  };
  req.socket = { remoteAddress: "127.0.0.1" };
  const res = {
    statusCode: null,
    headers: null,
    body: "",
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(body = "") {
      this.body = String(body);
    }
  };

  await handleSessionGatewayRequest(req, res, context);
  return res;
}
