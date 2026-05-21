const state = {
  sessions: [],
  selected: null,
  outputLoading: false,
  language: localStorage.getItem("sessionGatewayLanguage") || "zh",
  theme: localStorage.getItem("sessionGatewayTheme") || "dark"
};

const translations = {
  zh: {
    sessions: "会话",
    create: "新建",
    command: "命令",
    restart: "重启",
    stop: "停止",
    config: "配置",
    refresh: "刷新",
    close: "关闭",
    save: "保存",
    send: "发送",
    run: "执行",
    language: "语言",
    theme: "主题",
    darkTheme: "黑暗",
    lightTheme: "明亮",
    configTitle: "配置",
    sessionsTitle: "会话",
    createTitle: "新建会话",
    commandTitle: "命令",
    commandParser: "命令解析",
    aiParserEnabled: "规则失败时使用本地模型",
    token: "Bearer token",
    dockerMode: "Docker",
    hostMode: "非 Docker",
    noSession: "未选择会话",
    selectRunning: "请先选择一个运行中的会话",
    selectSession: "请先选择一个会话",
    sendPlaceholder: "发送到当前会话",
    namePlaceholder: "会话名，例如 codex-app",
    cwdPlaceholder: "工作目录，例如 /workspace/app",
    projectPlaceholder: "项目名",
    nlPlaceholder: "帮助 / 发送 查看当前项目结构 / 新建 codex 会话 app，目录 /workspace/app"
  },
  en: {
    sessions: "Sessions",
    create: "Create",
    command: "Command",
    restart: "Restart",
    stop: "Stop",
    config: "Config",
    refresh: "Refresh",
    close: "Close",
    save: "Save",
    send: "Send",
    run: "Run",
    language: "Language",
    theme: "Theme",
    darkTheme: "Dark",
    lightTheme: "Light",
    configTitle: "Config",
    sessionsTitle: "Sessions",
    createTitle: "Create Session",
    commandTitle: "Command",
    commandParser: "Command Parser",
    aiParserEnabled: "Use local model when rules fail",
    token: "Bearer token",
    dockerMode: "Docker",
    hostMode: "Host",
    noSession: "No session selected",
    selectRunning: "Select a running session first",
    selectSession: "Select a session first",
    sendPlaceholder: "Send text to selected session",
    namePlaceholder: "Session name, e.g. codex-app",
    cwdPlaceholder: "Working directory, e.g. /workspace/app",
    projectPlaceholder: "Project",
    nlPlaceholder: "help / send inspect this repo / create codex session app in /workspace/app"
  }
};

const els = {
  openSessions: document.querySelector("#open-sessions"),
  closeSessions: document.querySelector("#close-sessions"),
  sessionsTitle: document.querySelector("[data-i18n='sessionsTitle']"),
  sessionsPanel: document.querySelector("#sessions-panel"),
  openConfig: document.querySelector("#open-config"),
  configDialog: document.querySelector("#config-dialog"),
  configForm: document.querySelector("#config-form"),
  language: document.querySelector("#language"),
  theme: document.querySelector("#theme"),
  openCreate: document.querySelector("#open-create"),
  createDialog: document.querySelector("#create-dialog"),
  createForm: document.querySelector("#create-form"),
  openRun: document.querySelector("#open-run"),
  runDialog: document.querySelector("#run-dialog"),
  runForm: document.querySelector("#run-form"),
  token: document.querySelector("#token"),
  aiParserEnabled: document.querySelector("#ai-parser-enabled"),
  aiParserBaseUrl: document.querySelector("#ai-parser-base-url"),
  aiParserModel: document.querySelector("#ai-parser-model"),
  aiParserApiKey: document.querySelector("#ai-parser-api-key"),
  kind: document.querySelector("#kind"),
  name: document.querySelector("#name"),
  cwd: document.querySelector("#cwd"),
  project: document.querySelector("#project"),
  create: document.querySelector("#create"),
  nl: document.querySelector("#nl"),
  runNl: document.querySelector("#run-nl"),
  commandResult: document.querySelector("#command-result"),
  refresh: document.querySelector("#refresh"),
  list: document.querySelector("#session-list"),
  title: document.querySelector("#selected-title"),
  output: document.querySelector("#output"),
  input: document.querySelector("#input"),
  send: document.querySelector("#send"),
  restart: document.querySelector("#restart"),
  stop: document.querySelector("#stop")
};

