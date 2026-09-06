import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { startMockVast } from "./mockVast.js";

// The config module reads env once at import time, so set it up first.
let mock;
let tools;

const ILLUSTRIOUS = {
  id: 101,
  hash_id: "hash-illustrious",
  creator_id: 42,
  name: "Illustrious ComfyUI",
  image: "vastai/comfyui:latest",
  env: "-e COMFYUI_DIR=/workspace/ComfyUI -e OPEN_BUTTON_PORT=8188 -p 8188:8188",
  onstart: "bash /workspace/repo/comfyui/onstart.sh",
  runtype: "ssh",
  use_ssh: true,
  recommended_disk_space: 60,
};

const ANIMAGINE = {
  id: 102,
  hash_id: "hash-animagine",
  creator_id: 42,
  name: "Animagine ComfyUI",
  image: "vastai/comfyui:latest",
  env: "-e COMFYUI_DIR=/workspace/ComfyUI",
  onstart: "echo hi",
  runtype: "ssh",
};

const RUNNING_INSTANCE = {
  id: 555,
  label: "comfy-box",
  actual_status: "running",
  cur_state: "running",
  gpu_name: "RTX 4090",
  num_gpus: 1,
  dph_total: 0.42,
  template_hash_id: "hash-illustrious",
  extra_env: [],
  start_date: 1700000000,
};

before(async () => {
  mock = await startMockVast({
    templates: [ILLUSTRIOUS, ANIMAGINE],
    instances: [RUNNING_INSTANCE],
  });
  process.env.VAST_URL = mock.url;
  process.env.VAST_API_KEY = "test-key";
  process.env.VAST_AGENT_DATA_DIR = "/tmp/vast-agent-test-data";
  ({ tools } = await import("../dist/tools/registry.js"));
});

after(async () => {
  await mock.close();
});

const call = (name, input = {}) => {
  const tool = tools.find((t) => t.name === name);
  assert.ok(tool, `tool ${name} should exist`);
  return tool.handler(input);
};

const currentTemplate = (hashId) => mock.state.templates.find((t) => t.hash_id === hashId);

describe('"nimm mein Illustrious-Template und füge den Akira-LoRA hinzu"', () => {
  test("resolves the template by partial name — no hash needed", async () => {
    const t = await call("vast_get_template", { template: "illustrious" });
    assert.equal(t.hash_id, "hash-illustrious");
  });

  test("adds the LoRA, picking the ComfyUI loras path from the template's own COMFYUI_DIR", async () => {
    await call("vast_add_lora", {
      template: "illustrious",
      name: "akira",
      source: "url",
      ref: "https://example.com/akira.safetensors",
      weight: 0.8,
    });

    const models = await call("vast_list_template_models", { template: "illustrious" });
    assert.equal(models.length, 1);
    assert.equal(models[0].name, "akira");
    assert.equal(models[0].role, "lora");
    assert.equal(models[0].weight, 0.8);
    assert.equal(models[0].targetPath, "/workspace/ComfyUI/models/loras");
  });

  test("keeps the existing runtime, image and env untouched", async () => {
    const t = currentTemplate("hash-illustrious");
    assert.equal(t.image, ILLUSTRIOUS.image);
    assert.equal(t.env, ILLUSTRIOUS.env);
    assert.equal(t.runtype, "ssh");
    assert.equal(t.recommended_disk_space, 60);
  });

  test("preserves the user's own onstart commands around the managed block", async () => {
    const t = currentTemplate("hash-illustrious");
    assert.match(t.onstart, /bash \/workspace\/repo\/comfyui\/onstart\.sh/);
    assert.match(t.onstart, /akira\.safetensors/);
    assert.ok(t.onstart.indexOf("akira.safetensors") < t.onstart.indexOf("bash /workspace/repo/comfyui/onstart.sh"));
  });

  test("edits in place — it never creates a second template", () => {
    assert.equal(mock.state.templates.length, 2);
    assert.equal(mock.state.requests.filter((r) => r.method === "POST").length, 0);
  });
});

