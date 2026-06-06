import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseWithLocalModel } from "./ai_parser.mjs";
import { loadConfig, updateRuntimeSettings } from "./config.mjs";
import { CodeClipSessionRecorder } from "./codeclip_recorder.mjs";
import { isAuthorizedHeader } from "./auth.mjs";
import { parseNaturalCommand } from "./nl.mjs";
import { createSessionAgentManager } from "./session_agent.mjs";
import { SessionStore } from "./store.mjs";
import { TmuxBackend } from "./tmux.mjs";
import { newId, normalizeLines, outputEtag, readJsonBody, sanitizeTmuxName } from "./utils.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, "..", "public");
const SEND_FOLLOWUP_DELAY_MS = 5_000;
const SEND_FOLLOWUP_LINES = 30;
const SESSION_LIST_OUTPUT_LINES = 80;
const IDLE_OUTPUT_STOPPED_MS = 60_000;
const ROOM_SUBMIT_KEY_DELAY_MIN_MS = 600;
const ROOM_SUBMIT_KEY_DELAY_MAX_MS = 2_000;

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
  const sessionRecorder =
    options.sessionRecorder ?? new CodeClipSessionRecorder({ sessionsDir: config.codeClipSessionsDir });
  const staticDir = options.publicDir ?? publicDir;
  const eventHub = options.eventHub ?? new SessionEventHub();
  const sessionTaskStates = options.sessionTaskStates ?? new Map();
  const context = { config, store, tmux, sessionRecorder, publicDir: staticDir, eventHub, sessionTaskStates };
  context.sessionAgentManager =
    options.sessionAgentManager ?? createSessionAgentManager(context, createSessionAgentOperations(context));
  let notificationPollTimer = null;
  const pollNotifications = async () => {
    try {
      await listSessionsWithTaskState(context);
    } catch (error) {
      console.warn(`Session task notification poll failed: ${errorMessage(error)}`);
    }
  };
  const scheduleNotificationPoll = () => {
    clearTimeout(notificationPollTimer);
    const hasWebhook = Boolean(config.notificationWebhookUrl || config.runtimeSettings?.notifications?.webhookUrl);
    const hasWebSocketClients = typeof eventHub.hasClients === "function" && eventHub.hasClients();
    if (!hasWebhook && !hasWebSocketClients) return;
    if (config.notificationPollMs <= 0) return;
    notificationPollTimer = setTimeout(async () => {
      await pollNotifications();
      scheduleNotificationPoll();
    }, config.notificationPollMs);
    notificationPollTimer.unref?.();
  };
  eventHub.onClientChange = scheduleNotificationPoll;
  const server = http.createServer((req, res) => handleRequest(req, res, context));
  server.on("upgrade", (req, socket, head) => handleWebSocketUpgrade(req, socket, head, context));
  server.on("listening", scheduleNotificationPoll);
  server.on("close", () => clearTimeout(notificationPollTimer));
  return server;
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
    const sessions = await listSessionsWithTaskState(context);
    sendJson(res, 200, { sessions });
    return;
  }

  if (method === "POST" && pathname === "/api/sessions") {
    const body = await readJsonBody(req);
    const input = parseCreateInput(body, context);
    const session = await createSession(input, context);
    const membership = await assignCreatedSessionToRoom(session, body, context);
    if (membership) await injectRolePromptIfRequested(session, membership, body, context, { defaultEnabled: true });
    sendJson(res, 201, { session: membership ? store.findByIdOrName(session.id) : session, membership });
    return;
  }

  if (method === "GET" && pathname === "/api/role-presets") {
    sendJson(res, 200, { rolePresets: store.listRolePresets() });
    return;
  }

  if (method === "GET" && pathname === "/api/rooms") {
    sendJson(res, 200, { rooms: store.listRooms() });
    return;
  }

  if (method === "POST" && pathname === "/api/rooms") {
    const body = await readJsonBody(req);
    const room = store.createRoom(parseRoomInput(body));
    sendJson(res, 201, { room });
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
    const settings = updateRuntimeSettings(config, { ...config.runtimeSettings, ...(body.settings ?? body) });
    context.sessionAgentManager?.reset?.();
    sendJson(res, 200, { settings });
    return;
  }

  const roomRoute = pathname.match(/^\/api\/rooms\/([^/]+)(?:\/([^/]+))?$/);
  if (roomRoute) {
    const roomId = decodeURIComponent(roomRoute[1]);
    const action = roomRoute[2] ?? "";
    await handleRoomAction(req, res, method, roomId, action, context);
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

async function handleRoomAction(req, res, method, roomId, action, context) {
  const { store } = context;

  if (method === "GET" && action === "") {
    const room = store.getRoom(roomId);
    if (!room) throw new Error(`Room not found: ${roomId}`);
    sendJson(res, 200, { room });
    return;
  }

  if (method === "DELETE" && action === "") {
    const room = store.getRoom(roomId);
    if (!room) throw new Error(`Room not found: ${roomId}`);
    store.deleteRoom(room.id);
    context.eventHub?.broadcast({ type: "room_deleted", roomId: room.id });
    sendJson(res, 200, { ok: true, roomId: room.id });
    return;
  }

  if (method === "GET" && action === "messages") {
    const url = new URL(req.url ?? "/", "http://localhost");
    const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get("limit") || "100", 10) || 100));
    sendJson(res, 200, { messages: store.listRoomMessages(roomId, limit) });
    return;
  }

  if (method === "POST" && action === "messages") {
    const body = await readJsonBody(req);
    const result = await dispatchRoomMessage(roomId, body, context);
    sendJson(res, 201, result);
    return;
  }

  if (method === "POST" && action === "sessions") {
    const body = await readJsonBody(req);
    const room = store.getRoom(roomId);
    if (!room) throw new Error(`Room not found: ${roomId}`);
    const role = parseRole(body.role);

    if (typeof body.sessionId === "string" && body.sessionId.trim()) {
      const membership = store.assignSessionToRoom(room.id, body.sessionId.trim(), role, parseMembershipOptions(body));
      const session = store.findByIdOrName(membership.sessionId);
      if (session) await injectRolePromptIfRequested(session, membership, body, context, { defaultEnabled: false });
      sendJson(res, 200, { room: store.getRoom(room.id), membership, session: store.findByIdOrName(membership.sessionId) });
      return;
    }

    const input = parseCreateInput(body, context);
    const session = await createSession(input, context);
    const membership = store.assignSessionToRoom(room.id, session.id, role, parseMembershipOptions(body));
    await injectRolePromptIfRequested(session, membership, body, context, { defaultEnabled: true });
    sendJson(res, 201, { room: store.getRoom(room.id), membership, session: store.findByIdOrName(session.id) });
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

async function dispatchRoomMessage(roomId, body, context) {
  const { store } = context;
  const room = store.getRoom(roomId);
  if (!room) throw new Error(`Room not found: ${roomId}`);
  const target = parseRoomMessageTarget(body.target ?? body);
  const fromSessionId = normalizeOptionalSessionId(body.fromSessionId);
  const roomOnly = target.mode === "room" || body.metadata?.source === "agent-result";
  const targets = roomOnly ? [] : resolveRoomMessageTargets(room, target, fromSessionId);
  if (!roomOnly && !targets.length) throw new Error("No running room sessions match the message target");

  const message = store.createRoomMessage({
    roomId: room.id,
    fromSessionId,
    text: body.text,
    targetMode: target.mode,
    targetRole: target.role,
    targetSessionIds: target.sessionIds,
    metadata: body.metadata
  });

  if (roomOnly) {
    const delivered = store.getRoomMessage(message.id);
    context.eventHub?.broadcast({ type: "room_message_created", room: store.getRoom(room.id), message: delivered });
    return { message: delivered };
  }

  for (const targetSession of targets) {
    const delivery = store.addRoomMessageDelivery(message.id, targetSession.sessionId);
    const session = store.findByIdOrName(targetSession.sessionId);
    try {
      const text = formatRoomMessageForSession(message, room, targetSession, context);
      await context.tmux.send(session, text, { submitKeyDelayMs: roomSubmitKeyDelayMs(text, context.config) });
      saveInputIfSupported(store, session.id, text);
      store.touch(session.id);
      store.updateRoomMessageDelivery(delivery.id, "sent");
    } catch (error) {
      store.updateRoomMessageDelivery(delivery.id, "failed", errorMessage(error));
    }
  }

  const delivered = store.getRoomMessage(message.id);
  context.eventHub?.broadcast({ type: "room_message_created", room: store.getRoom(room.id), message: delivered });
  return { message: delivered };
}

function parseRoomMessageTarget(target) {
  const mode = typeof target.mode === "string" && target.mode.trim() ? target.mode.trim() : "all";
  if (!["all", "role", "session", "room"].includes(mode)) throw new Error("target mode must be all, role, session, or room");
  const role = typeof target.role === "string" && target.role.trim() ? target.role.trim() : null;
  const sessionIds = Array.isArray(target.sessionIds)
    ? target.sessionIds.filter((id) => typeof id === "string" && id.trim()).map((id) => id.trim())
    : typeof target.sessionId === "string" && target.sessionId.trim()
      ? [target.sessionId.trim()]
      : [];
  if (mode === "role" && !role) throw new Error("target role is required");
  if (mode === "session" && !sessionIds.length) throw new Error("target sessionIds are required");
  return { mode, role, sessionIds };
}

function normalizeOptionalSessionId(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function resolveRoomMessageTargets(room, target, fromSessionId) {
  const memberships = (room.sessions ?? []).filter((membership) => membership.sessionStatus === "running");
  const selected = memberships.filter((membership) => {
    if (fromSessionId && membership.sessionId === fromSessionId) return false;
    if (target.mode === "all") return true;
    if (target.mode === "role") return roomRoleMatches(membership, target.role);
    if (target.mode === "session") return target.sessionIds.includes(membership.sessionId);
    return false;
  });
  return [...new Map(selected.map((membership) => [membership.sessionId, membership])).values()];
}

function roomRoleMatches(membership, role) {
  const expected = role.toLowerCase();
  return [membership.role, membership.rolePresetName, membership.rolePresetLabel]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase() === expected);
}

function formatRoomMessageForSession(message, room, targetSession, context = {}) {
  const from = message.fromSessionName || message.fromSessionId || "user";
  const to = targetSession.role || targetSession.rolePresetName || targetSession.sessionName;
  return [
    `[Room: ${room.name}]`,
    `[From: ${from}]`,
    `[To: ${to}]`,
    "",
    buildRoomCallbackInstructions(message, room, targetSession, context),
    "",
    message.text
  ].join("\n");
}

function roomSubmitKeyDelayMs(text, config = {}) {
  const base = Math.max(config.submitKeyDelayMs ?? 0, ROOM_SUBMIT_KEY_DELAY_MIN_MS);
  const scaled = Math.ceil(String(text).length / 8);
  return Math.min(ROOM_SUBMIT_KEY_DELAY_MAX_MS, Math.max(base, scaled));
}

function buildRoomCallbackInstructions(message, room, targetSession, { config } = {}) {
  const callbackUrl = `${roomCallbackBaseUrl(config)}/api/rooms/${encodeURIComponent(room.id)}/messages`;
  const resultPayload = {
    fromSessionId: targetSession.sessionId,
    text: `[DONE] ${message.metadata?.taskId ?? ""}\n- 完成内容：...\n- 产出物：...\n- 验证/证据：...\n- 阻塞项/后续建议：...`,
    target: { mode: "room" },
    metadata: { source: "agent-result", parentMessageId: message.id }
  };
  const curl = [
    "curl -sS -X POST",
    shellQuote(callbackUrl),
    "-H",
    shellQuote(`Authorization: Bearer ${config?.authToken ?? ""}`),
    "-H",
    shellQuote("Content-Type: application/json"),
    "-d",
    shellQuote(JSON.stringify(resultPayload))
  ].join(" ");
  return [
    "System instruction: This is a room task delivered through Session Gateway.",
    "When the task is done, failed, blocked, or you find a bug, you MUST send the final result back to the room by calling the callback API. Do not only reply inside this CLI session.",
    "Result content must start with [DONE], [FAIL], [BLOCKED], or [BUG]. Send conclusions, artifacts, validation evidence, and blockers only; do not send raw terminal logs or full execution traces.",
    `Callback API: POST ${callbackUrl}`,
    "Use your current session id as fromSessionId so the room can attribute the result.",
    `You can run this curl after replacing the content fields: ${curl}`
  ].join("\n");
}

function roomCallbackBaseUrl(config = {}) {
  if (typeof config.publicBaseUrl === "string" && config.publicBaseUrl.trim()) {
    return config.publicBaseUrl.trim().replace(/\/+$/, "");
  }
  if (typeof process.env.SESSION_GATEWAY_PUBLIC_BASE_URL === "string" && process.env.SESSION_GATEWAY_PUBLIC_BASE_URL.trim()) {
    return process.env.SESSION_GATEWAY_PUBLIC_BASE_URL.trim().replace(/\/+$/, "");
  }
  const host = config.host === "0.0.0.0" || config.host === "::" ? "127.0.0.1" : (config.host || "127.0.0.1");
  return `http://${host}:${config.port || 8787}`;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
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
    await recordFinalAnswerBeforeInput(session, body.text, context);
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

  if (method === "POST" && action === "resize") {
    const body = await readJsonBody(req);
    const size = parseTmuxSize(body);
    await tmux.resize(session, size.cols, size.rows);
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

function parseTmuxSize(value) {
  const cols = Number(value?.cols);
  const rows = Number(value?.rows);
  if (!Number.isInteger(cols) || cols < 20 || cols > 500) throw new Error("cols must be an integer between 20 and 500");
  if (!Number.isInteger(rows) || rows < 5 || rows > 200) throw new Error("rows must be an integer between 5 and 200");
  return { cols, rows };
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
  if (context.sessionAgentManager?.run) {
    const result = await context.sessionAgentManager.run(body.text, {
      currentSessionId: body.currentSessionId,
      roomContext: body.roomContext
    });
    sendJson(res, 200, result);
    return;
  }
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
    const sessions = (await listSessionsWithTaskState(context)).filter(
      (session) => !command.runningOnly || session.status === "running"
    );
    sendJson(res, 200, { command, sessions });
    return;
  }

  if (command.type === "send") {
    const session = requireCommandSession(command, body, context);
    await recordFinalAnswerBeforeInput(session, command.text, context);
    await tmux.send(session, command.text);
    saveInputIfSupported(store, session.id, command.text);
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

function createSessionAgentOperations(context) {
  let currentRequest = {};
  const withCurrentRequest = (params = {}) => ({ ...currentRequest, ...params });
  const isSummaryRequest = () => /总结|摘要|概括|归纳|summary|summari[sz]e|recap/i.test(String(currentRequest.text ?? ""));
  return {
    setCurrentRequest(request = {}) {
      currentRequest = request;
    },
    async list_sessions(params = {}) {
      const sessions = (await listSessionsWithTaskState(context)).filter(
        (session) => !params.runningOnly || session.status === "running"
      );
      if (!params.includeOutputLines) return { sessions };
      const lines = normalizeLines(params.includeOutputLines);
      const enriched = [];
      for (const session of sessions) {
        let output = "";
        if (session.status === "running") {
          try {
            output = await context.tmux.capture(session, lines);
            context.store.saveOutput(session.id, lines, output);
          } catch {
            output = "";
          }
        }
        enriched.push({ ...session, output });
      }
      return { sessions: enriched };
    },
    async get_session_output(params = {}) {
      const command = {
        type: "output",
        target: params.target ?? null,
        targetIndex: params.targetIndex,
        lines: params.lines ?? (isSummaryRequest() ? 50 : 50)
      };
      const session = requireCommandSession(command, withCurrentRequest(params), context);
      const output = await context.tmux.capture(session, command.lines);
      context.store.saveOutput(session.id, command.lines, output);
      return { session, output };
    },
    async send_to_session(params = {}) {
      const command = { type: "send", target: params.target ?? null, targetIndex: params.targetIndex, text: params.text };
      if (typeof command.text !== "string" || !command.text.trim()) throw new Error("text is required");
      const session = requireCommandSession(command, withCurrentRequest(params), context);
      await recordFinalAnswerBeforeInput(session, command.text, context);
      await context.tmux.send(session, command.text);
      saveInputIfSupported(context.store, session.id, command.text);
      context.store.touch(session.id);
      const output = await captureAfterSend(session, context);
      return { ok: true, session, output };
    },
    async send_keys_to_session(params = {}) {
      const command = { type: "keys", target: params.target ?? null, targetIndex: params.targetIndex };
      const session = requireCommandSession(command, withCurrentRequest(params), context);
      const keys = parseTmuxKeys(params.keys);
      await context.tmux.sendKeys(session, keys);
      context.store.touch(session.id);
      return { ok: true, session, keys };
    },
    async switch_session(params = {}) {
      const command = { type: "switch", target: params.target ?? null, targetIndex: params.targetIndex };
      const session = requireCommandSession(command, withCurrentRequest(params), context);
      const output = await context.tmux.capture(session, 120);
      context.store.saveOutput(session.id, 120, output);
      return { session, output };
    },
    async stop_session(params = {}) {
      const command = { type: "stop", target: params.target ?? null, targetIndex: params.targetIndex };
      const session = requireCommandSession(command, withCurrentRequest(params), context);
      await context.tmux.stop(session);
      context.store.updateStatus(session.id, "stopped");
      return { ok: true, session: context.store.findByIdOrName(session.id) ?? { ...session, status: "stopped" } };
    },
    async restart_session(params = {}) {
      const command = { type: "restart", target: params.target ?? null, targetIndex: params.targetIndex };
      const session = requireCommandSession(command, withCurrentRequest(params), context);
      await context.tmux.restart(session);
      context.store.markRunning(session.id);
      return { session: context.store.findByIdOrName(session.id) };
    },
    async create_session(params = {}) {
      if (!isSessionKind(params.kind)) throw new Error("kind must be codex, claude, opencode, pi-os, or runtime");
      if (params.kind === "runtime" && !context.config.allowRuntimeMode) {
        throw new Error("Runtime mode is disabled on this server. Set SESSION_GATEWAY_ALLOW_RUNTIME=true to enable.");
      }
      const deployment =
        params.kind === "runtime" || !params.deployment?.mode
          ? null
          : parseCreateDeployment(params.kind, { deployment: params.deployment }, context);
      const session = await createSession({
        kind: params.kind,
        cwd: typeof params.cwd === "string" && params.cwd.trim() ? params.cwd.trim() : undefined,
        name: typeof params.name === "string" ? params.name : undefined,
        project: typeof params.project === "string" ? params.project : null,
        deployment,
        commandArgs: []
      }, context);
      return { session };
    },
    async summarize_session_states() {
      const sessions = await listSessionsWithTaskState(context);
      const groups = sessions.reduce((acc, session) => {
        const key = session.taskState ?? session.status;
        acc[key] = acc[key] ?? [];
        acc[key].push(session.name);
        return acc;
      }, {});
      return JSON.stringify({ groups, sessions }, null, 2);
    },
    async list_rooms() {
      const rooms = context.store.listRooms();
      return { rooms };
    },
    async create_room(params = {}) {
      if (typeof params.name !== "string" || !params.name.trim()) {
        throw new Error("room name is required");
      }
      const room = context.store.createRoom({
        name: params.name.trim(),
        objective: typeof params.objective === "string" ? params.objective.trim() : undefined,
        project: typeof params.project === "string" ? params.project.trim() : undefined
      });
      return { room };
    },
    async get_room(params = {}) {
      const roomIdOrName = params.roomId ?? params.roomName ?? params.target;
      if (typeof roomIdOrName !== "string" || !roomIdOrName.trim()) {
        throw new Error("roomId or roomName is required");
      }
      const room = context.store.getRoom(roomIdOrName.trim());
      if (!room) throw new Error(`Room not found: ${roomIdOrName}`);
      return { room };
    },
    async assign_session_to_room(params = {}) {
      const roomIdOrName = params.roomId ?? params.roomName;
      if (typeof roomIdOrName !== "string" || !roomIdOrName.trim()) {
        throw new Error("roomId is required");
      }
      const sessionIdOrName = params.sessionId ?? params.sessionName;
      if (typeof sessionIdOrName !== "string" || !sessionIdOrName.trim()) {
        throw new Error("sessionId is required");
      }
      const room = context.store.getRoom(roomIdOrName.trim());
      if (!room) throw new Error(`Room not found: ${roomIdOrName}`);
      const session = context.store.findByIdOrName(sessionIdOrName.trim());
      if (!session) throw new Error(`Session not found: ${sessionIdOrName}`);

      const options = {
        rolePresetId: typeof params.rolePresetId === "string" && params.rolePresetId.trim() ? params.rolePresetId.trim() : null,
        rolePrompt: typeof params.rolePrompt === "string" ? params.rolePrompt : undefined
      };
      const membership = context.store.assignSessionToRoom(room.id, session.id, params.role ?? null, options);

      if (params.injectRolePrompt && membership?.rolePrompt) {
        if (session.kind !== "runtime") {
          await new Promise((resolve) => setTimeout(resolve, context.config.cliStartupDelayMs));
        }
        const text = rolePromptMessage(membership);
        await context.tmux.send(session, text);
        saveInputIfSupported(context.store, session.id, text);
        context.store.touch(session.id);
      }

      return { room: context.store.getRoom(room.id), membership, session: context.store.findByIdOrName(session.id) };
    },
    async send_room_message(params = {}) {
      const roomIdOrName = params.roomId ?? params.roomName;
      if (typeof roomIdOrName !== "string" || !roomIdOrName.trim()) {
        throw new Error("roomId is required");
      }
      if (typeof params.text !== "string" || !params.text.trim()) {
        throw new Error("text is required");
      }
      const room = context.store.getRoom(roomIdOrName.trim());
      if (!room) throw new Error(`Room not found: ${roomIdOrName}`);

      const result = await dispatchRoomMessage(room.id, {
        text: params.text,
        fromSessionId: params.fromSessionId ?? null,
        target: {
          mode: params.targetMode ?? "all",
          role: params.targetRole ?? null,
          sessionIds: params.targetSessionIds ?? []
        },
        metadata: params.metadata ?? { source: "web-pi" }
      }, context);

      return result;
    },
    async list_room_messages(params = {}) {
      const roomIdOrName = params.roomId ?? params.roomName;
      if (typeof roomIdOrName !== "string" || !roomIdOrName.trim()) {
        throw new Error("roomId is required");
      }
      const room = context.store.getRoom(roomIdOrName.trim());
      if (!room) throw new Error(`Room not found: ${roomIdOrName}`);
      const limit = typeof params.limit === "number" ? Math.min(500, Math.max(1, params.limit)) : 100;
      const messages = context.store.listRoomMessages(room.id, limit);
      return { room, messages };
    }
  };
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

async function recordFinalAnswerBeforeInput(session, text, context) {
  try {
    await context.sessionRecorder?.recordBeforeInput(session, text, context);
  } catch (error) {
    console.warn(`CodeClip session record failed: ${errorMessage(error)}`);
  }
}

function saveInputIfSupported(store, sessionId, text) {
  if (typeof store.saveInput === "function") store.saveInput(sessionId, text);
}

async function parseCommand(text, { config }) {
  let command;
  const parser = config.runtimeSettings?.commandParser;

  if (parser?.mode === "web-ai-agent-pi" && parser.webAiAgentPiUrl) {
    try {
      command = await parseWithWebAiAgentPi(text, parser);
    } catch (error) {
      console.warn(`web-ai-agent-pi parser failed, falling back to rules: ${errorMessage(error)}`);
      command = parseNaturalCommand(text);
    }
    assertAiCreateIntent(command, text);
    return applyDeploymentHints(command, text);
  }

  try {
    command = parseNaturalCommand(text);
  } catch (ruleError) {
    if (errorMessage(ruleError).startsWith("Ambiguous natural-language command:")) throw ruleError;
    if (!parser?.enabled) throw ruleError;
    command = await parseWithLocalModel(text, config.runtimeSettings);
    assertAiCreateIntent(command, text);
  }
  return applyDeploymentHints(command, text);
}

async function parseWithWebAiAgentPi(text, parser) {
  const headers = { "content-type": "application/json" };
  if (parser.webAiAgentPiToken) {
    headers["authorization"] = `Bearer ${parser.webAiAgentPiToken}`;
  }

  const response = await fetch(`${parser.webAiAgentPiUrl}/api/nl`, {
    method: "POST",
    headers,
    body: JSON.stringify({ text })
  });

  if (!response.ok) {
    throw new Error(`web-ai-agent-pi request failed: ${response.status}`);
  }

  const data = await response.json();
  return convertWebAiAgentPiCommand(data);
}

function convertWebAiAgentPiCommand(data) {
  const type = data.command?.type;
  if (!type) throw new Error("Invalid web-ai-agent-pi response: missing command type");

  if (type === "list") {
    return { type: "list", runningOnly: false };
  }

  if (type === "create") {
    const deployment = data.command.deploymentMode ? { mode: data.command.deploymentMode } : undefined;
    return {
      type: "create",
      input: {
        kind: data.command.kind || "codex",
        cwd: data.command.cwd,
        name: data.command.name,
        project: null,
        ...(deployment ? { deployment } : {})
      }
    };
  }

  if (type === "send") {
    return {
      type: "send",
      target: data.session || null,
      text: data.output || ""
    };
  }

  if (type === "output") {
    return {
      type: "output",
      target: data.session || null,
      lines: 100
    };
  }

  if (type === "stop") {
    return { type: "stop", target: data.session || null };
  }

  if (type === "restart") {
    return { type: "restart", target: data.session || null };
  }

  return { type: "help" };
}

function assertAiCreateIntent(command, text) {
  if (command.type !== "create") return;
  if (hasExplicitCreateIntent(text)) return;
  throw new Error("Create command requires an explicit create-session request");
}

function hasExplicitCreateIntent(text) {
  const kind = "codex|claude\\s+code|claud\\s+code|claude|claud|opencode|open code|pi-os|pi os|runtime|本地";
  return (
    new RegExp(`(?:新建|创建|建|启动)(?:一个)?\\s*(?:(?:非\\s*docker|host|本机|宿主机|docker)\\s*(?:模式)?\\s*的?\\s*)?(?:${kind})?\\s*会话`, "iu").test(text) ||
    new RegExp(`(?:新建|创建|建|启动)(?:一个)?\\s*(?:${kind})`, "iu").test(text) ||
    new RegExp(`^(?:create|new|start)\\s+(?:a\\s+)?(?:${kind})(?:\\s+session)?\\b`, "iu").test(text) ||
    /^(?:create|new|start)\s+(?:a\s+)?session\b/iu.test(text)
  );
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

async function listSessionsWithTaskState(context) {
  const sessions = await refreshStatuses(context.store.list(), context);
  const annotated = await annotateSessionsTaskState(sessions, context);
  await dispatchSessionTaskTransitions(annotated, context);
  return annotated;
}

async function annotateSessionsTaskState(sessions, { store, tmux }) {
  const annotated = [];
  for (const session of sessions) {
    let snapshot = typeof store.latestOutputSnapshot === "function" ? store.latestOutputSnapshot(session.id) : null;
    let output = snapshot?.text ?? "";
    if (session.status === "running" && typeof tmux.capture === "function") {
      try {
        const captured = await tmux.capture(session, SESSION_LIST_OUTPUT_LINES);
        if (captured !== output && typeof store.saveOutput === "function") {
          snapshot = store.saveOutput(session.id, SESSION_LIST_OUTPUT_LINES, captured, { touch: false });
        }
        output = captured;
      } catch {
        // Keep the status list useful even if one tmux pane cannot be captured.
      }
    }
    annotated.push({ ...session, taskState: detectTaskState(session, output, snapshot) });
  }
  return annotated;
}

function detectTaskState(session, output, snapshot) {
  if (session.status !== "running") return "completed";
  if (hasConfirmationPrompt(output)) return "needs_confirmation";
  if (isOutputIdle(snapshot)) return "completed";
  return "in_progress";
}

function isOutputIdle(snapshot) {
  if (!snapshot?.capturedAt) return false;
  const capturedAt = Date.parse(snapshot.capturedAt);
  if (!Number.isFinite(capturedAt)) return false;
  return Date.now() - capturedAt >= IDLE_OUTPUT_STOPPED_MS;
}

async function dispatchSessionTaskTransitions(sessions, context) {
  if (!context.sessionTaskStates) context.sessionTaskStates = new Map();
  const notifications = [];
  for (const session of sessions) {
    const previousTaskState = context.sessionTaskStates.get(session.id);
    context.sessionTaskStates.set(session.id, session.taskState);
    if (!shouldNotifyTaskTransition(previousTaskState, session.taskState)) continue;
    notifications.push({
      type: "session_task_state_changed",
      session,
      previousTaskState,
      taskState: session.taskState,
      changedAt: new Date().toISOString()
    });
  }

  for (const event of notifications) {
    context.eventHub?.broadcast(event);
    await sendSessionWebhook(event, context);
  }
}

function shouldNotifyTaskTransition(previousTaskState, taskState) {
  return previousTaskState === "in_progress" && (taskState === "completed" || taskState === "needs_confirmation");
}

async function sendSessionWebhook(event, { config, fetchImpl = fetch }) {
  const webhookUrl = config.notificationWebhookUrl || config.runtimeSettings?.notifications?.webhookUrl;
  if (!webhookUrl) return;
  try {
    await fetchImpl(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event)
    });
  } catch (error) {
    console.warn(`Session task webhook failed: ${errorMessage(error)}`);
  }
}

function hasConfirmationPrompt(text) {
  const normalized = stripAnsi(String(text ?? ""));
  const lines = normalized
    .split("\n")
    .filter((line) => line.trim())
    .slice(-10);
  const context = lines.join("\n");
  if (/allow\?\s*YES\?/i.test(context)) return true;
  return lines.some(
    (line) =>
      /\ballow\s+once\b.*\ballow\s+(?:always|allways)\b.*\breject\b/i.test(line) ||
      /(?:^|[\s>❯›»])[1-9]\s*[\).:\]-]\s*(?:yes|allow(?:\s+(?:once|always|allways))?)\b/i.test(line) ||
      /(?:^|[\s>❯›»])a\s*[\).:\]-]\s*allow(?:\s+(?:once|always|allways))?\b/i.test(line) ||
      /^\s*allow(?:\s+(?:once|always|allways))?\b/i.test(line) ||
      /(?:^|[\s>❯›»])y\s*[\).:\]-]\s*yes\b/i.test(line)
  );
}

