const state = {
  sessions: [],
  selected: null,
  outputLoading: false,
  outputLoadingSessionId: null,
  outputEtags: new Map(),
  outputPollTimer: null,
  sessionPollTimer: null,
  sessionLoading: false,
  outputPollDelayMs: 1000,
  outputWheelLastSentAt: 0,
  allYesEnabled: localStorage.getItem("sessionGatewayAllYes") === "1",
  autoYesSignatures: new Map(),
  cliDeploymentDefaults: {},
  pendingDeleteSession: null,
  customQuickKeys: loadCustomQuickKeys(),
  language: localStorage.getItem("sessionGatewayLanguage") || "zh",
  theme: localStorage.getItem("sessionGatewayTheme") || "dark"
};

const OUTPUT_POLL_DELAYS_MS = [1000, 2000, 5000, 10000];

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
    cancel: "取消",
    delete: "删除",
    allYes: "All Yes",
    quickKeyTitle: "自定义快捷键",
    quickKeyText: "文本 + 回车",
    stopGeneration: "停止",
    pageUp: "上页",
    pageDown: "下页",
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
    deleteTitle: "删除会话",
    historyTitle: "输入历史",
    history: "历史",
    deleteConfirm: "确认删除会话“{name}”？正在运行的会话会先停止。",
    commandParser: "命令解析",
    aiParserEnabled: "规则失败时使用本地模型",
    deployment: "部署方式",
    token: "Bearer token",
    dockerMode: "Docker",
    hostMode: "非 Docker",
    noSession: "未选择会话",
    selectRunning: "请先选择一个运行中的会话",
    selectSession: "请先选择一个会话",
    statusRunning: "运行",
    statusStopped: "停止",
    taskCompleted: "已停止",
    taskInProgress: "进行中",
    taskNeedsConfirmation: "需要确认",
    confirmAlert: "需要确认：{name}",
    sendPlaceholder: "发送到当前会话",
    namePlaceholder: "会话名，例如 codex-app",
    cwdPlaceholder: "工作目录，留空则使用默认会话目录",
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
    cancel: "Cancel",
    delete: "Delete",
    allYes: "All Yes",
    quickKeyTitle: "Custom Quick Key",
    quickKeyText: "Text + Enter",
    stopGeneration: "Stop",
    pageUp: "Page Up",
    pageDown: "Page Down",
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
    deleteTitle: "Delete Session",
    historyTitle: "Input History",
    history: "History",
    deleteConfirm: "Delete session \"{name}\"? A running session will be stopped first.",
    commandParser: "Command Parser",
    aiParserEnabled: "Use local model when rules fail",
    deployment: "Deployment",
    token: "Bearer token",
    dockerMode: "Docker",
    hostMode: "Host",
    noSession: "No session selected",
    selectRunning: "Select a running session first",
    selectSession: "Select a session first",
    statusRunning: "Running",
    statusStopped: "Stopped",
    taskCompleted: "Stopped",
    taskInProgress: "In progress",
    taskNeedsConfirmation: "Needs confirmation",
    confirmAlert: "Needs confirmation: {name}",
    sendPlaceholder: "Send text to selected session",
    namePlaceholder: "Session name, e.g. codex-app",
    cwdPlaceholder: "Working directory; leave blank for the default session folder",
    projectPlaceholder: "Project",
    nlPlaceholder: "help / send inspect this repo / create codex session app in /workspace/app"
  }
};

