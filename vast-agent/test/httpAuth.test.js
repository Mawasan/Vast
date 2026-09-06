import assert from "node:assert/strict";
import test from "node:test";
import { hasValidAgentToken } from "../dist/http/auth.js";

test("remote agent authorization", async (t) => {
  await t.test("accepts the configured bearer token", () => {
    assert.equal(hasValidAgentToken("Bearer secret-value", "secret-value"), true);
  });

  await t.test("rejects missing, malformed, and incorrect credentials", () => {
    assert.equal(hasValidAgentToken(undefined, "secret-value"), false);
    assert.equal(hasValidAgentToken("secret-value", "secret-value"), false);
    assert.equal(hasValidAgentToken("Bearer wrong", "secret-value"), false);
  });

  await t.test("fails closed when no access token is configured", () => {
    assert.equal(hasValidAgentToken("Bearer anything", undefined), false);
  });
});