els.token.value = localStorage.getItem("sessionGatewayToken") || "";
els.language.value = state.language;
els.theme.value = state.theme;
els.token.addEventListener("input", () => {
  localStorage.setItem("sessionGatewayToken", els.token.value);
});
els.language.addEventListener("change", () => {
  state.language = els.language.value;
  localStorage.setItem("sessionGatewayLanguage", state.language);
  applyLanguage();
});
els.theme.addEventListener("change", () => {
  state.theme = els.theme.value;
  localStorage.setItem("sessionGatewayTheme", state.theme);
  applyTheme();
});

els.openSessions.addEventListener("click", () => {
  els.sessionsPanel.classList.add("open");
  els.sessionsPanel.setAttribute("aria-hidden", "false");
  refreshSessions();
});
els.closeSessions.addEventListener("click", closeSessionsPanel);
els.openConfig.addEventListener("click", async () => {
  await loadConfig();
  els.configDialog.showModal();
});
els.openCreate.addEventListener("click", () => {
  els.createDialog.showModal();
  els.cwd.focus();
});
els.openRun.addEventListener("click", () => {
  els.runDialog.showModal();
  els.commandResult.textContent = "";
  els.nl.focus();
});
document.querySelectorAll("[data-close-dialog]").forEach((button) => {
  button.addEventListener("click", () => {
    closeDialog(button.dataset.closeDialog);
  });
});
els.runDialog.addEventListener("close", focusSessionInput);
els.refresh.addEventListener("click", refreshSessions);
els.configForm.addEventListener("submit", (event) => {
  event.preventDefault();
  saveConfig();
});
els.createForm.addEventListener("submit", (event) => {
  event.preventDefault();
  createSession();
});
els.send.addEventListener("click", sendInput);
els.restart.addEventListener("click", restartSession);
els.stop.addEventListener("click", stopSession);
els.runForm.addEventListener("submit", (event) => {
  event.preventDefault();
  runNaturalCommand();
});
els.input.addEventListener("keydown", (event) => {
  if (event.key === "Enter") sendInput();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeSessionsPanel();
});

applyLanguage();
applyTheme();
attachDeploymentToggles();
await loadConfig();
await refreshSessions();
setInterval(refreshSelectedOutput, 2000);

async function api(path, options = {}) {
  const headers = {
    ...(options.body ? { "content-type": "application/json" } : {}),
    authorization: `Bearer ${els.token.value}`,
    ...options.headers
  };
  const response = await fetch(path, { ...options, headers });
  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json") ? await response.json() : await response.text();
  if (!response.ok) {
    const message = typeof payload === "string" ? payload : payload.error || "Request failed";
    throw new Error(message);
  }
  return payload;
}

async function loadConfig() {
  try {
    const data = await api("/api/config");
    applyServerSettings(data.settings);
  } catch (error) {
    showError(error);
  }
}

async function saveConfig() {
  try {
    localStorage.setItem("sessionGatewayToken", els.token.value);
    state.language = els.language.value;
    state.theme = els.theme.value;
    localStorage.setItem("sessionGatewayLanguage", state.language);
    localStorage.setItem("sessionGatewayTheme", state.theme);
    applyLanguage();
    applyTheme();

    const settings = {
      cliDeployment: Object.fromEntries(
        ["codex", "opencode", "claude"].map((kind) => [
          kind,
          {
            mode: document.querySelector(`[data-deploy-mode="${kind}"]`).value,
            dockerName: document.querySelector(`[data-docker-name="${kind}"]`).value
          }
        ])
      ),
      commandParser: {
        enabled: els.aiParserEnabled.checked,
        mode: els.aiParserEnabled.checked ? "rules-first-ai-fallback" : "rules-only",
        baseUrl: els.aiParserBaseUrl.value,
        model: els.aiParserModel.value,
        apiKey: els.aiParserApiKey.value
      }
    };
    const data = await api("/api/config", {
      method: "PUT",
      body: JSON.stringify({ settings })
    });
    applyServerSettings(data.settings);
    els.configDialog.close();
  } catch (error) {
    showError(error);
  }
}

async function refreshSessions() {
  try {
    const data = await api("/api/sessions");
    state.sessions = data.sessions;
    if (state.selected) {
      const current = state.sessions.find((session) => session.id === state.selected.id);
      state.selected = current || null;
      renderSessions();
      if (state.selected?.status === "running") {
        await loadOutput();
      } else if (state.selected) {
        showSessionSummary(state.selected);
      } else {
        els.title.textContent = t("noSession");
      }
      return;
    }
    state.selected = state.sessions.find((session) => session.status === "running") ?? state.sessions[0] ?? null;
    renderSessions();
    if (state.selected?.status === "running") {
      await loadOutput();
    }
  } catch (error) {
    showError(error);
  }
}