const els = {
  openSessions: document.querySelector("#open-sessions"),
  confirmAlert: document.querySelector("#confirm-alert"),
  closeSessions: document.querySelector("#close-sessions"),
  sessionsTitle: document.querySelector("[data-i18n='sessionsTitle']"),
  sessionsPanel: document.querySelector("#sessions-panel"),
  openConfig: document.querySelector("#open-config"),
  configDialog: document.querySelector("#config-dialog"),
  configForm: document.querySelector("#config-form"),
  language: document.querySelector("#language"),
  theme: document.querySelector("#theme"),
  allYes: document.querySelector("#all-yes"),
  openHistory: document.querySelector("#open-history"),
  historyDialog: document.querySelector("#history-dialog"),
  historyList: document.querySelector("#history-list"),
  openCreate: document.querySelector("#open-create"),
  createDialog: document.querySelector("#create-dialog"),
  createForm: document.querySelector("#create-form"),
  openRun: document.querySelector("#open-run"),
  runDialog: document.querySelector("#run-dialog"),
  runForm: document.querySelector("#run-form"),
  deleteDialog: document.querySelector("#delete-dialog"),
  deleteForm: document.querySelector("#delete-form"),
  deleteMessage: document.querySelector("#delete-message"),
  quickKeys: document.querySelector("#quick-keys"),
  addQuickKey: document.querySelector("#add-quick-key"),
  quickKeyDialog: document.querySelector("#quick-key-dialog"),
  quickKeyForm: document.querySelector("#quick-key-form"),
  quickKeyLabel: document.querySelector("#quick-key-label"),
  quickKeyValue: document.querySelector("#quick-key-value"),
  token: document.querySelector("#token"),
  aiParserEnabled: document.querySelector("#ai-parser-enabled"),
  aiParserBaseUrl: document.querySelector("#ai-parser-base-url"),
  aiParserModel: document.querySelector("#ai-parser-model"),
  aiParserApiKey: document.querySelector("#ai-parser-api-key"),
  kind: document.querySelector("#kind"),
  createDeployment: document.querySelector("#create-deployment"),
  createDeploymentMode: document.querySelector("#create-deployment-mode"),
  createDockerName: document.querySelector("#create-docker-name"),
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
els.allYes.checked = state.allYesEnabled;
els.token.addEventListener("input", () => {
  localStorage.setItem("sessionGatewayToken", els.token.value);
});
els.allYes.addEventListener("change", async () => {
  state.allYesEnabled = els.allYes.checked;
  localStorage.setItem("sessionGatewayAllYes", state.allYesEnabled ? "1" : "0");
  if (state.allYesEnabled) {
    if (state.selected?.status === "running") {
      clearOutputEtag(state.selected.id);
      await loadOutput({ force: true });
    }
    maybeAutoYes(els.output.textContent, { force: true });
  }
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
els.confirmAlert.addEventListener("click", async () => {
  const session = firstSessionNeedingConfirmation();
  if (session) await selectSession(session);
});
els.closeSessions.addEventListener("click", closeSessionsPanel);
els.openConfig.addEventListener("click", async () => {
  await loadConfig();
  els.configDialog.showModal();
});
els.openHistory.addEventListener("click", async () => {
  await loadHistory();
  els.historyDialog.showModal();
});
els.openCreate.addEventListener("click", () => {
  updateCreateDeploymentControls();
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
els.kind.addEventListener("change", () => {
  delete els.createDeploymentMode.dataset.touched;
  updateCreateDeploymentControls();
});
els.createDeploymentMode.addEventListener("change", () => {
  els.createDeploymentMode.dataset.touched = "1";
  updateCreateDeploymentControls();
});
els.send.addEventListener("click", sendInput);
els.restart.addEventListener("click", restartSession);
els.stop.addEventListener("click", stopSession);
els.runForm.addEventListener("submit", (event) => {
  event.preventDefault();
  runNaturalCommand();
});
els.deleteForm.addEventListener("submit", (event) => {
  event.preventDefault();
  deletePendingSession();
});
els.addQuickKey.addEventListener("click", openQuickKeyDialog);
els.quickKeyForm.addEventListener("submit", (event) => {
  event.preventDefault();
  saveQuickKey();
});
els.input.addEventListener("keydown", (event) => {
  if (event.key === "Enter") sendInput();
  if (event.key === "PageUp" || event.key === "PageDown") {
    event.preventDefault();
    sendQuickKeys([event.key]);
  }
});
els.output.addEventListener("wheel", handleOutputWheel, { passive: false });
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeSessionsPanel();
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    clearOutputPoll();
    clearSessionPoll();
  } else {
    resetOutputPolling(1000);
    scheduleSessionPoll(1000);
  }
});

applyLanguage();
applyTheme();
await loadConfig();
updateCreateDeploymentControls();
await refreshSessions();
renderQuickKeys();
resetOutputPolling(1000);
scheduleSessionPoll(5000);

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
    applyAiParserVisibility();
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

    const commandParser = {
      enabled: els.aiParserEnabled.checked,
      mode: els.aiParserEnabled.checked ? "rules-first-ai-fallback" : "rules-only"
    };

    if (els.aiParserEnabled.checked && !isAiParserConfigSaved()) {
      commandParser.baseUrl = els.aiParserBaseUrl.value;
      commandParser.model = els.aiParserModel.value;
      commandParser.apiKey = els.aiParserApiKey.value;

      localStorage.setItem("sessionGatewayAiParser", JSON.stringify({
        baseUrl: els.aiParserBaseUrl.value,
        model: els.aiParserModel.value,
        apiKey: els.aiParserApiKey.value
      }));
    } else if (isAiParserConfigSaved()) {
      const saved = JSON.parse(localStorage.getItem("sessionGatewayAiParser") || "{}");
      commandParser.baseUrl = saved.baseUrl;
      commandParser.model = saved.model;
      commandParser.apiKey = saved.apiKey;
    }

    const settings = {
      cliDeployment: state.cliDeploymentDefaults,
      commandParser
    };
    const data = await api("/api/config", {
      method: "PUT",
      body: JSON.stringify({ settings })
    });
    applyServerSettings(data.settings);
    applyAiParserVisibility();
    els.configDialog.close();
  } catch (error) {
    showError(error);
  }
}

