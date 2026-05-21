import assert from "node:assert/strict";
import test from "node:test";
import { commandManual, parseWithLocalModel, validateAiCommand } from "../src/ai_parser.mjs";

test("parseWithLocalModel accepts OpenAI-compatible JSON commands", async () => {
  const command = await parseWithLocalModel(
    "send npm test",
    {
      commandParser: {
        enabled: true,
        baseUrl: "http://127.0.0.1:1234",
        model: "local-model",
        apiKey: "secret"
      }
    },
    async (url, options) => {
      assert.equal(url, "http://127.0.0.1:1234/v1/chat/completions");
      assert.equal(options.headers.authorization, "Bearer secret");
      const body = JSON.parse(options.body);
      assert.equal(body.model, "local-model");
      assert.match(body.messages[0].content, /Operation manual/);
      assert.match(body.messages[0].content, /opencode-OPCAid/);
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '{"type":"send","text":"npm test"}' } }]
        })
      };
    }
  );

  assert.deepEqual(command, {
    type: "send",
    target: null,
    text: "npm test",
    needsCurrentSession: true
  });
});

test("commandManual documents fixed actions and output format", () => {
  const manual = commandManual();
  assert.match(manual, /Allowed type values: create, list, send, output, switch, stop, restart, help/);
  assert.match(manual, /\{"type":"create"/);
  assert.match(manual, /Return JSON only/);
});

test("validateAiCommand rejects unknown actions", () => {
  assert.throws(() => validateAiCommand({ type: "shell", command: "rm -rf /" }), /not allowed/);
});

test("validateAiCommand rejects invalid create kinds", () => {
  assert.throws(
    () => validateAiCommand({ type: "create", input: { kind: "bash", cwd: "/workspace/app" } }),
    /kind is not allowed/
  );
});

test("validateAiCommand normalizes safe output commands", () => {
  assert.deepEqual(validateAiCommand({ type: "output", target: "codex-app", lines: 5000 }), {
    type: "output",
    target: "codex-app",
    lines: 2000
  });
});

test("validateAiCommand sanitizes AI-created session names", () => {
  assert.deepEqual(
    validateAiCommand({
      type: "create",
      input: { kind: "opencode", cwd: "/workspace/OPCAid", name: "opencode+OPCAid" }
    }),
    {
      type: "create",
      input: {
        kind: "opencode",
        cwd: "/workspace/OPCAid",
        name: "opencode-OPCAid",
        project: null
      }
    }
  );
});
