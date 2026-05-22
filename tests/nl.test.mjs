import assert from "node:assert/strict";
import test from "node:test";
import { parseNaturalCommand } from "../src/nl.mjs";

test("parses create commands", () => {
  assert.deepEqual(parseNaturalCommand("新建一个 codex 会话 codex-app，目录 /workspace/app。"), {
    type: "create",
    input: {
      kind: "codex",
      cwd: "/workspace/app",
      name: "codex-app",
      project: null
    }
  });
});

test("parses compact create commands without spaces", () => {
  assert.deepEqual(parseNaturalCommand("新建一个opencode会话test,目录/workspace/test"), {
    type: "create",
    input: {
      kind: "opencode",
      cwd: "/workspace/test",
      name: "test",
      project: null
    }
  });
});

test("parses loose Chinese create commands with folder-derived names", () => {
  assert.deepEqual(parseNaturalCommand("建一个opencode会话，用/workspace/OPCAid文件夹，会话名称用opencode+文件夹名称"), {
    type: "create",
    input: {
      kind: "opencode",
      cwd: "/workspace/OPCAid",
      name: "opencode-OPCAid",
      project: null
    }
  });
});

test("parses explicit create deployment mode", () => {
  assert.deepEqual(parseNaturalCommand("新建一个claude会话，在docker里运行，用/work/OPCAid文件夹"), {
    type: "create",
    input: {
      kind: "claude",
      cwd: "/work/OPCAid",
      name: undefined,
      project: null,
      deployment: { mode: "docker" }
    }
  });
  assert.deepEqual(parseNaturalCommand("新建一个codex会话，在宿主机运行，用/workspace/app文件夹"), {
    type: "create",
    input: {
      kind: "codex",
      cwd: "/workspace/app",
      name: undefined,
      project: null,
      deployment: { mode: "host" }
    }
  });
});

test("parses send commands", () => {
  assert.deepEqual(parseNaturalCommand("把这句话发给 claude-main：查看。"), {
    type: "send",
    target: "claude-main",
    text: "查看"
  });
});

test("parses current-session send commands", () => {
  assert.deepEqual(parseNaturalCommand("发送 查看当前项目结构"), {
    type: "send",
    target: null,
    text: "查看当前项目结构",
    needsCurrentSession: true
  });
});

test("parses output commands with accidental punctuation", () => {
  assert.deepEqual(parseNaturalCommand("codex-1 最近输。出"), {
    type: "output",
    target: "codex-1",
    lines: 120
  });
});

test("parses output commands with line counts", () => {
  assert.deepEqual(parseNaturalCommand("codex-1 最近 200 行输出"), {
    type: "output",
    target: "codex-1",
    lines: 200
  });
});

test("parses running list commands", () => {
  assert.deepEqual(parseNaturalCommand("列出所有运行中的会话。"), {
    type: "list",
    runningOnly: true
  });
});

test("parses stop commands", () => {
  assert.deepEqual(parseNaturalCommand("停止 opencode-test。"), {
    type: "stop",
    target: "opencode-test"
  });
});

test("parses English command aliases", () => {
  assert.deepEqual(parseNaturalCommand("help"), { type: "help" });
  assert.deepEqual(parseNaturalCommand("list running sessions"), { type: "list", runningOnly: true });
  assert.deepEqual(parseNaturalCommand("create codex session app in /workspace/app"), {
    type: "create",
    input: {
      kind: "codex",
      cwd: "/workspace/app",
      name: "app",
      project: null
    }
  });
  assert.deepEqual(parseNaturalCommand("send npm test to codex-app"), {
    type: "send",
    target: "codex-app",
    text: "npm test"
  });
  assert.deepEqual(parseNaturalCommand("output codex-app 200"), {
    type: "output",
    target: "codex-app",
    lines: 200
  });
  assert.deepEqual(parseNaturalCommand("use codex-app"), {
    type: "switch",
    target: "codex-app"
  });
  assert.deepEqual(parseNaturalCommand("restart codex-app"), {
    type: "restart",
    target: "codex-app"
  });
});
