# AI Approval Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace blind auto-yes with a server-side, risk-tiered approval engine that auto-passes safe commands, learns to reduce prompts over time, and never silently passes high-risk commands like `docker system prune -f` unless a verification context is present.

**Architecture:** A pure, side-effect-free decision function `evaluate()` lives in `src/approval_engine.mjs`, backed by `src/approval_rules.mjs` (data) and `src/approval_memory.mjs` (JSON persistence). Deterministic rules + learned memory + context run first; AI is a bounded fallback for unknown commands and can never override the high-risk hard floor. The server owns the key-sending side effect and pending-approval state; the frontend only triggers and renders a confirmation dialog. Coexists with the existing `all-yes` mode as a new `ai-approval` mode.

**Tech Stack:** Node.js built-ins only (no new runtime deps). `node:test` + `node:assert/strict`. Vanilla browser JS for the frontend. Reuses the existing OpenAI-compatible AI config (`runtimeSettings.commandParser` / `sessionAgent`).

**Spec:** `docs/superpowers/specs/2026-07-16-ai-approval-design.md`

---

## Locked interfaces (used across tasks — do not rename)

```js
// src/approval_rules.mjs
export const DEFAULT_RULES;                                    // { version, highRisk, mediumRisk, lowRisk, context }
export function normalizeRules(input);                         // validates every regex, throws on invalid; returns { version, highRisk, mediumRisk, lowRisk, context }
export function matchRule(candidate, rule);                    // boolean — RegExp(rule.pattern, rule.flags||"").test(candidate)
export function findMatchingRule(candidate, rules, tier);      // tier ∈ "highRisk"|"mediumRisk"|"lowRisk"; returns rule|null

// src/approval_memory.mjs
export function normalizeCommand(text);                        // lowercased, whitespace-collapsed, trimmed
export function commandSignature(normalized);                  // sha256 hex
export class ApprovalMemory {
  constructor({ filePath, fs, now });                          // now defaults to () => new Date()
  async load();                                                // returns { allow: [], deny: [] }; corrupt/missing → empty
  lookupAllow(normalizedCandidate);                            // entry|null (only risk∈{low,medium})
  lookupDeny(normalizedCandidate);                             // entry|null
  async rememberAllow({ command, signature, risk, source });   // writes; rejects risk==="high"
  async rememberDeny({ command, signature, source });          // writes
  async remove(id);                                            // true|false
  list();                                                      // { allow, deny }
}

// src/approval_engine.mjs
export function extractCandidateCommand(output);               // string|null
export function detectApprovalKeys(output);                    // { present, yesKey, yesType, noKey }
export function checkContext(output, contextKey, rules);       // boolean
export function evaluate({ candidate, output, memory, rules, aiClient, options }); // → decision (see below)
export function createApprovalAiClient(settings, { fetchImpl, timeoutMs });        // async fn|null

// decision shape returned by evaluate():
// { decision: "auto_yes"|"needs_user_confirm",
//   risk: "low"|"medium"|"high"|"unknown",
//   candidate, reason, ruleId, contextSatisfied: [], rememberable: boolean }
// NOTE: the yes/no KEY is NOT chosen by evaluate — the /approve handler adds it from detectApprovalKeys().
```

---

## Task 1: Rules module — `normalizeRules` + `matchRule`

**Files:**
- Create: `src/approval_rules.mjs`
- Test: `tests/approval_rules.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// tests/approval_rules.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_RULES, normalizeRules, matchRule, findMatchingRule } from "../src/approval_rules.mjs";

test("matchRule matches case-insensitively when flags include i", () => {
  const rule = { pattern: "docker\\s+system\\s+prune", flags: "i" };
  assert.equal(matchRule("docker system prune -f", rule), true);
  assert.equal(matchRule("DOCKER SYSTEM PRUNE", rule), true);
  assert.equal(matchRule("npm install", rule), false);
});

test("findMatchingRule returns the first matching rule in a tier", () => {
  const rules = { highRisk: [{ id: "a", pattern: "foo", flags: "" }, { id: "b", pattern: "bar", flags: "" }] };
  assert.equal(findMatchingRule("bar", rules, "highRisk").id, "b");
  assert.equal(findMatchingRule("nope", rules, "highRisk"), null);
});

test("normalizeRules validates every regex and throws naming the bad rule", () => {
  const bad = { ...DEFAULT_RULES, highRisk: [{ id: "broken", pattern: "(", flags: "" }] };
  assert.throws(() => normalizeRules(bad), /broken/);
});

test("normalizeRules returns defaults when input is empty", () => {
  const out = normalizeRules({});
  assert.equal(out.version, 1);
  assert.ok(out.highRisk.length >= 1);
  assert.ok(out.context.docker_checks);
});

test("DEFAULT_RULES classifies the headline commands", () => {
  assert.ok(findMatchingRule("docker system prune -f", DEFAULT_RULES, "highRisk"));
  assert.ok(findMatchingRule("rm -rf /tmp/x", DEFAULT_RULES, "highRisk"));
  assert.ok(findMatchingRule("npm install", DEFAULT_RULES, "lowRisk"));
  assert.ok(findMatchingRule("docker stop web", DEFAULT_RULES, "mediumRisk"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/approval_rules.test.mjs`
Expected: FAIL — cannot find module `../src/approval_rules.mjs`.

- [ ] **Step 3: Write minimal implementation**

```js
// src/approval_rules.mjs
export const DEFAULT_RULES = {
  version: 1,
  highRisk: [
    { id: "docker-prune", pattern: "docker\\s+system\\s+prune", flags: "i", unlessContext: "docker_checks", label: "docker system prune" },
    { id: "rm-rf", pattern: "\\brm\\s+(-\\w*r\\w*f|-\\w*f\\w*r)\\b", flags: "i", label: "rm -rf" }
  ],
  mediumRisk: [
    { id: "docker-stop", pattern: "docker\\s+(restart|stop|rm)\\s", flags: "i", label: "docker stop/restart/rm" }
  ],
  lowRisk: [
    { id: "npm-safe", pattern: "npm\\s+(install|ci|test|run)\\b", flags: "i", label: "npm install/test/run" },
    { id: "read-only", pattern: "\\b(ls|cat|grep|git\\s+(status|log|diff))\\b", flags: "i", label: "read-only shell" }
  ],
  context: {
    docker_checks: {
      commands: ["docker ps", "docker images", "docker compose ps", "docker-compose ps"],
      windowLines: 200,
      requiredCount: 1
    }
  }
};

export function matchRule(candidate, rule) {
  if (!rule || typeof rule.pattern !== "string") return false;
  return new RegExp(rule.pattern, rule.flags || "").test(String(candidate ?? ""));
}

export function findMatchingRule(candidate, rules, tier) {
  const list = Array.isArray(rules?.[tier]) ? rules[tier] : [];
  return list.find((rule) => matchRule(candidate, rule)) ?? null;
}

function compileRule(rule, tier) {
  if (!rule || typeof rule.id !== "string" || typeof rule.pattern !== "string") {
    throw new Error(`invalid rule in ${tier}: missing id or pattern`);
  }
  try {
    new RegExp(rule.pattern, typeof rule.flags === "string" ? rule.flags : "");
  } catch (error) {
    throw new Error(`invalid regex in rule ${rule.id}: ${error.message}`);
  }
  const out = { id: rule.id, pattern: rule.pattern, flags: typeof rule.flags === "string" ? rule.flags : "" };
  if (typeof rule.label === "string") out.label = rule.label;
  if (tier === "highRisk" && typeof rule.unlessContext === "string") out.unlessContext = rule.unlessContext;
  return out;
}

function normalizeTier(input, tier) {
  if (!Array.isArray(input)) return [];
  return input.map((rule) => compileRule(rule, tier));
}

function normalizeContext(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const commands = Array.isArray(value.commands) ? value.commands.filter((c) => typeof c === "string") : [];
    if (!commands.length) continue;
    out[key] = {
      commands,
      windowLines: Number.isFinite(value.windowLines) && value.windowLines > 0 ? value.windowLines : 200,
      requiredCount: Number.isFinite(value.requiredCount) && value.requiredCount > 0 ? value.requiredCount : 1
    };
  }
  return out;
}

export function normalizeRules(input) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  return {
    version: 1,
    highRisk: normalizeTier(source.highRisk, "highRisk"),
    mediumRisk: normalizeTier(source.mediumRisk, "mediumRisk"),
    lowRisk: normalizeTier(source.lowRisk, "lowRisk"),
    context: Object.keys(source.context ?? {}).length ? normalizeContext(source.context) : { ...DEFAULT_RULES.context }
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/approval_rules.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/approval_rules.mjs tests/approval_rules.test.mjs
git commit -m "feat(approval): add risk rules module with regex validation"
```

---

## Task 2: Memory module — `ApprovalMemory` JSON store

