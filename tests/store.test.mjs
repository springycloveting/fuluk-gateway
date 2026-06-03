import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionStore } from "../src/store.mjs";

test("SessionStore creates and reads sessions", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-gateway-"));
  const store = new SessionStore(path.join(dir, "test.sqlite"));

  const session = store.create(
    {
      kind: "runtime",
      cwd: dir,
      name: "runtime-test",
      project: "demo",
      commandArgs: ["-l"]
    },
    "/bin/bash",
    []
  );

  assert.equal(session.name, "runtime-test");
  assert.equal(session.tmuxSessionName, "runtime-test");
  assert.equal(store.list().length, 1);
  assert.equal(store.findByIdOrName("runtime-test").id, session.id);

  store.updateStatus(session.id, "stopped");
  assert.equal(store.findByIdOrName(session.id).status, "stopped");
  store.close();
});

test("SessionStore stores base docker exec args", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-gateway-"));
  const store = new SessionStore(path.join(dir, "test.sqlite"));

  const session = store.create(
    {
      kind: "codex",
      cwd: dir,
      name: "codex-app",
      commandArgs: ["--resume"]
    },
    "docker",
    ["exec", "-w", dir, "-it", "worker-codex", "codex"]
  );

  assert.equal(session.tmuxSessionName, "codex-app");
  assert.deepEqual(session.commandArgs, ["exec", "-w", dir, "-it", "worker-codex", "codex", "--resume"]);
  store.close();
});

test("SessionStore lists recently used sessions first", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-gateway-"));
  const store = new SessionStore(path.join(dir, "test.sqlite"));

  const older = store.create({ kind: "runtime", cwd: dir, name: "older" }, "/bin/bash", []);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const newer = store.create({ kind: "runtime", cwd: dir, name: "newer" }, "/bin/bash", []);

  assert.equal(store.list()[0].id, newer.id);

  await new Promise((resolve) => setTimeout(resolve, 5));
  store.touch(older.id);

  assert.equal(store.list()[0].id, older.id);
  store.close();
});

test("SessionStore replaces an existing stopped session", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-gateway-"));
  const store = new SessionStore(path.join(dir, "test.sqlite"));

  const original = store.create(
    {
      kind: "runtime",
      cwd: dir,
      name: "app",
      project: "old"
    },
    "/bin/bash",
    []
  );
  store.saveOutput(original.id, 10, "old output");
  store.updateStatus(original.id, "stopped");

  const replacement = store.replace(
    original.id,
    {
      kind: "codex",
      cwd: path.join(dir, "next"),
      name: "ignored-name",
      project: "new",
      commandArgs: ["--resume"]
    },
    "codex",
    []
  );

  assert.equal(replacement.id, original.id);
  assert.equal(replacement.name, "app");
  assert.equal(replacement.kind, "codex");
  assert.equal(replacement.cwd, path.join(dir, "next"));
  assert.equal(replacement.project, "new");
  assert.deepEqual(replacement.commandArgs, ["--resume"]);
  assert.equal(replacement.status, "running");

  const saved = store.findByIdOrName("app");
  assert.equal(saved.id, original.id);
  assert.equal(saved.kind, "codex");
  assert.equal(saved.status, "running");

  const snapshots = store.db
    .prepare("select * from output_snapshots where session_id = ?")
    .all(original.id);
  assert.equal(snapshots.length, 0);
  store.close();
});

test("SessionStore deletes a session and its output snapshots", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-gateway-"));
  const store = new SessionStore(path.join(dir, "test.sqlite"));

  const session = store.create({ kind: "runtime", cwd: dir, name: "delete-me" }, "/bin/bash", []);
  store.saveOutput(session.id, 10, "output");

  assert.equal(store.delete(session.id), true);
  assert.equal(store.findByIdOrName(session.id), null);
  assert.equal(
    store.db.prepare("select count(*) as count from output_snapshots where session_id = ?").get(session.id).count,
    0
  );
  assert.equal(store.delete(session.id), false);
  store.close();
});

test("SessionStore reads the latest output snapshot", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-gateway-"));
  const store = new SessionStore(path.join(dir, "test.sqlite"));
  const session = store.create({ kind: "runtime", cwd: dir, name: "snapshot-test" }, "/bin/bash", []);

  store.saveOutput(session.id, 10, "old output");
  const latest = store.saveOutput(session.id, 20, "new output");

  assert.deepEqual(store.latestOutputSnapshot(session.id), latest);
  assert.equal(store.latestOutputSnapshot("missing"), null);
  store.close();
});

test("SessionStore can save background output without touching session order", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-gateway-"));
  const store = new SessionStore(path.join(dir, "test.sqlite"));
  const older = store.create({ kind: "runtime", cwd: dir, name: "older-output" }, "/bin/bash", []);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const newer = store.create({ kind: "runtime", cwd: dir, name: "newer-output" }, "/bin/bash", []);

  store.saveOutput(older.id, 80, "background scan", { touch: false });

  assert.equal(store.list()[0].id, newer.id);
  store.close();
});

test("SessionStore creates rooms and assigns sessions with roles", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-gateway-"));
  const store = new SessionStore(path.join(dir, "test.sqlite"));

  const session = store.create({ kind: "runtime", cwd: dir, name: "designer" }, "/bin/bash", []);
  const room = store.createRoom({ name: "launch", project: "site", objective: "ship homepage" });
  const membership = store.assignSessionToRoom(room.id, session.id, "reviewer");

  assert.equal(membership.roomId, room.id);
  assert.equal(membership.sessionId, session.id);
  assert.equal(membership.role, "reviewer");
  assert.equal(store.getRoom("launch").sessions[0].sessionName, "designer");
  assert.equal(store.findByIdOrName("designer").rooms[0].roomName, "launch");

  const updated = store.assignSessionToRoom(room.id, session.id, "implementer");
  assert.equal(updated.role, "implementer");
  assert.equal(store.listRooms()[0].sessions.length, 1);
  store.close();
});

test("SessionStore seeds ECC role presets and stores preset prompts on room sessions", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-gateway-"));
  const store = new SessionStore(path.join(dir, "test.sqlite"));

  const preset = store.getRolePreset("code-reviewer");
  assert.equal(preset.name, "code-reviewer");
  assert.equal(preset.label, "代码审查员");
  assert.equal(preset.sourceUrl, "https://github.com/affaan-m/ECC/blob/main/agents/code-reviewer.md");
  assert.deepEqual(preset.tools, ["Read", "Grep", "Glob", "Bash"]);

  const session = store.create({ kind: "runtime", cwd: dir, name: "reviewer" }, "/bin/bash", []);
  const room = store.createRoom({ name: "review-room" });
  const membership = store.assignSessionToRoom(room.id, session.id, null, { rolePresetId: preset.id });

  assert.equal(membership.role, "代码审查员");
  assert.equal(membership.rolePresetId, preset.id);
  assert.equal(membership.rolePresetName, "code-reviewer");
  assert.equal(membership.rolePresetLabel, "代码审查员");
  assert.match(membership.rolePrompt, /senior code reviewer/i);
  store.close();
});