function stripAnsi(text) {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function findExistingNamedSession(input, { store }) {
  const name = input.name?.trim();
  if (!name) return null;
  const existing = store.findByIdOrName(name);
  return existing?.name === name ? existing : null;
}

function parseRoomInput(body) {
  if (typeof body.name !== "string" || !body.name.trim()) throw new Error("room name is required");
  return {
    name: body.name,
    objective: typeof body.objective === "string" ? body.objective : undefined,
    project: typeof body.project === "string" ? body.project : undefined
  };
}

function parseRole(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new Error("role must be a string");
  return value.trim() || null;
}

function parseMembershipOptions(body) {
  return {
    rolePresetId: typeof body.rolePresetId === "string" && body.rolePresetId.trim() ? body.rolePresetId.trim() : null,
    rolePrompt: typeof body.rolePrompt === "string" ? body.rolePrompt : undefined
  };
}

async function assignCreatedSessionToRoom(session, body, { store }) {
  const roomId = typeof body.roomId === "string" && body.roomId.trim() ? body.roomId.trim() : null;
  if (!roomId) return null;
  return store.assignSessionToRoom(roomId, session.id, parseRole(body.role), parseMembershipOptions(body));
}

async function injectRolePromptIfRequested(session, membership, body, context, { defaultEnabled }) {
  const shouldInject = body.injectRolePrompt === undefined ? defaultEnabled : Boolean(body.injectRolePrompt);
  if (!shouldInject || !membership?.rolePrompt) return;
  if (session.kind !== "runtime") {
    await new Promise((resolve) => setTimeout(resolve, context.config.cliStartupDelayMs));
  }
  const text = rolePromptMessage(membership);
  await context.tmux.send(session, text);
  saveInputIfSupported(context.store, session.id, text);
  context.store.touch(session.id);
}

function rolePromptMessage(membership) {
  return [
    `You are assigned to room "${membership.roomName}" as "${membership.role ?? membership.rolePresetName ?? "agent"}".`,
    "",
    membership.rolePrompt
  ].join("\n");
}

function parseCreateInput(body, context) {
  if (!isSessionKind(body.kind)) throw new Error("kind must be codex, claude, opencode, pi-os, or runtime");

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
  return value === "codex" || value === "claude" || value === "opencode" || value === "pi-os" || value === "runtime";
}

function requireSession(idOrName, { store }) {
  const session = store.findByIdOrName(idOrName);
  if (!session) throw new Error(`Session not found: ${idOrName}`);
  return session;
}

function isAuthorized(req, { config }) {
  return isAuthorizedHeader(req.headers.authorization, config.authToken);
}

function isAuthorizedWebSocket(url, req, { config }) {
  const token = url.searchParams.get("token");
  return token === config.authToken || isAuthorized(req, { config });
}

function handleWebSocketUpgrade(req, socket, head, context) {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname !== "/api/session-events") {
      socket.destroy();
      return;
    }
    if (!isAuthorizedWebSocket(url, req, context)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    const key = req.headers["sec-websocket-key"];
    if (req.headers.upgrade?.toLowerCase() !== "websocket" || typeof key !== "string") {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }
    const accept = crypto
      .createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "\r\n"
      ].join("\r\n")
    );
    context.eventHub?.add(socket);
    if (head?.length) socket.unshift(head);
  } catch {
    socket.destroy();
  }
}

class SessionEventHub {
  constructor() {
    this.clients = new Set();
  }

  add(socket) {
    this.clients.add(socket);
    socket.on("close", () => {
      this.clients.delete(socket);
      this.onClientChange?.();
    });
    socket.on("error", () => {
      this.clients.delete(socket);
      this.onClientChange?.();
    });
    this.onClientChange?.();
  }

  hasClients() {
    return this.clients.size > 0;
  }

  broadcast(event) {
    const frame = encodeWebSocketTextFrame(JSON.stringify(event));
    for (const socket of this.clients) {
      if (socket.destroyed || socket.writableEnded) {
        this.clients.delete(socket);
        continue;
      }
      socket.write(frame);
    }
  }
}

function encodeWebSocketTextFrame(text) {
  const payload = Buffer.from(text, "utf8");
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  if (payload.length <= 0xffff) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
    return Buffer.concat([header, payload]);
  }
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(payload.length), 2);
  return Buffer.concat([header, payload]);
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