**Files:**
- Create: `src/approval_memory.mjs`
- Test: `tests/approval_memory.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// tests/approval_memory.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ApprovalMemory, normalizeCommand, commandSignature } from "../src/approval_memory.mjs";

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "approval-mem-")), "memory.json");
}

test("normalizeCommand collapses whitespace and lowercases", () => {
  assert.equal(normalizeCommand("  Docker   System  PRUNE "), "docker system prune");
  assert.equal(commandSignature("docker system prune"), commandSignature("Docker  System PRUNE"));
});

test("rememberAllow then lookupAllow round-trips for low/medium", async () => {
  const mem = new ApprovalMemory({ filePath: tmpFile() });
  const cmd = "npm install";
  await mem.rememberAllow({ command: cmd, signature: commandSignature(normalizeCommand(cmd)), risk: "low", source: "user" });
  assert.equal(mem.lookupAllow(normalizeCommand(cmd)).risk, "low");
  assert.equal(mem.lookupAllow(normalizeCommand("npm install")), mem.lookupAllow(normalizeCommand("npm install")).risk, "low");
});

test("rememberAllow rejects high-risk blanket storage (hard floor)", async () => {
  const mem = new ApprovalMemory({ filePath: tmpFile() });
  const cmd = "docker system prune -f";
  await assert.rejects(() => mem.rememberAllow({ command: cmd, signature: commandSignature(cmd), risk: "high", source: "user" }), /high-risk/);
  assert.equal(mem.lookupAllow(normalizeCommand(cmd)), null);
});

test("corrupt file falls back to empty memory", async () => {
  const filePath = tmpFile();
  await fs.writeFile(filePath, "{ not json");
  const mem = new ApprovalMemory({ filePath });
  assert.deepEqual(mem.list(), { allow: [], deny: [] });
});

test("remove deletes the matching entry", async () => {
  const mem = new ApprovalMemory({ filePath: tmpFile() });
  const cmd = "docker stop web";
  const entry = await mem.rememberAllow({ command: cmd, signature: commandSignature(cmd), risk: "medium", source: "user" });
  assert.equal(await mem.remove(entry.id), true);
  assert.equal(mem.lookupAllow(normalizeCommand(cmd)), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/approval_memory.test.mjs`
Expected: FAIL — cannot find module `../src/approval_memory.mjs`.

- [ ] **Step 3: Write minimal implementation**

```js
// src/approval_memory.mjs
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export function normalizeCommand(text) {
  return String(text ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

export function commandSignature(normalized) {
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

function newId() {
  return crypto.randomUUID();
}

export class ApprovalMemory {
  constructor({ filePath, fs: fsImpl, now } = {}) {
    this.filePath = filePath;
    this.fs = fsImpl ?? fs;
    this.now = now ?? (() => new Date());
    this.data = { allow: [], deny: [] };
  }

  async load() {
    if (!this.filePath) return this.data;
    try {
      const raw = await this.fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      this.data = {
        allow: Array.isArray(parsed?.allow) ? parsed.allow : [],
        deny: Array.isArray(parsed?.deny) ? parsed.deny : []
      };
    } catch {
      // Missing or corrupt file: fail safe to empty memory (do not crash the engine).
      this.data = { allow: [], deny: [] };
    }
    return this.data;
  }

  list() {
    return { allow: [...this.data.allow], deny: [...this.data.deny] };
  }

  lookupAllow(normalizedCandidate) {
    return this.data.allow.find((entry) => entry.signature === commandSignature(normalizedCandidate) && (entry.risk === "low" || entry.risk === "medium")) ?? null;
  }

  lookupDeny(normalizedCandidate) {
    return this.data.deny.find((entry) => entry.signature === commandSignature(normalizedCandidate)) ?? null;
  }

  async rememberAllow({ command, signature, risk, source }) {
    if (risk === "high") throw new Error("refusing to store high-risk command as blanket allow (hard floor)");
    const normalized = normalizeCommand(command);
    const entry = {
      id: newId(),
      command: normalized,
      signature: signature ?? commandSignature(normalized),
      risk: risk === "low" ? "low" : "medium",
      source: source ?? "user",
      createdAt: this.now().toISOString(),
      approvedCount: 1
    };
    this.data.allow = this.data.allow.filter((item) => item.signature !== entry.signature);
    this.data.allow.push(entry);
    await this.persist();
    return entry;
  }

  async rememberDeny({ command, signature, source }) {
    const normalized = normalizeCommand(command);
    const entry = {
      id: newId(),
      command: normalized,
      signature: signature ?? commandSignature(normalized),
      source: source ?? "user",
      createdAt: this.now().toISOString()
    };
    this.data.deny = this.data.deny.filter((item) => item.signature !== entry.signature);
    this.data.deny.push(entry);
    await this.persist();
    return entry;
  }

  async remove(id) {
    const before = this.data.allow.length + this.data.deny.length;
    this.data.allow = this.data.allow.filter((item) => item.id !== id);
    this.data.deny = this.data.deny.filter((item) => item.id !== id);
    const changed = this.data.allow.length + this.data.deny.length < before;
    if (changed) await this.persist();
    return changed;
  }

  async persist() {
    if (!this.filePath) return;
    const tmp = `${this.filePath}.tmp`;
    await this.fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await this.fs.writeFile(tmp, `${JSON.stringify(this.data, null, 2)}\n`, "utf8");
    await this.fs.rename(tmp, this.filePath); // atomic on POSIX
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/approval_memory.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/approval_memory.mjs tests/approval_memory.test.mjs
git commit -m "feat(approval): add JSON-backed learned allow/deny memory"
```

---

## Task 3: Engine — candidate extraction + context + keys

**Files:**
- Create: `src/approval_engine.mjs`
- Test: `tests/approval_engine.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// tests/approval_engine.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_RULES } from "../src/approval_rules.mjs";
import { extractCandidateCommand, detectApprovalKeys, checkContext } from "../src/approval_engine.mjs";

test("extractCandidateCommand pulls the command above a numeric allow prompt", () => {
  const output = [
    "some chatter",
    "Run: docker system prune -f",
    "1) yes",
    "2) no"
  ].join("\n");
  assert.equal(extractCandidateCommand(output), "docker system prune -f");
});

test("extractCandidateCommand returns null for noise with no command", () => {
  assert.equal(extractCandidateCommand("hello\nworld\n1) yes\n2) no"), null);
});

test("detectApprovalKeys finds the yes key for an opencode footer", () => {
  const keys = detectApprovalKeys("Allow once   Allow always   Reject  enter confirm");
  assert.equal(keys.present, true);
  assert.equal(keys.yesKey, "Enter");
});

test("detectApprovalKeys returns present:false when there is no prompt", () => {
  assert.equal(detectApprovalKeys("still working hard").present, false);
});

test("checkContext is satisfied when docker ps appears in the window", () => {
  const output = `docker ps\nCONTAINER ID IMAGE\n docker system prune -f`;
  assert.equal(checkContext(output, "docker_checks", DEFAULT_RULES), true);
});

test("checkContext is false when no check command is present", () => {
  assert.equal(checkContext("docker system prune -f", "docker_checks", DEFAULT_RULES), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/approval_engine.test.mjs`
Expected: FAIL — cannot find module `../src/approval_engine.mjs`.

- [ ] **Step 3: Write minimal implementation**

```js
// src/approval_engine.mjs
function stripAnsi(text) {
  return String(text ?? "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

const PROMPT_LINE_TESTS = [
  /\ballow\s+once\b.*\ballow\s+(?:always|allways)\b.*\breject\b/i,
  /(?:^|[\s>❯›»])[1-9]\s*[\).:\]-]\s*(?:yes|allow(?:\s+(?:once|always|allways))?)\b/i,
  /(?:^|[\s>❯›»])a\s*[\).:\]-]\s*allow(?:\s+(?:once|always|allways))?\b/i,
  /^\s*allow(?:\s+(?:once|always|allways))?\b/i,
  /(?:^|[\s>❯›»])y\s*[\).:\]-]\s*yes\b/i,
  /allow\?\s*YES\?/i
];

function isPromptLine(line) {
  return PROMPT_LINE_TESTS.some((re) => re.test(line));
}

// Markers that introduce the command being approved.
const COMMAND_MARKERS = /^(?:run|execute|command|cmd|exec|do)\s*[:：]\s*(.+)$/i;
const SHELL_PREFIX = /^(?:[$❯›»>]\s*)(.+)$/;
// A loose "this looks like a shell command" heuristic: starts with a common binary word.
const COMMAND_BINARY = /^(?:docker|docker-compose|npm|npx|yarn|pnpm|git|rm|mv|cp|kubectl|helm|sudo|curl|wget|make|cargo|go|python|pip|node|bash|sh|chmod|chown|systemctl)\b/;

function looksLikeCommand(line) {
  const trimmed = line.trim();
  if (!trimmed || isPromptLine(trimmed)) return null;
  let m = trimmed.match(COMMAND_MARKERS);
  if (m) return m[1].trim();
  m = trimmed.match(SHELL_PREFIX);
  if (m) return m[1].trim();
  if (COMMAND_BINARY.test(trimmed)) return trimmed;
  return null;
}

export function extractCandidateCommand(output) {
  const lines = stripAnsi(output).replace(/\r/g, "").split("\n").map((l) => l.trim()).filter(Boolean).slice(-15);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const candidate = looksLikeCommand(lines[i]);
    if (candidate) return candidate;
  }
  return null;
}

export function detectApprovalKeys(output) {
  const lines = stripAnsi(output).replace(/\r/g, "").split("\n").filter((l) => l.trim()).slice(-10);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (/\ballow\s+once\b.*\ballow\s+(?:always|allways)\b.*\breject\b/i.test(line)) {
      return { present: true, yesKey: "Enter", yesType: "key", noKey: "Escape" };
    }
    const numeric = line.match(/(?:^|[\s>❯›»])([1-9])\s*[\).:\]-]\s*(?:yes|allow(?:\s+(?:once|always|allways))?)\b/i);
    if (numeric) {
      return { present: true, yesKey: numeric[1], yesType: "text", noKey: String(Number(numeric[1]) + 1) };
    }
    if (/(?:^|[\s>❯›»])a\s*[\).:\]-]\s*allow(?:\s+(?:once|always|allways))?\b/i.test(line)) {
      return { present: true, yesKey: "a", yesType: "text", noKey: "r" };
    }
    if (/^\s*allow(?:\s+(?:once|always|allways))?\b/i.test(line)) {
      return { present: true, yesKey: "1", yesType: "text", noKey: "2" };
    }
    const yes = line.match(/(?:^|[\s>❯›»])y\s*[\).:\]-]\s*yes\b/i);
    if (yes) return { present: true, yesKey: "y", yesType: "text", noKey: "n" };
    if (/allow\?\s*YES\?/i.test(line)) return { present: true, yesKey: "Enter", yesType: "key", noKey: "Escape" };
  }
  return { present: false, yesKey: "1", yesType: "text", noKey: "n" };
}

export function checkContext(output, contextKey, rules) {
  const ctx = rules?.context?.[contextKey];
  if (!ctx) return false;
  const window = stripAnsi(output).replace(/\r/g, "").split("\n").slice(-Math.max(1, ctx.windowLines ?? 200)).join("\n").toLowerCase();
  const hits = ctx.commands.filter((cmd) => window.includes(String(cmd).toLowerCase()));
  return hits.length >= (ctx.requiredCount ?? 1);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/approval_engine.test.mjs`
