import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { dispatchPendingWorkflowAssignments, reconcileWorkflowResults } from "../src/server.mjs";
import { SessionStore } from "../src/store.mjs";
import { createWorkflowSupervisor, detectWorkflowIssues } from "../src/workflow_supervisor.mjs";

test("detectWorkflowIssues marks pending dispatched assignments as stalled", () => {
  const issues = detectWorkflowIssues(
    {
      assignments: [
        {
          id: "assignment-1",
          sessionId: "session-1",
          status: "pending",
          dispatchedMessageId: "message-1",
          resultMessageId: null,
          ageSeconds: 901
        },
        {
          id: "assignment-2",
          sessionId: "session-2",
          status: "completed",
          dispatchedMessageId: "message-2",
          resultMessageId: "result-2",
          ageSeconds: 10000
        }
      ]
    },
    { stallMs: 900_000, hardTimeoutMs: 3_600_000 }
  );

  assert.deepEqual(issues.map((issue) => [issue.type, issue.assignmentId]), [["stalled_assignment", "assignment-1"]]);
});

test("workflow supervisor dispatches pending assignments and records one stalled reminder", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-gateway-supervisor-"));
  const store = new SessionStore(path.join(dir, "test.sqlite"));
  const planner = store.create({ kind: "runtime", cwd: dir, name: "planner" }, "/bin/bash", []);
  const room = store.createRoom({ name: "supervised-room" });
  store.assignSessionToRoom(room.id, planner.id, "planner");
  const workflow = store.startWorkflowRun(
    store.createWorkflowRun({ roomId: room.id, objective: "Ship supervised flow" }).id,
    { eventKey: "supervised:start" }
  );
  const sent = [];
  const context = {
    config: { submitKeyDelayMs: 0 },
    store,
    tmux: {
      async send(session, text) {
        sent.push({ sessionId: session.id, text });
      }
    }
  };
  const supervisor = createWorkflowSupervisor(
    context,
    { reconcileWorkflowResults, dispatchPendingWorkflowAssignments },
    {
      enabled: false,
      ownerId: "test-supervisor",
      stallMs: 0,
      hardTimeoutMs: 3_600_000,
      sameActionCooldownMs: 600_000
    }
  );

  const first = await supervisor.tickWorkflow(workflow.id);
  assert.equal(first.detectedIssues.length, 1);
  assert.equal(first.interventions.length, 1);
  assert.equal(sent.length, 2);
  assert.match(sent[0].text, /工作流目标：\nShip supervised flow/);
  assert.match(sent[1].text, /未收到回传结果/);

  const current = store.getWorkflowRun(workflow.id);
  assert.equal(current.runAssignments[0].interventionCount, 1);
  assert.equal(store.listWorkflowObservations(workflow.id).length, 1);
  assert.equal(store.listWorkflowInterventions(workflow.id).length, 1);

  const second = await supervisor.tickWorkflow(workflow.id);
  assert.equal(second.detectedIssues.length, 1);
  assert.equal(second.interventions.length, 0);
  assert.equal(sent.length, 2);
  store.close();
});

test("workflow supervisor applies PM redirect and skips duplicate deterministic remind", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-gateway-supervisor-pm-"));
  const store = new SessionStore(path.join(dir, "test.sqlite"));
  const planner = store.create({ kind: "runtime", cwd: dir, name: "planner" }, "/bin/bash", []);
  const room = store.createRoom({ name: "pm-room" });
  store.assignSessionToRoom(room.id, planner.id, "planner");
  const workflow = store.startWorkflowRun(
    store.createWorkflowRun({ roomId: room.id, objective: "Ship PM supervision" }).id,
    { eventKey: "pm:start" }
  );
  const sent = [];
  const context = {
    config: { submitKeyDelayMs: 0 },
    store,
    tmux: {
      async send(session, text) {
        sent.push({ sessionId: session.id, text });
      }
    }
  };
  const supervisor = createWorkflowSupervisor(
    context,
    {
      reconcileWorkflowResults,
      dispatchPendingWorkflowAssignments,
      async dispatchRoomMessage(roomId, body, ctx) {
        return dispatchPendingRoomMessage(roomId, body, ctx);
      },
      projectManagerAgent: {
        async decide(snapshot) {
          const assignment = snapshot.assignments[0];
          return {
            ok: true,
            errors: [],
            decision: {
              status: "intervention_required",
              summary: "方向需要纠偏",
              actions: [{
                type: "redirect",
                assignmentId: assignment.id,
                targetSessionId: assignment.sessionId,
                reason: "卡住",
                message: "请先回传当前阻塞点，不要继续扩展范围。"
              }]
            }
          };
        }
      }
    },
    {
      enabled: false,
      pmAgentEnabled: true,
      ownerId: "pm-test-supervisor",
      stallMs: 0,
      hardTimeoutMs: 3_600_000,
      sameActionCooldownMs: 600_000
    }
  );

  const result = await supervisor.tickWorkflow(workflow.id);

  assert.equal(result.managerDecision.ok, true);
  assert.equal(result.interventions.length, 1);
  assert.equal(result.interventions[0].source, "pm_agent");
  assert.equal(result.interventions[0].actionType, "redirect");
  assert.equal(sent.length, 2);
  assert.match(sent[0].text, /Ship PM supervision/);
  assert.match(sent[1].text, /PM纠偏/);
  assert.match(sent[1].text, /当前阻塞点/);
  assert.equal(store.getWorkflowRun(workflow.id).runAssignments[0].interventionCount, 0);
  store.close();
});

