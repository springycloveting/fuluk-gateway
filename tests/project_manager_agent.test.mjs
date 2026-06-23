import assert from "node:assert/strict";
import test from "node:test";
import { parseManagerDecision, validateManagerDecision } from "../src/project_manager_agent.mjs";

test("parseManagerDecision accepts strict and fenced JSON", () => {
  assert.equal(parseManagerDecision('{"status":"healthy","actions":[]}').status, "healthy");
  assert.equal(parseManagerDecision('```json\n{"status":"watching","actions":[]}\n```').status, "watching");
});

test("validateManagerDecision normalizes valid remind actions", () => {
  const result = validateManagerDecision({
    members: [{ sessionId: "s1" }],
    assignments: [{ id: "a1", sessionId: "s1", status: "pending", resultMessageId: null }]
  }, {
    status: "intervention_required",
    summary: "需要提醒",
    actions: [
      {
        type: "remind",
        assignmentId: "a1",
        reason: "超时",
        message: "请回调"
      }
    ]
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.decision.actions, [{
    type: "remind",
    assignmentId: "a1",
    targetSessionId: "s1",
    targetRole: null,
    reason: "超时",
    message: "请回调"
  }]);
});

test("validateManagerDecision rejects unknown assignments and outside sessions", () => {
  const result = validateManagerDecision({
    members: [{ sessionId: "s1" }],
    assignments: [{ id: "a1", sessionId: "s1", status: "completed", resultMessageId: "m1" }]
  }, {
    status: "bad-status",
    actions: [
      { type: "remind", assignmentId: "missing", message: "请回调" },
      { type: "redirect", assignmentId: "a1", targetSessionId: "outside", message: "改方向" }
    ]
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /Invalid PM status/);
  assert.match(result.errors.join("\n"), /unknown assignment|finished assignment/);
});

test("validateManagerDecision requires targetRole for spawn_agent", () => {
  const result = validateManagerDecision({
    members: [{ sessionId: "s1" }],
    assignments: [{ id: "a1", sessionId: "s1", status: "pending", resultMessageId: null }]
  }, {
    status: "intervention_required",
    actions: [{ type: "spawn_agent", assignmentId: "a1", reason: "缺少执行者" }]
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /spawn_agent requires targetRole/);
});
