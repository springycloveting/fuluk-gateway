import { newId } from "./utils.mjs";

const ACTIVE_WORKFLOW_STATUSES = new Set(["planning", "executing", "integration_testing", "security_review", "blocked"]);

export const DEFAULT_WORKFLOW_SUPERVISOR_OPTIONS = {
  enabled: true,
  pmAgentEnabled: false,
  intervalMs: 60_000,
  leaseMs: 120_000,
  stallMs: 15 * 60_000,
  hardTimeoutMs: 60 * 60_000,
  sameActionCooldownMs: 10 * 60_000,
  maxInterventionsPerAssignment: 3,
  maxSpawnedAgentsPerRoom: 3
};

export function createWorkflowSupervisor(context, operations = {}, inputOptions = {}) {
  const options = normalizeSupervisorOptions(inputOptions);
  const ownerId = inputOptions.ownerId || `supervisor-${newId()}`;
  let timer = null;
  let running = false;

  const supervisor = {
    ownerId,
    options,
    start() {
      if (!options.enabled || timer) return;
      timer = setInterval(() => {
        supervisor.tick().catch((error) => {
          console.warn(`Workflow supervisor tick failed: ${errorMessage(error)}`);
        });
      }, options.intervalMs);
      timer.unref?.();
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
    async tick() {
      if (running) return { skipped: true, reason: "already_running" };
      running = true;
      try {
        const workflows = context.store.listActiveWorkflowRuns();
        const results = [];
        for (const workflow of workflows) results.push(await supervisor.tickWorkflow(workflow.id));
        return { skipped: false, workflows: results };
      } finally {
        running = false;
      }
    },
    async tickWorkflow(runId) {
      const workflow = context.store.getWorkflowRun(runId);
      if (!workflow) throw new Error(`Workflow run not found: ${runId}`);
      if (!ACTIVE_WORKFLOW_STATUSES.has(workflow.status)) return { runId, skipped: true, reason: "inactive" };
      const now = new Date();
      const lease = context.store.acquireWorkflowSupervisorLease(
        workflow.id,
        ownerId,
        new Date(now.getTime() + options.leaseMs).toISOString(),
        now.toISOString()
      );
      if (!lease || lease.ownerId !== ownerId) return { runId, skipped: true, reason: "leased" };

      await operations.reconcileWorkflowResults?.(workflow.id, context);
      await operations.dispatchPendingWorkflowAssignments?.(context.store.getWorkflowRun(workflow.id), context);

      const refreshed = context.store.getWorkflowRun(workflow.id);
      const snapshot = buildProjectSnapshot(refreshed, context.store, now);
      const detectedIssues = detectWorkflowIssues(snapshot, options);
      const observation = context.store.createWorkflowObservation({
        runId: refreshed.id,
        tickId: newId(),
        snapshot,
        detectedIssues
      });
      const interventions = [];
      const managerDecision = await askProjectManagerIfNeeded(snapshot, detectedIssues, observation, context, operations, options);
      const managerHandledAssignments = new Set(
        managerDecision?.ok
          ? (managerDecision.interventions ?? [])
              .filter((item) => item.source === "pm_agent" && item.actionType !== "observe_only" && item.validationStatus === "executed")
              .map((item) => item.assignmentId)
              .filter(Boolean)
          : []
      );
      const managerHandledWorkflow = Boolean(
        managerDecision?.ok &&
        (managerDecision.interventions ?? []).some((item) =>
          item.source === "pm_agent" &&
          item.actionType !== "observe_only" &&
          item.validationStatus === "executed" &&
          !item.assignmentId
        )
      );
      for (const issue of detectedIssues) {
        if (managerHandledWorkflow) continue;
        if (managerHandledAssignments.has(issue.assignmentId)) continue;
        const intervention = await applyDeterministicIssue(issue, observation, context, operations, options, now);
        if (intervention) interventions.push(intervention);
      }
      if (managerDecision?.interventions?.length) interventions.push(...managerDecision.interventions);
      return { runId: refreshed.id, observation, detectedIssues, managerDecision, interventions };
    },
    status(runId) {
      const workflow = context.store.getWorkflowRun(runId);
      if (!workflow) throw new Error(`Workflow run not found: ${runId}`);
      return {
        enabled: options.enabled,
        ownerId,
        options,
        lease: context.store.getWorkflowSupervisorLease(runId),
        observations: context.store.listWorkflowObservations(runId, 5),
        interventions: context.store.listWorkflowInterventions(runId, 20)
      };
    }
  };

  return supervisor;
}

export function buildProjectSnapshot(workflow, store, now = new Date()) {
  const room = store.getRoom(workflow.roomId);
  const assignments = (workflow.runAssignments ?? []).map((assignment) => {
    const activityAt = assignment.lastActivityAt || assignment.updatedAt || assignment.createdAt;
    return {
      id: assignment.id,
      workItemId: assignment.workItemId,
      role: assignment.role,
      sessionId: assignment.sessionId,
      gateKind: assignment.gateKind,
      status: assignment.status,
      attemptNo: assignment.attemptNo,
      dispatchedMessageId: assignment.dispatchedMessageId,
      resultMessageId: assignment.resultMessageId,
      createdAt: assignment.createdAt,
      updatedAt: assignment.updatedAt,
      lastActivityAt: activityAt,
      lastRemindedAt: assignment.lastRemindedAt,
      interventionCount: assignment.interventionCount,
      supervisorState: assignment.supervisorState,
      ageSeconds: secondsSince(activityAt, now)
    };
  });
  const recentMessages = store.listRoomMessages(workflow.roomId, 50);
  return {
    room: {
      id: room.id,
      name: room.name,
      objective: room.objective,
      project: room.project
    },
    workflow: {
      id: workflow.id,
      status: workflow.status,
      currentStage: workflow.currentStage,
      objective: workflow.objective,
      templateId: workflow.templateId,
      templateName: workflow.templateName,
      startedAt: workflow.startedAt,
      updatedAt: workflow.updatedAt
    },
    members: (room.sessions ?? []).map((member) => ({
      sessionId: member.sessionId,
      sessionName: member.sessionName,
      role: member.role || member.rolePresetName || member.rolePresetLabel,
      status: member.sessionStatus,
      activeAssignments: assignments.filter(
        (assignment) => assignment.sessionId === member.sessionId && assignment.status === "pending"
      ).length
    })),
    assignments,
    recentResults: recentMessages
      .filter((message) => message.metadata?.source === "agent-result")
      .slice(-10)
      .map((message) => ({
        messageId: message.id,
        fromSessionId: message.fromSessionId,
        parentMessageId: message.metadata?.parentMessageId,
        status: resultStatus(message.text),
        text: message.text,
        createdAt: message.createdAt
      })),
    generatedAt: now.toISOString()
  };
}

export function detectWorkflowIssues(snapshot, options = DEFAULT_WORKFLOW_SUPERVISOR_OPTIONS) {
  const issues = [];
  const stallSeconds = Math.ceil(options.stallMs / 1000);
  const hardTimeoutSeconds = Math.ceil(options.hardTimeoutMs / 1000);

  // Check for assignments with stopped sessions (only if we have members data)
  const members = snapshot.members ?? [];
  const hasMembersData = members.length > 0;
  const runningSessionIds = new Set(
    members.filter((m) => m.status === "running").map((m) => m.sessionId)
  );

  for (const assignment of snapshot.assignments ?? []) {
    if (assignment.status !== "pending") continue;

    // Check if the assigned session is stopped (only if we have members data)
    if (hasMembersData && assignment.sessionId && !runningSessionIds.has(assignment.sessionId)) {
      issues.push({
        type: "session_stopped",
        severity: "error",
        assignmentId: assignment.id,
        sessionId: assignment.sessionId,
        reason: `Assignment ${assignment.id} 的目标会话 ${assignment.sessionId} 已停止运行。`
      });
      continue;
    }

    if (!assignment.dispatchedMessageId || assignment.resultMessageId) continue;
    if (assignment.ageSeconds >= hardTimeoutSeconds) {
      issues.push({
        type: "assignment_hard_timeout",
        severity: "error",
        assignmentId: assignment.id,
        sessionId: assignment.sessionId,
        reason: `Assignment ${assignment.id} 已超过 ${hardTimeoutSeconds} 秒无回调。`
      });
      continue;
    }
    if (assignment.ageSeconds >= stallSeconds) {
      issues.push({
        type: "stalled_assignment",
        severity: "warning",
        assignmentId: assignment.id,
        sessionId: assignment.sessionId,
        reason: `Assignment ${assignment.id} 已超过 ${stallSeconds} 秒无回调。`
      });
    }
  }

  return issues;
}

async function applyDeterministicIssue(issue, observation, context, operations, options, now) {
  // Handle session_stopped - mark workflow as needing human intervention
  if (issue.type === "session_stopped") {
    const assignment = context.store.getWorkflowAssignment(issue.assignmentId);
    if (!assignment || assignment.status !== "pending") return null;

    // Get workflow to find roomId
    const workflow = context.store.getWorkflowRun(observation.runId);
    const roomId = workflow?.roomId;
    if (!roomId) return null;

    // Mark workflow as needing human intervention
    context.store.updateWorkflowRunState(observation.runId, "needs_human", "needs_human");

    // Post a notice to the room
    await operations.dispatchRoomMessage?.(roomId, {
      text: `[BLOCKED] 工作流需要人工介入。\n\n${issue.reason}\n\n请重启相关会话或手动处理此任务。`,
      target: { mode: "room" },
      metadata: { source: "workflow-system", workflowRunId: observation.runId }
    }, context);

    return context.store.createWorkflowIntervention({
      runId: observation.runId,
      observationId: observation.id,
      source: "rule",
      actionType: "escalate",
      targetSessionId: assignment.sessionId,
      assignmentId: assignment.id,
      workItemId: assignment.workItemId,
      reason: issue.reason,
      validationStatus: "executed",
      executedAt: now.toISOString()
    });
  }

  if (issue.type !== "stalled_assignment" && issue.type !== "assignment_hard_timeout") return null;
  const assignment = context.store.getWorkflowAssignment(issue.assignmentId);
  if (!assignment || assignment.status !== "pending") return null;
  if (assignment.interventionCount >= options.maxInterventionsPerAssignment) {
    return context.store.createWorkflowIntervention({
      runId: observation.runId,
      observationId: observation.id,
      source: "rule",
      actionType: "escalate",
      targetSessionId: assignment.sessionId,
      assignmentId: assignment.id,
      workItemId: assignment.workItemId,
      reason: "Assignment 已达到最大自动干预次数。",
      validationStatus: "accepted",
      executedAt: now.toISOString()
    });
  }

  const sinceIso = new Date(now.getTime() - options.sameActionCooldownMs).toISOString();
  const recent = context.store.findRecentWorkflowIntervention({
    runId: observation.runId,
    actionType: "remind",
    assignmentId: assignment.id,
    sinceIso
  });
  if (recent) return null;

  const intervention = context.store.createWorkflowIntervention({
    runId: observation.runId,
    observationId: observation.id,
    source: "rule",
    actionType: "remind",
    targetSessionId: assignment.sessionId,
    assignmentId: assignment.id,
    workItemId: assignment.workItemId,
    reason: issue.reason,
    instruction: "这是未收到回传结果的任务提醒。业务完成后必须调用回调 API 回传 [DONE]，不要只在终端输出结论。",
    validationStatus: "accepted"
  });

  await operations.dispatchPendingWorkflowAssignments?.(context.store.getWorkflowRun(observation.runId), context, {
    redispatch: true,
    assignmentIds: [assignment.id]
  });
  const updated = context.store.getWorkflowAssignment(assignment.id);
  context.store.markWorkflowAssignmentReminded(assignment.id, updated?.dispatchedMessageId ?? null);
  return context.store.updateWorkflowIntervention(intervention.id, {
    validationStatus: "executed",
    dispatchedMessageId: updated?.dispatchedMessageId ?? null,
    executedAt: new Date().toISOString()
  });
}

async function askProjectManagerIfNeeded(snapshot, detectedIssues, observation, context, operations, options) {
  if (!options.pmAgentEnabled || !detectedIssues.length) return null;
  const manager = operations.projectManagerAgent ?? context.projectManagerAgent;
  if (!manager?.decide) return null;
  try {
    const result = await manager.decide(snapshot, detectedIssues);
    if (!result?.ok) {
      const intervention = context.store.createWorkflowIntervention({
        runId: observation.runId,
        observationId: observation.id,
        source: "pm_agent",
        actionType: "observe_only",
        reason: "PM Agent 输出未通过校验。",
        decision: result?.decision ?? {},
        validationStatus: "rejected",
        validationError: (result?.errors ?? ["PM Agent validation failed"]).join("; ")
      });
      return { ok: false, decision: result?.decision ?? null, errors: result?.errors ?? [], interventions: [intervention] };
    }
    const interventions = [];
    for (const action of result.decision.actions) {
      const intervention = await applyManagerAction(action, result.decision, observation, context, operations, options);
      if (intervention) interventions.push(intervention);
    }
    if (!interventions.length) {
      interventions.push(context.store.createWorkflowIntervention({
        runId: observation.runId,
        observationId: observation.id,
        source: "pm_agent",
        actionType: "observe_only",
        reason: result.decision.summary || "PM Agent chose to observe.",
        decision: result.decision,
        validationStatus: "accepted"
      }));
    }
    return { ok: true, decision: result.decision, interventions };
  } catch (error) {
    const intervention = context.store.createWorkflowIntervention({
      runId: observation.runId,
      observationId: observation.id,
      source: "pm_agent",
      actionType: "observe_only",
      reason: "PM Agent 调用失败。",
      validationStatus: "failed",
      validationError: errorMessage(error)
    });
    return { ok: false, errors: [errorMessage(error)], interventions: [intervention] };
  }
}

async function applyManagerAction(action, decision, observation, context, operations, options) {
  const assignment = action.assignmentId ? context.store.getWorkflowAssignment(action.assignmentId) : null;
  const base = {
    runId: observation.runId,
    observationId: observation.id,
    source: "pm_agent",
    actionType: action.type,
    targetSessionId: action.targetSessionId,
    targetRole: action.targetRole,
    assignmentId: action.assignmentId,
    workItemId: assignment?.workItemId ?? null,
    reason: action.reason || decision.summary,
    instruction: action.message,
    decision,
    validationStatus: "accepted"
  };

  if (action.type === "observe_only") return context.store.createWorkflowIntervention(base);

  if (action.type === "remind") {
    const intervention = context.store.createWorkflowIntervention(base);
    await operations.dispatchPendingWorkflowAssignments?.(context.store.getWorkflowRun(observation.runId), context, {
      redispatch: true,
      assignmentIds: [action.assignmentId]
    });
    const updated = context.store.getWorkflowAssignment(action.assignmentId);
    context.store.markWorkflowAssignmentReminded(action.assignmentId, updated?.dispatchedMessageId ?? null);
    return context.store.updateWorkflowIntervention(intervention.id, {
      validationStatus: "executed",
      dispatchedMessageId: updated?.dispatchedMessageId ?? null,
      executedAt: new Date().toISOString()
    });
  }

  if (action.type === "redirect") {
    const intervention = context.store.createWorkflowIntervention(base);
    const result = await operations.dispatchRoomMessage?.(observation.roomId, {
      text: [
        "[PM纠偏]",
        action.message,
        "",
        "请完成后通过原任务回调返回 [DONE] / [FAIL] / [BLOCKED]。"
      ].join("\n"),
      target: { mode: "session", sessionIds: [action.targetSessionId] },
      metadata: {
        source: "pm-intervention",
        workflowRunId: observation.runId,
        assignmentId: action.assignmentId,
        actionType: action.type
      }
    }, context);
    return context.store.updateWorkflowIntervention(intervention.id, {
      validationStatus: "executed",
      dispatchedMessageId: result?.message?.id ?? null,
      executedAt: new Date().toISOString()
    });
  }

  if (action.type === "retry") {
    const intervention = context.store.createWorkflowIntervention(base);
    context.store.updateWorkflowAssignmentStatus(action.assignmentId, "failed", { supervisorState: "retried" });
    const retry = context.store.createWorkflowAssignment({
      runId: observation.runId,
      workItemId: assignment.workItemId || assignment.id,
      gateKind: assignment.gateKind,
      role: assignment.role,
      sessionId: assignment.sessionId,
      attemptNo: assignment.attemptNo + 1
    });
    await operations.dispatchPendingWorkflowAssignments?.(context.store.getWorkflowRun(observation.runId), context, {
      assignmentIds: [retry.id]
    });
    const dispatched = context.store.getWorkflowAssignment(retry.id);
    return context.store.updateWorkflowIntervention(intervention.id, {
      validationStatus: "executed",
      dispatchedMessageId: dispatched?.dispatchedMessageId ?? null,
      executedAt: new Date().toISOString()
    });
  }

  if (action.type === "reassign") {
    const target = findReassignmentTarget(context.store.getRoom(observation.roomId), action, assignment);
    if (!target) {
      return context.store.createWorkflowIntervention({
        ...base,
        validationStatus: "failed",
        validationError: "No running room session is available for reassignment."
      });
    }
    const intervention = context.store.createWorkflowIntervention({ ...base, targetSessionId: target.sessionId });
    context.store.updateWorkflowAssignmentStatus(action.assignmentId, "blocked", { supervisorState: "reassigned" });
    const next = context.store.createWorkflowAssignment({
      runId: observation.runId,
      workItemId: assignment.workItemId || assignment.id,
      gateKind: assignment.gateKind,
      role: assignment.role,
      sessionId: target.sessionId,
      attemptNo: assignment.attemptNo + 1
    });
    await operations.dispatchPendingWorkflowAssignments?.(context.store.getWorkflowRun(observation.runId), context, {
      assignmentIds: [next.id]
    });
    const dispatched = context.store.getWorkflowAssignment(next.id);
    return context.store.updateWorkflowIntervention(intervention.id, {
      validationStatus: "executed",
      dispatchedMessageId: dispatched?.dispatchedMessageId ?? null,
      executedAt: new Date().toISOString()
    });
  }

  if (action.type === "request_replan") {
    const planner = findRoomMembersWithRole(context.store.getRoom(observation.roomId), "planner")[0];
    if (!planner) {
      return context.store.createWorkflowIntervention({
        ...base,
        validationStatus: "failed",
        validationError: "No running planner session is available for replan."
      });
    }
    const intervention = context.store.createWorkflowIntervention({ ...base, targetSessionId: planner.sessionId, targetRole: "planner" });
    const result = await operations.dispatchRoomMessage?.(observation.roomId, {
      text: [
        "[PM重规划请求]",
        action.message || decision.summary || "当前计划需要更新，请基于最新结果重新规划剩余任务。",
        "",
        "请输出更新后的计划、任务负责人、依赖和验收标准，并通过房间回调返回 [DONE]。"
      ].join("\n"),
      target: { mode: "session", sessionIds: [planner.sessionId] },
      metadata: {
        source: "pm-intervention",
        workflowRunId: observation.runId,
        actionType: action.type
      }
    }, context);
    return context.store.updateWorkflowIntervention(intervention.id, {
      validationStatus: "executed",
      dispatchedMessageId: result?.message?.id ?? null,
      executedAt: new Date().toISOString()
    });
  }

  if (action.type === "escalate" || action.type === "pause_workflow") {
    const intervention = context.store.createWorkflowIntervention(base);
    context.store.updateWorkflowRunState(observation.runId, "needs_human", "needs_human");
    const result = await operations.dispatchRoomMessage?.(observation.roomId, {
      text: `[BLOCKED] PM 监督已暂停自动推进，需要人工介入。\n\n${action.reason || decision.summary || "未提供原因。"}`,
      target: { mode: "room" },
      metadata: {
        source: "pm-intervention",
        workflowRunId: observation.runId,
        actionType: action.type
      }
    }, context);
    return context.store.updateWorkflowIntervention(intervention.id, {
      validationStatus: "executed",
      dispatchedMessageId: result?.message?.id ?? null,
      executedAt: new Date().toISOString()
    });
  }

  if (action.type === "spawn_agent") {
    const spawnedCount = context.store.listWorkflowInterventions(observation.runId, 200)
      .filter((item) => item.actionType === "spawn_agent" && item.validationStatus === "executed")
      .length;
    if (spawnedCount >= (options.maxSpawnedAgentsPerRoom ?? DEFAULT_WORKFLOW_SUPERVISOR_OPTIONS.maxSpawnedAgentsPerRoom)) {
      return context.store.createWorkflowIntervention({
        ...base,
        validationStatus: "rejected",
        validationError: "Room has reached the automatic spawned agent limit."
      });
    }
    if (!operations.spawnWorkflowAgent) {
      return context.store.createWorkflowIntervention({
        ...base,
        validationStatus: "failed",
        validationError: "spawnWorkflowAgent operation is not configured."
      });
    }
    const intervention = context.store.createWorkflowIntervention(base);
    const spawned = await operations.spawnWorkflowAgent({
      runId: observation.runId,
      roomId: observation.roomId,
      role: action.targetRole,
      reason: action.reason || decision.summary
    }, context);
    let dispatchedMessageId = null;
    if (assignment) {
      context.store.updateWorkflowAssignmentStatus(action.assignmentId, "blocked", { supervisorState: "spawned_agent" });
      const next = context.store.createWorkflowAssignment({
        runId: observation.runId,
        workItemId: assignment.workItemId || assignment.id,
        gateKind: assignment.gateKind,
        role: assignment.role,
        sessionId: spawned.session.id,
        attemptNo: assignment.attemptNo + 1
      });
      await operations.dispatchPendingWorkflowAssignments?.(context.store.getWorkflowRun(observation.runId), context, {
        assignmentIds: [next.id]
      });
      dispatchedMessageId = context.store.getWorkflowAssignment(next.id)?.dispatchedMessageId ?? null;
    } else if (action.message) {
      const result = await operations.dispatchRoomMessage?.(observation.roomId, {
        text: action.message,
        target: { mode: "session", sessionIds: [spawned.session.id] },
        metadata: {
          source: "pm-intervention",
          workflowRunId: observation.runId,
          actionType: action.type
        }
      }, context);
      dispatchedMessageId = result?.message?.id ?? null;
    }
    return context.store.updateWorkflowIntervention(intervention.id, {
      validationStatus: "executed",
      dispatchedMessageId,
      executedAt: new Date().toISOString()
    });
  }

  return context.store.createWorkflowIntervention({
    ...base,
    validationStatus: "skipped",
    validationError: "PM action execution is planned for Phase 3."
  });
}

function findReassignmentTarget(room, action, assignment) {
  if (action.targetSessionId) {
    return (room?.sessions ?? []).find((member) =>
      member.sessionId === action.targetSessionId &&
      member.sessionStatus === "running" &&
      roomRoleMatches(member, assignment.role)
    ) ?? null;
  }
  const candidates = findRoomMembersWithRole(room, assignment.role).filter((member) => member.sessionId !== assignment.sessionId);
  return candidates.sort((left, right) => String(left.sessionName).localeCompare(String(right.sessionName), undefined, { numeric: true }))[0] ?? null;
}

function findRoomMembersWithRole(room, role) {
  return (room?.sessions ?? []).filter((member) => member.sessionStatus === "running" && roomRoleMatches(member, role));
}

function roomRoleMatches(member, role) {
  const expected = String(role ?? "").toLowerCase();
  return [member.role, member.rolePresetName, member.rolePresetLabel]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase() === expected);
}

function normalizeSupervisorOptions(input = {}) {
  return {
    ...DEFAULT_WORKFLOW_SUPERVISOR_OPTIONS,
    ...Object.fromEntries(
      Object.entries(input).filter(([, value]) => value !== undefined && value !== null)
    )
  };
}

function secondsSince(value, now) {
  const timestamp = Date.parse(value ?? "");
  if (!Number.isFinite(timestamp)) return 0;
  return Math.max(0, Math.floor((now.getTime() - timestamp) / 1000));
}

function resultStatus(text) {
  const match = String(text ?? "").trimStart().match(/^\[(DONE|FAIL|BLOCKED|BUG)\]/i);
  return match?.[1]?.toUpperCase() ?? "UNKNOWN";
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
