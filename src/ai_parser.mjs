import { normalizeLines, sanitizeTmuxName } from "./utils.mjs";

const ALLOWED_TYPES = new Set(["create", "list", "send", "output", "switch", "stop", "restart", "help"]);
const ALLOWED_KINDS = new Set(["codex", "claude", "opencode", "runtime"]);

export async function parseWithLocalModel(text, settings, fetchImpl = fetch) {
  const parser = settings?.commandParser;
  if (!parser?.enabled) throw new Error("AI command parser is not enabled");
  if (!parser.baseUrl) throw new Error("AI command parser baseUrl is required");
  if (!parser.model) throw new Error("AI command parser model is required");

  const response = await fetchImpl(openAiChatUrl(parser.baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(parser.apiKey ? { authorization: `Bearer ${parser.apiKey}` } : {})
    },
    body: JSON.stringify({
      model: parser.model,
      temperature: 0,
      messages: [
        {
          role: "system",
          content: commandManual()
        },
        { role: "user", content: text }
      ]
    })
  });

  if (!response.ok) {
    throw new Error(`AI command parser failed: ${response.status}`);
  }

  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("AI command parser returned empty content");
  }

  return validateAiCommand(parseJsonContent(content));
}

export function commandManual() {
  return [
    "You are the command parser for Session Gateway.",
    "Read the user's natural-language command and return exactly one JSON object.",
    "Return JSON only. Do not use markdown. Do not explain.",
    "",
    "Security rules:",
    "- You are not an executor. You only classify intent into one allowed JSON action.",
    "- Never return shell commands, scripts, code, or arbitrary actions.",
    "- If the user asks for an unsupported operation, return {\"type\":\"help\"}.",
    "- Allowed type values: create, list, send, output, switch, stop, restart, help.",
    "- Allowed CLI kinds for create: codex, claude, opencode, runtime.",
    "- Session names and project names should use letters, numbers, dot, underscore, or hyphen.",
    "- If the user says name is '<prefix>+folder name' or '<prefix>+文件夹名称', convert it to '<prefix>-<last path segment>'.",
    "",
    "Operation manual:",
    "- help: user asks for help, command list, usage, or examples.",
    "- list: user asks to list/view sessions. Set runningOnly true only when they ask for running/active sessions.",
    "- create: user asks to create/build/start a new codex, claude, opencode, or runtime session. Extract cwd from directory/folder/path wording. cwd is required.",
    "- send: user asks to send text/message/instruction to a session. If no target session is named, omit target or set it to null.",
    "- output: user asks to show/capture/recent output for a session. Default lines is 120 unless the user gives a number.",
    "- switch: user asks to enter/use/switch to a session.",
    "- stop: user asks to stop/end a session.",
    "- restart: user asks to restart a session.",
    "",
    "Return schemas:",
    "{\"type\":\"create\",\"input\":{\"kind\":\"codex|claude|opencode|runtime\",\"cwd\":\"/path\",\"name\":\"optional\",\"project\":null}}",
    "{\"type\":\"list\",\"runningOnly\":false}",
    "{\"type\":\"send\",\"target\":\"optional session name or null\",\"text\":\"message\"}",
    "{\"type\":\"output\",\"target\":\"session name\",\"lines\":120}",
    "{\"type\":\"switch\",\"target\":\"session name\"}",
    "{\"type\":\"stop\",\"target\":\"session name\"}",
    "{\"type\":\"restart\",\"target\":\"session name\"}",
    "{\"type\":\"help\"}",
    "",
    "Examples:",
    "User: 帮助",
    "JSON: {\"type\":\"help\"}",
    "User: 列出运行中的会话",
    "JSON: {\"type\":\"list\",\"runningOnly\":true}",
    "User: 建一个opencode会话，用/workspace/OPCAid文件夹，会话名称用opencode+文件夹名称",
    "JSON: {\"type\":\"create\",\"input\":{\"kind\":\"opencode\",\"cwd\":\"/workspace/OPCAid\",\"name\":\"opencode-OPCAid\",\"project\":null}}",
    "User: 新建 codex 会话 app，目录 /workspace/app",
    "JSON: {\"type\":\"create\",\"input\":{\"kind\":\"codex\",\"cwd\":\"/workspace/app\",\"name\":\"app\",\"project\":null}}",
    "User: 发送 查看当前项目结构",
    "JSON: {\"type\":\"send\",\"target\":null,\"text\":\"查看当前项目结构\"}",
    "User: 把 npm test 发给 codex-app",
    "JSON: {\"type\":\"send\",\"target\":\"codex-app\",\"text\":\"npm test\"}",
    "User: codex-app 最近 200 行输出",
    "JSON: {\"type\":\"output\",\"target\":\"codex-app\",\"lines\":200}",
    "User: 进入 local",
    "JSON: {\"type\":\"switch\",\"target\":\"local\"}",
    "User: 停止 opencode-OPCAid",
    "JSON: {\"type\":\"stop\",\"target\":\"opencode-OPCAid\"}",
    "User: 重启 sessions",
    "JSON: {\"type\":\"restart\",\"target\":\"sessions\"}"
  ].join("\n");
}

export function validateAiCommand(command) {
  if (!command || typeof command !== "object" || Array.isArray(command)) {
    throw new Error("AI command must be an object");
  }
  if (!ALLOWED_TYPES.has(command.type)) {
    throw new Error("AI command type is not allowed");
  }

  if (command.type === "help") return { type: "help" };

  if (command.type === "list") {
    return { type: "list", runningOnly: Boolean(command.runningOnly) };
  }

  if (command.type === "create") {
    const input = command.input;
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("AI create command requires input");
    }
    if (!ALLOWED_KINDS.has(input.kind)) {
      throw new Error("AI create command kind is not allowed");
    }
    if (typeof input.cwd !== "string" || !input.cwd.trim()) {
      throw new Error("AI create command requires cwd");
    }
    return {
      type: "create",
      input: {
        kind: input.kind,
        cwd: input.cwd.trim(),
        name: optionalName(input.name, { sanitize: true }),
        project: optionalName(input.project, { sanitize: true }) ?? null
      }
    };
  }

  if (command.type === "send") {
    if (typeof command.text !== "string" || !command.text.trim()) {
      throw new Error("AI send command requires text");
    }
    const target = optionalName(command.target);
    return {
      type: "send",
      target: target ?? null,
      text: command.text.trim(),
      needsCurrentSession: !target
    };
  }

  if (command.type === "output") {
    return {
      type: "output",
      target: requiredName(command.target, "AI output command requires target"),
      lines: normalizeLines(command.lines, 120)
    };
  }

  return {
    type: command.type,
    target: requiredName(command.target, `AI ${command.type} command requires target`)
  };
}

function parseJsonContent(content) {
  const trimmed = content.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("AI command parser did not return JSON");
    return JSON.parse(match[0]);
  }
}

function openAiChatUrl(baseUrl) {
  const normalized = baseUrl.replace(/\/+$/, "");
  if (normalized.endsWith("/v1/chat/completions")) return normalized;
  if (normalized.endsWith("/v1")) return `${normalized}/chat/completions`;
  return `${normalized}/v1/chat/completions`;
}

function optionalName(value, options = {}) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (options.sanitize) return sanitizeTmuxName(trimmed.replaceAll("+", "-"));
  if (!/^[A-Za-z0-9_.-]+$/.test(trimmed)) throw new Error("AI command target/name contains invalid characters");
  return trimmed;
}

function requiredName(value, message) {
  return optionalName(value) ?? throwError(message);
}

function throwError(message) {
  throw new Error(message);
}
