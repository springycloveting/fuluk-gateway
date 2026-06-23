import { canAutoYesSession, shouldSendAutoYes } from "./auto_yes.js";
import { isNearScrollBottom, roomMessagesSignature } from "./room_messages.js";
import { currentWorkflowAssignments } from "./workflow_view.js";

const state = {
  sessions: [],
  rooms: [],
  roomMessages: [],
  workflows: [],
  workflowSupervisors: new Map(),
  workflowTemplates: [],
  workflowView: false,
  roomViewMode: "messages", // "messages" | "assistant" | "workflow"
  workflowPollTimer: null,
  rolePresets: [],
  selectedRoomId: localStorage.getItem("sessionGatewaySelectedRoomId") || "",
  selectedRoomChatId: "",
  selectedRoomTargetMode: "all",
  selectedRoomTargetRole: "",
  selectedRoomTargetSessionId: "",
  selectedSessionId: "",
  selectionVersion: 0,
  selected: null,
  outputLoading: false,
  outputLoadingSessionId: null,
  outputEtags: new Map(),
  outputPollTimer: null,
  sessionPollTimer: null,
  sessionLoading: false,
  outputPollDelayMs: 1000,
  outputWheelLastSentAt: 0,
  outputScrollOffset: 0,
  latestOutputText: "",
  terminal: null,
  terminalUsingXterm: false,
  terminalRenderVersion: 0,
  terminalResizeBySession: new Map(),
  allYesMode: localStorage.getItem("sessionGatewayAllYesMode") || "off",
  autoYesSignatures: new Map(),
  cliDeploymentDefaults: {},
  notifications: {},
  sessionAgentSettings: {},
  workflowSupervisorSettings: {},
  pendingDeleteSession: null,
  assistantMessages: [],
  assistantRoomContext: null,
  pendingDeleteRoom: null,
  customQuickKeys: loadCustomQuickKeys(),
  language: localStorage.getItem("sessionGatewayLanguage") || "zh",
  theme: localStorage.getItem("sessionGatewayTheme") || "dark",
  reviewingSessionId: null
};

const OUTPUT_POLL_DELAYS_MS = [1000, 2000, 5000, 10000];
const UNASSIGNED_ROOM_FILTER = "__unassigned__";

const translations = {
  zh: {
    sessions: "会话",
    create: "新建",
    command: "助手",
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
    roomCreateTitle: "新建房间",
    roomAssignment: "房间",
    assignRoleTitle: "分配角色",
    allRooms: "全部会话",
    unassignedSessions: "独立会话",
    noRoom: "不关联房间",
    noPreset: "自定义角色",
    newRoom: "新房间",
    joinRoom: "房间",
    rolePrompt: "输入该会话在房间里的角色",
    injectRolePrompt: "发送角色说明到会话",
    roomConversation: "房间对话",
    projectGroupChat: "项目群聊",
    roomEmpty: "这个房间还没有消息。",
    roomAll: "房间全员",
    roomRole: "按角色",
    roomSession: "房间会话",
    currentSession: "当前会话",
    noRoleTarget: "没有可用角色",
    noSessionTarget: "没有可用会话",
    commandTitle: "助手",
    deleteTitle: "删除会话",
    historyTitle: "输入历史",
    history: "历史",
    assistantEmpty: "和 web-pi 对话。它会通过工具管理会话，并把结果整理成回复。",
    assistantUser: "你",
    assistantError: "错误",
    deleteConfirm: "确认删除会话「{name}」？正在运行的会话会先停止。",
    commandParser: "助手与命令解析",
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
    rolePlaceholder: "角色，例如 reviewer",
    roomNamePlaceholder: "房间名，例如 frontend-redesign",
    roomObjectivePlaceholder: "目标",
    nlPlaceholder: "问 web-pi，例如：查看并总结当前会话。",
    roomAssistantTitle: "群聊助手",
    roomAssistantSubtitle: "房间协调",
    roomAssistantEmpty: "群聊助手帮助协调房间内各会话的协作。可以发送任务、查看状态、分配角色。",
    roomAssistantPlaceholder: "发送任务或询问房间状态…",
    deleteRoomTitle: "删除房间",
    deleteRoom: "删除房间",
    deleteRoomConfirm: "确认删除房间「{name}」？房间内的会话将变为独立会话。",
  },
  en: {
    sessions: "Sessions",
    create: "Create",
    command: "Assistant",
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
    roomCreateTitle: "Create Room",
    roomAssignment: "Room",
    assignRoleTitle: "Assign Role",
    allRooms: "All sessions",
    unassignedSessions: "Standalone sessions",
    noRoom: "No room",
    noPreset: "Custom role",
    newRoom: "New room",
    joinRoom: "Room",
    rolePrompt: "Role for this session in the room",
    injectRolePrompt: "Send role prompt to session",
    roomConversation: "Room conversation",
    projectGroupChat: "Project chat",
    roomEmpty: "No room messages yet.",
    roomAll: "All room sessions",
    roomRole: "By role",
    roomSession: "Room session",
    currentSession: "Current session",
    noRoleTarget: "No roles available",
    noSessionTarget: "No sessions available",
    commandTitle: "Assistant",
    deleteTitle: "Delete Session",
    historyTitle: "Input History",
    history: "History",
    assistantEmpty: "Chat with web-pi. It manages sessions through tools and summarizes the result here.",
    assistantUser: "You",
    assistantError: "Error",
    deleteConfirm: "Delete session \"{name}\"? A running session will be stopped first.",
    commandParser: "Assistant & Command Parser",
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
    rolePlaceholder: "Role, e.g. reviewer",
    roomNamePlaceholder: "Room name, e.g. frontend-redesign",
    roomObjectivePlaceholder: "Objective",
    nlPlaceholder: "Ask web-pi, e.g. summarize the current session.",
    roomAssistantTitle: "Room Assistant",
    roomAssistantSubtitle: "Room coordination",
    roomAssistantEmpty: "Room assistant helps coordinate sessions in the room. Send tasks, check status, assign roles.",
    roomAssistantPlaceholder: "Send task or ask about room status…",
    deleteRoomTitle: "Delete Room",
    deleteRoom: "Delete Room",
    deleteRoomConfirm: "Delete room \"{name}\"? Sessions in this room will become standalone.",
  }
};

const els = {
  openSessions: document.querySelector("#open-sessions"),
  confirmAlert: document.querySelector("#confirm-alert"),
  closeSessions: document.querySelector("#close-sessions"),
  sessionsTitle: document.querySelector("[data-i18n='sessionsTitle']"),
  sessionsPanel: document.querySelector("#sessions-panel"),
  roomFilter: document.querySelector("#room-filter"),
  openRoomCreate: document.querySelector("#open-room-create"),
  roomCreateDialog: document.querySelector("#room-create-dialog"),
  roomCreateForm: document.querySelector("#room-create-form"),
  roomName: document.querySelector("#room-name"),
  roomProject: document.querySelector("#room-project"),
  roomObjective: document.querySelector("#room-objective"),
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
  closeRun: document.querySelector("#close-run"),
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
  aiParserBaseUrl: document.querySelector("#ai-parser-base-url"),
  aiParserModel: document.querySelector("#ai-parser-model"),
  aiParserApiKey: document.querySelector("#ai-parser-api-key"),
  workflowPmEnabled: document.querySelector("#workflow-pm-enabled"),
  workflowSupervisorIntervalSeconds: document.querySelector("#workflow-supervisor-interval-seconds"),
  workflowSupervisorStallSeconds: document.querySelector("#workflow-supervisor-stall-seconds"),
  workflowSupervisorHardTimeoutSeconds: document.querySelector("#workflow-supervisor-hard-timeout-seconds"),
  workflowSupervisorCooldownSeconds: document.querySelector("#workflow-supervisor-cooldown-seconds"),
  workflowSupervisorMaxInterventions: document.querySelector("#workflow-supervisor-max-interventions"),
  workflowSupervisorMaxSpawned: document.querySelector("#workflow-supervisor-max-spawned"),
  kind: document.querySelector("#kind"),
  createDeployment: document.querySelector("#create-deployment"),
  createDeploymentMode: document.querySelector("#create-deployment-mode"),
  createDockerName: document.querySelector("#create-docker-name"),
  name: document.querySelector("#name"),
  cwd: document.querySelector("#cwd"),
  project: document.querySelector("#project"),
  createRoom: document.querySelector("#create-room"),
  createRolePreset: document.querySelector("#create-role-preset"),
  createRole: document.querySelector("#create-role"),
  assignRoleDialog: document.querySelector("#assign-role-dialog"),
  assignRoleForm: document.querySelector("#assign-role-form"),
  assignSessionId: document.querySelector("#assign-session-id"),
  assignRoom: document.querySelector("#assign-room"),
  assignRolePreset: document.querySelector("#assign-role-preset"),
  assignRole: document.querySelector("#assign-role"),
  assignInjectPrompt: document.querySelector("#assign-inject-prompt"),
  roomPanel: document.querySelector("#room-panel"),
  roomTitle: document.querySelector("#room-title"),
  roomSubtitle: document.querySelector("#room-subtitle"),
  roomMessages: document.querySelector("#room-messages"),
  workflowTabMessages: document.querySelector("#workflow-tab-messages"),
  workflowTabAssistant: document.querySelector("#workflow-tab-assistant"),
  workflowTabBoard: document.querySelector("#workflow-tab-board"),
  workflowBoard: document.querySelector("#workflow-board"),
  roomAssistantPanel: document.querySelector("#room-assistant-panel"),
  roomAssistantMessages: document.querySelector("#room-assistant-messages"),
  clearRoomAssistant: document.querySelector("#clear-room-assistant"),
  workflowContent: document.querySelector("#workflow-content"),
  workflowRefresh: document.querySelector("#workflow-refresh"),
  workflowCreate: document.querySelector("#workflow-create"),
  workflowDialog: document.querySelector("#workflow-dialog"),
  workflowForm: document.querySelector("#workflow-form"),
  workflowObjective: document.querySelector("#workflow-objective"),
  workflowTemplate: document.querySelector("#workflow-template"),
  workflowManageTemplates: document.querySelector("#workflow-manage-templates"),
  workflowAutoStart: document.querySelector("#workflow-auto-start"),
  workflowTemplateDialog: document.querySelector("#workflow-template-dialog"),
  workflowTemplateForm: document.querySelector("#workflow-template-form"),
  workflowTemplateList: document.querySelector("#workflow-template-list"),
  workflowTemplateId: document.querySelector("#workflow-template-id"),
  workflowTemplateName: document.querySelector("#workflow-template-name"),
  workflowTemplateDescription: document.querySelector("#workflow-template-description"),
  workflowTemplateStages: document.querySelector("#workflow-template-stages"),
  workflowTemplateNew: document.querySelector("#workflow-template-new"),
  workflowTemplateDelete: document.querySelector("#workflow-template-delete"),
  roomActions: document.querySelector("#room-actions"),
  refreshRoomMessages: document.querySelector("#refresh-room-messages"),
  deleteRoomDialog: document.querySelector("#delete-room-dialog"),
  deleteRoomForm: document.querySelector("#delete-room-form"),
  deleteRoomMessage: document.querySelector("#delete-room-message"),
  reviewButtons: document.querySelector("#review-buttons"),
  reviewDialog: document.querySelector("#review-dialog"),
  reviewSessionInfo: document.querySelector("#review-session-info"),
  create: document.querySelector("#create"),
  nl: document.querySelector("#nl"),
  runNl: document.querySelector("#run-nl"),
  assistantMessages: document.querySelector("#assistant-messages"),
  commandResult: document.querySelector("#command-result"),
  refresh: document.querySelector("#refresh"),
  list: document.querySelector("#session-list"),
  title: document.querySelector("#selected-title"),
  terminalOutput: document.querySelector("#terminal-output"),
  xtermOutput: document.querySelector("#xterm-output"),
  output: document.querySelector("#output"),
  sendTargetMode: document.querySelector("#send-target-mode"),
  sendTargetRole: document.querySelector("#send-target-role"),
  sendTargetSession: document.querySelector("#send-target-session"),
  input: document.querySelector("#input"),
  send: document.querySelector("#send"),
  restart: document.querySelector("#restart"),
  stop: document.querySelector("#stop")
};

