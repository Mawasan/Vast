import type { ModelResource } from "../core/types.js";
import { attachInitImage, type AnimaWorkflowOptions, type ApiWorkflow } from "./anima.js";

const fileOf = (resource: ModelResource) => resource.filename ?? `${resource.name}.safetensors`;

function nextNodeId(workflow: ApiWorkflow): string {
  return String(Math.max(0, ...Object.keys(workflow).map(Number)) + 1);
}

/** Minimal API-format SDXL/Illustrious workflow built from one template's resources. */
export function buildSdxlApiWorkflow(resources: ModelResource[], options: AnimaWorkflowOptions): ApiWorkflow {
  const base = resources.find((resource) => resource.role === "base");
  if (!base) throw new Error("The image template has no attached base model.");
  if (!base.targetPath.replace(/\\/g, "/").includes("/checkpoints")) {
    throw new Error("The selected template is not an SDXL/Illustrious template: its base model is not in models/checkpoints.");
  }

  const width = options.width ?? 832;
  const height = options.height ?? 1216;
  if (width % 64 !== 0 || height % 64 !== 0 || width < 512 || height < 512 || width > 2048 || height > 2048) {
    throw new Error("Image width and height must be 512-2048 and divisible by 64.");
  }

  const workflow: ApiWorkflow = {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: fileOf(base) }, _meta: { title: "Checkpoint" } },
  };
  let modelRef: [string, number] = ["1", 0];
  let clipRef: [string, number] = ["1", 1];
  let nextId = 2;
  for (const lora of resources.filter((resource) => resource.role === "lora")) {
    const id = String(nextId++);
    workflow[id] = {
      class_type: "LoraLoader",
      inputs: { model: modelRef, clip: clipRef, lora_name: fileOf(lora), strength_model: lora.weight ?? 1, strength_clip: lora.weight ?? 1 },
      _meta: { title: lora.name },
    };
    modelRef = [id, 0];
    clipRef = [id, 1];
  }

  const positiveId = String(nextId++);
  const negativeId = String(nextId++);
  workflow[positiveId] = { class_type: "CLIPTextEncode", inputs: { text: options.prompt, clip: clipRef } };
  workflow[negativeId] = { class_type: "CLIPTextEncode", inputs: { text: options.negativePrompt ?? "worst quality, low quality, lowres, blurry, bad anatomy, bad hands, watermark, text", clip: clipRef } };

  const latentRef = options.initImage
    ? attachInitImage(workflow, options.initImage, ["1", 2], width, height)
    : (() => {
        const latentId = String(nextId++);
        workflow[latentId] = { class_type: "EmptyLatentImage", inputs: { width, height, batch_size: 1 } };
        return [latentId, 0] as [string, number];
      })();

  const samplerId = nextNodeId(workflow);
  const decodeId = String(Number(samplerId) + 1);
  const saveId = String(Number(samplerId) + 2);
  workflow[samplerId] = {
    class_type: "KSampler",
    inputs: {
      seed: options.seed ?? Math.floor(Math.random() * Number.MAX_SAFE_INTEGER),
      steps: options.steps ?? 30,
      cfg: options.cfg ?? 5.5,
      sampler_name: options.samplerName ?? "dpmpp_2m_sde",
      scheduler: options.scheduler ?? "karras",
      denoise: options.initImage ? 0.68 : 1,
      model: modelRef,
      positive: [positiveId, 0],
      negative: [negativeId, 0],
      latent_image: latentRef,
    },
  };
  workflow[decodeId] = { class_type: "VAEDecode", inputs: { samples: [samplerId, 0], vae: ["1", 2] } };
  workflow[saveId] = { class_type: "SaveImage", inputs: { filename_prefix: "AKIRA_SDXL", images: [decodeId, 0] } };
  return workflow;
}