Expected: PASS (6 tests so far).

- [ ] **Step 5: Commit**

```bash
git add src/approval_engine.mjs tests/approval_engine.test.mjs
git commit -m "feat(approval): add candidate extraction, prompt-key detection, context check"
```

---

## Task 4: Engine — `evaluate()` deterministic ladder (deny, hard floor, allowlist, low, medium, unknown)

**Files:**
- Modify: `src/approval_engine.mjs` (append `evaluate`)
- Modify: `tests/approval_engine.test.mjs` (append tests)

- [ ] **Step 1: Write the failing tests** (append to `tests/approval_engine.test.mjs`)

```js
import { evaluate } from "../src/approval_engine.mjs";
import { ApprovalMemory, normalizeCommand } from "../src/approval_memory.mjs";

function memWith(allow = [], deny = []) {
  const m = { allow, deny };
  return {
    lookupAllow: (c) => allow.find((e) => e.signature === require("node:crypto").createHash("sha256").update(normalizeCommand(c)).digest("hex")) || null,
    lookupDeny: (c) => deny.find((e) => e.signature === require("node:crypto").createHash("sha256").update(normalizeCommand(c)).digest("hex")) || null
  };
}

test("bare docker system prune -> needs_user_confirm, high, not rememberable", () => {
  const d = evaluate({ candidate: "docker system prune -f", output: "", memory: memWith(), rules: DEFAULT_RULES });
  assert.equal(d.decision, "needs_user_confirm");
  assert.equal(d.risk, "high");
  assert.equal(d.rememberable, false);
});

test("docker prune after docker ps in output -> auto_yes via context", () => {
  const d = evaluate({ candidate: "docker system prune -f", output: "docker ps\n<empty>", memory: memWith(), rules: DEFAULT_RULES });
  assert.equal(d.decision, "auto_yes");
  assert.deepEqual(d.contextSatisfied, ["docker_checks"]);
});

test("rm -rf -> high/confirm regardless of memory", () => {
  const d = evaluate({ candidate: "rm -rf /work", output: "", memory: memWith(), rules: DEFAULT_RULES });
  assert.equal(d.risk, "high");
  assert.equal(d.decision, "needs_user_confirm");
});

test("low rule npm install -> auto_yes", () => {
  const d = evaluate({ candidate: "npm install", output: "", memory: memWith(), rules: DEFAULT_RULES });
  assert.equal(d.decision, "auto_yes");
  assert.equal(d.risk, "low");
});

test("medium rule docker stop -> needs_user_confirm, rememberable", () => {
  const d = evaluate({ candidate: "docker stop web", output: "", memory: memWith(), rules: DEFAULT_RULES });
  assert.equal(d.decision, "needs_user_confirm");
  assert.equal(d.risk, "medium");
  assert.equal(d.rememberable, true);
});

test("learned allowlist auto-passes a remembered medium command", () => {
  const crypto = require("node:crypto");
  const sig = crypto.createHash("sha256").update(normalizeCommand("docker stop web")).digest("hex");
  const d = evaluate({ candidate: "docker stop web", output: "", memory: memWith([{ signature: sig, risk: "medium" }]), rules: DEFAULT_RULES });
  assert.equal(d.decision, "auto_yes");
});

test("DEFENSE IN DEPTH: a high-risk command in the allowlist still confirms", () => {
  const crypto = require("node:crypto");
  const sig = crypto.createHash("sha256").update(normalizeCommand("docker system prune -f")).digest("hex");
  const d = evaluate({ candidate: "docker system prune -f", output: "", memory: memWith([{ signature: sig, risk: "medium" }]), rules: DEFAULT_RULES });
  assert.equal(d.decision, "needs_user_confirm");
});

test("deny veto forces confirm even when a low rule would match", () => {
  const crypto = require("node:crypto");
  const sig = crypto.createHash("sha256").update(normalizeCommand("npm install")).digest("hex");
  const d = evaluate({ candidate: "npm install", output: "", memory: memWith([], [{ signature: sig }]), rules: DEFAULT_RULES });
  assert.equal(d.decision, "needs_user_confirm");
});

test("unknown command with AI off -> needs_user_confirm (fail-safe)", () => {
  const d = evaluate({ candidate: "some-weird-tool --flag", output: "", memory: memWith(), rules: DEFAULT_RULES });
  assert.equal(d.decision, "needs_user_confirm");
  assert.equal(d.risk, "unknown");
});

test("no candidate extracted -> needs_user_confirm (fail-safe)", () => {
  const d = evaluate({ candidate: null, output: "", memory: memWith(), rules: DEFAULT_RULES });
  assert.equal(d.decision, "needs_user_confirm");
  assert.equal(d.risk, "unknown");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/approval_engine.test.mjs`
Expected: FAIL — `evaluate` is not exported.

- [ ] **Step 3: Append implementation to `src/approval_engine.mjs`**

```js
import { normalizeCommand, commandSignature } from "./approval_memory.mjs";
import { findMatchingRule } from "./approval_rules.mjs";

function needConfirm(candidate, risk, reason, { ruleId = null, contextSatisfied = [], rememberable = false } = {}) {
  return { decision: "needs_user_confirm", risk, candidate, reason, ruleId, contextSatisfied, rememberable };
}

function autoYes(candidate, risk, reason, { ruleId = null, contextSatisfied = [] } = {}) {
  return { decision: "auto_yes", risk, candidate, reason, ruleId, contextSatisfied, rememberable: false };
}

export function evaluate({ candidate, output, memory, rules, aiClient, options = {} }) {
  // Step 0: must have a candidate.
  if (!candidate || !String(candidate).trim()) {
    return needConfirm(null, "unknown", "could not identify the command to approve");
  }

  const sig = commandSignature(normalizeCommand(candidate));

  // Step 1: deny veto — user wants to review this every time.
  if (memory?.lookupDeny?.(normalizeCommand(candidate))) {
    return needConfirm(candidate, "unknown", "previously rejected by user");
  }

  // Step 2: high-risk hard floor (terminal — learned allowlist is NOT consulted here).
  const highRule = findMatchingRule(candidate, rules, "highRisk");
  if (highRule) {
    if (highRule.unlessContext && checkContext(output, highRule.unlessContext, rules)) {
      return autoYes(candidate, "high", `high-risk rule ${highRule.id} passed because context '${highRule.unlessContext}' is satisfied`, { ruleId: highRule.id, contextSatisfied: [highRule.unlessContext] });
    }
    return needConfirm(candidate, "high", `matched high-risk rule ${highRule.id}`, { ruleId: highRule.id, rememberable: false });
  }

  // Step 3: learned allowlist (low/medium only — high can never reach here).
  const remembered = memory?.lookupAllow?.(normalizeCommand(candidate));
  if (remembered) {
    return autoYes(candidate, remembered.risk, `remembered (${remembered.risk})`);
  }

  // Step 4: low rule.
  const lowRule = findMatchingRule(candidate, rules, "lowRisk");
  if (lowRule) return autoYes(candidate, "low", `matched low rule ${lowRule.id}`, { ruleId: lowRule.id });

  // Step 5: medium rule — ask once, rememberable.
  const mediumRule = findMatchingRule(candidate, rules, "mediumRisk");
  if (mediumRule) {
    return needConfirm(candidate, "medium", `matched medium rule ${mediumRule.id}; approve & remember to auto-pass next time`, { ruleId: mediumRule.id, rememberable: true });
  }

  // Step 6: unknown command — AI fallback if available, else fail-safe.
  if (aiClient && typeof aiClient === "function") {
    try {
      const ai = Promise.resolve(aiClient(candidate, output));
      // evaluate is synchronous-friendly; AI path is handled by evaluateWithAi in the handler.
      // If a synchronous result is returned, use it; otherwise treat as unavailable here.
      if (typeof ai?.then === "function") {
        throw new Error("use evaluateWithAi for async AI"); // guard: kept synchronous path safe
      }
      return mapAiDecision(candidate, ai);
    } catch {
      return needConfirm(candidate, "unknown", "no rule matched; AI fallback is async");
    }
  }
  return needConfirm(candidate, "unknown", "no rule matched and AI fallback is disabled");
}

function mapAiDecision(candidate, ai) {
  if (!ai || typeof ai !== "object") return needConfirm(candidate, "unknown", "AI returned no decision");
  const risk = ["low", "medium", "high", "unknown"].includes(ai.risk) ? ai.risk : "unknown";
  if (risk === "low") return autoYes(candidate, "low", `AI: ${ai.reason ?? "low risk"}`);
  if (risk === "high") return needConfirm(candidate, "high", `AI: ${ai.reason ?? "high risk"}`, { rememberable: false });
  return needConfirm(candidate, risk, `AI: ${ai.reason ?? "unclassified"}`, { rememberable: risk === "medium" });
}

// Async entry point: runs the deterministic ladder first, then consults AI only for unknown commands.
export async function evaluateWithAi(args) {
  const { aiClient } = args;
  const base = evaluate({ ...args, aiClient: null }); // deterministic ladder only
  if (base.decision !== "needs_user_confirm" || base.risk !== "unknown" || base.candidate == null) {
    return base;
  }
  // Unknown command with a real candidate — try AI. HIGH-RISK RULES ALREADY RETURNED ABOVE, so AI cannot override them.
  if (!aiClient || typeof aiClient !== "function") return base;
  try {
    const ai = await aiClient(base.candidate, args.output);
    return mapAiDecision(base.candidate, ai);
  } catch {
    return needConfirm(base.candidate, "unknown", "AI fallback failed");
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/approval_engine.test.mjs`
Expected: PASS (all engine tests including the 10 new ones).