async function createSession() {
  try {
    const body = {
      kind: els.kind.value,
      name: els.name.value || undefined,
      cwd: els.cwd.value,
      project: els.project.value || undefined
    };
    const data = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify(body)
    });
    state.selected = data.session;
    els.createDialog.close();
    await refreshSessions();
  } catch (error) {
    showError(error);
  }
}

async function runNaturalCommand() {
  try {
    const result = await api("/api/nl", {
      method: "POST",
      body: JSON.stringify({ text: els.nl.value, currentSessionId: state.selected?.id })
    });
    if (typeof result === "string") {
      els.commandResult.textContent = result;
    } else {
      if (result.session) {
        state.selected = result.session;
      }
      els.commandResult.textContent = formatCommandResult(result);
      if (typeof result.output === "string") {
        els.output.textContent = result.output;
      }
      await refreshSessions();
      scheduleOutputRefreshes();
    }
  } catch (error) {
    els.commandResult.textContent = error instanceof Error ? error.message : String(error);
  }
}

async function loadOutput() {
  if (!state.selected) return;
  if (state.selected.status !== "running") {
    showSessionSummary(state.selected);
    return;
  }
  if (state.outputLoading) return;
  state.outputLoading = true;
  try {
    const text = await api(`/api/sessions/${encodeURIComponent(state.selected.id)}/output?lines=300`);
    const shouldStickToBottom =
      els.output.scrollHeight - els.output.scrollTop - els.output.clientHeight < 48;
    els.output.textContent = text;
    els.title.textContent = state.selected.name;
    if (shouldStickToBottom) {
      els.output.scrollTop = els.output.scrollHeight;
    }
  } catch (error) {
    showError(error);
  } finally {
    state.outputLoading = false;
  }
}

async function sendInput() {
  if (!state.selected) {
    showError(new Error(t("selectRunning")));
    return;
  }
  if (state.selected.status !== "running") {
    showSessionSummary(state.selected);
    return;
  }
  if (!els.input.value.trim()) return;
  try {
    await api(`/api/sessions/${encodeURIComponent(state.selected.id)}/input`, {
      method: "POST",
      body: JSON.stringify({ text: els.input.value })
    });
    els.input.value = "";
    scheduleOutputRefreshes();
  } catch (error) {
    showError(error);
  }
}

async function restartSession() {
  if (!state.selected) {
    showError(new Error(t("selectSession")));
    return;
  }
  try {
    await api(`/api/sessions/${encodeURIComponent(state.selected.id)}/restart`, { method: "POST" });
    await refreshSessions();
  } catch (error) {
    showError(error);
  }
}

async function stopSession() {
  if (!state.selected) {
    showError(new Error(t("selectSession")));
    return;
  }
  try {
    await api(`/api/sessions/${encodeURIComponent(state.selected.id)}`, { method: "DELETE" });
    await refreshSessions();
  } catch (error) {
    showError(error);
  }
}

function renderSessions() {
  els.list.innerHTML = "";
  for (const session of state.sessions) {
    const item = document.createElement("button");
    item.className = `session-item${state.selected?.id === session.id ? " active" : ""}`;
    item.type = "button";
    item.innerHTML = `
      <span class="session-name">${escapeHtml(session.name)}</span>
      <span class="session-meta">${escapeHtml(session.kind)} · ${escapeHtml(session.status)} · ${escapeHtml(session.cwd)}</span>
    `;
    item.addEventListener("click", async () => {
      state.selected = session;
      renderSessions();
      closeSessionsPanel();
      if (session.status === "running") {
        await loadOutput();
      } else {
        showSessionSummary(session);
      }
    });
    els.list.append(item);
  }

  if (!state.sessions.length) {
    els.list.textContent = "No sessions.";
  }
}

function closeSessionsPanel() {
  els.sessionsPanel.classList.remove("open");
  els.sessionsPanel.setAttribute("aria-hidden", "true");
}

function closeDialog(dialogId) {
  const dialog = document.querySelector(`#${dialogId}`);
  if (dialog?.open) dialog.close();
}

function focusSessionInput() {
  requestAnimationFrame(() => {
    if (state.selected?.status === "running") {
      els.input.focus();
    }
  });
}