els.token.value = localStorage.getItem("sessionGatewayToken") || "";
els.language.value = state.language;
els.theme.value = state.theme;
updateAllYesButton();
els.token.addEventListener("input", () => {
  localStorage.setItem("sessionGatewayToken", els.token.value);
});
els.allYes.addEventListener("click", async () => {
  const modes = ["off", "session", "global"];
  const currentIndex = modes.indexOf(state.allYesMode);
  const nextIndex = (currentIndex + 1) % modes.length;
  state.allYesMode = modes[nextIndex];
  localStorage.setItem("sessionGatewayAllYesMode", state.allYesMode);
  updateAllYesButton();
  
  if (state.allYesMode !== "off") {
    if (state.selected?.status === "running") {
      clearOutputEtag(state.selected.id);
      await loadOutput({ force: true });
    }
    if (state.allYesMode === "session") {
      maybeAutoYes(state.latestOutputText, { force: true });
    } else if (state.allYesMode === "global") {
      await autoYesAllSessions();
    }
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
  delete els.kind.dataset.touched;
  delete els.createDeploymentMode.dataset.touched;
  updateCreateDeploymentControls();
  els.createDialog.showModal();
  els.cwd.focus();
});
els.openRun.addEventListener("click", () => {
  openAssistant();
  els.nl.focus();
});
els.closeRun.addEventListener("click", closeAssistant);
document.querySelectorAll("[data-close-dialog]").forEach((button) => {
  button.addEventListener("click", () => {
    closeDialog(button.dataset.closeDialog);
  });
});
els.refresh.addEventListener("click", refreshSessions);
els.roomFilter.addEventListener("change", () => {
  state.selectedRoomId = els.roomFilter.value;
  localStorage.setItem("sessionGatewaySelectedRoomId", state.selectedRoomId);
  if (state.selectedRoomChatId && state.selectedRoomChatId !== selectedRealRoomId()) {
    state.selectedRoomChatId = "";
    showTerminalView();
  }
  renderSessions();
  renderRoomPanel();
  renderQuickKeys();
});
els.refreshRoomMessages.addEventListener("click", loadRoomMessages);
els.clearRoomAssistant.addEventListener("click", () => {
  if (!state.selectedRoomChatId) return;
  if (!window.confirm("确认清空群聊助手对话记录？")) return;
  state.assistantMessages = [];
  saveRoomAssistantMessages(state.selectedRoomChatId, []);
  renderRoomAssistantMessages();
});
els.workflowTabMessages.addEventListener("click", () => showRoomView("messages"));
els.workflowTabAssistant.addEventListener("click", () => showRoomView("assistant"));
els.workflowTabBoard.addEventListener("click", async () => {
  showRoomView("workflow");
  await loadWorkflows();
});
els.workflowRefresh.addEventListener("click", loadWorkflows);
els.workflowContent.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-workflow-action]");
  if (!button) return;
  button.disabled = true;
  try {
    const action = button.dataset.workflowAction;
    const workflowId = button.dataset.workflowId;
    const isDelete = action === "delete";
    if (isDelete && !window.confirm("确认删除这个工作流？相关任务、监督记录和干预记录都会被清理。")) return;
    const path = isDelete
      ? `/api/workflows/${encodeURIComponent(workflowId)}`
      : action === "supervisor/tick"
        ? `/api/workflows/${encodeURIComponent(workflowId)}/supervisor/tick`
        : `/api/workflows/${encodeURIComponent(workflowId)}/${action}`;
    await api(path, {
      method: isDelete ? "DELETE" : "POST",
      ...(isDelete ? {} : { body: JSON.stringify({}) })
    });
    await loadWorkflows();
  } catch (error) {
    showError(error);
  } finally {
    button.disabled = false;
  }
});
els.workflowCreate.addEventListener("click", () => {
  els.workflowObjective.value = selectedRoomForChat()?.objective || "";
  loadWorkflowTemplates();
  els.workflowDialog.showModal();
});
els.workflowForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await createWorkflow();
});
els.workflowManageTemplates.addEventListener("click", async () => {
  await loadWorkflowTemplates();
  selectWorkflowTemplateEditor(els.workflowTemplate.value);
  els.workflowTemplateDialog.showModal();
});
els.workflowTemplateList.addEventListener("change", () => selectWorkflowTemplateEditor(els.workflowTemplateList.value));
els.workflowTemplateNew.addEventListener("click", () => selectWorkflowTemplateEditor(""));
els.workflowTemplateDelete.addEventListener("click", deleteWorkflowTemplate);
els.workflowTemplateForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await saveWorkflowTemplate();
});
els.deleteRoomForm.addEventListener("submit", (event) => {
  event.preventDefault();
  deletePendingRoom();
});
els.sendTargetMode.addEventListener("change", () => {
  state.selectedRoomTargetMode = els.sendTargetMode.value;
  renderSendTargetControls();
});
els.sendTargetRole.addEventListener("change", () => {
  state.selectedRoomTargetRole = els.sendTargetRole.value;
});
els.sendTargetSession.addEventListener("change", () => {
  state.selectedRoomTargetSessionId = els.sendTargetSession.value;
});
els.openRoomCreate.addEventListener("click", () => {
  els.roomName.value = "";
  els.roomProject.value = els.project.value || selectedRoom()?.project || "";
  els.roomObjective.value = "";
  els.roomCreateDialog.showModal();
  els.roomName.focus();
});
els.roomCreateForm.addEventListener("submit", (event) => {
  event.preventDefault();
  createRoom();
});
els.configForm.addEventListener("submit", (event) => {
  event.preventDefault();
  saveConfig();
});
els.createForm.addEventListener("submit", (event) => {
  event.preventDefault();
  createSession();
});
els.createRolePreset.addEventListener("change", () => {
  applySelectedPresetToRole(els.createRolePreset, els.createRole);
});
els.assignRolePreset.addEventListener("change", () => {
  applySelectedPresetToRole(els.assignRolePreset, els.assignRole);
});
els.assignRoom.addEventListener("change", () => {
  applySelectedAssignRoom();
});
els.assignRoleForm.addEventListener("submit", (event) => {
  event.preventDefault();
  assignRoleFromDialog();
});
els.kind.addEventListener("change", () => {
  els.kind.dataset.touched = "1";
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
document.querySelectorAll(".review-quick-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const value = btn.dataset.value;
    sendQuickReview(value);
  });
});
els.input.addEventListener("keydown", (event) => {
  if (event.key === "Enter") sendInput();
  if (!selectedRoomForChat() && (event.key === "PageUp" || event.key === "PageDown")) {
    event.preventDefault();
    if (shouldUsePaneWheel(currentSelectedSession())) {
      sendQuickKeys([event.key === "PageUp" ? "WheelUpPane" : "WheelDownPane"]);
    } else {
      scrollOutputHistory(event.key === "PageUp" ? -1 : 1);
    }
  }
});
els.terminalOutput.addEventListener("wheel", handleOutputWheel, { passive: false, capture: true });
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeSessionsPanel();
    closeAssistant();
  }
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    clearOutputPoll();
    if (state.allYesMode !== "global") clearSessionPoll();
  } else {
    resetOutputPolling(1000);
    scheduleSessionPoll(1000);
  }
});

