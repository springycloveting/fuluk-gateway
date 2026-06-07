export function workflowResultOutcome(text) {
  const firstPart = String(text ?? "").replace(/^\uFEFF/, "").trimStart().slice(0, 200);
  const status = firstPart.match(/^(?:[*_`\s]*)\[(DONE|FAIL|BLOCKED|BUG)\]/i)?.[1]?.toUpperCase();
  return status === "DONE" ? "completed" : status === "BLOCKED" ? "blocked" : "failed";
}

export function pairedSession(room, sourceSessionId, sourceRole, targetRole) {
  const sources = roleMembers(room, sourceRole).sort(bySessionName);
  const targets = roleMembers(room, targetRole).sort(bySessionName);
  const source = sources.find((item) => item.sessionId === sourceSessionId);
  if (!source) return null;
  const suffix = source.sessionName?.match(/(\d+)$/)?.[1];
  const exact = suffix ? targets.find((item) => item.sessionName?.match(/(\d+)$/)?.[1] === suffix) : null;
  return exact || targets[sources.indexOf(source)] || null;
}

export function plannerTasksForSession(plan, sessionName) {
  const text = String(plan ?? "");
  const sections = text.split(/(?=^#{3,5}\s+(?:任务\s+)?T?\d+\b)/gim);
  const owned = sections.filter((section) => {
    const owner = section.match(/(?:负责人|Owner)\s*[*：:]*\s*[*`]*([^\n*`]+)/i)?.[1]?.trim();
    return owner && owner.toLowerCase() === String(sessionName).toLowerCase();
  });
  return owned.length ? owned.join("\n\n---\n\n").trim() : text;
}

export function assignmentChainRoot(assignment) {
  return assignment.workItemId || assignment.id;
}

export function latestChainAssignment(workflow, gateKind, chainRoot) {
  return workflow.runAssignments
    .filter((item) => item.gateKind === gateKind && assignmentChainRoot(item) === chainRoot)
    .sort((a, b) => b.attemptNo - a.attemptNo || String(b.createdAt).localeCompare(String(a.createdAt)))[0] || null;
}

function roleMembers(room, role) {
  const expected = role.toLowerCase();
  return (room?.sessions ?? []).filter((item) =>
    item.sessionStatus === "running" &&
    [item.role, item.rolePresetName, item.rolePresetLabel]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase() === expected)
  );
}

function bySessionName(left, right) {
  return String(left.sessionName).localeCompare(String(right.sessionName), undefined, { numeric: true });
}