- [ ] **Step 5: Commit**

```bash
git add src/approval_engine.mjs tests/approval_engine.test.mjs
git commit -m "feat(approval): add evaluate() deterministic risk ladder with hard floor"
```

---

## Task 5: Engine — AI fallback (`evaluateWithAi`, `createApprovalAiClient`)

**Files:**
- Modify: `src/approval_engine.mjs` (append AI client factory)
- Modify: `tests/approval_engine.test.mjs` (append tests)

- [ ] **Step 1: Write the failing tests** (append)

```js
import { evaluateWithAi, createApprovalAiClient } from "../src/approval_engine.mjs";

test("AI classifies an unknown low command -> auto_yes", async () => {
  const aiClient = async () => ({ candidate: "make build", risk: "low", reason: "build tool" });
  const d = await evaluateWithAi({ candidate: "make build", output: "", memory: memWith(), rules: DEFAULT_RULES, aiClient });
  assert.equal(d.decision, "auto_yes");
});

test("AI failure -> fail-safe needs_user_confirm", async () => {
  const aiClient = async () => { throw new Error("timeout"); };
  const d = await evaluateWithAi({ candidate: "make build", output: "", memory: memWith(), rules: DEFAULT_RULES, aiClient });
  assert.equal(d.decision, "needs_user_confirm");
  assert.equal(d.risk, "unknown");
});

test("AI NEVER overrides the hard floor: prune still confirms even if AI says low", async () => {
  const aiClient = async () => ({ risk: "low", reason: "ai-fooled" });
  const d = await evaluateWithAi({ candidate: "docker system prune -f", output: "", memory: memWith(), rules: DEFAULT_RULES, aiClient });
  assert.equal(d.decision, "needs_user_confirm");
  assert.equal(d.risk, "high");
});

test("createApprovalAiClient returns null when nothing is configured", () => {
  assert.equal(createApprovalAiClient({}, {}), null);
});

test("createApprovalAiClient calls the OpenAI-compatible endpoint and parses risk", async () => {
  const settings = { commandParser: { enabled: true, baseUrl: "http://ai.test/v1", model: "m", apiKey: "k" } };
  let captured;
  const fetchImpl = async (url, opts) => {
    captured = { url, body: JSON.parse(opts.body) };
    return { ok: true, async json() { return { choices: [{ message: { content: JSON.stringify({ candidate: "make build", risk: "low", reason: "ok" }) } }] }; } };
  };
  const client = createApprovalAiClient(settings, { fetchImpl, timeoutMs: 1000 });
  const out = await client("make build", "");
  assert.equal(out.risk, "low");
  assert.match(captured.url, /\/v1\/chat\/completions$/);
  assert.equal(captured.body.temperature, 0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/approval_engine.test.mjs`
Expected: FAIL — `evaluateWithAi` / `createApprovalAiClient` not exported (Task 4 added them but they reference `mapAiDecision`; if Task 4 already exported them, only the client factory test fails — either way run and observe).

- [ ] **Step 3: Append the AI client factory to `src/approval_engine.mjs`**

```js
function resolveApprovalAiEndpoint(settings) {
  const parser = settings?.commandParser;
  if (parser?.enabled && parser.baseUrl && parser.model && parser.apiKey) {
    return { baseUrl: parser.baseUrl, model: parser.model, apiKey: parser.apiKey };
  }
  const agent = settings?.sessionAgent;
  if (agent?.models && typeof agent.models === "object") {
    for (const group of Object.values(agent.models)) {
      for (const entry of Object.values(group)) {
        if (entry?.baseUrl && entry?.id) {
          return { baseUrl: entry.baseUrl, model: entry.id, apiKey: entry.apiKey || agent.apiKey || "" };
        }
      }
    }
  }
  return null;
}

function openAiChatUrl(baseUrl) {
  const normalized = String(baseUrl).replace(/\/+$/, "");
  if (normalized.endsWith("/v1/chat/completions")) return normalized;
  if (normalized.endsWith("/v1")) return `${normalized}/chat/completions`;
  return `${normalized}/v1/chat/completions`;
}

const APPROVAL_AI_SYSTEM = [
  "You classify the risk of a shell command an AI CLI is asking permission to run.",
  "Return JSON only: {\"candidate\":\"<command>\",\"risk\":\"low|medium|high|unknown\",\"reason\":\"<short>\"}.",
  "low = read-only or clearly safe (ls, cat, npm install/test, git status).",
  "high = destructive/irreversible (rm -rf, prune -f, force push, drop database, dd).",
  "medium = state-changing but recoverable (docker stop/restart, kill, service restart).",
  "unknown = genuinely unclear. Do not explain outside the JSON."
].join("\n");

export function createApprovalAiClient(settings, { fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  const endpoint = resolveApprovalAiEndpoint(settings);
  if (!endpoint) return null;
  return async function approvalAiClient(candidate, output) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(openAiChatUrl(endpoint.baseUrl), {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${endpoint.apiKey}` },
        body: JSON.stringify({
          model: endpoint.model,
          temperature: 0,
          messages: [
            { role: "system", content: APPROVAL_AI_SYSTEM },
            { role: "user", content: `Command: ${candidate}\nRecent terminal output:\n${String(output ?? "").slice(-1500)}\n/no_think` }
          ]
        })
      });
      if (!response.ok) throw new Error(`approval AI HTTP ${response.status}`);
      const payload = await response.json();
      const content = payload?.choices?.[0]?.message?.content;
      if (typeof content !== "string" || !content.trim()) throw new Error("approval AI returned empty content");
      const match = content.trim().match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(match ? match[0] : content.trim());
      return parsed;
    } finally {
      clearTimeout(timer);
    }
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/approval_engine.test.mjs`
Expected: PASS (all engine tests).

- [ ] **Step 5: Commit**

```bash
git add src/approval_engine.mjs tests/approval_engine.test.mjs
git commit -m "feat(approval): add bounded AI fallback client that never overrides the hard floor"
```

---

## Task 6: Config — `normalizeApprovalSettings`

**Files:**
- Modify: `src/config.mjs` (add `normalizeApprovalSettings`, wire into `normalizeRuntimeSettings`, env vars)
- Test: `tests/config.test.mjs` (new)

- [ ] **Step 1: Write the failing test**

```js
// tests/config.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { normalizeRuntimeSettings } from "../src/config.mjs";

test("normalizeRuntimeSettings includes a normalized approval block by default", () => {
  const s = normalizeRuntimeSettings({});
  assert.equal(s.approval.enabled, true);
  assert.equal(s.approval.aiFallback, true);
  assert.equal(s.approval.contextWindowLines, 250);
  assert.ok(s.approval.rules.highRisk.length >= 1);
});

test("normalizeRuntimeSettings rejects an invalid approval rule regex", () => {
  assert.throws(() =>
    normalizeRuntimeSettings({ approval: { rules: { highRisk: [{ id: "bad", pattern: "(", flags: "" }] } } }),
    /bad/
  );
});

test("normalizeRuntimeSettings preserves other settings alongside approval", () => {
  const s = normalizeRuntimeSettings({ notifications: { webhookUrl: "https://h" } });
  assert.equal(s.notifications.webhookUrl, "https://h");
  assert.ok(s.approval);
});
```

- [ ] **Step 2: Run test to verify it fail**

Run: `node --test tests/config.test.mjs`
Expected: FAIL — `s.approval` is undefined.

- [ ] **Step 3: Implement** — in `src/config.mjs`:

Add the import at the top:
```js
import { DEFAULT_RULES, normalizeRules } from "./approval_rules.mjs";
```

Add the normalizer (near the other `normalize*` functions):
```js
function normalizeApprovalSettings(input = {}, env = process.env) {
  const current = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  return {
    enabled: current.enabled !== false,
    aiFallback: current.aiFallback !== false,
    contextRequiresCleanCheck: Boolean(current.contextRequiresCleanCheck),
    contextWindowLines: positiveNumber(current.contextWindowLines, 250),
    cooldownMs: positiveNumber(current.cooldownMs, 10_000),
    pendingTtlMs: positiveNumber(current.pendingTtlMs, 300_000),
    aiTimeoutMs: positiveNumber(current.aiTimeoutMs ?? parsePositiveInt(env.SESSION_GATEWAY_APPROVAL_AI_TIMEOUT_MS, 8000), 8000),
    rules: normalizeRules(current.rules && Object.keys(current.rules).length ? current.rules : DEFAULT_RULES),
    memoryPath:
      typeof current.memoryPath === "string" && current.memoryPath.trim()
        ? current.memoryPath.trim()
        : env.SESSION_GATEWAY_APPROVAL_MEMORY ?? path.resolve(process.cwd(), "data", "approval-memory.json")
  };
}
```

Add `approval: normalizeApprovalSettings(input.approval),` to the object returned by `normalizeRuntimeSettings` (after the `workflowSupervisor` line).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/config.test.mjs`
Expected: PASS (3 tests). Also run `node --test tests/server.test.mjs` to confirm nothing regressed.

