import test from "node:test";
import assert from "node:assert/strict";

const { buildAnimaApiWorkflow } = await import("../dist/comfyui/anima.js");
const { buildSdxlApiWorkflow } = await import("../dist/comfyui/sdxl.js");

const base = {
  name: "One Obsession v4",
  role: "base",
  source: "url",
  ref: "https://example.com/model",
  filename: "oneObsessionAnima_v40.safetensors",
  targetPath: "/workspace/ComfyUI/models/diffusion_models",
};

test("Anima workflow uses UNETLoader and model-only LoRAs in order", () => {
  const workflow = buildAnimaApiWorkflow([
    base,
    { ...base, name: "style-a", role: "lora", filename: "style-a.safetensors", targetPath: "/workspace/ComfyUI/models/loras", weight: 0.55 },
    { ...base, name: "style-b", role: "lora", filename: "style-b.safetensors", targetPath: "/workspace/ComfyUI/models/loras", weight: 0.45 },
  ], { prompt: "1girl", seed: 42 });
  assert.equal(workflow["1"].class_type, "UNETLoader");
  assert.equal(workflow["1"].inputs.unet_name, "oneObsessionAnima_v40.safetensors");
  assert.equal(workflow["4"].class_type, "LoraLoaderModelOnly");
  assert.deepEqual(workflow["4"].inputs.model, ["1", 0]);
  assert.equal(workflow["4"].inputs.strength_model, 0.55);
  assert.deepEqual(workflow["5"].inputs.model, ["4", 0]);
  const sampler = Object.values(workflow).find((node) => node.class_type === "KSampler");
  assert.deepEqual(sampler.inputs.model, ["5", 0]);
  assert.equal(Object.values(workflow).at(-1).class_type, "SaveImage");
});

test("Anima workflow uses attached text encoder and VAE resources", () => {
  const workflow = buildAnimaApiWorkflow([
    base,
    { ...base, name: "encoder", role: "text_encoder", filename: "custom-qwen.safetensors", targetPath: "/workspace/ComfyUI/models/text_encoders" },
    { ...base, name: "vae", role: "vae", filename: "custom-vae.safetensors", targetPath: "/workspace/ComfyUI/models/vae" },
  ], { prompt: "1girl" });
  assert.equal(workflow["2"].inputs.clip_name, "custom-qwen.safetensors");
  assert.equal(workflow["3"].inputs.vae_name, "custom-vae.safetensors");
});

test("Anima workflow rejects an SDXL checkpoint template", () => {
  assert.throws(
    () => buildAnimaApiWorkflow([{ ...base, targetPath: "/workspace/ComfyUI/models/checkpoints" }], { prompt: "test" }),
    /not an Anima template/
  );
});

test("SDXL workflow chains model and CLIP through every LoRA", () => {
  const workflow = buildSdxlApiWorkflow([
    { ...base, role: "base", filename: "illustrious.safetensors", targetPath: "/workspace/ComfyUI/models/checkpoints" },
    { ...base, name: "style", role: "lora", filename: "style.safetensors", targetPath: "/workspace/ComfyUI/models/loras", weight: 0.6 },
  ], { prompt: "1girl", seed: 7 });
  assert.equal(workflow["1"].class_type, "CheckpointLoaderSimple");
  assert.equal(workflow["2"].class_type, "LoraLoader");
  assert.deepEqual(workflow["2"].inputs.model, ["1", 0]);
  assert.deepEqual(workflow["2"].inputs.clip, ["1", 1]);
  const encoders = Object.values(workflow).filter((node) => node.class_type === "CLIPTextEncode");
  assert.ok(encoders.every((node) => JSON.stringify(node.inputs.clip) === JSON.stringify(["2", 1])));
  const sampler = Object.values(workflow).find((node) => node.class_type === "KSampler");
  assert.deepEqual(sampler.inputs.model, ["2", 0]);
});
