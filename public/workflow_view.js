export function currentWorkflowAssignments(assignments) {
  const latest = new Map();
  for (const assignment of assignments ?? []) {
    const root = assignment.workItemId || assignment.id;
    const key = `${assignment.gateKind}:${root}`;
    const previous = latest.get(key);
    if (!previous || assignment.attemptNo > previous.attemptNo ||
        (assignment.attemptNo === previous.attemptNo && String(assignment.createdAt) > String(previous.createdAt))) {
      latest.set(key, assignment);
    }
  }
  return [...latest.values()];
}
