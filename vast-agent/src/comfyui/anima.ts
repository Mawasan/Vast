import type { ModelResource } from "../core/types.js";

export interface AnimaWorkflowOptions {
  prompt: string;
  negativePrompt?: string;
  width?: number;
  height?: number;
  steps?: number;
  cfg?: number;
  samplerName?: string;
  scheduler?: string;
  seed?: number;
  /** Filename already uploaded to the worker's ComfyUI input folder. */
  initImage?: string;
}

type ApiNode = { class_type: string; inputs: Record<string, unknown>; _meta?: { title: string } };
export type ApiWorkflow = Record<string, ApiNode>;

const fileOf = (resource: ModelResource) => resource.filename ?? `${resource.name}.safetensors`;

function nextNodeId(workflow: ApiWorkflow): string {
  return String(Math.max(0, ...Object.keys(workflow).map(Number)) + 1);
}

/** Encode a worker-side reference image into the sampler latent. */
export function attachInitImage(
  workflow: ApiWorkflow,
  initImage: string,
  vae: [string, number],
  width: number,
  height: number,
): [string, number] {
  const loadId = nextNodeId(workflow);
  workflow[loadId] = {
    class_type: "LoadImage",
    inputs: { image: initImage },
    _meta: { title: "Character reference" },
  };
  const scaleId = nextNodeId(workflow);
  workflow[scaleId] = {
    class_type: "ImageScale",
    inputs: { image: [loadId, 0], upscale_method: "lanczos", width, height, crop: "center" },
  };
  const encodeId = nextNodeId(workflow);
  workflow[encodeId] = {
    class_type: "VAEEncode",
    inputs: { pixels: [scaleId, 0], vae },
  };
  return [encodeId, 0];
}

/**
 * Minimal, custom-node-free Anima workflow for ComfyUI's API format.
 * Anima is Qwen-Image: UNET + Qwen CLIP + Qwen VAE, not an SDXL checkpoint.
 */
export function buildAnimaApiWorkflow(
  resources: ModelResource[],
  options: AnimaWorkflowOptions
): ApiWorkflow {
  const base = resources.find((resource) => resource.role === "base");
  if (!base) throw new Error("The Anima template has no attached base model.");
  if (!base.targetPath.replace(/\\/g, "/").includes("/diffusion_models")) {
    throw new Error("The selected template is not an Anima template: its base model is not in models/diffusion_models.");
  }
  const textEncoder = resources.find((resource) => resource.role === "text_encoder");
  const vae = resources.find((resource) => resource.role === "vae");

  const width = options.width ?? 896;
  const height = options.height ?? 1152;
  if (width % 64 !== 0 || height % 64 !== 0 || width < 512 || height < 512 || width > 2048 || height > 2048) {
    throw new Error("Anima width and height must be 512-2048 and divisible by 64.");
  }

  const workflow: ApiWorkflow = {
    "1": {
      class_type: "UNETLoader",
      inputs: { unet_name: fileOf(base), weight_dtype: "default" },
      _meta: { title: "Anima model" },
    },
    "2": {
      class_type: "CLIPLoader",
      inputs: {
        clip_name: textEncoder ? fileOf(textEncoder) : "qwen_3_06b_base.safetensors",
        type: "qwen_image",
        device: "default",
      },
      _meta: { title: "Anima text encoder" },
    },
    "3": {
      class_type: "VAELoader",
      inputs: { vae_name: vae ? fileOf(vae) : "qwen_image_vae.safetensors" },
      _meta: { title: "Anima VAE" },
    },
  };

  let modelRef: [string, number] = ["1", 0];
  let nextId = 4;
  for (const lora of resources.filter((resource) => resource.role === "lora")) {
    const id = String(nextId++);
    workflow[id] = {
      class_type: "LoraLoaderModelOnly",
      inputs: {
        model: modelRef,
        lora_name: fileOf(lora),
        strength_model: lora.weight ?? 1,
      },
      _meta: { title: lora.name },
    };
    modelRef = [id, 0];
  }

  const positiveId = String(nextId++);
  const negativeId = String(nextId++);
  workflow[positiveId] = { class_type: "CLIPTextEncode", inputs: { text: options.prompt, clip: ["2", 0] } };
  workflow[negativeId] = { class_type: "CLIPTextEncode", inputs: { text: options.negativePrompt ?? "worst quality, low quality, lowres, blurry, bad anatomy, watermark, text", clip: ["2", 0] } };

  const latentRef = options.initImage
    ? attachInitImage(workflow, options.initImage, ["3", 0], width, height)
    : (() => {
        const latentId = String(nextId++);
        workflow[latentId] = { class_type: "EmptySD3LatentImage", inputs: { width, height, batch_size: 1 } };
        return [latentId, 0] as [string, number];
      })();

  const samplerId = nextNodeId(workflow);
  const decodeId = String(Number(samplerId) + 1);
  const saveId = String(Number(samplerId) + 2);
  workflow[samplerId] = {
    class_type: "KSampler",
    inputs: {
      seed: options.seed ?? Math.floor(Math.random() * Number.MAX_SAFE_INTEGER),
      steps: options.steps ?? 35,
      cfg: options.cfg ?? 4.5,
      sampler_name: options.samplerName ?? "euler",
      scheduler: options.scheduler ?? "simple",
      denoise: options.initImage ? 0.68 : 1,
      model: modelRef,
      positive: [positiveId, 0],
      negative: [negativeId, 0],
      latent_image: latentRef,
    },
  };
  workflow[decodeId] = { class_type: "VAEDecode", inputs: { samples: [samplerId, 0], vae: ["3", 0] } };
  workflow[saveId] = { class_type: "SaveImage", inputs: { filename_prefix: "AKIRA_Anima", images: [decodeId, 0] } };
  return workflow;
}