function isAiParserConfigSaved() {
  const saved = localStorage.getItem("sessionGatewayAiParser");
  if (!saved) return false;
  const config = JSON.parse(saved);
  return config.baseUrl && config.model;
}

function applyAiParserVisibility() {
  const saved = isAiParserConfigSaved();
  const fieldset = els.aiParserEnabled.closest("fieldset");
  const inputs = fieldset.querySelectorAll("input:not(#ai-parser-enabled)");

  inputs.forEach((input) => {
    input.hidden = saved;
  });

  if (saved) {
    const config = JSON.parse(localStorage.getItem("sessionGatewayAiParser") || "{}");
    els.aiParserBaseUrl.value = config.baseUrl || "";
    els.aiParserModel.value = config.model || "";
    els.aiParserApiKey.value = config.apiKey || "";
  }
}

async function refreshSessions() {
  if (state.sessionLoading) return;
  state.sessionLoading = true;
  try {
    const data = await api("/api/sessions");
    state.sessions = data.sessions;
    if (state.selected) {
      const current = state.sessions.find((session) => session.id === state.selected.id);
      state.selected = current || null;
      renderSessions();
      renderTaskAlert();
      renderQuickKeys();
      if (state.selected?.status === "running") {
        await loadOutput();
        resetOutputPolling();
      } else if (state.selected) {
        clearOutputPoll();
        showSessionSummary(state.selected);
      } else {
        clearOutputPoll();
        els.title.textContent = t("noSession");
      }
      return;
    }
    state.selected = state.sessions.find((session) => session.status === "running") ?? state.sessions[0] ?? null;
    renderSessions();
    renderTaskAlert();
    renderQuickKeys();
    if (state.selected?.status === "running") {
      await loadOutput();
      resetOutputPolling();
    } else {
      clearOutputPoll();
    }
  } catch (error) {
    showError(error);
  } finally {
    state.sessionLoading = false;
    scheduleSessionPoll();
  }
}

