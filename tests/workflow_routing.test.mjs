import assert from "node:assert/strict";
import test from "node:test";
import {
  latestChainAssignment,
  pairedSession,
  plannerTasksForSession,
  workflowResultOutcome
} from "../src/workflow_routing.mjs";
import { currentWorkflowAssignments } from "../public/workflow_view.js";

const room = {
  sessions: [
    { sessionId: "t2", sessionName: "tester2", sessionStatus: "running", role: "tester" },
    { sessionId: "c1", sessionName: "coder1", sessionStatus: "running", role: "coder" },
    { sessionId: "t1", sessionName: "tester1", sessionStatus: "running", role: "tester" },
    { sessionId: "c2", sessionName: "coder2", sessionStatus: "running", role: "coder" }
  ]
};

test("coder and tester pairing is stable regardless of room member order", () => {
  assert.equal(pairedSession(room, "c1", "coder", "tester").sessionId, "t1");
  assert.equal(pairedSession(room, "c2", "coder", "tester").sessionId, "t2");
});

test("planner tasks are restricted to the named coder", () => {
  const plan = [
    "#### 任务 T1: API",
    "- **负责人**: coder1",
    "- 说明: API work",
    "#### 任务 T2: LLM",
    "- **负责人**: coder2",
    "- 说明: LLM work"
  ].join("\n");
  assert.match(plannerTasksForSession(plan, "coder1"), /T1: API/);
  assert.doesNotMatch(plannerTasksForSession(plan, "coder1"), /T2: LLM/);
  assert.match(plannerTasksForSession(plan, "coder2"), /T2: LLM/);
});

test("workflow result accepts a formatted DONE tag but not prose without a tag", () => {
  assert.equal(workflowResultOutcome("**[DONE]** passed"), "completed");
  assert.equal(workflowResultOutcome("Tests passed but callback is missing"), "failed");
});

test("chain lookup and UI select the latest attempt without mixing roots", () => {
  const assignments = [
    { id: "c1a1", workItemId: null, gateKind: "development", attemptNo: 1, status: "completed", createdAt: "1" },
    { id: "t1a1", workItemId: "c1a1", gateKind: "testing", attemptNo: 1, status: "failed", createdAt: "2" },
    { id: "c1a2", workItemId: "c1a1", gateKind: "development", attemptNo: 2, status: "completed", createdAt: "3" },
    { id: "t1a2", workItemId: "c1a1", gateKind: "testing", attemptNo: 2, status: "pending", createdAt: "4" },
    { id: "c2a1", workItemId: null, gateKind: "development", attemptNo: 1, status: "completed", createdAt: "1" }
  ];
  const workflow = { runAssignments: assignments };
  assert.equal(latestChainAssignment(workflow, "development", "c1a1").id, "c1a2");
  const visible = currentWorkflowAssignments(assignments);
  assert.ok(visible.some((item) => item.id === "t1a2"));
  assert.ok(!visible.some((item) => item.id === "t1a1"));
  assert.ok(visible.some((item) => item.id === "c2a1"));
});
