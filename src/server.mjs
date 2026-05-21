import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseWithLocalModel } from "./ai_parser.mjs";
import { loadConfig, updateRuntimeSettings } from "./config.mjs";
import { isAuthorizedHeader } from "./auth.mjs";
import { parseNaturalCommand } from "./nl.mjs";
import { SessionStore } from "./store.mjs";
import { TmuxBackend } from "./tmux.mjs";
import { normalizeLines, readJsonBody } from "./utils.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, "..", "public");
const config = loadConfig();
const store = new SessionStore(config.databasePath);
const tmux = new TmuxBackend(config);

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (url.pathname === "/health") {
      await handleHealth(res);
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      if (!isAuthorized(req)) {
        sendJson(res, 401, { error: "Unauthorized" });
        return;
      }
      try {
        await handleApi(req, res, url);
      } catch (error) {
        sendJson(res, 400, { error: errorMessage(error) });
      }
      return;
    }

    await serveStatic(res, url.pathname);
  } catch (error) {
    sendJson(res, 500, { error: errorMessage(error) });
  }
});

server.listen(config.port, config.host, () => {
  console.log(`Session Gateway listening on http://${config.host}:${config.port}`);
});

async function handleHealth(res) {
  try {
    await tmux.ensureAvailable();
    sendJson(res, 200, { ok: true, tmux: true });
  } catch (error) {
    sendJson(res, 503, { ok: false, tmux: false, error: errorMessage(error) });
  }
}

