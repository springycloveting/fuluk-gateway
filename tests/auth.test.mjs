import assert from "node:assert/strict";
import test from "node:test";
import { isAuthorizedHeader } from "../src/auth.mjs";

test("isAuthorizedHeader accepts the configured bearer token", () => {
  assert.equal(isAuthorizedHeader("Bearer secret", "secret"), true);
});

test("isAuthorizedHeader rejects missing or incorrect tokens", () => {
  assert.equal(isAuthorizedHeader(undefined, "secret"), false);
  assert.equal(isAuthorizedHeader("Bearer wrong", "secret"), false);
});