async function createSession() {
  try {
    const body = {
      kind: els.kind.value,
      name: els.name.value || undefined,
      cwd: els.cwd.value,
      project: els.project.value || undefined,
      deploymentMode: els.kind.value === "runtime" ? undefined : els.createDeploymentMode.value,
      dockerName:
        els.kind.value !== "runtime" && els.createDeploymentMode.value === "docker"
          ? els.createDockerName.value
          : undefined
    };
    const data = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify(body)
    });
    state.selected = data.session;
    clearOutputEtag(state.selected.id);
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
        if (state.selected) clearOutputEtag(state.selected.id);
      }
      await refreshSessions();
      resetOutputPolling(500);
    }
  } catch (error) {
    els.commandResult.textContent = error instanceof Error ? error.message : String(error);
  }
}

async function loadOutput(options = {}) {
  if (!state.selected) return null;
  if (state.selected.status !== "running") {
    showSessionSummary(state.selected);
    return null;
  }
  const sessionId = state.selected.id;
  if (state.outputLoading && state.outputLoadingSessionId === sessionId) return null;
  state.outputLoading = true;
  state.outputLoadingSessionId = sessionId;
  try {
    const params = new URLSearchParams({ lines: "300", format: "json" });
    const etag = state.outputEtags.get(sessionId);
    if (etag && !options.force) params.set("etag", etag);
    const data = await api(`/api/sessions/${encodeURIComponent(sessionId)}/output?${params}`);
    if (state.selected?.id !== sessionId) return null;
    if (typeof data === "string") {
      updateOutputText(data);
      clearOutputEtag(sessionId);
      return true;
    }
    if (data.etag) state.outputEtags.set(sessionId, data.etag);
    if (!data.changed) return false;
    updateOutputText(data.output ?? "");
    return true;
  } catch (error) {
    showError(error);
    return null;
  } finally {
    if (state.outputLoadingSessionId === sessionId) {
      state.outputLoading = false;
      state.outputLoadingSessionId = null;
    }
  }
}

function updateOutputText(text) {
    const shouldStickToBottom =
      els.output.scrollHeight - els.output.scrollTop - els.output.clientHeight < 48;
    els.output.textContent = text;
    els.title.textContent = state.selected.name;
    if (shouldStickToBottom) {
      els.output.scrollTop = els.output.scrollHeight;
    }
    markSelectedTaskState(findYesOption(text) ? "needs_confirmation" : "in_progress");
    maybeAutoYes(text);
}

function handleOutputWheel(event) {
  if (!shouldForwardOutputWheel(event)) return;
  event.preventDefault();
  const now = Date.now();
  if (now - state.outputWheelLastSentAt < 120) return;
  state.outputWheelLastSentAt = now;
  sendQuickKeys([event.deltaY < 0 ? "PageUp" : "PageDown"]);
}

function shouldForwardOutputWheel(event) {
  if (!state.selected || state.selected.status !== "running" || state.selected.kind === "runtime") return false;
  if (!event.deltaY) return false;
  const canScrollUp = els.output.scrollTop > 0;
  const canScrollDown = els.output.scrollTop + els.output.clientHeight < els.output.scrollHeight - 1;
  return event.deltaY < 0 ? !canScrollUp : !canScrollDown;
}

function maybeAutoYes(text, options = {}) {
  if (!state.allYesEnabled || !state.selected || state.selected.status !== "running") return;
  if (state.selected.kind === "runtime") return;
  const match = findYesOption(text);
  if (!match) return;
  const sessionId = state.selected.id;
  const signature = match.signature;
  if (!options.force && state.autoYesSignatures.get(sessionId) === signature) return;
  sendAutoYes(sessionId, signature, match.key, match.type);
}

