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
import { newId, normalizeLines, outputEtag, readJsonBody, sanitizeTmuxName } from "./utils.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, "..", "public");
const SEND_FOLLOWUP_DELAY_MS = 5_000;
const SEND_FOLLOWUP_LINES = 30;

// Security headers for all responses
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "X-XSS-Protection": "1; mode=block",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()"
};

// Rate limiting configuration
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 100;
const rateLimitStore = new Map();

export function createSessionGatewayServer(options = {}) {
  const config = options.config ?? loadConfig();
  const store = options.store ?? new SessionStore(config.databasePath);
  const tmux = options.tmux ?? new TmuxBackend(config);
  const staticDir = options.publicDir ?? publicDir;

  return http.createServer((req, res) => handleRequest(req, res, { config, store, tmux, publicDir: staticDir }));
}

export async function handleSessionGatewayRequest(req, res, context) {
  return handleRequest(req, res, context);
}

async function handleRequest(req, res, context) {
  try {
    // Apply rate limiting
    const clientIp = getClientIp(req);
    if (!checkRateLimit(clientIp)) {
      sendJson(res, 429, { error: "Too many requests. Please try again later." });
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (url.pathname === "/health") {
      await handleHealth(res, context);
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      if (!isAuthorized(req, context)) {
        sendJson(res, 401, { error: "Unauthorized" });
        return;
      }
      try {
        await handleApi(req, res, url, context);
      } catch (error) {
        sendJson(res, 400, { error: errorMessage(error) });
      }
      return;
    }

    await serveStatic(res, url.pathname, context);
  } catch (error) {
    sendJson(res, 500, { error: errorMessage(error) });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = loadConfig();

  // Security warning for runtime mode
  if (config.allowRuntimeMode) {
    console.warn("");
    console.warn("╔══════════════════════════════════════════════════════════════╗");
    console.warn("║  WARNING: Runtime mode is ENABLED                            ║");
    console.warn("║  Authenticated users can execute arbitrary shell commands!   ║");
    console.warn("║  Set SESSION_GATEWAY_ALLOW_RUNTIME=false to disable.         ║");
    console.warn("╚══════════════════════════════════════════════════════════════╝");
    console.warn("");
  }

  const server = createSessionGatewayServer({ config });
  server.listen(config.port, config.host, () => {
    console.log(`Session Gateway listening on http://${config.host}:${config.port}`);
  });
}

async function handleHealth(res, { tmux }) {
  try {
    await tmux.ensureAvailable();
    sendJson(res, 200, { ok: true, tmux: true });
  } catch (error) {
    sendJson(res, 503, { ok: false, tmux: false, error: errorMessage(error) });
  }
}

async function handleApi(req, res, url, context) {
  const method = req.method ?? "GET";
  const pathname = url.pathname;
  const { config, store } = context;

  if (method === "GET" && pathname === "/api/sessions") {
    const sessions = await refreshStatuses(store.list(), context);
    sendJson(res, 200, { sessions });
    return;
  }

  if (method === "POST" && pathname === "/api/sessions") {
    const body = await readJsonBody(req);
    const input = parseCreateInput(body, context);
    const session = await createSession(input, context);
    sendJson(res, 201, { session });
    return;
  }

  if (method === "POST" && pathname === "/api/nl") {
    await handleNaturalLanguage(req, res, context);
    return;
  }

  if (method === "GET" && pathname === "/api/history") {
    const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get("limit") || "200", 10) || 200));
    const history = store.listAllInputHistory(limit);
    sendJson(res, 200, { history });
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
    await handleSessionAction(req, res, url, method, idOrName, action, context);
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

async function handleSessionAction(req, res, url, method, idOrName, action, context) {
  const { store, tmux } = context;
  const session = requireSession(idOrName, context);

  if (method === "GET" && action === "output") {
    const lines = normalizeLines(url.searchParams.get("lines"));
    const text = await tmux.capture(session, lines);
    const etag = outputEtag(text, lines);
    if (url.searchParams.get("format") === "json") {
      const changed = url.searchParams.get("etag") !== etag;
      if (changed) store.saveOutput(session.id, lines, text);
      sendJson(res, 200, changed ? { changed, etag, output: text } : { changed, etag });
      return;
    }
    store.saveOutput(session.id, lines, text);
    sendText(res, 200, text);
    return;
  }

  if (method === "GET" && action === "history") {
    const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get("limit") || "100", 10) || 100));
    const history = store.listInputHistory(session.id, limit);
    sendJson(res, 200, { history });
    return;
  }

  if (method === "POST" && action === "input") {
    const body = await readJsonBody(req);
    if (typeof body.text !== "string" || !body.text.trim()) throw new Error("text is required");
    await tmux.send(session, body.text);
    store.saveInput(session.id, body.text);
    store.touch(session.id);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (method === "POST" && action === "keys") {
    const body = await readJsonBody(req);
    const keys = parseTmuxKeys(body.keys);
    await tmux.sendKeys(session, keys);
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

  if (method === "DELETE" && action === "delete") {
    await tmux.stop(session);
    store.delete(session.id);
    sendJson(res, 200, { ok: true });
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

function parseTmuxKeys(value) {
  if (!Array.isArray(value) || !value.length) throw new Error("keys are required");
  return value.map((key) => {
    if (typeof key !== "string" || !key.trim()) throw new Error("keys must be non-empty strings");
    const normalized = key.trim();
    if (!isAllowedTmuxKey(normalized)) throw new Error(`tmux key is not allowed: ${normalized}`);
    return normalized;
  });
}

function isAllowedTmuxKey(key) {
  return (
    /^[A-Za-z0-9]$/.test(key) ||
    /^C-[A-Za-z]$/.test(key) ||
    /^(Enter|Escape|Space|Tab|BTab|Up|Down|Left|Right|BSpace|DC|Home|End|PageUp|PageDown)$/.test(key)
  );
}

async function handleNaturalLanguage(req, res, context) {
  const body = await readJsonBody(req);
  if (typeof body.text !== "string") throw new Error("text is required");
  const { store, tmux } = context;

  const command = await parseCommand(body.text, context);
  if (command.type === "create") {
    const session = await createSession(command.input, context);
    sendJson(res, 201, { command, session });
    return;
  }

  if (command.type === "help") {
    sendJson(res, 200, { command, help: commandHelpText() });
    return;
  }

  if (command.type === "list") {
    const sessions = (await refreshStatuses(store.list(), context)).filter(
      (session) => !command.runningOnly || session.status === "running"
    );
    sendJson(res, 200, { command, sessions });
    return;
  }

  if (command.type === "send") {
    const session = requireCommandSession(command, body, context);
    await tmux.send(session, command.text);
    store.touch(session.id);
    const output = await captureAfterSend(session, context);
    sendJson(res, 200, { command, ok: true, session, output });
    return;
  }

  if (command.type === "output") {
    const session = requireCommandSession(command, body, context);
    const text = await tmux.capture(session, command.lines);
    store.saveOutput(session.id, command.lines, text);
    sendJson(res, 200, { command, session, output: text });
    return;
  }

  if (command.type === "switch") {
    const session = requireCommandSession(command, body, context);
    const text = await tmux.capture(session, 120);
    store.saveOutput(session.id, 120, text);
    sendJson(res, 200, { command, session, output: text });
    return;
  }

  if (command.type === "stop") {
    const session = requireCommandSession(command, body, context);
    await tmux.stop(session);
    store.updateStatus(session.id, "stopped");
    sendJson(res, 200, { command, ok: true });
    return;
  }

  if (command.type === "restart") {
    const session = requireCommandSession(command, body, context);
    await tmux.restart(session);
    store.markRunning(session.id);
    sendJson(res, 200, { command, session: store.findByIdOrName(session.id) });
  }
}

async function captureAfterSend(session, { config, store, tmux }) {
  const delayMs = config.sendFollowupDelayMs ?? SEND_FOLLOWUP_DELAY_MS;
  if (delayMs > 0) {
    if (typeof tmux.sleep === "function") {
      await tmux.sleep(delayMs);
    } else {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  const output = await tmux.capture(session, SEND_FOLLOWUP_LINES);
  store.saveOutput(session.id, SEND_FOLLOWUP_LINES, output);
  return output;
}

async function parseCommand(text, { config }) {
  let command;
  try {
    command = parseNaturalCommand(text);
  } catch (ruleError) {
    if (errorMessage(ruleError).startsWith("Ambiguous natural-language command:")) throw ruleError;
    if (!config.runtimeSettings?.commandParser?.enabled) throw ruleError;
    command = await parseWithLocalModel(text, config.runtimeSettings);
  }
  return applyDeploymentHints(command, text);
}

function applyDeploymentHints(command, text) {
  if (command.type !== "create") return command;
  const deployment = parseDeploymentHint(text);
  if (!deployment) return command;
  return {
    ...command,
    input: {
      ...command.input,
      deployment
    }
  };
}

function parseDeploymentHint(text) {
  if (/(?:host|非\s*docker|本机|宿主机)\s*(?:模式)?\s*(?:的|运行)?/iu.test(text)) {
    return { mode: "host" };
  }
  if (/(?:在|用)?\s*docker\s*(?:模式)?\s*(?:里|中|内|的)?\s*(?:运行)?/iu.test(text)) {
    return { mode: "docker" };
  }
  return null;
}

function currentSessionId(body) {
  if (typeof body.currentSessionId === "string" && body.currentSessionId.trim()) {
    return body.currentSessionId.trim();
  }
  throw new Error("Command requires a target session or selected current session");
}

function requireCommandSession(command, body, context) {
  if (command.targetIndex) return requireSessionByIndex(command.targetIndex, context);
  return requireSession(command.target ?? currentSessionId(body), context);
}

function requireSessionByIndex(index, { store }) {
  const sessions = store.list();
  const session = sessions[index - 1];
  if (!session) throw new Error(`Session not found at position: ${index}`);
  return session;
}

function commandHelpText() {
  return [
    "Run Command supports these safe actions:",
    "帮助 / help",
    "列出会话 / list sessions",
    "查询会话列表",
    "列出运行中的会话 / list running sessions",
    "新建 codex 会话 app，目录 /workspace/app",
    "create codex session app in /workspace/app",
    "查看会话 / 查看绘画：显示当前会话最近 50 行",
    "发送 修改一下返回的列数 / send inspect this repo",
    "发送到 web-ai-agent 会话 修改配置",
    "发送 修改配置 到 web-ai-agent 会话",
    "发送到第五个会话 修改配置",
    "把消息发给 codex-app：npm test / send npm test to codex-app",
    "codex-app 最近 200 行输出 / output codex-app 200",
    "进入 codex-app / use codex-app",
    "停止 codex-app / stop codex-app",
    "重启 codex-app / restart codex-app"
  ].join("\n");
}

async function createSession(input, context) {
  const { store, tmux } = context;
  const preparedInput = prepareCreateInput(input, tmux);
  const commandSpec = tmux.resolveCreateCommand(preparedInput);
  await tmux.ensureAvailable();
  const existingSession = findExistingNamedSession(preparedInput, context);
  if (existingSession) {
    const isRunning = await tmux.exists(existingSession);
    store.updateStatus(existingSession.id, isRunning ? "running" : "stopped");
    if (isRunning) {
      throw new Error(`Session name already exists and is running: ${existingSession.name}`);
    }
  }
  await tmux.validateCreateInput(preparedInput, commandSpec);

  const session = existingSession
    ? store.replace(existingSession.id, preparedInput, commandSpec.command, commandSpec.args)
    : store.create(preparedInput, commandSpec.command, commandSpec.args);

  try {
    await tmux.create(session);
    return session;
  } catch (error) {
    store.updateStatus(session.id, "stopped");
    throw error;
  }
}

function prepareCreateInput(input, tmux) {
  const name = input.name?.trim() || `${input.kind}-${newId().slice(0, 8)}`;
  if (typeof input.cwd === "string" && input.cwd.trim()) {
    return { ...input, name, cwd: input.cwd.trim() };
  }

  const commandSpec = tmux.resolveCreateCommand({ ...input, name, cwd: "/" });
  return {
    ...input,
    name,
    cwd: defaultCwdForSession(name, commandSpec.cwdMode)
  };
}

function defaultCwdForSession(name, cwdMode) {
  const folder = sanitizeTmuxName(name);
  const baseDir = cwdMode === "container" ? "/work" : "/home/v6/work";
  return path.posix.join(baseDir, folder);
}

async function refreshStatuses(sessions, { store, tmux }) {
  for (const session of sessions) {
    const exists = await tmux.exists(session);
    const nextStatus = exists ? "running" : "stopped";
    if (nextStatus !== session.status) store.updateStatus(session.id, nextStatus);
  }
  return store.list();
}

function findExistingNamedSession(input, { store }) {
  const name = input.name?.trim();
  if (!name) return null;
  const existing = store.findByIdOrName(name);
  return existing?.name === name ? existing : null;
}

function parseCreateInput(body, context) {
  if (!isSessionKind(body.kind)) throw new Error("kind must be codex, claude, opencode, or runtime");

  // Check if runtime mode is allowed
  if (body.kind === "runtime" && !context.config.allowRuntimeMode) {
    throw new Error("Runtime mode is disabled on this server. Set SESSION_GATEWAY_ALLOW_RUNTIME=true to enable.");
  }

  const deployment = parseCreateDeployment(body.kind, body, context);

  return {
    kind: body.kind,
    cwd: typeof body.cwd === "string" && body.cwd.trim() ? body.cwd.trim() : undefined,
    name: typeof body.name === "string" ? body.name : undefined,
    project: typeof body.project === "string" ? body.project : null,
    deployment,
    commandArgs: Array.isArray(body.commandArgs)
      ? body.commandArgs.map((item) => {
          if (typeof item !== "string") throw new Error("commandArgs must be strings");
          return item;
        })
      : []
  };
}

function parseCreateDeployment(kind, body, { config }) {
  if (kind === "runtime") return null;
  const mode = body.deploymentMode ?? body.deployment?.mode;
  if (mode === undefined || mode === null || mode === "") return null;
  if (mode !== "host" && mode !== "docker") throw new Error("deploymentMode must be docker or host");
  const fallbackDockerName = config.runtimeSettings?.cliDeployment?.[kind]?.dockerName ?? `worker-${kind}`;
  const dockerName =
    typeof body.dockerName === "string" && body.dockerName.trim()
      ? body.dockerName.trim()
      : typeof body.deployment?.dockerName === "string" && body.deployment.dockerName.trim()
        ? body.deployment.dockerName.trim()
        : fallbackDockerName;
  return { mode, dockerName };
}

function isSessionKind(value) {
  return value === "codex" || value === "claude" || value === "opencode" || value === "runtime";
}

function requireSession(idOrName, { store }) {
  const session = store.findByIdOrName(idOrName);
  if (!session) throw new Error(`Session not found: ${idOrName}`);
  return session;
}

function isAuthorized(req, { config }) {
  return isAuthorizedHeader(req.headers.authorization, config.authToken);
}

async function serveStatic(res, pathname, context) {
  const publicDir = context.publicDir;
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.resolve(publicDir, `.${safePath}`);

  try {
    // Resolve symlinks to prevent path traversal bypass
    const [resolvedPublic, resolvedFile] = await Promise.all([
      fs.realpath(publicDir),
      fs.realpath(filePath).catch(() => null)
    ]);

    if (!resolvedFile || !resolvedFile.startsWith(resolvedPublic)) {
      sendJson(res, 403, { error: "Forbidden" });
      return;
    }

    const data = await fs.readFile(resolvedFile);
    const contentType = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8"
    }[path.extname(resolvedFile)] ?? "application/octet-stream";

    res.writeHead(200, {
      "cache-control": "no-store",
      "content-type": contentType,
      ...SECURITY_HEADERS
    });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: "Not found" });
  }
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...SECURITY_HEADERS
  });
  res.end(JSON.stringify(payload));
}

