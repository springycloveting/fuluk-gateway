import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("terminal panes include padding inside their measured height", () => {
  const css = fs.readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");

  assert.ok(css.includes("#output,\n.xterm-output {\n  box-sizing: border-box;\n  min-height: 100%;"));
});

test("live xterm output renders the visible tail instead of the 300-line top", () => {
  const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

  assert.ok(app.includes("params.set(\"lines\", String(clampInteger(size.rows + 2, 20, 300)));"));
  assert.ok(app.includes("const snapshot = visibleTerminalSnapshot(text, size?.rows);"));
  assert.ok(app.includes("state.terminal.scrollToBottom();"));
  assert.equal(app.includes("state.terminal.scrollToTop();"), false);
});

test("updateOutputText tolerates a browser with no session selected", () => {
  // On a token-less browser the init flow hits GET /api/config -> 401, which
  // loadConfig reports via showError -> updateOutputText. If updateOutputText
  // dereferences state.selected.name while state.selected is null, the throw
  // escapes loadConfig's catch, loadConfig rejects, and the openConfig handler
  // (no try/catch) never reaches showModal() -> the config dialog cannot open
  // -> the user can never paste a token. This locks the null guard in place.
  const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

  assert.equal(app.includes("state.selected.name;"), false, "updateOutputText must not dereference state.selected.name without a null guard");
  assert.ok(app.includes("state.selected?.name"), "updateOutputText should null-guard the selected session name");
});

test("clicking config always opens the dialog even if loadConfig rejects", () => {
  // Defense-in-depth: the config dialog is the only way to enter a Bearer token,
  // so opening it must never depend on loadConfig succeeding. The handler must
  // run showModal() unconditionally (here via finally) regardless of whether
  // loadConfig / showError throws.
  const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

  assert.ok(
    /els\.openConfig\.addEventListener\("click", async \(\) => \{\s*try \{\s*await loadConfig\(\);\s*\} catch \(error\) \{\s*showError\(error\);\s*\} finally \{\s*els\.configDialog\.showModal\(\);\s*\}\s*\}\);/.test(app),
    "openConfig handler must wrap loadConfig in try/catch and open the dialog in finally"
  );
});
