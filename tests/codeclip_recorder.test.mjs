import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CodeClipSessionRecorder,
  extractFinalAnswer,
  isRecordableUserMessage,
  latestRecordableUserMessage
} from "../src/codeclip_recorder.mjs";

test("isRecordableUserMessage filters short choice replies", () => {
  for (const value of ["1", "2", "3", "4", "Yes", "No", "Allow", "a", " yes "]) {
    assert.equal(isRecordableUserMessage(value), false);
  }
  assert.equal(isRecordableUserMessage("修复登录问题"), true);
});

test("latestRecordableUserMessage skips choices in newest-first history", () => {
  assert.deepEqual(
    latestRecordableUserMessage([
      { text: "1" },
      { text: "Allow" },
      { text: "实现会话记录" }
    ]),
    { text: "实现会话记录" }
  );
});

test("extractFinalAnswer prefers final_answer payloads", () => {
  const output = [
    "user: 实现会话记录",
    "{\"type\":\"agent\",\"final_answer\":\"已写入记录功能，测试通过\"}",
    "›"
  ].join("\n");

  assert.equal(extractFinalAnswer(output), "已写入记录功能，测试通过");
});

test("extractFinalAnswer ignores opencode status chrome when no reply is present", () => {
  const output = [
    "┃",
    "┃",
    "┃",
    "┃  Build · GLM-5 jcloud Engine",
    "╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀",
    "77.9K (39%)  ctrl+p commands"
  ].join("\n");

  assert.equal(extractFinalAnswer(output), "");
});

test("CodeClipSessionRecorder appends CodeClip session JSONL records", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codeclip-sessions-"));
  const recorder = new CodeClipSessionRecorder({
    sessionsDir: dir,
    now: () => new Date("2026-05-27T14:32:01.000Z")
  });
  const session = {
    id: "session-1",
    name: "web-ai-agent",
    project: "Session_Gateway"
  };
  const store = {
    listInputHistory(sessionId, limit) {
      assert.equal(sessionId, "session-1");
      assert.equal(limit, 50);
      return [{ text: "1" }, { text: "根据格式文档实现会话记录" }];
    }
  };
  const tmux = {
    async capture(record, lines) {
      assert.equal(record.id, "session-1");
      assert.equal(lines, 200);
      return "final_answer: 已追加到 CodeClip JSONL";
    }
  };

  const record = await recorder.recordBeforeInput(session, "继续优化", { store, tmux });
  assert.deepEqual(record, {
    session_id: "session-1",
    project: "Session_Gateway",
    date: "2026-05-27",
    turns: [
      {
        timestamp: "2026-05-27T14:32:01.000Z",
        user_message: "根据格式文档实现会话记录",
        agent_result: "已追加到 CodeClip JSONL"
      }
    ]
  });

  const lines = fs.readFileSync(path.join(dir, "2026-05-27.jsonl"), "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), record);
});