function applyServerSettings(settings) {
  const cliDeployment = settings?.cliDeployment ?? {};
  for (const kind of ["codex", "opencode", "claude"]) {
    const mode = document.querySelector(`[data-deploy-mode="${kind}"]`);
    const dockerName = document.querySelector(`[data-docker-name="${kind}"]`);
    mode.value = cliDeployment[kind]?.mode ?? "docker";
    dockerName.value = cliDeployment[kind]?.dockerName ?? `worker-${kind}`;
  }
  const commandParser = settings?.commandParser ?? {};
  els.aiParserEnabled.checked = Boolean(commandParser.enabled);
  els.aiParserBaseUrl.value = commandParser.baseUrl ?? "";
  els.aiParserModel.value = commandParser.model ?? "";
  els.aiParserApiKey.value = commandParser.apiKey ?? "";
  toggleDockerInputs();
}

function attachDeploymentToggles() {
  document.querySelectorAll("[data-deploy-mode]").forEach((select) => {
    select.addEventListener("change", toggleDockerInputs);
  });
}

function toggleDockerInputs() {
  document.querySelectorAll("[data-deploy-mode]").forEach((select) => {
    const kind = select.dataset.deployMode;
    const dockerName = document.querySelector(`[data-docker-name="${kind}"]`);
    dockerName.disabled = select.value !== "docker";
  });
}

function applyLanguage() {
  const text = translations[state.language] ?? translations.zh;
  document.querySelectorAll("[data-i18n]").forEach((element) => {
    element.textContent = text[element.dataset.i18n] ?? element.textContent;
  });
  els.openSessions.textContent = text.sessions;
  els.openCreate.textContent = text.create;
  els.openRun.textContent = text.command;
  els.restart.textContent = text.restart;
  els.stop.textContent = text.stop;
  els.openConfig.textContent = text.config;
  els.sessionsTitle.textContent = text.sessionsTitle;
  els.closeSessions.textContent = text.close;
  els.refresh.textContent = text.refresh;
  els.send.textContent = text.send;
  els.create.textContent = text.create;
  els.runNl.textContent = text.run;
  els.input.placeholder = text.sendPlaceholder;
  els.name.placeholder = text.namePlaceholder;
  els.cwd.placeholder = text.cwdPlaceholder;
  els.project.placeholder = text.projectPlaceholder;
  els.nl.placeholder = text.nlPlaceholder;
  if (!state.selected) els.title.textContent = text.noSession;
}

function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
}

function t(key) {
  return (translations[state.language] ?? translations.zh)[key] ?? key;
}

function showError(error) {
  els.output.textContent = error instanceof Error ? error.message : String(error);
}

function formatCommandResult(result) {
  if (!result || typeof result !== "object") return String(result);
  if (Array.isArray(result.sessions)) return formatSessionList(result.sessions);
  if (result.command?.type === "send") return state.language === "zh" ? "已发送。" : "Sent.";
  if (result.command?.type === "stop") return state.language === "zh" ? "已停止。" : "Stopped.";
  if (result.command?.type === "restart") return state.language === "zh" ? "已重启。" : "Restarted.";
  if (result.command?.type === "create" && result.session) {
    return formatSessionList([result.session]);
  }
  if (result.command?.type === "switch" && result.session) {
    return formatSessionList([result.session]);
  }
  const copy = { ...result };
  if (typeof copy.output === "string") copy.output = `${copy.output.length} characters shown in terminal`;
  return JSON.stringify(copy, null, 2);
}

function formatSessionList(sessions) {
  if (!sessions.length) return state.language === "zh" ? "没有会话。" : "No sessions.";
  return sessions
    .map((session) =>
      [
        `${session.name}  [${session.kind} / ${session.status}]`,
        `cwd: ${session.cwd}`,
        session.project ? `project: ${session.project}` : null,
        `updated: ${session.updatedAt}`
      ]
        .filter(Boolean)
        .join("\n")
    )
    .join("\n\n");
}

function refreshSelectedOutput() {
  if (document.hidden || !state.selected || state.selected.status !== "running") return;
  loadOutput();
}

function scheduleOutputRefreshes() {
  for (const delay of [500, 1500, 3000, 6000, 10000]) {
    setTimeout(refreshSelectedOutput, delay);
  }
}

function showSessionSummary(session) {
  els.title.textContent = session.name;
  els.output.textContent = JSON.stringify(
    {
      name: session.name,
      kind: session.kind,
      status: session.status,
      cwd: session.cwd,
      project: session.project,
      tmuxSessionName: session.tmuxSessionName,
      command: [session.command, ...session.commandArgs].join(" ")
    },
    null,
    2
  );
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