test("workflow supervisor applies PM retry by superseding the old assignment", async () => {
  const { store, workflow, sent, context } = createSupervisorFixture("retry-room", ["planner"]);
  const supervisor = createWorkflowSupervisor(
    context,
    {
      reconcileWorkflowResults,
      dispatchPendingWorkflowAssignments,
      projectManagerAgent: {
        async decide(snapshot) {
          return pmDecision({
            type: "retry",
            assignmentId: snapshot.assignments[0].id,
            reason: "重新尝试"
          });
        }
      }
    },
    { enabled: false, pmAgentEnabled: true, ownerId: "retry-supervisor", stallMs: 0, hardTimeoutMs: 3_600_000 }
  );

  const result = await supervisor.tickWorkflow(workflow.id);
  const assignments = store.getWorkflowRun(workflow.id).runAssignments;

  assert.equal(result.interventions[0].actionType, "retry");
  assert.equal(assignments.length, 2);
  assert.equal(assignments[0].status, "failed");
  assert.equal(assignments[1].status, "pending");
  assert.equal(assignments[1].attemptNo, 2);
  assert.ok(assignments[1].dispatchedMessageId);
  assert.equal(sent.length, 2);
  store.close();
});

test("workflow supervisor applies PM reassign to another same-role session", async () => {
  const { store, workflow, sent, context, sessions } = createSupervisorFixture("reassign-room", ["planner", "planner"]);
  const supervisor = createWorkflowSupervisor(
    context,
    {
      reconcileWorkflowResults,
      dispatchPendingWorkflowAssignments,
      projectManagerAgent: {
        async decide(snapshot) {
          const target = sessions.find((session) => session.id !== snapshot.assignments[0].sessionId);
          return pmDecision({
            type: "reassign",
            assignmentId: snapshot.assignments[0].id,
            targetSessionId: target.id,
            reason: "改派"
          });
        }
      }
    },
    { enabled: false, pmAgentEnabled: true, ownerId: "reassign-supervisor", stallMs: 0, hardTimeoutMs: 3_600_000 }
  );

  await supervisor.tickWorkflow(workflow.id);
  const assignments = store.getWorkflowRun(workflow.id).runAssignments;

  assert.equal(assignments[0].status, "blocked");
  assert.notEqual(assignments[1].sessionId, assignments[0].sessionId);
  assert.equal(assignments[1].attemptNo, 2);
  assert.ok(assignments[1].dispatchedMessageId);
  assert.equal(sent.length, 2);
  store.close();
});

test("workflow supervisor applies PM replan and escalation messages", async () => {
  const { store, workflow, sent, context } = createSupervisorFixture("replan-room", ["planner"]);
  let mode = "request_replan";
  const supervisor = createWorkflowSupervisor(
    context,
    {
      reconcileWorkflowResults,
      dispatchPendingWorkflowAssignments,
      dispatchRoomMessage: dispatchPendingRoomMessage,
      projectManagerAgent: {
        async decide(snapshot) {
          const action = mode === "request_replan"
            ? { type: "request_replan", reason: "需要重规划", message: "请更新剩余计划。" }
            : { type: "escalate", assignmentId: snapshot.assignments[0].id, reason: "自动处理预算耗尽。" };
          return pmDecision(action);
        }
      }
    },
    {
      enabled: false,
      pmAgentEnabled: true,
      ownerId: "replan-supervisor",
      stallMs: 0,
      hardTimeoutMs: 3_600_000,
      sameActionCooldownMs: 0
    }
  );

  let result = await supervisor.tickWorkflow(workflow.id);
  assert.equal(result.interventions[0].actionType, "request_replan");
  assert.match(sent.at(-1).text, /PM重规划请求/);

  mode = "escalate";
  result = await supervisor.tickWorkflow(workflow.id);
  assert.equal(result.interventions[0].actionType, "escalate");
  assert.equal(store.getWorkflowRun(workflow.id).status, "needs_human");
  assert.match(store.listRoomMessages(context.store.getRoom("replan-room").id).at(-1).text, /\[BLOCKED\] PM 监督已暂停自动推进/);
  store.close();
});