describe("multiple LoRAs and weights", () => {
  test("a second LoRA coexists with the first", async () => {
    await call("vast_add_lora", {
      template: "illustrious",
      name: "neon",
      source: "url",
      ref: "https://example.com/neon.safetensors",
    });
    const models = await call("vast_list_template_models", { template: "illustrious" });
    assert.deepEqual(models.map((m) => m.name).sort(), ["akira", "neon"]);
  });

  test("weight can be changed by partial name", async () => {
    await call("vast_set_lora_weight", { template: "illustrious", name: "neo", weight: 0.35 });
    const models = await call("vast_list_template_models", { template: "illustrious" });
    assert.equal(models.find((m) => m.name === "neon").weight, 0.35);
  });

  test("removing one LoRA leaves the other intact", async () => {
    await call("vast_remove_lora", { template: "illustrious", name: "akira" });
    const models = await call("vast_list_template_models", { template: "illustrious" });
    assert.deepEqual(models.map((m) => m.name), ["neon"]);
  });

  test('"add the akira lora again" works from memory, without repeating source/ref', async () => {
    await call("vast_add_lora", { template: "animagine", name: "akira" });
    const models = await call("vast_list_template_models", { template: "animagine" });
    assert.equal(models.length, 1);
    assert.equal(models[0].name, "akira");
    assert.equal(models[0].ref, "https://example.com/akira.safetensors");
  });

  test("an unknown name without source/ref fails clearly instead of inventing one", async () => {
    await assert.rejects(
      () => call("vast_add_lora", { template: "animagine", name: "never-seen-lora" }),
      /not a LoRA this agent has seen before/
    );
  });

  test("removing a LoRA that isn't there fails loudly instead of silently succeeding", async () => {
    await assert.rejects(
      () => call("vast_remove_lora", { template: "illustrious", name: "nope" }),
      /No LoRA matching "nope"/
    );
  });
});

describe("base model swap", () => {
  test("sets the base model into models/checkpoints and replaces any previous base", async () => {
    await call("vast_set_template_base_model", {
      template: "illustrious",
      name: "illustrious-xl",
      source: "url",
      ref: "https://example.com/illustrious.safetensors",
    });
    await call("vast_set_template_base_model", {
      template: "illustrious",
      name: "animagine-xl",
      source: "url",
      ref: "https://example.com/animagine.safetensors",
    });

    const models = await call("vast_list_template_models", { template: "illustrious" });
    const bases = models.filter((m) => m.role === "base");
    assert.equal(bases.length, 1, "only one base model at a time");
    assert.equal(bases[0].name, "animagine-xl");
    assert.equal(bases[0].targetPath, "/workspace/ComfyUI/models/checkpoints");
    assert.ok(models.some((m) => m.name === "neon"), "LoRAs survive a base model swap");
  });

  test("a direct Civitai download URL uses the account token when one is available", async () => {
    await call("vast_set_template_base_model", {
      template: "illustrious",
      name: "kodoranime",
      source: "url",
      ref: "https://civitai.com/api/download/models/3285126?fileId=3169463",
      filename: "kodoranime.safetensors",
    });
    const script = currentTemplate("hash-illustrious").onstart;
    assert.match(script, /CIVITAI_API_TOKEN/);
    assert.match(script, /Authorization: Bearer \$CIVITAI_API_TOKEN/);
    assert.match(script, /fileId=3169463/);
  });
});

describe("env vars stay surgical", () => {
  test("setting one variable leaves the others and the port mapping alone", async () => {
    await call("vast_set_template_env_vars", {
      template: "illustrious",
      vars: { MODEL_NAME: "animagine", OPEN_BUTTON_PORT: null },
    });
    const env = currentTemplate("hash-illustrious").env;
    assert.match(env, /-e COMFYUI_DIR=\/workspace\/ComfyUI/);
    assert.match(env, /-e MODEL_NAME=animagine/);
    assert.doesNotMatch(env, /OPEN_BUTTON_PORT/);
    assert.match(env, /-p 8188:8188/, "port mapping preserved");
  });
});