applyLanguage();
applyTheme();
await loadConfig();
await loadRolePresets();
await loadRooms();
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
      enabled: true,
      mode: "rules-first-ai-fallback",
      baseUrl: els.aiParserBaseUrl.value,
      model: els.aiParserModel.value,
      apiKey: els.aiParserApiKey.value
    };

    localStorage.setItem("sessionGatewayAiParser", JSON.stringify({
      baseUrl: els.aiParserBaseUrl.value,
      model: els.aiParserModel.value,
      apiKey: els.aiParserApiKey.value
    }));

    const settings = {
      cliDeployment: state.cliDeploymentDefaults,
      notifications: state.notifications,
      commandParser,
      workflowSupervisor: {
        ...state.workflowSupervisorSettings,
        pmAgentEnabled: els.workflowPmEnabled.checked,
        intervalMs: secondsInputToMs(els.workflowSupervisorIntervalSeconds, 60),
        stallMs: secondsInputToMs(els.workflowSupervisorStallSeconds, 15 * 60),
        hardTimeoutMs: secondsInputToMs(els.workflowSupervisorHardTimeoutSeconds, 60 * 60),
        sameActionCooldownMs: secondsInputToMs(els.workflowSupervisorCooldownSeconds, 10 * 60),
        maxInterventionsPerAssignment: numberInput(els.workflowSupervisorMaxInterventions, 3),
        maxSpawnedAgentsPerRoom: numberInput(els.workflowSupervisorMaxSpawned, 3)
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

function numberInput(input, fallback) {
  const value = Number.parseInt(input.value, 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function numberOrFallback(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function secondsInputToMs(input, fallbackSeconds) {
  return numberInput(input, fallbackSeconds) * 1000;
}

function setSecondsInput(input, value, fallbackSeconds) {
  const milliseconds = numberOrFallback(value, fallbackSeconds * 1000);
  input.value = String(Math.round(milliseconds / 1000));
}

async function loadRooms() {
  try {
    const data = await api("/api/rooms");
    state.rooms = data.rooms ?? [];
    if (
      state.selectedRoomId &&
      state.selectedRoomId !== UNASSIGNED_ROOM_FILTER &&
      !state.rooms.some((room) => room.id === state.selectedRoomId)
    ) {
      state.selectedRoomId = "";
      localStorage.setItem("sessionGatewaySelectedRoomId", "");
    }
    renderRoomControls();
    renderRoomPanel();
    renderSendTargetControls();
  } catch (error) {
    showError(error);
  }
}

async function loadRoomMessages() {
  const roomId = state.selectedRoomChatId;
  if (!roomId) {
    state.roomMessages = [];
    renderRoomPanel();
    return;
  }
  try {
    const data = await api(`/api/rooms/${encodeURIComponent(roomId)}/messages`);
    state.roomMessages = data.messages ?? [];
    renderRoomPanel();
  } catch (error) {
    showError(error);
  }
}

function showRoomView(mode) {
  state.roomViewMode = mode;
  state.workflowView = mode === "workflow";
  els.roomMessages.hidden = mode !== "messages";
  els.roomAssistantPanel.hidden = mode !== "assistant";
  els.workflowBoard.hidden = mode !== "workflow";
  els.workflowTabMessages.classList.toggle("active", mode === "messages");
  els.workflowTabAssistant.classList.toggle("active", mode === "assistant");
  els.workflowTabBoard.classList.toggle("active", mode === "workflow");
  els.roomActions.hidden = mode === "workflow";
  els.input.closest(".input-row").hidden = mode === "workflow";
  updateInputPlaceholder();
  if (mode === "assistant" && state.assistantRoomContext) {
    renderRoomAssistantMessages();
  }
  if (mode !== "workflow") clearWorkflowPoll();
}

async function loadWorkflows() {
  const roomId = state.selectedRoomChatId;
  if (!roomId) return;
  try {
    const data = await api(`/api/rooms/${encodeURIComponent(roomId)}/workflows`);
    if (roomId !== state.selectedRoomChatId) return;
    state.workflows = data.workflows ?? [];
    await loadWorkflowSupervisors(state.workflows);
    renderWorkflows();
    scheduleWorkflowPoll();
  } catch (error) {
    showError(error);
  }
}

async function loadWorkflowSupervisors(workflows) {
  const entries = await Promise.all((workflows ?? []).map(async (workflow) => {
    try {
      const data = await api(`/api/workflows/${encodeURIComponent(workflow.id)}/supervisor`);
      return [workflow.id, { ok: true, ...(data.supervisor ?? {}) }];
    } catch (error) {
      return [workflow.id, { ok: false, error: error.message }];
    }
  }));
  state.workflowSupervisors = new Map(entries);
}

async function createWorkflow() {
  const roomId = state.selectedRoomChatId;
  const objective = els.workflowObjective.value.trim();
  if (!roomId || !objective) return showError(new Error("项目目标不能为空"));
  try {
    const created = await api(`/api/rooms/${encodeURIComponent(roomId)}/workflows`, {
      method: "POST",
      body: JSON.stringify({ objective, templateId: els.workflowTemplate.value || undefined })
    });
    if (els.workflowAutoStart.checked) {
      await api(`/api/workflows/${encodeURIComponent(created.workflow.id)}/start`, {
        method: "POST",
        body: JSON.stringify({ eventKey: `ui-start:${created.workflow.id}` })
      });
    }
    els.workflowDialog.close();
    await loadWorkflows();
  } catch (error) {
    showError(error);
  }
}

const WORKFLOW_STAGE_EXAMPLE = [
  { id: "plan", name: "规划", role: "planner", mode: "one", maxAttempts: 3, prompt: "请规划以下目标并回传可执行方案：\n{objective}" },
  { id: "build", name: "开发", role: "coder", mode: "all", maxAttempts: 3, prompt: "你是 {sessionName}。根据目标和前序结果完成分配给你的开发：\n目标：{objective}\n前序结果：{previousResults}" },
  { id: "verify", name: "测试", role: "testerall", mode: "one", maxAttempts: 3, prompt: "请执行完整测试。\n目标：{objective}\n前序结果：{previousResults}" }
];

async function loadWorkflowTemplates() {
  const data = await api("/api/workflow-templates");
  state.workflowTemplates = data.templates ?? [];
  const selected = els.workflowTemplate.value || "builtin-project-delivery";
  const options = state.workflowTemplates.map((template) =>
    `<option value="${escapeHtml(template.id)}">${escapeHtml(template.name)}</option>`
  ).join("");
  els.workflowTemplate.innerHTML = options;
  els.workflowTemplateList.innerHTML = `<option value="">新建模板</option>${options}`;
  if (state.workflowTemplates.some((item) => item.id === selected)) els.workflowTemplate.value = selected;
}

function selectWorkflowTemplateEditor(id) {
  const template = state.workflowTemplates.find((item) => item.id === id);
  const builtin = template?.kind === "classic";
  els.workflowTemplateList.value = id || "";
  els.workflowTemplateId.value = builtin ? "" : template?.id || "";
  els.workflowTemplateName.value = builtin ? "" : template?.name || "";
  els.workflowTemplateDescription.value = builtin ? "" : template?.description || "";
  els.workflowTemplateStages.value = JSON.stringify(builtin ? WORKFLOW_STAGE_EXAMPLE : template?.stages || WORKFLOW_STAGE_EXAMPLE, null, 2);
  els.workflowTemplateDelete.disabled = !template || builtin;
}

async function saveWorkflowTemplate() {
  try {
    const stages = JSON.parse(els.workflowTemplateStages.value);
    const id = els.workflowTemplateId.value;
    const result = await api(id ? `/api/workflow-templates/${encodeURIComponent(id)}` : "/api/workflow-templates", {
      method: id ? "PUT" : "POST",
      body: JSON.stringify({
        name: els.workflowTemplateName.value,
        description: els.workflowTemplateDescription.value,
        stages
      })
    });
    await loadWorkflowTemplates();
    els.workflowTemplate.value = result.template.id;
    selectWorkflowTemplateEditor(result.template.id);
  } catch (error) {
    showError(error);
  }
}

async function deleteWorkflowTemplate() {
  const id = els.workflowTemplateId.value;
  if (!id) return;
  try {
    await api(`/api/workflow-templates/${encodeURIComponent(id)}`, { method: "DELETE" });
    await loadWorkflowTemplates();
    selectWorkflowTemplateEditor("");
  } catch (error) {
    showError(error);
  }
}

function renderWorkflows() {
  if (!state.workflows.length) {
    els.workflowContent.innerHTML = `<div class="workflow-empty">这个房间还没有工作流。</div>`;
    return;
  }
  els.workflowContent.innerHTML = state.workflows.map((workflow) => `
    <article class="workflow-run">
      <header>
        <div><strong>${escapeHtml(workflow.objective)}</strong><small>${escapeHtml(workflow.templateName || "标准项目交付")} · ${escapeHtml(workflowStageName(workflow.currentStage))}</small></div>
        <div class="workflow-run-actions">
          <span class="workflow-state ${escapeHtml(workflow.status)}">${escapeHtml(workflowStateName(workflow.status))}</span>
          <button class="workflow-delete" type="button" data-workflow-action="delete" data-workflow-id="${escapeHtml(workflow.id)}" title="删除工作流" aria-label="删除工作流">删除</button>
        </div>
      </header>
      <div class="workflow-progress"><span style="width:${workflowProgress(workflow)}%"></span></div>
      <div class="workflow-gates">${currentWorkflowAssignments(workflow.runAssignments).map(renderWorkflowAssignment).join("")}</div>
      <div class="workflow-items">${(workflow.workItems ?? []).map(renderWorkflowItem).join("") || "<span>等待 Planner 拆解任务</span>"}</div>
      ${renderWorkflowSupervisor(workflow)}
      ${(workflow.artifacts ?? []).map((artifact) => `<code class="workflow-artifact">${escapeHtml(artifact.location)}</code>`).join("")}
      ${!["completed", "cancelled"].includes(workflow.status) ? `<button class="ghost workflow-advance" type="button" data-workflow-action="${workflow.status === "draft" ? "start" : "advance"}" data-workflow-id="${escapeHtml(workflow.id)}">${workflow.status === "draft" ? "启动" : "继续流转"}</button>` : ""}
    </article>
  `).join("");
}

function renderWorkflowSupervisor(workflow) {
  const supervisor = state.workflowSupervisors.get(workflow.id);
  if (!supervisor) return "";
  if (!supervisor.ok) {
    return `<section class="workflow-supervisor error"><strong>PM 监督</strong><span>${escapeHtml(supervisor.error || "加载失败")}</span></section>`;
  }
  const latestObservation = supervisor.observations?.[0] ?? null;
  const latestIntervention = supervisor.interventions?.[0] ?? null;
  const issues = latestObservation?.detectedIssues ?? [];
  const pmEnabled = supervisor.options?.pmAgentEnabled;
  const issueText = issues.length
    ? issues.slice(0, 2).map((issue) => `${issue.type}: ${issue.reason || issue.assignmentId || ""}`).join("；")
    : "暂无异常";
  const interventionText = latestIntervention
    ? `${latestIntervention.source}/${latestIntervention.actionType} · ${latestIntervention.validationStatus}`
    : "暂无干预";
  return `<section class="workflow-supervisor">
    <header>
      <strong>PM 监督</strong>
      <span class="workflow-state ${pmEnabled ? "completed" : "pending"}">${pmEnabled ? "PM Agent 已启用" : "PM Agent 未启用"}</span>
    </header>
    <div class="workflow-supervisor-grid">
      <span>Supervisor：${supervisor.enabled ? "运行中" : "未启动"}</span>
      <span>最近观察：${escapeHtml(latestObservation?.createdAt ? formatTime(latestObservation.createdAt) : "无")}</span>
      <span>问题：${escapeHtml(issueText)}</span>
      <span>干预：${escapeHtml(interventionText)}</span>
    </div>
    <button class="ghost" type="button" data-workflow-action="supervisor/tick" data-workflow-id="${escapeHtml(workflow.id)}">立即监督一次</button>
  </section>`;
}

function renderWorkflowItem(item) {
  return `<section class="workflow-item">
    <header><strong>${escapeHtml(item.title)}</strong><span class="workflow-state ${escapeHtml(item.status)}">${escapeHtml(workflowStateName(item.status))}</span></header>
    <small>${escapeHtml((item.acceptanceCriteria ?? []).join(" · "))}</small>
    <div class="workflow-gates">${(item.assignments ?? []).map(renderWorkflowAssignment).join("")}</div>
    ${(item.findings ?? []).map((finding) => `<div class="workflow-finding">[${escapeHtml(finding.severity)}] ${escapeHtml(finding.title)}：${escapeHtml(finding.evidence || "")}</div>`).join("")}
  </section>`;
}

function renderWorkflowAssignment(assignment) {
  return `<span class="workflow-assignment ${escapeHtml(assignment.status)}">${escapeHtml(assignment.role)} #${escapeHtml(assignment.attemptNo)} · ${escapeHtml(workflowStateName(assignment.status))}</span>`;
}

function workflowProgress(workflow) {
  if (workflow.status === "completed") return 100;
  const base = { draft: 0, planning: 10, executing: 35, integration_testing: 70, security_review: 85, needs_human: 85 }[workflow.status] ?? 0;
  const items = workflow.workItems ?? [];
  const passed = items.filter((item) => item.status === "passed").length;
  return Math.round(Math.max(base, items.length ? 20 + (passed / items.length) * 50 : base));
}

function workflowStateName(value) {
  return ({ draft: "草稿", planning: "规划中", planned: "等待依赖", executing: "执行中", coding: "开发中", task_testing: "任务测试", integration_testing: "整体测试", security_review: "安全审计", security_fix: "安全修复", pending: "待执行", passed: "已通过", completed: "已完成", failed: "失败", needs_human: "需人工介入" })[value] || value;
}

function workflowStageName(value) {
  return ({ planning: "规划", development: "开发", testing: "分项测试", coding: "开发", integration_testing: "整体测试", security_review: "安全审计", security_fix: "安全修复", needs_human: "人工介入", human_intervention: "人工介入", completed: "完成" })[value] || value;
}

function scheduleWorkflowPoll() {
  clearWorkflowPoll();
  if (!state.workflowView || !state.workflows.some((workflow) => !["completed", "cancelled", "needs_human"].includes(workflow.status))) return;
  state.workflowPollTimer = setTimeout(loadWorkflows, 5_000);
}

function clearWorkflowPoll() {
  if (state.workflowPollTimer) clearTimeout(state.workflowPollTimer);
  state.workflowPollTimer = null;
}

async function createRoom() {
  try {
    const body = {
      name: els.roomName.value,
      project: els.roomProject.value || undefined,
      objective: els.roomObjective.value || undefined
    };
    const data = await api("/api/rooms", {
      method: "POST",
      body: JSON.stringify(body)
    });
    state.rooms = [data.room, ...state.rooms.filter((room) => room.id !== data.room.id)];
    state.selectedRoomId = data.room.id;
    localStorage.setItem("sessionGatewaySelectedRoomId", state.selectedRoomId);
    els.roomCreateDialog.close();
    state.roomMessages = [];
    renderRoomControls();
    renderSessions();
    await selectRoomChat(data.room);
  } catch (error) {
    showError(error);
  }
}

function renderRoomControls() {
  const roomOptions = [
    `<option value="">${escapeHtml(t("allRooms"))}</option>`,
    `<option value="${UNASSIGNED_ROOM_FILTER}">${escapeHtml(t("unassignedSessions"))}</option>`,
    ...state.rooms.map((room) => `<option value="${escapeHtml(room.id)}">${escapeHtml(room.name)}</option>`)
  ].join("");
  els.roomFilter.innerHTML = roomOptions;
  els.roomFilter.value = state.selectedRoomId;

  els.createRoom.innerHTML = [
    `<option value="">${escapeHtml(t("noRoom"))}</option>`,
    ...state.rooms.map((room) => `<option value="${escapeHtml(room.id)}">${escapeHtml(room.name)}</option>`)
  ].join("");
  els.createRoom.value = selectedRealRoomId();

  els.assignRoom.innerHTML = state.rooms
    .map((room) => `<option value="${escapeHtml(room.id)}">${escapeHtml(room.name)}</option>`)
    .join("");
  renderSendTargetControls();
}

function renderSendTargetControls() {
  const room = selectedRoomForChat() ?? selectedRoom();
  const roomSessions = room?.sessions ?? [];
  const roles = [...new Set(roomSessions.map(roomSessionRole).filter(Boolean))];
  const runningSessions = roomSessions.filter((session) => session.sessionStatus === "running");
  const hasRoom = Boolean(room);
  const validModes = new Set(["all", "role", "session-in-room"]);
  if (!validModes.has(state.selectedRoomTargetMode)) state.selectedRoomTargetMode = "all";
  els.sendTargetMode.value = state.selectedRoomTargetMode;

  [...els.sendTargetMode.options].forEach((option) => {
    option.disabled = !hasRoom;
    if (option.value === "role") option.disabled = !hasRoom || !roles.length;
    if (option.value === "session-in-room") option.disabled = !hasRoom || !runningSessions.length;
  });
  if (els.sendTargetMode.selectedOptions[0]?.disabled) {
    state.selectedRoomTargetMode = "all";
    els.sendTargetMode.value = "all";
  }

  els.sendTargetRole.innerHTML = roles.length
    ? roles.map((role) => `<option value="${escapeHtml(role)}">${escapeHtml(role)}</option>`).join("")
    : `<option value="">${escapeHtml(t("noRoleTarget"))}</option>`;
  if (roles.includes(state.selectedRoomTargetRole)) {
    els.sendTargetRole.value = state.selectedRoomTargetRole;
  } else {
    state.selectedRoomTargetRole = roles[0] || "";
    els.sendTargetRole.value = state.selectedRoomTargetRole;
  }
  els.sendTargetSession.innerHTML = runningSessions.length
    ? runningSessions
        .map((session) => `<option value="${escapeHtml(session.sessionId)}">${escapeHtml(session.sessionName)}</option>`)
        .join("")
    : `<option value="">${escapeHtml(t("noSessionTarget"))}</option>`;
  if (runningSessions.some((session) => session.sessionId === state.selectedRoomTargetSessionId)) {
    els.sendTargetSession.value = state.selectedRoomTargetSessionId;
  } else {
    state.selectedRoomTargetSessionId = runningSessions[0]?.sessionId || "";
    els.sendTargetSession.value = state.selectedRoomTargetSessionId;
  }

  els.sendTargetRole.hidden = els.sendTargetMode.value !== "role";
  els.sendTargetSession.hidden = els.sendTargetMode.value !== "session-in-room";
  els.input.placeholder = sendInputPlaceholder();
}

function roomSessionRole(session) {
  return session.role || session.rolePresetLabel || session.rolePresetName || "";
}

function renderRoomPanel() {
  const room = selectedRoomForChat();
  const active = Boolean(room);
  els.roomPanel.hidden = !active;
  els.output.hidden = active;
  els.roomActions.hidden = !active;
  els.addQuickKey.hidden = active;
  renderReviewButtons();
  if (!room) return;
  els.roomTitle.textContent = room.name;
  els.roomSubtitle.textContent = [room.objective, room.project].filter(Boolean).join(" · ");
  const signature = `${state.language}:${roomMessagesSignature(state.roomMessages)}`;
  if (els.roomMessages.dataset.signature === signature) return;
  const followLatest = !els.roomMessages.dataset.signature || isNearScrollBottom(els.roomMessages);
  const previousScrollTop = els.roomMessages.scrollTop;
  if (!state.roomMessages.length) {
    els.roomMessages.innerHTML = `<div class="room-empty">${escapeHtml(t("roomEmpty"))}</div>`;
    els.roomMessages.dataset.signature = signature;
    return;
  }
  els.roomMessages.innerHTML = state.roomMessages.map(renderRoomMessage).join("");
  els.roomMessages.dataset.signature = signature;
  els.roomMessages.scrollTop = followLatest ? els.roomMessages.scrollHeight : previousScrollTop;
}

function renderRoomMessage(message) {
  const deliveryText = (message.deliveries ?? [])
    .map((delivery) => `${delivery.sessionName}: ${delivery.status}${delivery.error ? ` (${delivery.error})` : ""}`)
    .join(" · ");
  const target = roomMessageTargetLabel(message);
  return `
    <article class="room-message">
      <div class="room-message-meta">
        <span>${escapeHtml(message.fromSessionName || t("assistantUser"))}</span>
        <span>${escapeHtml(target)}</span>
        <span>${escapeHtml(formatRoomTime(message.createdAt))}</span>
      </div>
      <div class="room-message-text">${escapeHtml(message.text)}</div>
      <div class="room-message-delivery">${escapeHtml(deliveryText)}</div>
    </article>
  `;
}

function roomMessageTargetLabel(message) {
  if (message.targetMode === "all") return t("roomAll");
  if (message.targetMode === "role") return `${t("roomRole")}: ${message.targetRole}`;
  if (message.targetMode === "session") return t("roomSession");
  return message.targetMode;
}

function formatRoomTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

async function loadRolePresets() {
  try {
    const data = await api("/api/role-presets");
    state.rolePresets = data.rolePresets ?? [];
    renderRolePresetControls();
  } catch (error) {
    showError(error);
  }
}

function renderRolePresetControls() {
  const options = [
    `<option value="">${escapeHtml(t("noPreset"))}</option>`,
    ...state.rolePresets.map((preset) => (
      `<option value="${escapeHtml(preset.id)}" title="${escapeHtml(preset.description ?? "")}">${escapeHtml(preset.label || preset.name)}</option>`
    ))
  ].join("");
  els.createRolePreset.innerHTML = options;
  els.assignRolePreset.innerHTML = options;
}

function applySelectedPresetToRole(select, input) {
  const preset = state.rolePresets.find((item) => item.id === select.value);
  if (!preset) return;
  input.value = preset.label || preset.name;
  if (select === els.createRolePreset && preset.defaultKind && !els.kind.dataset.touched) {
    els.kind.value = preset.defaultKind;
    updateCreateDeploymentControls();
  }
}

async function refreshSessions() {
  if (state.sessionLoading) return;
  state.sessionLoading = true;
  const selectionVersion = state.selectionVersion;
  try {
    const data = await api("/api/sessions");
    state.sessions = data.sessions;
    await loadRooms();
    if (selectionVersion !== state.selectionVersion) return;
    if (state.selectedRoomChatId) {
      state.selected = null;
      state.selectedSessionId = "";
      renderSessions();
      renderTaskAlert();
      renderQuickKeys();
      clearOutputPoll();
      await loadRoomMessages();
      return;
    }
    if (state.selectedSessionId || state.selected) {
      const selectedId = state.selectedSessionId || state.selected?.id;
      const current = state.sessions.find((session) => session.id === selectedId);
      state.selected = current || null;
      state.selectedSessionId = state.selected?.id || "";
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
    state.selectedSessionId = state.selected?.id || "";
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
    if (state.allYesMode === "global") {
      autoYesAllSessions();
    }
  }
}

async function createSession() {
  try {
    const body = {
      kind: els.kind.value,
      name: els.name.value || undefined,
      cwd: els.cwd.value,
      project: els.project.value || undefined,
      roomId: els.createRoom.value || undefined,
      rolePresetId: els.createRolePreset.value || undefined,
      role: els.createRole.value || undefined,
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
    state.selectedSessionId = data.session.id;
    state.selectionVersion += 1;
    clearOutputEtag(state.selected.id);
    els.createDialog.close();
    els.createRolePreset.value = "";
    els.createRole.value = "";
    await refreshSessions();
  } catch (error) {
    showError(error);
  }
}

async function runNaturalCommand() {
  const text = els.nl.value.trim();
  if (!text) return;
  appendAssistantMessage("user", text);
  els.nl.value = "";
  els.runNl.disabled = true;
  try {
    const body = { text, currentSessionId: state.selected?.id };
    if (state.assistantRoomContext) {
      body.roomContext = state.assistantRoomContext;
    }
    const result = await api("/api/nl", {
      method: "POST",
      body: JSON.stringify(body)
    });
    if (typeof result === "string") {
      appendAssistantMessage("assistant", result);
    } else {
      if (result.session) {
        state.selected = result.session;
        state.selectedSessionId = result.session.id;
        state.selectionVersion += 1;
      }
      appendAssistantMessage("assistant", formatCommandResult(result));
      const updateTerminal = result.presentation?.updateTerminal !== false;
      if (updateTerminal && typeof result.output === "string") {
        updateOutputText(result.output);
        if (state.selected) clearOutputEtag(state.selected.id);
      }
      await refreshSessions();
      if (updateTerminal) resetOutputPolling(500);
    }
  } catch (error) {
    appendAssistantMessage("error", error instanceof Error ? error.message : String(error));
  } finally {
    els.runNl.disabled = false;
    els.nl.focus();
  }
}

async function loadOutput(options = {}) {
  const selected = currentSelectedSession();
  if (!selected) return null;
  if (selected.status !== "running") {
    showSessionSummary(selected);
    return null;
  }
  const sessionId = selected.id;
  if (state.outputLoading && state.outputLoadingSessionId === sessionId) return null;
  state.outputLoading = true;
  state.outputLoadingSessionId = sessionId;
  try {
    const params = new URLSearchParams({ lines: "300", format: "json" });
    if (state.outputScrollOffset > 0) params.set("offset", String(state.outputScrollOffset));
    if (selected.kind !== "runtime" && ensureTerminal()) params.set("raw", "1");
    const etag = state.outputEtags.get(sessionId);
    if (etag && !options.force) params.set("etag", etag);
    const data = await api(`/api/sessions/${encodeURIComponent(sessionId)}/output?${params}`);
    if (state.selectedSessionId !== sessionId) return null;
    if (typeof data === "string") {
      updateOutputText(data, { history: state.outputScrollOffset > 0 });
      clearOutputEtag(sessionId);
      return true;
    }
    if (data.etag) state.outputEtags.set(sessionId, data.etag);
    if (!data.changed) return false;
    updateOutputText(data.output ?? "", { history: state.outputScrollOffset > 0 });
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

async function resizeTerminalForSession(session) {
  const size = measureTerminalSize();
  if (!size) return false;
  const signature = `${size.cols}x${size.rows}`;
  if (state.terminalResizeBySession.get(session.id) === signature) return false;
  await api(`/api/sessions/${encodeURIComponent(session.id)}/resize`, {
    method: "POST",
    body: JSON.stringify(size)
  });
  state.terminalResizeBySession.set(session.id, signature);
  clearOutputEtag(session.id);
  return true;
}

function measureTerminalSize() {
  const target = terminalMeasureElement();
  if (!target || target.hidden) return null;
  const style = getComputedStyle(target);
  const width =
    target.clientWidth - parseFloat(style.paddingLeft || "0") - parseFloat(style.paddingRight || "0");
  const height =
    target.clientHeight - parseFloat(style.paddingTop || "0") - parseFloat(style.paddingBottom || "0");
  if (width <= 0 || height <= 0) return null;

  const probe = document.createElement("span");
  probe.textContent = "MMMMMMMMMM";
  probe.style.cssText =
    "position:absolute;visibility:hidden;white-space:pre;left:-9999px;top:-9999px;font:inherit;";
  target.appendChild(probe);
  const charWidth = probe.getBoundingClientRect().width / 10;
  probe.remove();

  const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2;
  if (!charWidth || !lineHeight) return null;
  return {
    cols: clampInteger(Math.floor(width / charWidth), 20, 500),
    rows: clampInteger(Math.floor(height / lineHeight), 5, 200)
  };
}

function clampInteger(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function updateOutputText(text, options = {}) {
    const outputText = String(text ?? "");
    state.latestOutputText = outputText;
    const shouldStickToBottom =
      els.terminalOutput.scrollHeight - els.terminalOutput.scrollTop - els.terminalOutput.clientHeight < 48;
    const renderedWithXterm = renderTerminalText(outputText);
    if (!renderedWithXterm) {
      if (els.xtermOutput) els.xtermOutput.hidden = true;
      els.output.hidden = false;
    }
    els.output.textContent = renderedWithXterm ? "" : outputText;
    els.title.textContent = state.selected.name;
    if (shouldStickToBottom) {
      els.terminalOutput.scrollTop = els.terminalOutput.scrollHeight;
    }
    if (!options.history) {
      markSelectedTaskState(findYesOption(outputText) ? "needs_confirmation" : "in_progress");
      maybeAutoYes(outputText);
    }
}

function terminalMeasureElement() {
  return state.terminalUsingXterm ? els.xtermOutput : els.output;
}

function ensureTerminal() {
  if (state.terminal) return true;
  if (!els.xtermOutput || typeof window.Terminal !== "function") return false;
  els.xtermOutput.replaceChildren();
  state.terminal = new window.Terminal({
    allowProposedApi: false,
    convertEol: true,
    cursorBlink: false,
    disableStdin: true,
    fontFamily: "\"SFMono-Regular\", Consolas, \"Liberation Mono\", monospace",
    fontSize: 13,
    lineHeight: 1.45,
    scrollback: 0,
    theme: terminalTheme()
  });
  state.terminal.open(els.xtermOutput);
  state.terminalUsingXterm = true;
  els.xtermOutput.hidden = false;
  els.output.hidden = true;
  return true;
}

function renderTerminalText(text) {
  if (!els.xtermOutput || typeof window.Terminal !== "function") return false;
  if (!ensureTerminal()) return false;
  const size = measureTerminalSize();
  if (size) state.terminal.resize(size.cols, size.rows);
  const version = (state.terminalRenderVersion += 1);
  const snapshot = text || "";
  state.terminal.write("\x1b[3J\x1b[2J\x1b[H" + snapshot, () => {
    if (version === state.terminalRenderVersion) state.terminal.scrollToTop();
  });
  return true;
}

function disposeTerminal() {
  if (state.terminal) {
    state.terminal.dispose();
    state.terminal = null;
  }
  state.terminalUsingXterm = false;
  if (els.xtermOutput) els.xtermOutput.replaceChildren();
}

function terminalTheme() {
  if (state.theme === "light") {
    return {
      background: "#ffffff",
      foreground: "#17202a",
      cursor: "#1f6feb",
      selectionBackground: "#c6d0dc"
    };
  }
  return {
    background: "#05080c",
    foreground: "#dbe7f3",
    cursor: "#2f81f7",
    selectionBackground: "#2b3745"
  };
}

function handleOutputWheel(event) {
  if (!shouldForwardOutputWheel(event)) return;
  event.preventDefault();
  const now = Date.now();
  if (now - state.outputWheelLastSentAt < 180) return;
  state.outputWheelLastSentAt = now;
  const selected = currentSelectedSession();
  if (shouldUsePaneWheel(selected)) {
    const wheelKey = event.deltaY < 0 ? "WheelUpPane" : "WheelDownPane";
    sendQuickKeys(Array.from({ length: 5 }, () => wheelKey), { skipRefresh: true });
    return;
  }
  scrollOutputHistory(event.deltaY < 0 ? -1 : 1);
}

function shouldUsePaneWheel(session) {
  return session?.kind === "opencode";
}

function shouldForwardOutputWheel(event) {
  const selected = currentSelectedSession();
  if (!selected || selected.status !== "running" || selected.kind === "runtime") return false;
  if (!event.deltaY) return false;
  if (state.terminalUsingXterm) return true;
  const scroller = els.terminalOutput;
  const canScrollUp = scroller.scrollTop > 0;
  const canScrollDown = scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 1;
  return event.deltaY < 0 ? !canScrollUp : !canScrollDown;
}

function scrollOutputHistory(direction) {
  const selected = currentSelectedSession();
  if (!selected || selected.status !== "running") return false;
  const terminalSize = measureTerminalSize();
  const step = Math.max(5, Math.floor((terminalSize?.rows ?? 30) * 0.8));
  const nextOffset = direction < 0
    ? Math.min(state.outputScrollOffset + step, 5000)
    : Math.max(state.outputScrollOffset - step, 0);
  if (nextOffset === state.outputScrollOffset) return false;
  state.outputScrollOffset = nextOffset;
  clearOutputEtag(selected.id);
  loadOutput({ force: true });
  return true;
}

function updateAllYesButton() {
  els.allYes.dataset.state = state.allYesMode;
}

function maybeAutoYes(text, options = {}) {
  if (state.allYesMode === "off") return;
  
  const selected = currentSelectedSession();
  if (state.allYesMode === "session") {
    if (!selected || selected.status !== "running") return;
    if (selected.kind === "runtime") return;
    const match = findYesOption(text);
    if (!match) return;
    const sessionId = selected.id;
    const signature = match.signature;
    if (!options.force && !shouldSendAutoYes(state.autoYesSignatures.get(sessionId), signature)) return;
    sendAutoYes(sessionId, signature, match.key, match.type);
  }
}

async function autoYesAllSessions() {
  const sessionsNeedingConfirmation = state.sessions.filter(
    (session) => session.taskState === "needs_confirmation" && session.status === "running"
  );
  
  for (const session of sessionsNeedingConfirmation) {
    try {
      const output = await api(`/api/sessions/${encodeURIComponent(session.id)}/output?lines=50`);
      const match = findYesOption(output);
      if (match) {
        const signature = match.signature;
        if (shouldSendAutoYes(state.autoYesSignatures.get(session.id), signature)) {
          await sendAutoYes(session.id, signature, match.key, match.type, { allowBackground: true });
        }
      }
    } catch (error) {
      console.error(`Auto-yes failed for session ${session.name}:`, error);
    }
  }
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
  if (selectedRoomForChat()) {
    if (state.roomViewMode === "assistant") {
      await sendRoomAssistantInput();
    } else {
      await sendRoomInput();
    }
    return;
  }
  const session = currentSelectedSession();
  if (!session) {
    showError(new Error(t("selectRunning")));
    return;
  }
  if (session.status !== "running") {
    showSessionSummary(session);
    return;
  }
  if (!els.input.value.trim()) return;
  try {
    await api(`/api/sessions/${encodeURIComponent(session.id)}/input`, {
      method: "POST",
      body: JSON.stringify({ text: els.input.value })
    });
    els.input.value = "";
    state.outputScrollOffset = 0;
    clearOutputEtag(session.id);
    resetOutputPolling(500);
  } catch (error) {
    showError(error);
  }
}

function currentSelectedSession() {
  if (state.selectedSessionId) {
    const current = state.sessions.find((session) => session.id === state.selectedSessionId);
    if (current) {
      state.selected = current;
      return current;
    }
  }
  return state.selected;
}

async function sendRoomInput() {
  const roomId = state.selectedRoomChatId;
  if (!roomId) {
    showError(new Error(t("noRoom")));
    return;
  }
  if (!els.input.value.trim()) return;
  const target = buildRoomMessageTarget();
  try {
    await api(`/api/rooms/${encodeURIComponent(roomId)}/messages`, {
      method: "POST",
      body: JSON.stringify({
        text: els.input.value,
        fromSessionId: state.selected?.id,
        target,
        metadata: { source: "web" }
      })
    });
    els.input.value = "";
    await loadRoomMessages();
    await refreshSessions();
  } catch (error) {
    showError(error);
  }
}

function buildRoomMessageTarget() {
  const mode = state.selectedRoomTargetMode;
  if (mode === "role") {
    return { mode: "role", role: state.selectedRoomTargetRole || els.sendTargetRole.value };
  }
  if (mode === "session-in-room") {
    return { mode: "session", sessionIds: [state.selectedRoomTargetSessionId || els.sendTargetSession.value] };
  }
  return { mode: "all" };
}

async function sendRoomAssistantInput() {
  const text = els.input.value.trim();
  if (!text) return;
  appendRoomAssistantMessage("user", text);
  els.input.value = "";
  els.send.disabled = true;
  try {
    const body = { text, currentSessionId: state.selected?.id };
    if (state.assistantRoomContext) {
      body.roomContext = state.assistantRoomContext;
    }
    const result = await api("/api/nl", {
      method: "POST",
      body: JSON.stringify(body)
    });
    if (typeof result === "string") {
      appendRoomAssistantMessage("assistant", result);
    } else {
      if (result.session) {
        state.selected = result.session;
        state.selectedSessionId = result.session.id;
        state.selectionVersion += 1;
      }
      appendRoomAssistantMessage("assistant", formatCommandResult(result));
      const updateTerminal = result.presentation?.updateTerminal !== false;
      if (updateTerminal && typeof result.output === "string") {
        els.output.textContent = result.output;
        if (state.selected) clearOutputEtag(state.selected.id);
      }
      await refreshSessions();
      if (updateTerminal) resetOutputPolling(500);
    }
  } catch (error) {
    appendRoomAssistantMessage("error", error instanceof Error ? error.message : String(error));
  } finally {
    els.send.disabled = false;
    els.input.focus();
  }
}

function getRoomAssistantMessagesKey(roomId) {
  return `sessionGatewayRoomAssistant_${roomId}`;
}

function loadRoomAssistantMessages(roomId) {
  if (!roomId) return [];
  try {
    const saved = localStorage.getItem(getRoomAssistantMessagesKey(roomId));
    if (saved) {
      return JSON.parse(saved);
    }
  } catch (e) {
    console.warn("Failed to load room assistant messages:", e);
  }
  return [];
}

function saveRoomAssistantMessages(roomId, messages) {
  if (!roomId) return;
  try {
    localStorage.setItem(getRoomAssistantMessagesKey(roomId), JSON.stringify(messages));
  } catch (e) {
    console.warn("Failed to save room assistant messages:", e);
  }
}

function appendRoomAssistantMessage(role, text) {
  state.assistantMessages.push({ role, text, timestamp: Date.now() });
  saveRoomAssistantMessages(state.selectedRoomChatId, state.assistantMessages);
  renderRoomAssistantMessages();
}

function renderRoomAssistantMessages() {
  if (!els.roomAssistantMessages) return;
  if (!state.assistantMessages.length) {
    const emptyText = t("roomAssistantEmpty");
    els.roomAssistantMessages.innerHTML = `<div class="room-assistant-empty">${escapeHtml(emptyText)}</div>`;
    return;
  }
  els.roomAssistantMessages.innerHTML = state.assistantMessages
    .map((message) => {
      const roleLabel =
        message.role === "user"
          ? t("assistantUser")
          : message.role === "error"
            ? t("assistantError")
            : "web-pi";
      return `
        <div class="room-assistant-message ${escapeHtml(message.role)}">
          <div class="room-assistant-role">${escapeHtml(roleLabel)}</div>
          <div class="room-assistant-text">${escapeHtml(message.text)}</div>
        </div>
      `;
    })
    .join("");
  els.roomAssistantMessages.scrollTop = els.roomAssistantMessages.scrollHeight;
}

function sendInputPlaceholder() {
  if (!selectedRoomForChat()) return t("sendPlaceholder");
  if (state.roomViewMode === "assistant") return t("roomAssistantPlaceholder");
  if (state.selectedRoomTargetMode === "all") return t("roomAll");
  if (state.selectedRoomTargetMode === "role") return t("roomRole");
  if (state.selectedRoomTargetMode === "session-in-room") return t("roomSession");
  return t("sendPlaceholder");
}

function updateInputPlaceholder() {
  els.input.placeholder = sendInputPlaceholder();
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
    state.outputScrollOffset = 0;
    clearOutputEtag(state.selected.id);
    resetOutputPolling(500);
  } catch (error) {
    showError(error);
  }
}

async function sendAutoYes(sessionId, signature, key = "1", type = "text", options = {}) {
  if (!canAutoYesSession(state.sessions, state.selected?.id, sessionId, options)) return;
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
    state.autoYesSignatures.set(sessionId, { signature, sentAt: Date.now() });
    clearOutputEtag(sessionId);
    if (state.selected?.id === sessionId) resetOutputPolling(500);
  } catch (error) {
    showError(error);
  }
}

async function sendQuickKeys(keys, options = {}) {
  if (!state.selected || state.selected.status !== "running") {
    showError(new Error(t("selectRunning")));
    return;
  }
  try {
    await api(`/api/sessions/${encodeURIComponent(state.selected.id)}/keys`, {
      method: "POST",
      body: JSON.stringify({ keys })
    });
    if (!options.skipRefresh) {
      state.outputScrollOffset = 0;
      clearOutputEtag(state.selected.id);
    }
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
      state.selectedSessionId = "";
      state.selectionVersion += 1;
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

function openDeleteRoomDialog(room) {
  state.pendingDeleteRoom = room;
  els.deleteRoomMessage.textContent = t("deleteRoomConfirm").replace("{name}", room.name);
  els.deleteRoomDialog.showModal();
}

async function deletePendingRoom() {
  const room = state.pendingDeleteRoom;
  if (!room) return;
  try {
    await api(`/api/rooms/${encodeURIComponent(room.id)}`, { method: "DELETE" });
    state.selectedRoomChatId = "";
    state.selectedRoomId = "";
    localStorage.setItem("sessionGatewaySelectedRoomId", "");
    state.pendingDeleteRoom = null;
    els.deleteRoomDialog.close();
    showTerminalView();
    await refreshSessions();
  } catch (error) {
    showError(error);
  }
}

function renderQuickKeys() {
  els.quickKeys.innerHTML = "";
  for (const quickKey of currentQuickKeys()) {
    const button = document.createElement("button");
    button.className = "quick-key";
    button.type = "button";
    button.textContent = quickKey.label;
    button.title = quickKey.title ?? quickKey.label;
    button.addEventListener("click", () => activateQuickKey(quickKey));
    els.quickKeys.append(button);
  }
  renderSendTargetControls();
}

function currentQuickKeys() {
  if (selectedRoomForChat()) {
    return [
      { label: t("roomAll"), type: "room-mode", value: "all" },
      { label: t("roomRole"), type: "room-mode", value: "role" },
      { label: t("roomSession"), type: "room-mode", value: "session-in-room" }
    ];
  }
  return quickKeysForSession(state.selected);
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
      { label: "↑", type: "key", value: "Up", title: "Up" },
      { label: "↓", type: "key", value: "Down", title: "Down" },
      { label: "Enter", type: "key", value: "Enter", title: "Enter" },
      { label: t("pageUp"), type: "history-page", value: "up", title: "PageUp" },
      { label: t("pageDown"), type: "history-page", value: "down", title: "PageDown" }
    ];
  }
  return [];
}

function activateQuickKey(quickKey) {
  if (quickKey.type === "room-mode") {
    state.selectedRoomTargetMode = quickKey.value;
    els.sendTargetMode.value = quickKey.value;
    renderSendTargetControls();
    els.input.focus();
    return;
  }
  if (quickKey.type === "key") {
    sendQuickKeys([quickKey.value]);
    return;
  }
  if (quickKey.type === "history-page") {
    if (shouldUsePaneWheel(currentSelectedSession())) {
      sendQuickKeys([quickKey.value === "up" ? "WheelUpPane" : "WheelDownPane"]);
    } else {
      scrollOutputHistory(quickKey.value === "up" ? -1 : 1);
    }
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
  const room = selectedRoom();
  if (room) {
    els.list.append(renderRoomChatItem(room));
  }
  const sessions = filteredSessions();
  for (const session of sessions) {
    const membership = selectedRoomMembership(session);
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
          <button class="session-assign" type="button" title="${escapeHtml(t("joinRoom"))}">${escapeHtml(t("joinRoom"))}</button>
          <button class="session-delete" type="button" title="${escapeHtml(t("delete"))}">${escapeHtml(t("delete"))}</button>
        </span>
      </span>
      <span class="session-meta">${escapeHtml(sessionStatusLabel(session))} · ${escapeHtml(session.kind)} · ${escapeHtml(sessionDeploymentLabel(session))}${membership?.role ? ` · ${escapeHtml(membership.role)}` : ""} · ${escapeHtml(session.cwd)}</span>
    `;
    item.addEventListener("click", () => selectSession(session));
    item.querySelector(".session-assign")?.addEventListener("click", (event) => {
      event.stopPropagation();
      assignSessionToSelectedRoom(session);
    });
    item.querySelector(".session-delete").addEventListener("click", (event) => {
      event.stopPropagation();
      openDeleteDialog(session);
    });
    els.list.append(item);
  }

  if (!sessions.length && !room) {
    els.list.textContent = "No sessions.";
  }
}

function renderRoomChatItem(room) {
  const item = document.createElement("button");
  item.className = `session-item room-chat-item${state.selectedRoomChatId === room.id ? " active" : ""}`;
  item.type = "button";
  const count = room.sessions?.length ?? 0;
  item.innerHTML = `
    <span class="session-main">
      <span class="session-name">${escapeHtml(t("projectGroupChat"))}</span>
      <span class="session-controls">
        <span class="task-state in-progress">${escapeHtml(t("roomConversation"))}</span>
        <button class="session-delete" type="button" title="删除房间">×</button>
      </span>
    </span>
    <span class="session-meta">${escapeHtml(room.name)} · ${escapeHtml(String(count))} ${escapeHtml(t("sessions"))}</span>
  `;
  item.addEventListener("click", () => selectRoomChat(room));
  item.querySelector(".session-delete").addEventListener("click", (event) => {
    event.stopPropagation();
    openDeleteRoomDialog(room);
  });
  return item;
}

function filteredSessions() {
  if (state.selectedRoomId === UNASSIGNED_ROOM_FILTER) {
    return state.sessions.filter((session) => !(session.rooms ?? []).length);
  }
  if (state.selectedRoomId) {
    return state.sessions.filter((session) => sessionHasRoom(session, state.selectedRoomId));
  }
  return state.sessions;
}

function sessionHasRoom(session, roomId) {
  return (session.rooms ?? []).some((room) => room.roomId === roomId);
}

function selectedRoomMembership(session) {
  return sessionRoomMembership(session, state.selectedRoomId);
}

function sessionRoomMembership(session, roomId) {
  if (!roomId) return null;
  return (session.rooms ?? []).find((room) => room.roomId === roomId) ?? null;
}

function selectedRoom() {
  return state.rooms.find((room) => room.id === selectedRealRoomId()) ?? null;
}

function selectedRoomForChat() {
  return state.rooms.find((room) => room.id === state.selectedRoomChatId) ?? null;
}

function selectedRealRoomId() {
  return state.selectedRoomId === UNASSIGNED_ROOM_FILTER ? "" : state.selectedRoomId;
}

async function assignSessionToSelectedRoom(session) {
  if (!state.rooms.length) {
    showError(new Error(t("noRoom")));
    return;
  }
  const roomId = selectedRealRoomId() || session.rooms?.[0]?.roomId || state.rooms[0].id;
  const membership = sessionRoomMembership(session, roomId);
  els.assignSessionId.value = session.id;
  els.assignRoom.value = roomId;
  els.assignRolePreset.value = membership?.rolePresetId || "";
  els.assignRole.value = membership?.role || "";
  els.assignInjectPrompt.checked = false;
  els.assignRoleDialog.showModal();
  els.assignRoom.focus();
}

function applySelectedAssignRoom() {
  const session = state.sessions.find((item) => item.id === els.assignSessionId.value);
  if (!session) return;
  const membership = sessionRoomMembership(session, els.assignRoom.value);
  els.assignRolePreset.value = membership?.rolePresetId || "";
  els.assignRole.value = membership?.role || "";
}

async function assignRoleFromDialog() {
  const roomId = els.assignRoom.value;
  if (!roomId || !els.assignSessionId.value) return;
  try {
    await api(`/api/rooms/${encodeURIComponent(roomId)}/sessions`, {
      method: "POST",
      body: JSON.stringify({
        sessionId: els.assignSessionId.value,
        rolePresetId: els.assignRolePreset.value || undefined,
        role: els.assignRole.value || undefined,
        injectRolePrompt: els.assignInjectPrompt.checked
      })
    });
    els.assignRoleDialog.close();
    await refreshSessions();
  } catch (error) {
    showError(error);
  }
}

async function selectSession(session) {
  state.selectedRoomChatId = "";
  state.selected = session;
  state.selectedSessionId = session.id;
  state.selectionVersion += 1;
  showTerminalView();
  renderSessions();
  renderTaskAlert();
  renderQuickKeys();
  closeSessionsPanel();
  if (session.status === "running") {
    state.outputScrollOffset = 0;
    clearOutputEtag(session.id);
    try {
      await resizeTerminalForSession(session);
    } catch (error) {
      console.warn(error);
    }
    await loadOutput({ force: true });
    resetOutputPolling(1000);
  } else {
    clearOutputPoll();
    showSessionSummary(session);
  }
}

async function selectRoomChat(room) {
  clearWorkflowPoll();
  state.selectedRoomChatId = room.id;
  state.selected = null;
  state.selectedSessionId = "";
  state.selectionVersion += 1;
  state.workflowView = false;
  state.workflows = [];
  state.roomViewMode = "messages";
  // Initialize assistant context for the room
  const sessions = room.sessions ?? [];
  state.assistantRoomContext = {
    roomId: room.id,
    roomName: room.name,
    project: room.project,
    objective: room.objective,
    sessions: sessions.map((s) => ({
      sessionId: s.sessionId,
      sessionName: s.sessionName,
      role: s.role || s.rolePresetLabel || null,
      status: s.sessionStatus
    }))
  };
  // Load persisted assistant messages for this room
  state.assistantMessages = loadRoomAssistantMessages(room.id);
  delete els.roomMessages.dataset.signature;
  clearOutputPoll();
  renderSessions();
  renderTaskAlert();
  renderQuickKeys();
  renderRoomPanel();
  closeSessionsPanel();
  await loadRoomMessages();
  showRoomView("messages");
  els.title.textContent = `${t("projectGroupChat")} · ${room.name}`;
  els.input.focus();
}

function showTerminalView() {
  clearWorkflowPoll();
  state.selectedRoomChatId = "";
  state.assistantRoomContext = null;
  state.assistantMessages = [];
  state.roomViewMode = "messages";
  delete els.roomMessages.dataset.signature;
  els.output.hidden = false;
  els.roomPanel.hidden = true;
  els.roomActions.hidden = true;
  els.addQuickKey.hidden = false;
  if (!state.selected) {
    els.title.textContent = t("noSession");
    state.roomMessages = [];
    state.selectedSessionId = "";
    state.selectionVersion += 1;
  }
  renderSendTargetControls();
}

function closeSessionsPanel() {
  els.sessionsPanel.classList.remove("open");
  els.sessionsPanel.setAttribute("aria-hidden", "true");
}

function openAssistant() {
  state.assistantRoomContext = null;
  els.runDialog.classList.add("open");
  els.runDialog.setAttribute("aria-hidden", "false");
  els.runDialog.querySelector(".assistant-subtitle").textContent = "web-pi";
  renderAssistantMessages();
}

function openRoomAssistantDialog() {
  const room = selectedRoomForChat();
  if (!room) return;
  const sessions = room.sessions ?? [];
  state.assistantRoomContext = {
    roomId: room.id,
    roomName: room.name,
    project: room.project,
    objective: room.objective,
    sessions: sessions.map((s) => ({
      sessionId: s.sessionId,
      sessionName: s.sessionName,
      role: s.role || s.rolePresetLabel || null,
      status: s.sessionStatus
    }))
  };
  showRoomView("assistant");
  els.input.focus();
}

function closeAssistant() {
  els.runDialog.classList.remove("open");
  els.runDialog.setAttribute("aria-hidden", "true");
  focusSessionInput();
}

function appendAssistantMessage(role, text) {
  state.assistantMessages.push({
    role,
    text: String(text ?? ""),
    createdAt: new Date().toISOString()
  });
  if (state.assistantMessages.length > 80) {
    state.assistantMessages = state.assistantMessages.slice(-80);
  }
  renderAssistantMessages();
}

function renderAssistantMessages() {
  if (!els.assistantMessages) return;
  if (!state.assistantMessages.length) {
    const emptyText = state.assistantRoomContext ? t("roomAssistantEmpty") : t("assistantEmpty");
    els.assistantMessages.innerHTML = `<div class="assistant-empty">${escapeHtml(emptyText)}</div>`;
    return;
  }
  els.assistantMessages.innerHTML = state.assistantMessages
    .map((message) => {
      const roleLabel =
        message.role === "user"
          ? t("assistantUser")
          : message.role === "error"
            ? t("assistantError")
            : "web-pi";
      return `
        <div class="assistant-message ${escapeHtml(message.role)}">
          <div class="assistant-role">${escapeHtml(roleLabel)}</div>
          <div class="assistant-text">${escapeHtml(message.text)}</div>
        </div>
      `;
    })
    .join("");
  els.assistantMessages.scrollTop = els.assistantMessages.scrollHeight;
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
  state.notifications = settings?.notifications ?? {};
  state.sessionAgentSettings = settings?.sessionAgent ?? {};
  state.workflowSupervisorSettings = settings?.workflowSupervisor ?? {};
  els.workflowPmEnabled.checked = Boolean(state.workflowSupervisorSettings.pmAgentEnabled);
  setSecondsInput(els.workflowSupervisorIntervalSeconds, state.workflowSupervisorSettings.intervalMs, 60);
  setSecondsInput(els.workflowSupervisorStallSeconds, state.workflowSupervisorSettings.stallMs, 15 * 60);
  setSecondsInput(els.workflowSupervisorHardTimeoutSeconds, state.workflowSupervisorSettings.hardTimeoutMs, 60 * 60);
  setSecondsInput(els.workflowSupervisorCooldownSeconds, state.workflowSupervisorSettings.sameActionCooldownMs, 10 * 60);
  els.workflowSupervisorMaxInterventions.value = String(
    numberOrFallback(state.workflowSupervisorSettings.maxInterventionsPerAssignment, 3)
  );
  els.workflowSupervisorMaxSpawned.value = String(numberOrFallback(state.workflowSupervisorSettings.maxSpawnedAgentsPerRoom, 3));
  const commandParser = settings?.commandParser ?? {};

  const savedConfig = localStorage.getItem("sessionGatewayAiParser");
  if (savedConfig) {
    const saved = JSON.parse(savedConfig);
    if (saved.baseUrl && saved.model) {
      els.aiParserBaseUrl.value = saved.baseUrl;
      els.aiParserModel.value = saved.model || "";
      els.aiParserApiKey.value = saved.apiKey || "";
      updateCreateDeploymentControls();
      return;
    }
  }

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
  els.openRoomCreate.textContent = text.newRoom;
  els.restart.textContent = text.restart;
  els.stop.textContent = text.stop;
  els.openConfig.textContent = text.config;
  els.sessionsTitle.textContent = text.sessionsTitle;
  els.closeSessions.textContent = text.close;
  els.refresh.textContent = text.refresh;
  els.send.textContent = text.send;
  els.create.textContent = text.create;
  els.runNl.textContent = text.send;
  document.querySelector("#confirm-delete").textContent = text.delete;
  els.input.placeholder = text.sendPlaceholder;
  els.name.placeholder = text.namePlaceholder;
  els.cwd.placeholder = text.cwdPlaceholder;
  els.project.placeholder = text.projectPlaceholder;
  els.createRole.placeholder = text.rolePlaceholder;
  els.assignRole.placeholder = text.rolePlaceholder;
  els.roomName.placeholder = text.roomNamePlaceholder;
  els.roomProject.placeholder = text.projectPlaceholder;
  els.roomObjective.placeholder = text.roomObjectivePlaceholder;
  els.nl.placeholder = text.nlPlaceholder;
  els.sendTargetMode.options[0].textContent = text.roomAll;
  els.sendTargetMode.options[1].textContent = text.roomRole;
  els.sendTargetMode.options[2].textContent = text.roomSession;
  els.refreshRoomMessages.textContent = text.refresh;
  document.querySelector("#confirm-delete-room").textContent = text.delete;
  renderRoomControls();
  renderRolePresetControls();
  renderRoomPanel();
  renderSendTargetControls();
  renderAssistantMessages();
  if (!state.selected) els.title.textContent = text.noSession;
}

function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
  if (state.terminal) state.terminal.options.theme = terminalTheme();
}

function t(key) {
  return (translations[state.language] ?? translations.zh)[key] ?? key;
}

function showError(error) {
  updateOutputText(error instanceof Error ? error.message : String(error));
}

function formatCommandResult(result) {
  if (!result || typeof result !== "object") return String(result);
  if (result.command?.type === "assistant") {
    if (typeof result.answer === "string" && result.answer.trim()) {
      return result.answer;
    }
    if (!result.ok) {
      return state.language === "zh"
        ? "助手处理请求时遇到问题，请稍后重试。"
        : "The assistant encountered an issue processing your request. Please try again.";
    }
  }
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
  const selected = currentSelectedSession();
  if (document.hidden || !selected || selected.status !== "running") {
    clearOutputPoll();
    return;
  }
  const changed = await loadOutput();
  if (changed === false && state.outputScrollOffset === 0) maybeAutoYes(state.latestOutputText);
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
  const selected = currentSelectedSession();
  if (document.hidden || !selected || selected.status !== "running") return;
  state.outputPollTimer = setTimeout(refreshSelectedOutput, delayMs);
}

function scheduleSessionPoll(delayMs = 5000) {
  clearSessionPoll();
  if (document.hidden && state.allYesMode !== "global") return;
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

function sessionsNeedingConfirmationInRoom(roomId) {
  if (!roomId) return [];
  return state.sessions.filter(
    (session) => session.taskState === "needs_confirmation" && sessionHasRoom(session, roomId)
  );
}

function renderReviewButtons() {
  const roomId = state.selectedRoomChatId;
  const sessions = sessionsNeedingConfirmationInRoom(roomId);
  
  if (!roomId || sessions.length === 0) {
    els.reviewButtons.hidden = true;
    els.reviewButtons.innerHTML = "";
    return;
  }
  
  els.reviewButtons.hidden = false;
  els.reviewButtons.innerHTML = sessions.map((session) => 
    `<button class="review-btn" data-session-id="${escapeHtml(session.id)}" type="button">${escapeHtml(session.name)}</button>`
  ).join("");
  
  els.reviewButtons.querySelectorAll(".review-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const sessionId = btn.dataset.sessionId;
      openReviewDialog(sessionId);
    });
  });
}

async function openReviewDialog(sessionId) {
  const session = state.sessions.find((s) => s.id === sessionId);
  if (!session) return;
  
  state.reviewingSessionId = sessionId;
  
  els.reviewSessionInfo.innerHTML = `
    <div class="session-name">${escapeHtml(session.name)}</div>
    <div class="session-status">状态：待审核</div>
    <div>类型：${escapeHtml(session.kind)}</div>
    ${session.project ? `<div>项目：${escapeHtml(session.project)}</div>` : ""}
    <div class="session-output-label">最近输出：</div>
    <div class="session-output-loading">加载中...</div>
  `;
  
  els.reviewDialog.showModal();
  
  try {
    const output = await api(`/api/sessions/${encodeURIComponent(sessionId)}/output?lines=15`);
    const outputContainer = els.reviewSessionInfo.querySelector(".session-output-loading");
    if (outputContainer) {
      outputContainer.className = "session-output-content";
      outputContainer.textContent = output || "（无输出）";
    }
  } catch (error) {
    const outputContainer = els.reviewSessionInfo.querySelector(".session-output-loading");
    if (outputContainer) {
      outputContainer.className = "session-output-error";
      outputContainer.textContent = `加载失败：${error.message}`;
    }
  }
}

async function sendQuickReview(value) {
  const sessionId = state.reviewingSessionId;
  if (!sessionId) return;
  
  const session = state.sessions.find((s) => s.id === sessionId);
  if (!session || session.status !== "running") {
    showError(new Error("会话未运行"));
    return;
  }
  
  try {
    await api(`/api/sessions/${encodeURIComponent(sessionId)}/input`, {
      method: "POST",
      body: JSON.stringify({ text: value })
    });
    
    state.reviewingSessionId = null;
    els.reviewDialog.close();
    
    await refreshSessions();
  } catch (error) {
    showError(error);
  }
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