test("workflow supervisor applies PM spawn_agent and assigns work to the spawned session", async () => {
  const { store, workflow, sent, context } = createSupervisorFixture("spawn-room", ["planner"]);
  const supervisor = createWorkflowSupervisor(
    context,
    {
      reconcileWorkflowResults,
      dispatchPendingWorkflowAssignments,
      async spawnWorkflowAgent(input, ctx) {
        const session = ctx.store.create({
          kind: "codex",
          cwd: "/workspace/spawned",
          name: `spawned-${input.role}`
        }, "codex", []);
        const membership = ctx.store.assignSessionToRoom(input.roomId, session.id, input.role);
        return { session: ctx.store.findByIdOrName(session.id), membership };
      },
      projectManagerAgent: {
        async decide(snapshot) {
          return pmDecision({
            type: "spawn_agent",
            assignmentId: snapshot.assignments[0].id,
            targetRole: "planner",
            reason: "需要新 planner 接手"
          });
        }
      }
    },
    { enabled: false, pmAgentEnabled: true, ownerId: "spawn-supervisor", stallMs: 0, hardTimeoutMs: 3_600_000 }
  );

  const result = await supervisor.tickWorkflow(workflow.id);
  const assignments = store.getWorkflowRun(workflow.id).runAssignments;
  const spawned = store.findByIdOrName("spawned-planner");

  assert.equal(result.interventions[0].actionType, "spawn_agent");
  assert.equal(result.interventions[0].validationStatus, "executed");
  assert.ok(spawned);
  assert.equal(store.getRoom("spawn-room").sessions.some((member) => member.sessionId === spawned.id && member.role === "planner"), true);
  assert.equal(assignments[0].status, "blocked");
  assert.equal(assignments[1].sessionId, spawned.id);
  assert.equal(assignments[1].attemptNo, 2);
  assert.ok(assignments[1].dispatchedMessageId);
  assert.equal(sent.length, 2);
  store.close();
});

test("workflow supervisor rejects PM spawn_agent when spawn budget is exhausted", async () => {
  const { store, workflow, sent, context } = createSupervisorFixture("spawn-budget-room", ["planner"]);
  const supervisor = createWorkflowSupervisor(
    context,
    {
      reconcileWorkflowResults,
      dispatchPendingWorkflowAssignments,
      async spawnWorkflowAgent() {
        throw new Error("should not spawn");
      },
      projectManagerAgent: {
        async decide(snapshot) {
          return pmDecision({
            type: "spawn_agent",
            assignmentId: snapshot.assignments[0].id,
            targetRole: "planner",
            reason: "预算耗尽"
          });
        }
      }
    },
    {
      enabled: false,
      pmAgentEnabled: true,
      ownerId: "spawn-budget-supervisor",
      stallMs: 0,
      hardTimeoutMs: 3_600_000,
      maxSpawnedAgentsPerRoom: 0
    }
  );

  const result = await supervisor.tickWorkflow(workflow.id);
  const spawn = result.interventions.find((item) => item.actionType === "spawn_agent");
  const remind = result.interventions.find((item) => item.actionType === "remind");

  assert.equal(spawn.validationStatus, "rejected");
  assert.equal(remind.validationStatus, "executed");
  assert.equal(store.getWorkflowRun(workflow.id).runAssignments.length, 1);
  assert.equal(sent.length, 2);
  store.close();
});

function createSupervisorFixture(roomName, roles) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `session-gateway-${roomName}-`));
  const store = new SessionStore(path.join(dir, "test.sqlite"));
  const sessions = roles.map((role, index) => store.create({
    kind: "runtime",
    cwd: dir,
    name: `${role}${index + 1}`
  }, "/bin/bash", []));
  const room = store.createRoom({ name: roomName });
  for (const [index, session] of sessions.entries()) store.assignSessionToRoom(room.id, session.id, roles[index]);
  const workflow = store.startWorkflowRun(
    store.createWorkflowRun({ roomId: room.id, objective: `Ship ${roomName}` }).id,
    { eventKey: `${roomName}:start` }
  );
  const sent = [];
  const context = {
    config: { submitKeyDelayMs: 0 },
    store,
    tmux: {
      async send(session, text) {
        sent.push({ sessionId: session.id, text });
      }
    }
  };
  return { dir, store, room, workflow, sessions, sent, context };
}

function pmDecision(action) {
  return {
    ok: true,
    errors: [],
    decision: {
      status: "intervention_required",
      summary: action.reason || "PM action",
      actions: [action]
    }
  };
}

async function dispatchPendingRoomMessage(roomId, body, context) {
  const room = context.store.getRoom(roomId);
  const message = context.store.createRoomMessage({
    roomId,
    text: body.text,
    targetMode: body.target.mode,
    targetSessionIds: body.target.sessionIds ?? [],
    metadata: body.metadata
  });
  if (body.target.mode === "room") return { room, message: context.store.getRoomMessage(message.id) };
  for (const sessionId of body.target.sessionIds) {
    const delivery = context.store.addRoomMessageDelivery(message.id, sessionId);
    await context.tmux.send(context.store.findByIdOrName(sessionId), body.text);
    context.store.updateRoomMessageDelivery(delivery.id, "sent");
  }
  return { room, message: context.store.getRoomMessage(message.id) };
}