describe("template GPU filters", () => {
  test("legacy repeatedly encoded filters are repaired on the next edit", async () => {
    const legacy = JSON.stringify(JSON.stringify(JSON.stringify({ gpu_ram: { gte: 24000 } })));
    currentTemplate("hash-animagine").extra_filters = legacy;
    await call("vast_update_template", { template: "animagine", desc: "repaired" });
    assert.deepEqual(currentTemplate("hash-animagine").extra_filters, { gpu_ram: { gte: 24000 } });
  });

  test("GPU filters can be set as an object without JSON encoding", async () => {
    await call("vast_update_template", {
      template: "animagine",
      extraFilters: { compute_cap: { gte: 800 }, gpu_ram: { gte: 24000 } },
    });
    assert.deepEqual(currentTemplate("hash-animagine").extra_filters, {
      compute_cap: { gte: 800 },
      gpu_ram: { gte: 24000 },
    });
  });

  test("an unparseable legacy value remains readable and can be explicitly repaired", async () => {
    currentTemplate("hash-animagine").extra_filters = '"broken legacy value';
    const readable = await call("vast_get_template", { template: "animagine" });
    assert.equal(readable.name, "Animagine ComfyUI");
    await call("vast_update_template", {
      template: "animagine",
      extraFilters: { gpu_ram: { gte: 24000 } },
    });
    assert.deepEqual(currentTemplate("hash-animagine").extra_filters, { gpu_ram: { gte: 24000 } });
  });
});

describe("ambiguous or unknown template names", () => {
  test("an ambiguous name lists the candidates instead of guessing", async () => {
    await assert.rejects(
      () => call("vast_get_template", { template: "comfyui" }),
      /matches 2 of your templates/
    );
  });

  test("an unknown name lists what you actually have", async () => {
    await assert.rejects(
      () => call("vast_get_template", { template: "sdxl-turbo" }),
      /Illustrious ComfyUI/
    );
  });
});

describe("instances", () => {
  test("lists instances with status, GPU and price", async () => {
    const list = await call("vast_list_instances");
    assert.equal(list.length, 1);
    assert.equal(list[0].id, 555);
    assert.equal(list[0].gpu_name, "RTX 4090");
    assert.equal(list[0].dph_total, 0.42);
    assert.equal(list[0].template_hash_id, "hash-illustrious");
  });

  test("destroy without confirm makes NO destructive call", async () => {
    const before = mock.state.requests.filter((r) => r.method === "DELETE").length;
    const res = await call("vast_destroy_instance", { id: 555 });
    assert.equal(res.status, "confirmation_required");
    const after = mock.state.requests.filter((r) => r.method === "DELETE").length;
    assert.equal(after, before, "no DELETE was issued");
    assert.ok(mock.state.instances.some((i) => i.id === 555), "instance still alive");
  });

  test("destroy with confirm actually destroys and verifies the id is gone", async () => {
    const res = await call("vast_destroy_instance", { id: 555, confirm: true });
    assert.equal(res.destroyed, true);
    assert.equal(mock.state.instances.length, 0);
    assert.ok(
      mock.state.requests.some((r) => r.method === "DELETE" && r.path === "/api/v0/instances/555/")
    );
  });

  test("a destroy that leaves the instance alive is reported as a failure, not success", async () => {
    // Re-add an instance the mock refuses to delete, to prove verification bites.
    mock.state.instances.push({ ...RUNNING_INSTANCE, id: 777 });
    const { verifyDestroyed } = await import("../dist/vast/instances.js");
    const verification = await verifyDestroyed(777, { retries: 2, delayMs: 10 });
    assert.equal(verification.destroyed, false);
    assert.equal(verification.lastSeen.id, 777);
    mock.state.instances = [];
  });
});

describe("secrets", () => {
  test("account env var check returns names only, never values", async () => {
    const res = await call("vast_check_account_env_vars");
    assert.deepEqual(res.names, ["HF_TOKEN"]);
    assert.equal(res.hfTokenPresent, true);
    assert.equal(res.civitaiTokenPresent, false);
    assert.doesNotMatch(JSON.stringify(res), /should-never-be-returned/);
  });
});

describe("template deletion", () => {
  test("delete without confirm previews and deletes nothing", async () => {
    const res = await call("vast_delete_template", { template: "animagine" });
    assert.equal(res.status, "confirmation_required");
    assert.equal(res.preview.hashId, "hash-animagine");
    assert.equal(mock.state.templates.length, 2);
  });
});