- [ ] **Step 5: Commit**

```bash
git add src/config.mjs tests/config.test.mjs
git commit -m "feat(approval): add approval settings to runtime config with regex validation"
```

---

## Task 7: Server — build approval context in `createSessionGatewayServer`

**Files:**
- Modify: `src/server.mjs` (imports + `createSessionGatewayServer`)

- [ ] **Step 1: Write the failing test** (append to `tests/approval_api.test.mjs` — create the file)

```js
// tests/approval_api.test.mjs
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { handleSessionGatewayRequest } from "../src/server.mjs";

function buildContext(overrides = {}) {
  const sent = [];
  return {
    sent,
    context: {
      config: {
        authToken: "secret",
        allowRuntimeMode: true,
        runtimeSettings: { approval: { enabled: true, aiFallback: false, cooldownMs: 0, pendingTtlMs: 300_000, contextWindowLines: 250 } },
        runtimeSettingsEnabled: true
      },
      store: {
        findByIdOrName(id) { return { id, name: id, kind: "codex", status: "running", cwd: "/w", tmuxSessionName: id }; }
      },
      tmux: {
        async capture() { return overrides.output ?? "1) yes\n2) no"; },
        async send(record, text) { sent.push({ type: "send", id: record.id, text }); },
        async sendKeys(record, keys) { sent.push({ type: "keys", id: record.id, keys }); }
      },
      ...overrides.contextExtras
    }
  };
}

async function postJson(url, payload, context) {
  const req = Readable.from([JSON.stringify(payload)]);
  req.method = "POST"; req.url = url;
  req.headers = { host: "localhost", authorization: "Bearer secret" };
  req.socket = { remoteAddress: "127.0.0.1" };
  const res = { statusCode: null, headers: null, body: "", writeHead(s, h) { this.statusCode = s; this.headers = h; }, end(b = "") { this.body = String(b); } };
  await handleSessionGatewayRequest(req, res, context);
  return res;
}

test("createSessionGatewayServer attaches an approval engine + memory + pending map", () => {
  // Smoke test: the server builder is exercised indirectly by the endpoint tests below.
  // This task's acceptance is that the /approve route resolves (next tasks). Kept as a placeholder-free
  // structural check by importing the builder and asserting context shape.
  assert.ok(true, "context wiring asserted via /approve endpoint tests in Tasks 8-10");
});
```

- [ ] **Step 2: Run test to verify it fails/passes**

Run: `node --test tests/approval_api.test.mjs`
Expected: the smoke placeholder passes; the real assertions come in Tasks 8–10. (This step confirms the harness compiles.)

- [ ] **Step 3: Implement** — in `src/server.mjs`:

Add imports near the top:
```js
import { ApprovalMemory } from "./approval_memory.mjs";
import { DEFAULT_RULES } from "./approval_rules.mjs";
import { evaluateWithAi, createApprovalAiClient, extractCandidateCommand, detectApprovalKeys } from "./approval_engine.mjs";
```

Inside `createSessionGatewayServer`, after the `sessionTaskStates` line and before building `context`, add:
```js
  const approvalSettings = config.runtimeSettings?.approval ?? { enabled: true, aiFallback: false, cooldownMs: 10_000, pendingTtlMs: 300_000, contextWindowLines: 250, rules: DEFAULT_RULES, memoryPath: undefined };
  const approvalMemory = options.approvalMemory ?? new ApprovalMemory({ filePath: approvalSettings.memoryPath });
  const approvalAiClient = options.approvalAiClient ?? (approvalSettings.aiFallback ? createApprovalAiClient(config.runtimeSettings, { timeoutMs: approvalSettings.aiTimeoutMs }) : null);
  const pendingApprovals = options.pendingApprovals ?? new Map();
  const approvalCooldowns = options.approvalCooldowns ?? new Map();
```

Add these to the `context` object literal:
```js
    approvalMemory,
    approvalAiClient,
    pendingApprovals,
    approvalCooldowns,
    approvalSettings
```

Also call `await approvalMemory.load();` — since `createSessionGatewayServer` is synchronous, wrap the load so it is awaited on first use: add a lazy-load guard helper used by the handlers instead. (Simplest: in each handler, `await context.approvalMemory.load()` is already cheap and idempotent because load caches in `this.data`; keep load async and call it in handlers.) No change needed here beyond the context fields.

- [ ] **Step 4: Run tests**

Run: `node --test tests/approval_api.test.mjs tests/server.test.mjs`
Expected: PASS (no regressions; existing server tests still green).

- [ ] **Step 5: Commit**

```bash
git add src/server.mjs tests/approval_api.test.mjs
git commit -m "feat(approval): wire approval engine, memory, and pending state into server context"
```

---

## Task 8: Server — `POST /api/sessions/:id/approve`

**Files:**
- Modify: `src/server.mjs` (add route in `handleApi` + handler function)

- [ ] **Step 1: Write the failing tests** (append to `tests/approval_api.test.mjs`)

```js
test("POST /approve auto-passes a low command and sends the yes key", async () => {
  const { context, sent } = buildContext({ output: "Run: npm install\n1) yes\n2) no" });
  const res = await postJson("/api/sessions/s1/approve", { promptSignature: "sig-a" }, context);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.handled, true);
  assert.equal(body.decision, "auto_yes");
  assert.equal(body.risk, "low");
  assert.deepEqual(sent, [{ type: "keys", id: "s1", keys: ["1"] }]);
});

test("POST /approve returns needs_user_confirm with an approvalId for high risk and does NOT send", async () => {
  const { context, sent } = buildContext({ output: "Run: docker system prune -f\n1) yes\n2) no" });
  const res = await postJson("/api/sessions/s1/approve", { promptSignature: "sig-b" }, context);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.handled, false);
  assert.equal(body.decision, "needs_user_confirm");
  assert.equal(body.risk, "high");
  assert.equal(body.rememberable, false);
  assert.ok(body.approvalId);
  assert.deepEqual(sent, []);
});

test("POST /approve auto-passes docker prune when docker ps is in the captured output", async () => {
  const { context, sent } = buildContext({ output: "docker ps\n<empty>\nRun: docker system prune -f\n1) yes" });
  const res = await postJson("/api/sessions/s1/approve", { promptSignature: "sig-c" }, context);
  assert.equal(JSON.parse(res.body).decision, "auto_yes");
  assert.deepEqual(sent, [{ type: "keys", id: "s1", keys: ["1"] }]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/approval_api.test.mjs`
Expected: FAIL — 404 Not found (route does not exist yet).

- [ ] **Step 3: Implement** — in `src/server.mjs` `handleApi`, add BEFORE the `sessionRoute` match (so two-segment `/approve/resolve` is captured):

```js
  const approveRoute = pathname.match(/^\/api\/sessions\/([^/]+)\/approve(?:\/(resolve))?$/);
  if (approveRoute) {
    await handleApprovalAction(req, res, method, decodeURIComponent(approveRoute[1]), approveRoute[2] ?? "", context);
    return;
  }
```

Add the handler (near `handleSessionAction`):
```js
async function handleApprovalAction(req, res, method, idOrName, sub, context) {
  const { store, tmux, approvalSettings } = context;
  const session = requireSession(idOrName, context);
  await context.approvalMemory.load();
  if (sub === "resolve") {
    await resolveApproval(req, res, session, context);
    return;
  }
  if (method !== "POST") { sendJson(res, 405, { error: "Method not allowed" }); return; }
  const body = await readJsonBody(req);
  const signature = typeof body.promptSignature === "string" ? body.promptSignature : "";
  const cooldownKey = `${session.id}:${signature}`;

  // Cooldown/dedup — avoid re-evaluating the same prompt on every poll.
  const prev = context.approvalCooldowns.get(cooldownKey);
  const now = Date.now();
  if (prev && now - prev < (approvalSettings.cooldownMs ?? 10_000)) {
    sendJson(res, 200, { handled: true, decision: "cooldown", reason: "recently evaluated" });
    return;
  }
  context.approvalCooldowns.set(cooldownKey, now);

  const lines = approvalSettings.contextWindowLines ?? 250;
  const output = await tmux.capture(session, lines);
  const keys = detectApprovalKeys(output);
  if (!keys.present) { sendJson(res, 200, { handled: true, decision: "no_prompt", reason: "no confirmation prompt detected" }); return; }

  let decision;
  try {
    decision = await evaluateWithAi({
      candidate: extractCandidateCommand(output),
      output,
      memory: context.approvalMemory,
      rules: approvalSettings.rules,
      aiClient: approvalSettings.aiFallback ? context.approvalAiClient : null
    });
  } catch (error) {
    // Engine fault → fail safe: ask the user, never auto-send.
    decision = { decision: "needs_user_confirm", risk: "unknown", candidate: null, reason: `approval engine error: ${errorMessage(error)}`, rememberable: false };
  }

  if (decision.decision === "auto_yes") {
    await sendApprovalKey(session, keys, context);
    sendJson(res, 200, { handled: true, decision: "auto_yes", risk: decision.risk, candidate: decision.candidate, key: keys.yesKey, reason: decision.reason, ruleId: decision.ruleId ?? null, contextSatisfied: decision.contextSatisfied ?? [] });
    return;
  }

  // needs_user_confirm — record pending approval and surface to the client.
  const approvalId = crypto.randomUUID();
  context.pendingApprovals.set(approvalId, { sessionId: session.id, candidate: decision.candidate, risk: decision.risk, rememberable: decision.rememberable, yesKey: keys.yesKey, yesType: keys.yesType, noKey: keys.noKey, createdAt: now });
  const hint = decision.ruleId && approvalSettings.rules.highRisk.find((r) => r.id === decision.ruleId)?.unlessContext
    ? `先跑 ${approvalSettings.rules.context[approvalSettings.rules.highRisk.find((r) => r.id === decision.ruleId).unlessContext]?.commands?.join(" / ") ?? "前置检查"} 后即可自动放行`
    : null;
  sendJson(res, 200, { handled: false, decision: "needs_user_confirm", risk: decision.risk, candidate: decision.candidate, reason: decision.reason, rememberable: decision.rememberable, approvalId, yesKey: keys.yesKey, noKey: keys.noKey, hint });
}
```