function sendText(res, status, text) {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    ...SECURITY_HEADERS
  });
  res.end(text);
}

// Rate limiting implementation
function checkRateLimit(ip) {
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;

  let requests = rateLimitStore.get(ip) || [];

  // Filter out old requests
  requests = requests.filter((t) => t > windowStart);

  if (requests.length >= RATE_LIMIT_MAX_REQUESTS) {
    return false;
  }

  requests.push(now);
  rateLimitStore.set(ip, requests);

  // Periodic cleanup of old entries
  if (rateLimitStore.size > 10000) {
    cleanupRateLimitStore(now);
  }

  return true;
}

function cleanupRateLimitStore(now) {
  const windowStart = now - RATE_LIMIT_WINDOW_MS;
  for (const [ip, requests] of rateLimitStore.entries()) {
    const filtered = requests.filter((t) => t > windowStart);
    if (filtered.length === 0) {
      rateLimitStore.delete(ip);
    } else {
      rateLimitStore.set(ip, filtered);
    }
  }
}

function getClientIp(req) {
  // Check X-Forwarded-For header (for reverse proxy setups)
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) {
    const ips = forwarded.split(",").map((ip) => ip.trim());
    return ips[0] || req.socket?.remoteAddress || "unknown";
  }
  return req.socket?.remoteAddress || "unknown";
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
