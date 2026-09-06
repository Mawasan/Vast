import { test, describe, before } from "node:test";
import assert from "node:assert/strict";

let parseEnvFile, applyEnv;
before(async () => {
  ({ parseEnvFile, applyEnv } = await import("../dist/core/config.js"));
});

describe("reading keys from a .env file", () => {
  test("parses plain, quoted, commented and exported lines", () => {
    const parsed = parseEnvFile(
      [
        "# a comment",
        "",
        "VAST_API_KEY=plain_value",
        'HF_TOKEN="quoted value"',
        "CIVITAI_API_TOKEN='single quoted'",
        "export VAST_URL=https://console.vast.ai",
        "   SPACED   =   trimmed   ",
        "not a pair",
      ].join("\n")
    );
    assert.equal(parsed.VAST_API_KEY, "plain_value");
    assert.equal(parsed.HF_TOKEN, "quoted value");
    assert.equal(parsed.CIVITAI_API_TOKEN, "single quoted");
    assert.equal(parsed.VAST_URL, "https://console.vast.ai");
    assert.equal(parsed.SPACED, "trimmed");
    assert.equal(Object.keys(parsed).length, 5);
  });

  test("a value containing '=' survives intact", () => {
    const parsed = parseEnvFile("KEY=abc=def==");
    assert.equal(parsed.KEY, "abc=def==");
  });

  test("a real environment variable beats the file", () => {
    const target = { VAST_API_KEY: "from_shell" };
    applyEnv({ VAST_API_KEY: "from_file" }, target);
    assert.equal(target.VAST_API_KEY, "from_shell");
  });

  test("an EMPTY environment variable is treated as unset, so the file wins", () => {
    // This is what an MCP client passes when the user's shell has no key set.
    // Node's own loadEnvFile would skip it and silently ignore the .env.
    const target = { VAST_API_KEY: "" };
    applyEnv({ VAST_API_KEY: "from_file" }, target);
    assert.equal(target.VAST_API_KEY, "from_file");
  });

  test("a variable absent from the environment is taken from the file", () => {
    const target = {};
    applyEnv({ CIVITAI_API_TOKEN: "from_file" }, target);
    assert.equal(target.CIVITAI_API_TOKEN, "from_file");
  });
});
