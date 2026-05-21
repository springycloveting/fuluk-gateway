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