function findYesOption(text) {
  const normalized = stripAnsi(text);
  const lines = normalized
    .split("\n")
    .filter((line) => line.trim())
    .slice(-10);
  const context = lines.map((line) => line.trim()).join("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    // 匹配 opencode 权限底栏："Allow once   Allow always   Reject ... enter confirm"
    if (/\ballow\s+once\b.*\ballow\s+(?:always|allways)\b.*\breject\b/i.test(line)) {
      return { signature: context, key: "Enter", type: "key" };
    }
    // 匹配 "1) yes" / "1.Allow" / "2. Allow once" / "3: Allow always" 格式
    const numericAllow = line.match(
      /(?:^|[\s>❯›»])([1-9])\s*[\).:\]-]\s*(?:yes|allow(?:\s+(?:once|always|allways))?)\b/i
    );
    if (numericAllow) {
      return { signature: context, key: numericAllow[1] };
    }
    // 匹配 "a) allow" / "a. Allow once" / "a-Allow always" 格式
    if (/(?:^|[\s>❯›»])a\s*[\).:\]-]\s*allow(?:\s+(?:once|always|allways))?\b/i.test(line)) {
      return { signature: context, key: "a" };
    }
    // 匹配单独一行 "Allow" / "Allow once" / "Allow always"，默认选第一个选项
    if (/^\s*allow(?:\s+(?:once|always|allways))?\b/i.test(line)) {
      return { signature: context, key: "1" };
    }
    // 匹配 "y) yes" / "y. yes" 格式
    if (/(?:^|[\s>❯›»])y\s*[\).:\]-]\s*yes\b/i.test(line)) {
      return { signature: context, key: "y" };
    }
  }
  return null;
}

function stripAnsi(text) {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
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
    if (state.selected) clearOutputEtag(state.selected.id);
    resetOutputPolling(500);
  } catch (error) {
    showError(error);
  }
}

async function sendQuickText(text) {
  if (!state.selected || state.selected.status !== "running") {
    showError(new Error(t("selectRunning")));
    return;
  }
  try {
    await api(`/api/sessions/${encodeURIComponent(state.selected.id)}/input`, {
      method: "POST",
      body: JSON.stringify({ text })
    });
    clearOutputEtag(state.selected.id);
    resetOutputPolling(500);
  } catch (error) {
    showError(error);
  }
}

async function sendAutoYes(sessionId, signature, key = "1", type = "text") {
  if (!state.selected || state.selected.id !== sessionId || state.selected.status !== "running") return;
  try {
    if (type === "key") {
      await api(`/api/sessions/${encodeURIComponent(sessionId)}/keys`, {
        method: "POST",
        body: JSON.stringify({ keys: [key] })
      });
    } else {
      await api(`/api/sessions/${encodeURIComponent(sessionId)}/input`, {
        method: "POST",
        body: JSON.stringify({ text: key })
      });
    }
    state.autoYesSignatures.set(sessionId, signature);
    clearOutputEtag(sessionId);
    resetOutputPolling(500);
  } catch (error) {
    showError(error);
  }
}

async function sendQuickKeys(keys) {
  if (!state.selected || state.selected.status !== "running") {
    showError(new Error(t("selectRunning")));
    return;
  }
  try {
    await api(`/api/sessions/${encodeURIComponent(state.selected.id)}/keys`, {
      method: "POST",
      body: JSON.stringify({ keys })
    });
    clearOutputEtag(state.selected.id);
    resetOutputPolling(500);
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
    clearOutputEtag(state.selected.id);
    await refreshSessions();
    resetOutputPolling(500);
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
    clearOutputEtag(state.selected.id);
    clearOutputPoll();
    await refreshSessions();
  } catch (error) {
    showError(error);
  }
}

function openDeleteDialog(session) {
  state.pendingDeleteSession = session;
  els.deleteMessage.textContent = t("deleteConfirm").replace("{name}", session.name);
  els.deleteDialog.showModal();
}

async function deletePendingSession() {
  const session = state.pendingDeleteSession;
  if (!session) return;
  try {
    await api(`/api/sessions/${encodeURIComponent(session.id)}/delete`, { method: "DELETE" });
    clearOutputEtag(session.id);
    if (state.selected?.id === session.id) {
      state.selected = null;
      clearOutputPoll();
      els.output.textContent = "";
      els.title.textContent = t("noSession");
      renderQuickKeys();
    }
    state.pendingDeleteSession = null;
    els.deleteDialog.close();
    await refreshSessions();
  } catch (error) {
    showError(error);
  }
}

