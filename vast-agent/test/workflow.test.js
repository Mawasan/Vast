import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Exercises the graph surgery against the repo's real ComfyUI workflow, and
 * re-asserts the same invariants comfyui/tests/test_workflows.py checks, so a
 * patched graph is provably still loadable.
 */
const REAL_WORKFLOW = fileURLToPath(
  new URL("../../comfyui/workflows/illustrious-xl.json", import.meta.url)
);

let comfy;
before(async () => {
  comfy = await import("../dist/comfyui/workflow.js");
});

const fresh = () => JSON.parse(readFileSync(REAL_WORKFLOW, "utf8"));

/** The structural checks from the repo's own python workflow test. */
function assertStructurallySound(wf) {
  const nodes = new Map(wf.nodes.map((n) => [n.id, n]));
  assert.equal(nodes.size, wf.nodes.length, "node ids unique");
  const links = new Map(wf.links.map((l) => [l[0], l]));
  assert.equal(links.size, wf.links.length, "link ids unique");

  for (const [id, source, outSlot, target, inSlot, kind] of links.values()) {
    const output = nodes.get(source).outputs[outSlot];
    const input = nodes.get(target).inputs[inSlot];
    assert.equal(input.link, id, `link ${id} back-reference`);
    assert.ok(output.links.includes(id), `link ${id} listed on source output`);
    assert.equal(output.type, kind);
    assert.equal(input.type, kind);
  }

  for (const n of nodes.values()) {
    assert.equal(n.properties.cnr_id, "comfy-core");
    for (const input of n.inputs) assert.ok(links.has(input.link), `node ${n.id} input link exists`);
    for (const output of n.outputs) {
      for (const id of output.links) assert.ok(links.has(id), `node ${n.id} output link exists`);
    }
  }

  // Everything must be reachable walking backwards from SaveImage.
  const sink = [...nodes.values()].find((n) => n.type === "SaveImage");
  const reached = new Set();
  const pending = [sink.id];
  while (pending.length) {
    const id = pending.pop();
    if (reached.has(id)) continue;
    reached.add(id);
    for (const input of nodes.get(id).inputs) pending.push(links.get(input.link)[1]);
  }
  assert.deepEqual([...reached].sort(), [...nodes.keys()].sort(), "all nodes reachable");
}

