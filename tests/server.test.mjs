import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { handleSessionGatewayRequest } from "../src/server.mjs";

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
  const store = {
    list() {
      return sessions;
    },
    touch(sessionId) {
      touched.push(sessionId);
    },
    findByIdOrName() {
      throw new Error("current session should not be used for targetIndex send");
    }
  };
  const sent = [];
  const tmux = {
    async send(record, text) {
      sent.push({ sessionId: record.id, text });
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
      runtimeSettings: {},
      runtimeSettingsEnabled: false
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
    ok: true
  });
  assert.deepEqual(sent, [{ sessionId: "session-2", text: "修改配置" }]);
  assert.deepEqual(touched, ["session-2"]);
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
  const store = {
    findByIdOrName(value) {
      return value === glassSession.id || value === glassSession.name ? glassSession : null;
    },
    touch(sessionId) {
      touched.push(sessionId);
    }
  };
  const sent = [];
  const tmux = {
    async send(record, text) {
      sent.push({ sessionId: record.id, text, submitted: true });
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
      runtimeSettings: {},
      runtimeSettingsEnabled: false
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
    ok: true
  });
  assert.deepEqual(sent, [{ sessionId: "session-glass", text: "修改配置", submitted: true }]);
  assert.deepEqual(touched, ["session-glass"]);
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

function createCreateSessionContext({ cwdMode, records }) {
  return {
    config: {
      authToken: "secret",
      runtimeSettings: {},
      runtimeSettingsEnabled: false
    },
    store: {
      findByIdOrName() {
        return null;
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
        if (cwdMode === "host") return { command: "/bin/bash", args: [], cwdMode: "host" };
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
  const req = Readable.from([JSON.stringify(payload)]);
  req.method = "POST";
  req.url = url;
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

  await handleSessionGatewayRequest(req, res, context);
  return res;
}
