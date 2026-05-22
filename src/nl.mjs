const kindMap = {
  codex: "codex",
  claude: "claude",
  opencode: "opencode",
  "open code": "opencode",
  runtime: "runtime",
  本地: "runtime"
};

const targetPattern = "[A-Za-z0-9_.-]+";

export function parseNaturalCommand(text) {
  const raw = text.trim();
  if (!raw) throw new Error("Empty command");

  if (/^(help|帮助|指令|命令帮助)[。.\s]*$/i.test(raw)) {
    return { type: "help" };
  }

  const stop = raw.match(new RegExp(`^(?:停止|stop)\\s*(${targetPattern})[。.\\s]*$`, "i"));
  if (stop) return { type: "stop", target: stop[1] };

  const restart = raw.match(new RegExp(`^(?:重启|restart)\\s*(${targetPattern})[。.\\s]*$`, "i"));
  if (restart) return { type: "restart", target: restart[1] };

  const zhOutput = raw.match(new RegExp(`^(${targetPattern})\\s*最近\\s*(\\d+)?\\s*行?\\s*输[。.\\s]*出[。.\\s]*$`, "i"));
  if (zhOutput) return { type: "output", target: zhOutput[1], lines: parseLines(zhOutput[2]) };

  const enOutput = raw.match(new RegExp(`^(?:output|out|show output)\\s+(${targetPattern})(?:\\s+(\\d+))?[。.\\s]*$`, "i"));
  if (enOutput) return { type: "output", target: enOutput[1], lines: parseLines(enOutput[2]) };

  const switchSession = raw.match(new RegExp(`^(?:进入|切换到?|use|switch(?: to)?)\\s*(${targetPattern})[。.\\s]*$`, "i"));
  if (switchSession) return { type: "switch", target: switchSession[1] };

  if ((/列出|查看/.test(raw) && /会话/.test(raw)) || /^(?:ls|list)(?:\s+(?:running\s+)?sessions?)?[。.\s]*$/i.test(raw)) {
    return { type: "list", runningOnly: /运行中|running/.test(raw) };
  }

  const send = raw.match(new RegExp(`^把(?:这句话|消息|文本)?\\s*发给\\s*(${targetPattern})\\s*[：:]\\s*(.+?)\\s*[。.]?$`, "i"));
  if (send) return { type: "send", target: send[1], text: send[2] };

  const enSend = raw.match(new RegExp(`^send\\s+(.+?)\\s+to\\s+(${targetPattern})[。.]?$`, "i"));
  if (enSend) return { type: "send", target: enSend[2], text: enSend[1] };

  const currentSend = raw.match(/^(?:发送|send)\s+(.+?)\s*[。.]?$/i);
  if (currentSend) return { type: "send", target: null, text: currentSend[1], needsCurrentSession: true };

  const create = raw.match(/新建(?:一个)?\s*(codex|claude|opencode|open code|runtime|本地)\s*会话/iu);
  if (create) {
    const kind = kindMap[create[1].toLowerCase()] ?? kindMap[create[1]];
    const cwd = parseCwd(raw);
    if (!cwd) throw new Error("Create command requires cwd, for example: 目录 /workspace/app");
    const explicitName = parseName(raw, kind, cwd);
    const inlineName = raw.match(/会话\s*([A-Za-z0-9_.-]+)\s*[，,]/)?.[1];
    const name = explicitName ?? inlineName;
    const project = raw.match(/(?:项目|project)\s*([A-Za-z0-9_.-]+)/i)?.[1] ?? null;
    return {
      type: "create",
      input: {
        kind,
        cwd,
        name,
        project,
        ...deploymentInput(raw)
      }
    };
  }

  const looseZhCreate = raw.match(/(?:新)?建(?:一个)?\s*(codex|claude|opencode|open code|runtime|本地)\s*会话/iu);
  if (looseZhCreate) {
    const kind = kindMap[looseZhCreate[1].toLowerCase()] ?? kindMap[looseZhCreate[1]];
    const cwd = parseCwd(raw);
    if (!cwd) throw new Error("Create command requires cwd, for example: 目录 /workspace/app");
    return {
      type: "create",
      input: {
        kind,
        cwd,
        name: parseName(raw, kind, cwd),
        project: raw.match(/(?:项目|project)\s*([A-Za-z0-9_.-]+)/i)?.[1] ?? null,
        ...deploymentInput(raw)
      }
    };
  }

  const enCreate = raw.match(/^(?:create|new)\s+(codex|claude|opencode|open code|runtime)\s+(?:session\s+)?(?:named\s+)?([A-Za-z0-9_.-]+)?(?:\s+)?(?:in|cwd|dir|directory)\s+([^\s，。]+)(?:.*?project\s+([A-Za-z0-9_.-]+))?[。.]?$/iu);
  if (enCreate) {
    return {
      type: "create",
      input: {
        kind: kindMap[enCreate[1].toLowerCase()],
        cwd: enCreate[3],
        name: enCreate[2] || undefined,
        project: enCreate[4] ?? null,
        ...deploymentInput(raw)
      }
    };
  }

  throw new Error("Unsupported natural-language command");
}

function parseLines(value) {
  if (!value) return 120;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return 120;
  return Math.min(Math.max(parsed, 1), 2000);
}

function parseCwd(raw) {
  return raw.match(/(?:目录|文件夹|路径|用)\s*([/][^\s，。]+)/)?.[1]?.replace(/(?:文件夹|目录|路径)$/u, "");
}

function parseName(raw, kind, cwd) {
  if (/名称\s*用\s*[^，。]*文件夹名称/.test(raw)) {
    return `${kind}-${folderName(cwd)}`;
  }
  const direct = raw.match(/(?:名字|名称|name)\s*(?:用|为|叫)?\s*([A-Za-z0-9_.+-]+)/i)?.[1];
  if (direct) return normalizeNameExpression(direct, kind, cwd);
  return undefined;
}

function parseDeployment(raw) {
  if (/(?:host|非\s*docker|本机|宿主机)\s*(?:运行)?/iu.test(raw)) {
    return { mode: "host" };
  }
  if (/(?:在|用)?\s*docker\s*(?:里|中|内)?\s*(?:运行)?/iu.test(raw)) {
    return { mode: "docker" };
  }
  return undefined;
}

function deploymentInput(raw) {
  const deployment = parseDeployment(raw);
  return deployment ? { deployment } : {};
}

function normalizeNameExpression(value, kind, cwd) {
  return value
    .replaceAll("+文件夹名称", `-${folderName(cwd)}`)
    .replaceAll("+folder", `-${folderName(cwd)}`)
    .replaceAll("+", "-")
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function folderName(cwd) {
  return cwd.split("/").filter(Boolean).at(-1) ?? "session";
}