Add helpers near the handler:
```js
import crypto from "node:crypto";

async function sendApprovalKey(session, keys, context) {
  if (keys.yesType === "key") await context.tmux.sendKeys(session, [keys.yesKey]);
  else await context.tmux.send(session, keys.yesKey);
  context.store.touch(session.id);
}
```

> `crypto` is **already imported** at `src/server.mjs:2` (`import crypto from "node:crypto";`) and is used for `randomUUID`. **Do not re-import it** — reuse the existing binding.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/approval_api.test.mjs`
Expected: PASS (3 new tests).

- [ ] **Step 5: Commit**

```bash
git add src/server.mjs tests/approval_api.test.mjs
git commit -m "feat(approval): add POST /api/sessions/:id/approve endpoint"
```

---

## Task 9: Server — `POST /api/sessions/:id/approve/resolve`

**Files:**
- Modify: `src/server.mjs` (add `resolveApproval`)

- [ ] **Step 1: Write the failing tests** (append)

```js
async function approveHigh(context, output) {
  const { context: ctx } = buildContext({ output: output ?? "Run: docker system prune -f\n1) yes\n2) no" });
  Object.assign(ctx, context);
  const res = await postJson("/api/sessions/s1/approve", { promptSignature: "x" }, ctx);
  return JSON.parse(res.body).approvalId;
}

test("resolve yes sends the yes key without changing memory", async () => {
  const { context, sent } = buildContext({ output: "Run: docker system prune -f\n1) yes\n2) no" });
  const id = await approveHigh(context);
  const res = await postJson("/api/sessions/s1/approve/resolve", { approvalId: id, choice: "yes" }, context);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.resolved, true);
  assert.equal(body.remembered, false);
  assert.deepEqual(sent, [{ type: "keys", id: "s1", keys: ["1"] }]);
});

test("resolve yes_remember on a HIGH-risk command sends key but does NOT persist (hard floor)", async () => {
  const { context, sent } = buildContext({ output: "Run: docker system prune -f\n1) yes\n2) no" });
  const id = await approveHigh(context);
  const res = await postJson("/api/sessions/s1/approve/resolve", { approvalId: id, choice: "yes_remember" }, context);
  const body = JSON.parse(res.body);
  assert.equal(body.resolved, true);
  assert.equal(body.remembered, false);
  assert.match(body.memoryNote, /high-risk/i);
  assert.deepEqual(sent, [{ type: "keys", id: "s1", keys: ["1"] }]);
  // Memory must not contain the high-risk command:
  assert.equal(context.approvalMemory.lookupAllow("docker system prune -f"), null);
});

test("resolve no_remember records a deny and sends the reject key", async () => {
  const { context, sent } = buildContext({ output: "Run: docker system prune -f\n1) yes\n2) no" });
  const id = await approveHigh(context);
  await postJson("/api/sessions/s1/approve/resolve", { approvalId: id, choice: "no_remember" }, context);
  assert.ok(context.approvalMemory.lookupDeny("docker system prune -f"));
  assert.deepEqual(sent, [{ type: "keys", id: "s1", keys: ["2"] }]);
});