function renderQuickKeys() {
  els.quickKeys.innerHTML = "";
  for (const quickKey of quickKeysForSession(state.selected)) {
    const button = document.createElement("button");
    button.className = "quick-key";
    button.type = "button";
    button.textContent = quickKey.label;
    button.title = quickKey.title ?? quickKey.label;
    button.addEventListener("click", () => activateQuickKey(quickKey));
    els.quickKeys.append(button);
  }
}

function quickKeysForSession(session) {
  const base = ["1", "2", "3", "4"].map((value) => ({
    label: value,
    type: "text",
    value,
    title: `${value} + Enter`
  }));
  const kindKeys = session && session.kind !== "runtime" ? quickKeysForKind(session.kind) : [];
  return [...base, ...kindKeys, ...state.customQuickKeys];
}

function quickKeysForKind(kind) {
  if (kind === "codex" || kind === "claude" || kind === "opencode") {
    return [
      { label: t("stopGeneration"), type: "key", value: "Escape", title: "Escape" },
      { label: "Shift+Tab", type: "key", value: "BTab" },
      { label: t("pageUp"), type: "key", value: "PageUp", title: "PageUp" },
      { label: t("pageDown"), type: "key", value: "PageDown", title: "PageDown" }
    ];
  }
  return [];
}

function activateQuickKey(quickKey) {
  if (quickKey.type === "key") {
    sendQuickKeys([quickKey.value]);
    return;
  }
  sendQuickText(quickKey.value);
}

function openQuickKeyDialog() {
  els.quickKeyLabel.value = "";
  els.quickKeyValue.value = "";
  els.quickKeyDialog.showModal();
  els.quickKeyLabel.focus();
}

function saveQuickKey() {
  const label = els.quickKeyLabel.value.trim();
  const value = els.quickKeyValue.value.trim();
  if (!label || !value) return;
  state.customQuickKeys.push({ label, type: "text", value });
  localStorage.setItem("sessionGatewayCustomQuickKeys", JSON.stringify(state.customQuickKeys));
  els.quickKeyDialog.close();
  renderQuickKeys();
}

function loadCustomQuickKeys() {
  try {
    const parsed = JSON.parse(localStorage.getItem("sessionGatewayCustomQuickKeys") || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => item && item.type !== "key" && typeof item.label === "string" && typeof item.value === "string")
      .map((item) => ({
        label: item.label.slice(0, 16),
        type: "text",
        value: item.value
      }));
  } catch {
    return [];
  }
}

function renderSessions() {
  els.list.innerHTML = "";
  for (const session of state.sessions) {
    const item = document.createElement("button");
    item.className = `session-item${state.selected?.id === session.id ? " active" : ""}`;
    item.type = "button";
    item.innerHTML = `
      <span class="session-main">
        <span class="session-name">${escapeHtml(session.name)}</span>
        <span class="session-controls">
          <span class="task-state ${taskStateClass(session.taskState)}">${escapeHtml(
            taskStateLabel(session)
          )}</span>
          <button class="session-delete" type="button" title="${escapeHtml(t("delete"))}">${escapeHtml(t("delete"))}</button>
        </span>
      </span>
      <span class="session-meta">${escapeHtml(sessionStatusLabel(session))} · ${escapeHtml(session.kind)} · ${escapeHtml(sessionDeploymentLabel(session))} · ${escapeHtml(session.cwd)}</span>
    `;
    item.addEventListener("click", () => selectSession(session));
    item.querySelector(".session-delete").addEventListener("click", (event) => {
      event.stopPropagation();
      openDeleteDialog(session);
    });
    els.list.append(item);
  }

  if (!state.sessions.length) {
    els.list.textContent = "No sessions.";
  }
}