describe("the repo's real illustrious-xl workflow", () => {
  test("starts out valid and LoRA-free", () => {
    const wf = fresh();
    assertStructurallySound(wf);
    assert.equal(comfy.validateWorkflow(wf).valid, true);
    assert.deepEqual(comfy.listLoras(wf), []);
    assert.equal(comfy.getCheckpoint(wf).filename, "Illustrious-XL-v1.1.safetensors");
  });

  test("stays structurally sound after inserting a LoRA", () => {
    const wf = comfy.addLora(fresh(), { filename: "akira.safetensors", strengthModel: 0.8 });
    assertStructurallySound(wf);
    assert.equal(comfy.validateWorkflow(wf).valid, true);
  });

  test("the LoRA actually sits between the checkpoint and the sampler", () => {
    const wf = comfy.addLora(fresh(), { filename: "akira.safetensors", strengthModel: 0.8 });
    const nodes = new Map(wf.nodes.map((n) => [n.id, n]));
    const links = new Map(wf.links.map((l) => [l[0], l]));

    const sampler = [...nodes.values()].find((n) => n.type === "KSampler");
    const modelInput = sampler.inputs.find((i) => i.type === "MODEL");
    const feedsSampler = nodes.get(links.get(modelInput.link)[1]);
    assert.equal(feedsSampler.type, "LoraLoader", "KSampler now draws MODEL from the LoRA");

    const loraModelIn = feedsSampler.inputs.find((i) => i.type === "MODEL");
    const feedsLora = nodes.get(links.get(loraModelIn.link)[1]);
    assert.equal(feedsLora.type, "CheckpointLoaderSimple", "the LoRA draws from the checkpoint");
  });

  test("both text encoders get their CLIP through the LoRA", () => {
    const wf = comfy.addLora(fresh(), { filename: "akira.safetensors" });
    const nodes = new Map(wf.nodes.map((n) => [n.id, n]));
    const links = new Map(wf.links.map((l) => [l[0], l]));
    const encoders = [...nodes.values()].filter((n) => n.type === "CLIPTextEncode");
    assert.equal(encoders.length, 2);
    for (const enc of encoders) {
      const src = nodes.get(links.get(enc.inputs[0].link)[1]);
      assert.equal(src.type, "LoraLoader", "CLIP is routed through the LoRA too");
    }
  });

  test("strength lands in widgets_values where ComfyUI reads it", () => {
    const wf = comfy.addLora(fresh(), { filename: "akira.safetensors", strengthModel: 0.65 });
    const lora = wf.nodes.find((n) => n.type === "LoraLoader");
    assert.deepEqual(lora.widgets_values, ["akira.safetensors", 0.65, 0.65]);
  });

  test("a pinned url is recorded the way checkpoints are, and never points at a moving branch", () => {
    const url = "https://huggingface.co/some/repo/resolve/abc123def/akira.safetensors";
    const wf = comfy.addLora(fresh(), { filename: "akira.safetensors", url });
    const lora = wf.nodes.find((n) => n.type === "LoraLoader");
    assert.deepEqual(lora.properties.models, [
      { name: "akira.safetensors", url, directory: "loras" },
    ]);
    assert.doesNotMatch(url, /\/resolve\/main\//);
  });

  test("two LoRAs chain in order, both routed into the sampler", () => {
    let wf = comfy.addLora(fresh(), { filename: "akira.safetensors", strengthModel: 0.8 });
    wf = comfy.addLora(wf, { filename: "neon.safetensors", strengthModel: 0.4 });
    assertStructurallySound(wf);
    assert.deepEqual(
      comfy.listLoras(wf).map((l) => [l.filename, l.strengthModel]),
      [["akira.safetensors", 0.8], ["neon.safetensors", 0.4]]
    );
  });

  test("removing the middle LoRA reconnects the chain cleanly", () => {
    let wf = comfy.addLora(fresh(), { filename: "a.safetensors" });
    wf = comfy.addLora(wf, { filename: "b.safetensors" });
    wf = comfy.addLora(wf, { filename: "c.safetensors" });
    wf = comfy.removeLora(wf, "b.safetensors");
    assertStructurallySound(wf);
    assert.deepEqual(comfy.listLoras(wf).map((l) => l.filename), ["a.safetensors", "c.safetensors"]);
  });

  test("removing every LoRA restores the original wiring", () => {
    const original = fresh();
    let wf = comfy.addLora(fresh(), { filename: "a.safetensors" });
    wf = comfy.removeLora(wf, "a.safetensors");
    assertStructurallySound(wf);
    assert.deepEqual(comfy.listLoras(wf), []);

    const modelConsumer = (w) => {
      const links = new Map(w.links.map((l) => [l[0], l]));
      const sampler = w.nodes.find((n) => n.type === "KSampler");
      return links.get(sampler.inputs.find((i) => i.type === "MODEL").link)[1];
    };
    assert.equal(modelConsumer(wf), modelConsumer(original), "KSampler is fed by the checkpoint again");
  });

  test("adding the same LoRA twice updates it instead of duplicating it", () => {
    let wf = comfy.addLora(fresh(), { filename: "akira.safetensors", strengthModel: 0.8 });
    wf = comfy.addLora(wf, { filename: "akira.safetensors", strengthModel: 0.3 });
    assert.equal(wf.nodes.filter((n) => n.type === "LoraLoader").length, 1);
    assert.equal(comfy.listLoras(wf)[0].strengthModel, 0.3);
    assertStructurallySound(wf);
  });

  test("removing a LoRA that isn't wired in fails loudly", () => {
    assert.throws(() => comfy.removeLora(fresh(), "ghost.safetensors"), /no LoRA matching "ghost/i);
  });
});

describe("syncing a workflow to a template's attached models", () => {
  const resources = [
    {
      name: "animagine",
      role: "base",
      source: "url",
      ref: "https://example.com/animagine.safetensors",
      url: "https://example.com/animagine.safetensors",
      filename: "animagine-xl-4.0-opt.safetensors",
      targetPath: "/workspace/ComfyUI/models/checkpoints",
    },
    {
      name: "akira",
      role: "lora",
      source: "url",
      ref: "https://example.com/akira.safetensors",
      url: "https://example.com/akira.safetensors",
      filename: "akira.safetensors",
      targetPath: "/workspace/ComfyUI/models/loras",
      weight: 0.8,
    },
  ];

  test("swaps the checkpoint and wires the LoRA in one pass", () => {
    const { workflow, changes, validation } = comfy.syncWorkflowToResources(fresh(), resources);
    assert.equal(validation.valid, true);
    assertStructurallySound(workflow);
    assert.equal(comfy.getCheckpoint(workflow).filename, "animagine-xl-4.0-opt.safetensors");
    assert.deepEqual(comfy.listLoras(workflow).map((l) => l.filename), ["akira.safetensors"]);
    assert.equal(changes.length, 2);
  });

  test("is idempotent — syncing twice changes nothing the second time", () => {
    const first = comfy.syncWorkflowToResources(fresh(), resources);
    const second = comfy.syncWorkflowToResources(first.workflow, resources);
    assert.deepEqual(second.changes, []);
    assert.equal(second.validation.valid, true);
  });

  test("dropping a LoRA from the template unwires it from the workflow", () => {
    const withLora = comfy.syncWorkflowToResources(fresh(), resources).workflow;
    const withoutLora = comfy.syncWorkflowToResources(
      withLora,
      resources.filter((r) => r.role === "base")
    );
    assert.deepEqual(comfy.listLoras(withoutLora.workflow), []);
    assert.match(withoutLora.changes.join(" "), /removed LoRA akira/);
    assertStructurallySound(withoutLora.workflow);
  });

  test("changing the weight in the template updates the node's strength", () => {
    const withLora = comfy.syncWorkflowToResources(fresh(), resources).workflow;
    const reweighted = comfy.syncWorkflowToResources(
      withLora,
      resources.map((r) => (r.role === "lora" ? { ...r, weight: 0.25 } : r))
    );
    assert.equal(comfy.listLoras(reweighted.workflow)[0].strengthModel, 0.25);
    assert.match(reweighted.changes.join(" "), /weight 0\.8 -> 0\.25/);
  });
});