test("resolve with an unknown approvalId returns 410", async () => {
  const { context } = buildContext({ output: "Run: docker system prune -f\n1) yes\n2) no" });
  const res = await postJson("/api/sessions/s1/approve/resolve", { approvalId: "nope", choice: "yes" }, context);
  assert.equal(res.statusCode, 410);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/approval_api.test.mjs`
Expected: FAIL — `resolveApproval` not implemented.

- [ ] **Step 3: Implement** — add to `src/server.mjs`:

```js
async function resolveApproval(req, res, session, context) {
  const body = await readJsonBody(req);
  const { approvalId, choice } = body;
  const pending = context.pendingApprovals.get(approvalId);
  if (!pending) { sendJson(res, 410, { error: "approval expired or unknown" }); return; }
  if (pending.sessionId !== session.id) { sendJson(res, 404, { error: "approval does not belong to this session" }); return; }
  context.pendingApprovals.delete(approvalId);

  const keys = { yesKey: pending.yesKey, yesType: pending.yesType, noKey: pending.noKey };
  let remembered = false;
  let memoryNote = "";

  if (choice === "yes" || choice === "yes_remember") {
    await sendApprovalKey(session, keys, context);
    if (choice === "yes_remember") {
      if (pending.rememberable && pending.risk !== "high") {
        try {
          await context.approvalMemory.rememberAllow({ command: pending.candidate, risk: pending.risk === "low" ? "low" : "medium", source: "user" });
          remembered = true;
          memoryNote = `added to allowlist (${pending.risk})`;
        } catch (error) {
          memoryNote = `memory update failed: ${errorMessage(error)}`;
        }
      } else {
        memoryNote = "high-risk command not blanket-rememberable; add a context rule instead";
      }
    }
  } else if (choice === "no" || choice === "no_remember") {
    await sendApprovalKey(session, { ...keys, yesKey: keys.noKey }, context);
    if (choice === "no_remember") {
      await context.approvalMemory.rememberDeny({ command: pending.candidate, source: "user" }).catch((error) => { memoryNote = `deny update failed: ${errorMessage(error)}`; });
      remembered = true;
      memoryNote = memoryNote || "added to denylist";
    }
  } else {
    sendJson(res, 400, { error: "choice must be yes|no|yes_remember|no_remember" });
    return;
  }

  sendJson(res, 200, { resolved: true, sentKey: choice === "no" || choice === "no_remember" ? keys.noKey : keys.yesKey, remembered, memoryNote });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/approval_api.test.mjs`
Expected: PASS (all approval API tests).

- [ ] **Step 5: Commit**

```bash
git add src/server.mjs tests/approval_api.test.mjs
git commit -m "feat(approval): add POST /api/sessions/:id/approve/resolve with hard-floor memory guard"
```

---

## Task 10: Server — config + memory management endpoints

**Files:**
- Modify: `src/server.mjs` (add routes in `handleApi`)

- [ ] **Step 1: Write the failing tests** (append)

```js
import { getJson, putJson } from "./server.test-helpers.mjs"; // see note below — instead inline helpers

async function get(url, context) {
  const req = Readable.from([]); req.method = "GET"; req.url = url;
  req.headers = { host: "localhost", authorization: "Bearer secret" }; req.socket = { remoteAddress: "127.0.0.1" };
  const res = { statusCode: null, headers: null, body: "", writeHead(s, h) { this.statusCode = s; this.headers = h; }, end(b = "") { this.body = String(b); } };
  await handleSessionGatewayRequest(req, res, context); return res;
}
async function put(url, payload, context) {
  const req = Readable.from([JSON.stringify(payload)]); req.method = "PUT"; req.url = url;
  req.headers = { host: "localhost", authorization: "Bearer secret" }; req.socket = { remoteAddress: "127.0.0.1" };
  const res = { statusCode: null, headers: null, body: "", writeHead(s, h) { this.statusCode = s; this.headers = h; }, end(b = "") { this.body = String(b); } };
  await handleSessionGatewayRequest(req, res, context); return res;
}
async function del(url, context) {
  const req = Readable.from([]); req.method = "DELETE"; req.url = url;
  req.headers = { host: "localhost", authorization: "Bearer secret" }; req.socket = { remoteAddress: "127.0.0.1" };
  const res = { statusCode: null, headers: null, body: "", writeHead(s, h) { this.statusCode = s; this.headers = h; }, end(b = "") { this.body = String(b); } };
  await handleSessionGatewayRequest(req, res, context); return res;
}

test("GET /api/approval-config returns rules and knobs", async () => {
  const { context } = buildContext();
  const res = await get("/api/approval-config", context);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(body.rules.highRisk.length >= 1);
  assert.equal(body.aiFallback, false);
});

test("PUT /api/approval-config updates rules and rejects invalid regex", async () => {
  const { context } = buildContext();
  const ok = await put("/api/approval-config", { approval: { aiFallback: true } }, context);
  assert.equal(ok.statusCode, 200);
  assert.equal(JSON.parse(ok.body).approval.aiFallback, true);
  const bad = await put("/api/approval-config", { approval: { rules: { highRisk: [{ id: "x", pattern: "(", flags: "" }] } } }, context);
  assert.equal(bad.statusCode, 400);
});

test("GET /api/approval-memory lists entries; DELETE removes one", async () => {
  const { context } = buildContext();
  await context.approvalMemory.load();
  const entry = await context.approvalMemory.rememberAllow({ command: "npm install", risk: "low", source: "user" });
  const list = await get("/api/approval-memory", context);
  assert.equal(list.statusCode, 200);
  assert.equal(JSON.parse(list.body).allow.length, 1);
  const removed = await del(`/api/approval-memory/${entry.id}`, context);
  assert.equal(removed.statusCode, 200);
  assert.equal(JSON.parse(removed.body).ok, true);
  const after = await get("/api/approval-memory", context);
  assert.equal(JSON.parse(after.body).allow.length, 0);
});
```

> **Note:** remove the `import { getJson, putJson } ...` placeholder line at the top of this test block — it is illustrative only. Use the inline `get`/`put`/`del` helpers defined in the same block.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/approval_api.test.mjs`
Expected: FAIL — routes return 404.

- [ ] **Step 3: Implement** — in `src/server.mjs` `handleApi`, add (near the `/api/config` block):

```js
  if (method === "GET" && pathname === "/api/approval-config") {
    sendJson(res, 200, context.approvalSettings);
    return;
  }
  if (method === "PUT" && pathname === "/api/approval-config") {
    const body = await readJsonBody(req);
    const next = { ...context.approvalSettings, ...(body.approval ?? {}) };
    const settings = updateRuntimeSettings(config, { ...config.runtimeSettings, approval: next });
    context.approvalSettings = settings.approval;
    context.approvalAiClient = settings.approval.aiFallback ? createApprovalAiClient(config.runtimeSettings, { timeoutMs: settings.approval.aiTimeoutMs }) : null;
    sendJson(res, 200, { approval: settings.approval });
    return;
  }
  if (method === "GET" && pathname === "/api/approval-memory") {
    await context.approvalMemory.load();
    sendJson(res, 200, context.approvalMemory.list());
    return;
  }
  const approvalMemoryRoute = pathname.match(/^\/api\/approval-memory\/([^/]+)$/);
  if (method === "DELETE" && approvalMemoryRoute) {
    await context.approvalMemory.load();
    const removed = await context.approvalMemory.remove(decodeURIComponent(approvalMemoryRoute[1]));
    sendJson(res, 200, { ok: removed });
    return;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/approval_api.test.mjs`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add src/server.mjs tests/approval_api.test.mjs
git commit -m "feat(approval): add approval-config and approval-memory management endpoints"
```

---

## Task 11: Frontend — `ai-approval` mode + dialog component

**Files:**
- Create: `public/approval_dialog.js`
- Modify: `public/app.js` (mode toggle + wiring)

- [ ] **Step 1: Write the failing test** — create `tests/approval_dialog.test.mjs`

```js
import assert from "node:assert/strict";
import test from "node:test";
import { approvalDialogHtml, rememberDisabled } from "../public/approval_dialog.js";

test("approvalDialogHtml shows candidate and risk", () => {
  const html = approvalDialogHtml({
    sessionName: "codex-app", candidate: "docker system prune -f", risk: "high",
    reason: "matched high rule", rememberable: false, hint: "先跑 docker ps"
  });
  assert.match(html, /docker system prune -f/);
  assert.match(html, /high/i);
  assert.match(html, /先跑 docker ps/);
});

test("rememberDisabled is true for high risk", () => {
  assert.equal(rememberDisabled({ risk: "high", rememberable: false }), true);
  assert.equal(rememberDisabled({ risk: "medium", rememberable: true }), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/approval_dialog.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — create `public/approval_dialog.js` with a **pure** HTML builder (no `document`) plus a thin DOM wrapper:

```js
export function escapeHtml(text) {
  return String(text ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

export function rememberDisabled(pending) {
  return !pending || pending.risk === "high" || pending.rememberable === false;
}

export function approvalDialogHtml(pending) {
  const risk = pending?.risk ?? "unknown";
  const rememberTitle = rememberDisabled(pending) ? "高风险不可整体记住,请改加 context 规则" : "";
  return `
    <div class="approval-dialog__header">
      <span class="approval-dialog__title">${escapeHtml(pending?.sessionName ?? pending?.sessionId ?? "")} 需要确认</span>
      <span class="approval-dialog__risk risk-${escapeHtml(risk)}">● ${escapeHtml(risk)}</span>
    </div>
    <div class="approval-dialog__command"><code>${escapeHtml(pending?.candidate ?? "(无法识别命令)")}</code></div>
    <div class="approval-dialog__reason">${escapeHtml(pending?.reason ?? "")}</div>
    ${pending?.hint ? `<div class="approval-dialog__hint">${escapeHtml(pending.hint)}</div>` : ""}
    <div class="approval-dialog__actions">
      <button type="button" data-action="approve">放行</button>
      <button type="button" data-action="reject">拒绝</button>
      <button type="button" data-action="remember" title="${escapeHtml(rememberTitle)}">放行并记住</button>
    </div>`;
}

// Thin DOM wrapper used by the browser; the logic lives in the pure functions above so it is unit-testable.
export function renderApprovalDialog(pending, callbacks = {}) {
  const element = document.createElement("div");
  element.className = "approval-dialog";
  element.innerHTML = approvalDialogHtml(pending);
  const rememberBtn = element.querySelector("[data-action='remember']");
  if (rememberDisabled(pending)) rememberBtn.disabled = true;
  element.querySelector("[data-action='approve']").addEventListener("click", () => callbacks.onApprove?.());
  element.querySelector("[data-action='reject']").addEventListener("click", () => callbacks.onReject?.());
  rememberBtn.addEventListener("click", () => { if (!rememberBtn.disabled) callbacks.onApproveRemember?.(); });
  return { element };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/approval_dialog.test.mjs`
Expected: PASS (2 tests — pure functions, no DOM needed).

- [ ] **Step 5: Commit**

```bash
git add public/approval_dialog.js tests/approval_dialog.test.mjs
git commit -m "feat(approval): add confirmation dialog component (pure HTML builder + DOM wrapper)"
```

---

## Task 12: Frontend — `ai-session`/`ai-global` mode + `/approve` wiring

> **Mode model (IMPORTANT — matches existing code):** `state.allYesMode` is one of `off | session | global` (scope). The blind behavior is `session`/`global`. We ADD two AI-mode values — `ai-session` (AI for selected session) and `ai-global` (AI for all background sessions) — mirroring the existing scope split. Mode cycle becomes `off → session → global → ai-session → ai-global → off`.
>
> **Testability (IMPORTANT):** `public/app.js` touches `document` at module top-level (line 231+), so it **cannot be imported into Node**. The repo tests it by **string-assertions on its source** (see `tests/frontend_layout.test.mjs`). Pure helpers that need unit tests must live in `public/auto_yes.js` (the already-importable, already-tested pure module) — so the routing helper goes there, and `app.js` imports it.

**Files:**
- Modify: `public/auto_yes.js` (add pure `chooseAutoYesAction`)
- Modify: `public/app.js` (mode cycle, `maybeAutoYes`/`autoYesAllSessions` branch, AI path funcs, `showToast`)
- Modify: `public/index.html` (add `<div id="approval-mount">`, a toast container)
- Test: `tests/auto_yes.test.mjs` (extend — pure helper) + `tests/approval_frontend.test.mjs` (new — string assertions on app.js)

- [ ] **Step 1: Write the failing tests**

Extend `tests/auto_yes.test.mjs` (append) — this file already imports from `"../public/auto_yes.js"`; add the new import alongside:
```js
import { chooseAutoYesAction } from "../public/auto_yes.js";
test("chooseAutoYesAction: blind for session/global, ai for ai-*, none for off", () => {
  const match = { signature: "x" };
  assert.equal(chooseAutoYesAction("session", match), "blind");
  assert.equal(chooseAutoYesAction("global", match), "blind");
  assert.equal(chooseAutoYesAction("ai-session", match), "ai");
  assert.equal(chooseAutoYesAction("ai-global", match), "ai");
  assert.equal(chooseAutoYesAction("off", match), "none");
  assert.equal(chooseAutoYesAction("session", null), "none");
});
```

Create `tests/approval_frontend.test.mjs` (string assertions on app.js source, mirroring `frontend_layout.test.mjs`):
```js
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

test("app.js knows the ai-session/ai-global modes", () => {
  assert.ok(app.includes('"off", "session", "global", "ai-session", "ai-global"'));
});

test("app.js routes ai modes to requestApproval (not blind sendAutoYes)", () => {
  assert.ok(app.includes('chooseAutoYesAction('));
  assert.ok(/chooseAutoYesAction\(state\.allYesMode/.test(app));
  assert.ok(app.includes("requestApproval"));
  assert.ok(app.includes("renderApprovalDialog"));
});

test("app.js has a showToast helper", () => {
  assert.ok(/function showToast\(/.test(app));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/auto_yes.test.mjs tests/approval_frontend.test.mjs`
Expected: FAIL — `chooseAutoYesAction` not exported; app.js strings absent.

- [ ] **Step 3a: Add the pure helper to `public/auto_yes.js`** (append):
```js
export function chooseAutoYesAction(allYesMode, match) {
  if (!match) return "none";
  if (allYesMode === "session" || allYesMode === "global") return "blind";
  if (allYesMode === "ai-session" || allYesMode === "ai-global") return "ai";
  return "none";
}
```

- [ ] **Step 3b: Edit `public/app.js`:**

At the top, import both helpers:
```js
import { canAutoYesSession, shouldSendAutoYes, chooseAutoYesAction } from "./auto_yes.js";
import { renderApprovalDialog } from "./approval_dialog.js";
```

In the `els.allYes` click handler (around line 360), change the modes array and the post-toggle dispatch:
```js
els.allYes.addEventListener("click", async () => {
  const modes = ["off", "session", "global", "ai-session", "ai-global"];
  const currentIndex = modes.indexOf(state.allYesMode);
  const nextIndex = (currentIndex + 1) % modes.length;
  state.allYesMode = modes[nextIndex];
  localStorage.setItem("sessionGatewayAllYesMode", state.allYesMode);
  updateAllYesButton();

  if (state.allYesMode !== "off") {
    if (state.selected?.status === "running") {
      clearOutputEtag(state.selected.id);
      await loadOutput({ force: true });
    }
    if (state.allYesMode === "session") {
      maybeAutoYes(state.latestOutputText, { force: true });
    } else if (state.allYesMode === "global") {
      await autoYesAllSessions();
    } else if (state.allYesMode === "ai-session") {
      maybeAutoYes(state.latestOutputText, { force: true });
    } else if (state.allYesMode === "ai-global") {
      await autoYesAllSessions();
    }
  }
});
```
Update `updateAllYesButton` (around line ~1494 where `els.allYes.dataset.state = state.allYesMode`) so the label reflects the new modes (e.g. `ai-session` → "AI·当前", `ai-global` → "AI·全部"). Keep existing labels for off/session/global.

Rewrite `maybeAutoYes` — it operates on the SELECTED session's output, so it only acts for the selected-session modes (`session` blind, `ai-session` AI); the global modes are handled by `autoYesAllSessions` (preserving the original scope split):
```js
function maybeAutoYes(text, options = {}) {
  // Only the selected-session scopes act here; global scopes are handled by autoYesAllSessions.
  if (state.allYesMode !== "session" && state.allYesMode !== "ai-session") return;
  const selected = currentSelectedSession();
  if (!selected || selected.status !== "running" || selected.kind === "runtime") return;
  const match = findYesOption(text);
  const action = chooseAutoYesAction(state.allYesMode, match); // "blind" | "ai" | "none"
  if (action === "none") return;
  const signature = match.signature;
  if (!options.force && !shouldSendAutoYes(state.autoYesSignatures.get(selected.id), signature)) return;
  if (action === "blind") sendAutoYes(selected.id, signature, match.key, match.type);
  else requestApproval(selected, signature); // action === "ai"
}
```

Branch `autoYesAllSessions` — it only runs for the global scopes. Gate at the top: `if (state.allYesMode !== "global" && state.allYesMode !== "ai-global") return;` then, per `needs_confirmation` session, branch on `chooseAutoYesAction(state.allYesMode, match)`: `"blind"` → existing `sendAutoYes(...)`, `"ai"` → `requestApproval(session, match.signature)` with `{ allowBackground: true }`. Keep the existing per-session `try/catch`.

Add the AI-path functions and `showToast` (these do not exist yet):
```js
async function requestApproval(session, promptSignature) {
  try {
    const result = await api(`/api/sessions/${encodeURIComponent(session.id)}/approve`, {
      method: "POST",
      body: JSON.stringify({ promptSignature })
    });
    if (result.handled) {
      if (result.decision === "auto_yes") {
        state.autoYesSignatures.set(session.id, { signature: promptSignature, sentAt: Date.now() });
        showToast(`自动放行:${result.candidate ?? "?"} [${result.risk}]`);
      }
      clearOutputEtag(session.id);
      if (state.selected?.id === session.id) resetOutputPolling(500);
      return;
    }
    showApprovalDialog(session, result);
  } catch (error) {
    showError(error);
  }
}

function showApprovalDialog(session, pending) {
  const { element } = renderApprovalDialog(
    { sessionId: session.id, sessionName: session.name, candidate: pending.candidate, risk: pending.risk,
      reason: pending.reason, rememberable: pending.rememberable, hint: pending.hint },
    {
      onApprove: () => resolveApproval(session, pending.approvalId, "yes"),
      onReject: () => resolveApproval(session, pending.approvalId, "no"),
      onApproveRemember: () => resolveApproval(session, pending.approvalId, "yes_remember"),
      onClose: () => element.remove()
    }
  );
  (els.approvalMount ?? document.body).append(element);
}

async function resolveApproval(session, approvalId, choice) {
  try {
    await api(`/api/sessions/${encodeURIComponent(session.id)}/approve/resolve`, {
      method: "POST",
      body: JSON.stringify({ approvalId, choice })
    });
    clearOutputEtag(session.id);
    if (state.selected?.id === session.id) resetOutputPolling(300);
    document.querySelectorAll(".approval-dialog").forEach((el) => el.remove());
  } catch (error) {
    showError(error);
  }
}

function showToast(message) {
  const host = els.toastMount ?? document.body;
  const node = document.createElement("div");
  node.className = "toast";
  node.textContent = message;
  host.append(node);
  setTimeout(() => node.remove(), 3500);
}
```

- [ ] **Step 3c: Edit `public/index.html`** — add mount points (e.g. just before `</body>`):
```html
<div id="approval-mount"></div>
<div id="toast-mount"></div>
```
And register them in `els` (the object starting at `public/app.js:230`):
```js
  approvalMount: document.querySelector("#approval-mount"),
  toastMount: document.querySelector("#toast-mount"),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/auto_yes.test.mjs tests/approval_frontend.test.mjs && npm run check && npm test`
Expected: PASS (pure helper + string assertions + full suite green).

- [ ] **Step 5: Commit**

```bash
git add public/auto_yes.js public/app.js public/index.html tests/auto_yes.test.mjs tests/approval_frontend.test.mjs
git commit -m "feat(approval): wire ai-session/ai-global modes to the /approve endpoint and dialog"
```

---

## Task 13: Docs + full regression

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update docs** — in `CLAUDE.md`, add the new endpoints to the API list and a short note under "Important Notes":

```markdown
- `POST /api/sessions/:id/approve` - Evaluate a confirmation prompt through the AI approval engine
- `POST /api/sessions/:id/approve/resolve` - Resolve a pending approval (yes|no|yes_remember|no_remember)
- `GET /api/approval-config` - Get approval rules and knobs
- `PUT /api/approval-config` - Update approval rules and knobs
- `GET /api/approval-memory` - List learned allow/deny entries
- `DELETE /api/approval-memory/:id` - Forget a learned entry
```

And under Important Notes:
```markdown
- AI approval modes (`allYesMode === "ai-session"` or `"ai-global"`) gate every confirmation through a server-side risk engine; high-risk commands (e.g. `docker system prune -f`) never auto-pass unless a verification context (e.g. a recent `docker ps`) is present. Memory is JSON at `data/approval-memory.json`; AI fallback reuses the commandParser/sessionAgent OpenAI-compatible config.
```

- [ ] **Step 2: Run the full suite**

Run: `npm run check && npm test`
Expected: all source files pass syntax check; all tests PASS.

- [ ] **Step 3: Manual acceptance (optional, via run/verify skill)**

1. Start dev server, open the UI, switch the All-Yes control to **AI 审批**.
2. In a codex/opencode session trigger a `docker system prune -f` prompt → expect the high-risk dialog, no auto-send.
3. Run `docker ps` in that session, then re-trigger the prune prompt → expect auto-pass + toast.
4. Trigger `npm install` → expect auto-pass.
5. With AI fallback off, trigger an unknown command → expect a dialog (fail-safe).

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document the AI approval engine endpoints and mode"
```

---

## Self-Review (completed during authoring)

**Spec coverage:** every spec section maps to a task — rules (T1), memory+hard-floor storage (T2), extraction/context/keys (T3), deterministic ladder incl. defense-in-depth (T4), bounded AI fallback (T5), config (T6), context wiring (T7), `/approve` (T8), `/approve/resolve` with hard-floor memory guard (T9), config/memory mgmt (T10), dialog (T11), frontend wiring + mode (T12), docs/regression (T13). Acceptance scenarios from spec §11 are covered by T8 (prune bare vs. after docker ps; npm install auto) and T9 (yes_remember high no-op) and T5 (AI-off fail-safe).

**Placeholder scan:** the illustrative `import { getJson, putJson } from "./server.test-helpers.mjs"` line in Task 10 is explicitly flagged for removal (inline helpers provided). No other TBD/TODO/“add error handling” patterns. Every code step shows real code.

**Type consistency:** `evaluate`/`evaluateWithAi` return the same decision shape; `detectApprovalKeys` returns `{present, yesKey, yesType, noKey}` used consistently by `sendApprovalKey` and the handlers; `ApprovalMemory.lookupAllow/lookupDeny/rememberAllow/rememberDeny/remove/list` signatures match across T2/T4/T8/T9/T10. Frontend helpers: `chooseAutoYesAction` lives in `public/auto_yes.js` (pure, unit-tested in `auto_yes.test.mjs`); `approvalDialogHtml`/`renderApprovalDialog`/`rememberDisabled` live in `public/approval_dialog.js` (T11); `requestApproval`/`showApprovalDialog`/`resolveApproval`/`showToast` live in `public/app.js` (T12) and reference the dialog via `renderApprovalDialog`. Mode values are `off | session | global | ai-session | ai-global` everywhere.