async function selectSession(session) {
  state.selected = session;
  renderSessions();
  renderTaskAlert();
  renderQuickKeys();
  closeSessionsPanel();
  if (session.status === "running") {
    clearOutputEtag(session.id);
    await loadOutput({ force: true });
    resetOutputPolling(1000);
  } else {
    clearOutputPoll();
    showSessionSummary(session);
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

async function loadHistory() {
  try {
    const data = await api("/api/history");
    renderHistory(data.history ?? []);
  } catch (error) {
    els.historyList.textContent = `Error: ${error.message}`;
  }
}

function renderHistory(history) {
  if (!history.length) {
    els.historyList.textContent = t("noHistory");
    return;
  }
  els.historyList.innerHTML = history
    .map(
      (item) => `
    <div class="history-item">
      <div class="history-meta">
        <span class="history-session">${escapeHtml(item.sessionName || item.sessionId)}</span>
        <span class="history-kind">${escapeHtml(item.sessionKind || "")}</span>
        <span class="history-time">${formatTime(item.createdAt)}</span>
      </div>
      <div class="history-text">${escapeHtml(item.text)}</div>
    </div>
  `
    )
    .join("");
}

function formatTime(isoString) {
  const date = new Date(isoString);
  return date.toLocaleString();
}

function focusSessionInput() {
  requestAnimationFrame(() => {
    if (state.selected?.status === "running") {
      els.input.focus();
    }
  });
}

function applyServerSettings(settings) {
  state.cliDeploymentDefaults = settings?.cliDeployment ?? {};
  const commandParser = settings?.commandParser ?? {};

  const savedConfig = localStorage.getItem("sessionGatewayAiParser");
  if (savedConfig) {
    const saved = JSON.parse(savedConfig);
    if (saved.baseUrl && saved.model) {
      els.aiParserBaseUrl.value = saved.baseUrl;
      els.aiParserModel.value = saved.model || "";
      els.aiParserApiKey.value = saved.apiKey || "";
      els.aiParserEnabled.checked = commandParser.enabled;
      updateCreateDeploymentControls();
      return;
    }
  }

  els.aiParserEnabled.checked = Boolean(commandParser.enabled);
  els.aiParserBaseUrl.value = commandParser.baseUrl ?? "";
  els.aiParserModel.value = commandParser.model ?? "";
  els.aiParserApiKey.value = commandParser.apiKey ?? "";
  updateCreateDeploymentControls();
}

function updateCreateDeploymentControls() {
  const kind = els.kind.value;
  const isRuntime = kind === "runtime";
  els.createDeployment.hidden = isRuntime;
  if (isRuntime) return;

  const defaults = state.cliDeploymentDefaults[kind] ?? {};
  if (!els.createDeploymentMode.dataset.touched) {
    els.createDeploymentMode.value = defaults.mode === "host" ? "host" : "docker";
  }
  if (!els.createDockerName.value || els.createDockerName.dataset.kind !== kind) {
    els.createDockerName.value = defaults.dockerName ?? `worker-${kind}`;
    els.createDockerName.dataset.kind = kind;
  }
  els.createDockerName.disabled = els.createDeploymentMode.value !== "docker";
}

function applyLanguage() {
  const text = translations[state.language] ?? translations.zh;
  document.querySelectorAll("[data-i18n]").forEach((element) => {
    element.textContent = text[element.dataset.i18n] ?? element.textContent;
  });
  els.openSessions.textContent = text.sessions;
  renderTaskAlert();
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
  document.querySelector("#confirm-delete").textContent = text.delete;
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
  if (result.command?.type === "help" && typeof result.help === "string") return result.help;
  if (result.command?.type === "send") return state.language === "zh" ? "已发送。" : "Sent.";
  if (result.command?.type === "output") return state.language === "zh" ? "已显示最近输出。" : "Recent output shown.";
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
        `${session.name}  [${session.kind} / ${sessionStatusLabel(session)}]`,
        `deployment: ${sessionDeploymentLabel(session)}`,
        `cwd: ${session.cwd}`,
        session.project ? `project: ${session.project}` : null,
        `updated: ${session.updatedAt}`
      ]
        .filter(Boolean)
        .join("\n")
    )
    .join("\n\n");
}