async function handleApi(req, res, url) {
  const method = req.method ?? "GET";
  const pathname = url.pathname;

  if (method === "GET" && pathname === "/api/sessions") {
    const sessions = await refreshStatuses(store.list());
    sendJson(res, 200, { sessions });
    return;
  }

  if (method === "POST" && pathname === "/api/sessions") {
    const body = await readJsonBody(req);
    const input = parseCreateInput(body);
    const session = await createSession(input);
    sendJson(res, 201, { session });
    return;
  }

  if (method === "POST" && pathname === "/api/nl") {
    await handleNaturalLanguage(req, res);
    return;
  }

  if (method === "GET" && pathname === "/api/config") {
    sendJson(res, 200, { settings: config.runtimeSettings, enabled: config.runtimeSettingsEnabled });
    return;
  }

  if (method === "PUT" && pathname === "/api/config") {
    const body = await readJsonBody(req);
    const settings = updateRuntimeSettings(config, body.settings ?? body);
    sendJson(res, 200, { settings });
    return;
  }

  const sessionRoute = pathname.match(/^\/api\/sessions\/([^/]+)(?:\/([^/]+))?$/);
  if (sessionRoute) {
    const idOrName = decodeURIComponent(sessionRoute[1]);
    const action = sessionRoute[2] ?? "";
    await handleSessionAction(req, res, url, method, idOrName, action);
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

async function handleSessionAction(req, res, url, method, idOrName, action) {
  const session = requireSession(idOrName);

  if (method === "GET" && action === "output") {
    const lines = normalizeLines(url.searchParams.get("lines"));
    const text = await tmux.capture(session, lines);
    store.saveOutput(session.id, lines, text);
    sendText(res, 200, text);
    return;
  }

  if (method === "POST" && action === "input") {
    const body = await readJsonBody(req);
    if (typeof body.text !== "string" || !body.text.trim()) throw new Error("text is required");
    await tmux.send(session, body.text);
    store.touch(session.id);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (method === "POST" && action === "restart") {
    await tmux.restart(session);
    store.markRunning(session.id);
    sendJson(res, 200, { session: store.findByIdOrName(session.id) });
    return;
  }

  if (method === "DELETE" && action === "") {
    await tmux.stop(session);
    store.updateStatus(session.id, "stopped");
    sendJson(res, 200, { ok: true });
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

async function handleNaturalLanguage(req, res) {
  const body = await readJsonBody(req);
  if (typeof body.text !== "string") throw new Error("text is required");

  const command = await parseCommand(body.text);
  if (command.type === "create") {
    const session = await createSession(command.input);
    sendJson(res, 201, { command, session });
    return;
  }

  if (command.type === "help") {
    sendText(res, 200, commandHelpText());
    return;
  }

  if (command.type === "list") {
    const sessions = (await refreshStatuses(store.list())).filter(
      (session) => !command.runningOnly || session.status === "running"
    );
    sendJson(res, 200, { command, sessions });
    return;
  }

  if (command.type === "send") {
    const session = requireSession(command.target ?? currentSessionId(body));
    await tmux.send(session, command.text);
    store.touch(session.id);
    sendJson(res, 200, { command, ok: true });
    return;
  }

  if (command.type === "output") {
    const session = requireSession(command.target);
    const text = await tmux.capture(session, command.lines);
    store.saveOutput(session.id, command.lines, text);
    sendText(res, 200, text);
    return;
  }

  if (command.type === "switch") {
    const session = requireSession(command.target);
    const text = await tmux.capture(session, 120);
    store.saveOutput(session.id, 120, text);
    sendJson(res, 200, { command, session, output: text });
    return;
  }

  if (command.type === "stop") {
    const session = requireSession(command.target);
    await tmux.stop(session);
    store.updateStatus(session.id, "stopped");
    sendJson(res, 200, { command, ok: true });
    return;
  }

  if (command.type === "restart") {
    const session = requireSession(command.target);
    await tmux.restart(session);
    store.markRunning(session.id);
    sendJson(res, 200, { command, session: store.findByIdOrName(session.id) });
  }
}

async function parseCommand(text) {
  try {
    return parseNaturalCommand(text);
  } catch (ruleError) {
    if (!config.runtimeSettings?.commandParser?.enabled) throw ruleError;
    return parseWithLocalModel(text, config.runtimeSettings);
  }
}

function currentSessionId(body) {
  if (typeof body.currentSessionId === "string" && body.currentSessionId.trim()) {
    return body.currentSessionId.trim();
  }
  throw new Error("Command requires a target session or selected current session");
}

function commandHelpText() {
  return [
    "Run Command supports these safe actions:",
    "帮助 / help",
    "列出会话 / list sessions",
    "列出运行中的会话 / list running sessions",
    "新建 codex 会话 app，目录 /workspace/app",
    "create codex session app in /workspace/app",
    "发送 查看当前项目结构 / send inspect this repo",
    "把消息发给 codex-app：npm test / send npm test to codex-app",
    "codex-app 最近 200 行输出 / output codex-app 200",
    "进入 codex-app / use codex-app",
    "停止 codex-app / stop codex-app",
    "重启 codex-app / restart codex-app"
  ].join("\n");
}

async function createSession(input) {
  const commandSpec = tmux.resolveCreateCommand(input);
  await tmux.ensureAvailable();
  await tmux.validateCreateInput(input, commandSpec);
  const session = store.create(input, commandSpec.command, commandSpec.args);

  try {
    await tmux.create(session);
    return session;
  } catch (error) {
    store.updateStatus(session.id, "missing");
    throw error;
  }
}

async function refreshStatuses(sessions) {
  for (const session of sessions) {
    const exists = await tmux.exists(session);
    const nextStatus = exists ? "running" : session.status === "stopped" ? "stopped" : "missing";
    if (nextStatus !== session.status) store.updateStatus(session.id, nextStatus);
  }
  return store.list();
}

function parseCreateInput(body) {
  if (!isSessionKind(body.kind)) throw new Error("kind must be codex, claude, opencode, or runtime");
  if (typeof body.cwd !== "string" || !body.cwd.trim()) throw new Error("cwd is required");

  return {
    kind: body.kind,
    cwd: body.cwd,
    name: typeof body.name === "string" ? body.name : undefined,
    project: typeof body.project === "string" ? body.project : null,
    commandArgs: Array.isArray(body.commandArgs)
      ? body.commandArgs.map((item) => {
          if (typeof item !== "string") throw new Error("commandArgs must be strings");
          return item;
        })
      : []
  };
}

function isSessionKind(value) {
  return value === "codex" || value === "claude" || value === "opencode" || value === "runtime";
}

function requireSession(idOrName) {
  const session = store.findByIdOrName(idOrName);
  if (!session) throw new Error(`Session not found: ${idOrName}`);
  return session;
}

function isAuthorized(req) {
  return isAuthorizedHeader(req.headers.authorization, config.authToken);
}

async function serveStatic(res, pathname) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.resolve(publicDir, `.${safePath}`);
  if (!filePath.startsWith(publicDir)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }

  try {
    const data = await fs.readFile(filePath);
    const contentType = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8"
    }[path.extname(filePath)] ?? "application/octet-stream";
    res.writeHead(200, { "content-type": contentType });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: "Not found" });
  }
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function sendText(res, status, text) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(text);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
