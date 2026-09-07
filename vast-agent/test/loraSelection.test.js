import test from "node:test";
import assert from "node:assert/strict";

const { selectLoras } = await import("../dist/vast/loraSelection.js");
const { buildAnimaApiWorkflow } = await import("../dist/comfyui/anima.js");

const base = { name: "Anima v1.0", role: "base", source: "civitai", ref: "1", targetPath: "/workspace/ComfyUI/models/diffusion_models", filename: "anima.safetensors" };
const encoder = { name: "enc", role: "text_encoder", source: "url", ref: "u", targetPath: "/x/text_encoders", filename: "enc.safetensors" };
const vae = { name: "vae", role: "vae", source: "url", ref: "u", targetPath: "/x/vae", filename: "vae.safetensors" };
const lora = (name, file, weight) => ({ name, role: "lora", source: "civitai", ref: "9", targetPath: "/x/loras", filename: file, weight });
const all = [base, encoder, vae, lora("Deep Penetration", "deep.safetensors", 0.8), lora("Pearly Esearu Anima Style", "pearly.safetensors", 0.45), lora("JAV Hardcore BDSM", "jav.safetensors", 0.8)];

test("omitting the selection keeps every LoRA, as before", () => {
  assert.deepEqual(selectLoras(all), all);
});

test("an empty selection yields the plain base model", () => {
  const picked = selectLoras(all, []);
  assert.equal(picked.filter((r) => r.role === "lora").length, 0);
  assert.equal(picked.filter((r) => r.role === "base").length, 1);
});

test("one LoRA out of many is applied alone, with the template's weight", () => {
  const picked = selectLoras(all, [{ name: "Pearly" }]);
  const loras = picked.filter((r) => r.role === "lora");
  assert.equal(loras.length, 1);
  assert.equal(loras[0].name, "Pearly Esearu Anima Style");
  assert.equal(loras[0].weight, 0.45);
});

test("a request can override the strength without touching the template", () => {
  const picked = selectLoras(all, [{ name: "Deep Penetration", weight: 0.3 }]);
  assert.equal(picked.find((r) => r.role === "lora").weight, 0.3);
  assert.equal(all[3].weight, 0.8, "the template's own weight stays untouched");
});

test("the caller's order becomes the chain order", () => {
  const picked = selectLoras(all, [{ name: "jav" }, { name: "deep" }]);
  assert.deepEqual(picked.filter((r) => r.role === "lora").map((r) => r.name), ["JAV Hardcore BDSM", "Deep Penetration"]);
});

test("a name that matches nothing fails loudly and lists what is attached", () => {
  assert.throws(() => selectLoras(all, [{ name: "nonexistent" }]), /Attached: Deep Penetration, Pearly Esearu Anima Style, JAV Hardcore BDSM/);
});

test("only the chosen LoRA reaches the ComfyUI workflow", () => {
  const workflow = buildAnimaApiWorkflow(selectLoras(all, [{ name: "Pearly" }]), { prompt: "test" });
  const nodes = Object.values(workflow).filter((n) => n.class_type === "LoraLoaderModelOnly");
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].inputs.lora_name, "pearly.safetensors");
  assert.equal(nodes[0].inputs.strength_model, 0.45);
});

test("with no selection all three LoRAs still chain, so nothing silently changed", () => {
  const workflow = buildAnimaApiWorkflow(all, { prompt: "test" });
  assert.equal(Object.values(workflow).filter((n) => n.class_type === "LoraLoaderModelOnly").length, 3);
});