function sessionStatusLabel(session) {
  return session.status === "running" ? t("statusRunning") : t("statusStopped");
}

function taskStateLabel(session) {
  if (session.taskState === "needs_confirmation") return t("taskNeedsConfirmation");
  if (session.taskState === "completed") return t("taskCompleted");
  return t("taskInProgress");
}

function taskStateClass(taskState) {
  if (taskState === "needs_confirmation") return "needs-confirmation";
  if (taskState === "completed") return "completed";
  return "in-progress";
}

function sessionDeploymentLabel(session) {
  return session.command === "docker" ? t("dockerMode") : t("hostMode");
}

async function refreshSelectedOutput() {
  if (document.hidden || !state.selected || state.selected.status !== "running") {
    clearOutputPoll();
    return;
  }
  const changed = await loadOutput();
  if (changed === false) maybeAutoYes(els.output.textContent);
  updateOutputPollDelay(changed);
  scheduleOutputPoll(state.outputPollDelayMs);
}

function resetOutputPolling(delayMs = 1000) {
  state.outputPollDelayMs = delayMs;
  scheduleOutputPoll(delayMs);
}

function updateOutputPollDelay(changed) {
  if (changed === true) {
    state.outputPollDelayMs = OUTPUT_POLL_DELAYS_MS[0];
    return;
  }
  const currentIndex = OUTPUT_POLL_DELAYS_MS.indexOf(state.outputPollDelayMs);
  const nextIndex = Math.min(currentIndex < 0 ? 1 : currentIndex + 1, OUTPUT_POLL_DELAYS_MS.length - 1);
  state.outputPollDelayMs = OUTPUT_POLL_DELAYS_MS[nextIndex];
}

function scheduleOutputPoll(delayMs) {
  clearOutputPoll();
  if (document.hidden || !state.selected || state.selected.status !== "running") return;
  state.outputPollTimer = setTimeout(refreshSelectedOutput, delayMs);
}

function scheduleSessionPoll(delayMs = 5000) {
  clearSessionPoll();
  if (document.hidden) return;
  state.sessionPollTimer = setTimeout(refreshSessions, delayMs);
}

function clearSessionPoll() {
  if (state.sessionPollTimer) {
    clearTimeout(state.sessionPollTimer);
    state.sessionPollTimer = null;
  }
}

function clearOutputPoll() {
  if (state.outputPollTimer) {
    clearTimeout(state.outputPollTimer);
    state.outputPollTimer = null;
  }
}

function clearOutputEtag(sessionId) {
  state.outputEtags.delete(sessionId);
}

function showSessionSummary(session) {
  els.title.textContent = session.name;
  els.output.textContent = JSON.stringify(
    {
      name: session.name,
      kind: session.kind,
      status: session.status,
      taskState: taskStateLabel(session),
      deployment: sessionDeploymentLabel(session),
      cwd: session.cwd,
      project: session.project,
      tmuxSessionName: session.tmuxSessionName,
      command: [session.command, ...session.commandArgs].join(" ")
    },
    null,
    2
  );
}

function firstSessionNeedingConfirmation() {
  return state.sessions.find((session) => session.taskState === "needs_confirmation") ?? null;
}

function renderTaskAlert() {
  const session = firstSessionNeedingConfirmation();
  if (!session) {
    els.confirmAlert.hidden = true;
    els.confirmAlert.textContent = "";
    return;
  }
  els.confirmAlert.hidden = false;
  els.confirmAlert.textContent = t("confirmAlert").replace("{name}", session.name);
  els.confirmAlert.title = session.name;
}

function markSelectedTaskState(taskState) {
  if (!state.selected) return;
  state.selected = { ...state.selected, taskState };
  state.sessions = state.sessions.map((session) =>
    session.id === state.selected.id ? { ...session, taskState } : session
  );
  renderTaskAlert();
  renderSessions();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
