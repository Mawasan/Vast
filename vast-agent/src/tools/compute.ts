import { z } from "zod";
import type { ToolDef } from "./registry.js";
import { getJob, submitJob } from "../core/jobs.js";
import { searchOffers, rentInstance, setInstanceState } from "../vast/lifecycle.js";
import { runInference } from "../vast/inference.js";
import { selectLoras } from "../vast/loraSelection.js";
import { listModelsInTemplate } from "../vast/templateEdit.js";
import { buildAnimaApiWorkflow } from "../comfyui/anima.js";
import { buildSdxlApiWorkflow } from "../comfyui/sdxl.js";
import { listEndpoints, listWorkergroups, prepareTemplateEndpoint } from "../vast/serverless.js";

function def<S extends z.ZodRawShape>(tool: ToolDef<S>): ToolDef { return tool as unknown as ToolDef; }
const requestId = z.string().min(1).max(160).describe("Unique operation ID. Reuse exactly this ID and arguments after a disconnect to avoid duplicate billing.");
const confirm = z.boolean().default(false).describe("True only when the user has authorized this operation and its costs.");
const endpoint = z.string().min(1).max(256).describe("Existing Vast Serverless endpoint name.");
const cost = z.number().finite().nonnegative().default(100).describe("Estimated compute workload for Vast routing, NOT a dollar spending limit.");
const timeoutSeconds = z.number().int().min(10).max(1800).default(600);
const preview = (action: string, details: unknown) => ({ status: "confirmation_required", action, details, message: "Set confirm:true once this operation is authorized. Existing explicit authorization is sufficient." });
const inferenceShape = { requestId, endpoint, cost, timeoutSeconds, confirm };
const initImageBase64 = z.string().min(24).max(16_000_000).optional().describe("Optional character avatar as raw base64 or a data-URL. Uploaded to the assigned worker and used as an img2img identity reference.");
/**
 * Which of a template's LoRAs a single request wants. A template that backs
 * one shared endpoint carries every LoRA, so the caller picks per image.
 */
const loraSelection = z
  .array(z.object({ name: z.string().min(1), weight: z.number().finite().min(0).max(2).optional() }))
  .optional()
  .describe("Which of the template's LoRAs to apply, in chain order, with optional strength overrides. Omit to apply every LoRA the template carries; pass [] for the plain base model.");

export const computeTools: ToolDef[] = [
  def({ name: "vast_search_offers", description: "Search current on-demand GPU offers with pricing. Read-only. Put Vast fields directly inside filters (never another filters object), e.g. gpu_name:{eq:'RTX_4090'}, gpu_ram:{gte:24000}, dph_total:{lte:0.5}.",
    inputShape: { filters: z.record(z.string(), z.unknown()).default({}), limit: z.number().int().min(1).max(100).default(10), diskGb: z.number().positive().max(10000).default(40) },
    handler: async ({ filters, limit, diskGb }) => searchOffers(filters, limit, diskGb) }),
  def({ name: "vast_rent_instance", description: "Rent an on-demand GPU from a specific offer using an existing template. Rechecks quoted hourly price against maxHourlyUsd. Returns a durable job; poll vast_get_job. Does not auto-stop; storage/traffic charges may apply separately.",
    inputShape: { requestId, confirm, offerId: z.number().int().positive(), template: z.string().min(1), diskGb: z.number().positive().max(10000), maxHourlyUsd: z.number().finite().nonnegative(), label: z.string().max(256).optional() },
    handler: async ({ requestId, confirm, ...input }) => confirm ? submitJob(requestId, "rent", input, () => rentInstance(input)) : preview("rent", input) }),
  ...(["running", "stopped"] as const).map(state => def({
    name: state === "running" ? "vast_start_instance" : "vast_stop_instance",
    description: state === "running" ? "Start a stopped instance; GPU billing resumes. Returns observed status; poll vast_get_instance if transition is pending." : "Stop an instance and preserve its disk. Storage billing continues. Returns observed status; poll vast_get_instance if pending.",
    inputShape: { id: z.number().int().positive(), confirm },
    handler: async ({ id, confirm }) => confirm ? setInstanceState(id, state) : preview(state, { id }),
  })),
  def({ name: "vast_list_endpoints", description: "List configured Vast Serverless endpoints to find the name required for inference. Omits endpoint credentials.", inputShape: {}, handler: async () => listEndpoints() }),
  def({ name: "vast_list_workergroups", description: "List Vast Serverless workergroups and their endpoint/template mapping. Omits endpoint credentials and launch secrets.", inputShape: {}, handler: async () => listWorkergroups() }),
  def({ name: "vast_prepare_template_endpoint", description: "Create a scale-to-zero Vast Serverless endpoint and workergroup for an existing image template, or reuse its existing workergroup. Keeps one cold (stopped) worker disk so models survive scale-down; does not launch an idle GPU. Requires confirm:true.",
    inputShape: { template: z.string().min(1), endpointName: z.string().optional(), confirm },
    handler: async ({ template, endpointName, confirm }) => confirm
      ? prepareTemplateEndpoint(template, endpointName)
      : preview("prepare_template_endpoint", { template, endpointName: endpointName || "automatic", maxWorkers: 1, coldWorkers: 1, testWorkers: 0 }) }),
  def({ name: "vast_serverless_request", description: "Run text, image, audio, or video inference on an existing Vast Serverless endpoint using its native payload. Returns a durable job ID immediately; poll vast_get_job. Can trigger autoscaling and costs. No API keys needed in arguments. Does not create/configure endpoints.",
    inputShape: { ...inferenceShape, path: z.enum(["/generate/sync", "/generate", "/v1/chat/completions", "/v1/completions", "/v1/audio/speech", "/v1/images/generations"]), payload: z.record(z.string(), z.unknown()) },
    handler: async ({ requestId, confirm, ...input }) => confirm ? submitJob(requestId, "inference", input, () => runInference(input)) : preview("inference", { endpoint: input.endpoint, path: input.path }) }),
  def({ name: "vast_generate_image", description: "Execute a ComfyUI API-format workflow on an existing Vast Serverless image endpoint. Accepts node-id objects with class_type/inputs, NOT the editor nodes/links format. Supports any installed checkpoint/LoRA through the workflow. Returns a job; poll vast_get_job. Inline images, public URLs, and ComfyUI local_path outputs are supported.",
    inputShape: { ...inferenceShape, workflow: z.record(z.string(), z.object({ class_type: z.string().min(1), inputs: z.record(z.string(), z.unknown()), _meta: z.unknown().optional() })).refine(value => Object.keys(value).length > 0, "Workflow cannot be empty") },
    handler: async ({ requestId, confirm, workflow, ...input }) => {
      const args = { ...input, path: "/generate/sync", payload: { input: { request_id: requestId, workflow_json: workflow } } };
      return confirm ? submitJob(requestId, "image", args, () => runInference(args)) : preview("image_generation", { endpoint: input.endpoint });
    } }),
  def({ name: "vast_generate_anima_image", description: "Generate an image with an AKIRA Anima template on an existing Vast Serverless ComfyUI endpoint. Builds the correct UNET/Anima workflow automatically and chains the LoRAs chosen in `loras`, or every attached LoRA at its saved weight when that is omitted. Pass `initImageBase64` to condition on a character avatar. Returns a durable job; poll vast_get_job.",
    inputShape: {
      ...inferenceShape,
      template: z.string().min(1),
      prompt: z.string().min(1),
      negativePrompt: z.string().optional(),
      width: z.number().int().min(512).max(2048).multipleOf(64).default(896),
      height: z.number().int().min(512).max(2048).multipleOf(64).default(1152),
      steps: z.number().int().min(1).max(100).default(35),
      cfg: z.number().finite().min(0).max(30).default(4.5),
      samplerName: z.string().default("euler"),
      scheduler: z.string().default("simple"),
      seed: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
      loras: loraSelection,
      initImageBase64,
    },
    handler: async ({ requestId, confirm, template, prompt, negativePrompt, width, height, steps, cfg, samplerName, scheduler, seed, loras, initImageBase64, ...input }) => {
      const operation = { template, prompt, negativePrompt, width, height, steps, cfg, samplerName, scheduler, seed, loras, initImageBase64, ...input };
      if (!confirm) return preview("anima_image_generation", { endpoint: input.endpoint, template, width, height, hasInitImage: Boolean(initImageBase64) });
      return submitJob(requestId, "anima_image", operation, async () => {
        const resources = selectLoras(await listModelsInTemplate(template), loras);
        const options = { prompt, negativePrompt, width, height, steps, cfg, samplerName, scheduler, seed };
        return runInference({
          ...input,
          path: "/generate/sync",
          payload: { input: { request_id: requestId, workflow_json: buildAnimaApiWorkflow(resources, options) } },
          initImageBase64,
          attachInitImage: (filename) => ({ input: { request_id: requestId, workflow_json: buildAnimaApiWorkflow(resources, { ...options, initImage: filename }) } }),
        });
      });
    } }),
  def({ name: "vast_generate_template_image", description: "Generate an image from any AKIRA Anima or SDXL/Illustrious template on its matching Vast Serverless endpoint. Builds the family-correct workflow. Pass `loras` to choose which of the template's LoRAs apply; omitted, every attached LoRA is chained in order. Pass `initImageBase64` to keep the chatting character's avatar as the identity reference. Returns a durable job; poll vast_get_job.",
    inputShape: {
      ...inferenceShape,
      template: z.string().min(1),
      prompt: z.string().min(1),
      negativePrompt: z.string().optional(),
      width: z.number().int().min(512).max(2048).multipleOf(64).optional(),
      height: z.number().int().min(512).max(2048).multipleOf(64).optional(),
      steps: z.number().int().min(1).max(100).optional(),
      cfg: z.number().finite().min(0).max(30).optional(),
      samplerName: z.string().optional(),
      scheduler: z.string().optional(),
      seed: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
      loras: loraSelection,
      initImageBase64,
    },
    handler: async ({ requestId, confirm, template, prompt, negativePrompt, width, height, steps, cfg, samplerName, scheduler, seed, loras, initImageBase64, ...input }) => {
      const operation = { template, prompt, negativePrompt, width, height, steps, cfg, samplerName, scheduler, seed, loras, initImageBase64, ...input };
      if (!confirm) return preview("template_image_generation", { endpoint: input.endpoint, template, width: width ?? "family default", height: height ?? "family default", hasInitImage: Boolean(initImageBase64) });
      return submitJob(requestId, "template_image", operation, async () => {
        const resources = selectLoras(await listModelsInTemplate(template), loras);
        const base = resources.find((resource) => resource.role === "base");
        if (!base) throw new Error("The selected template has no attached base model.");
        const options = { prompt, negativePrompt, width, height, steps, cfg, samplerName, scheduler, seed };
        const build = (initImage?: string) => base.targetPath.replace(/\\/g, "/").includes("/diffusion_models")
          ? buildAnimaApiWorkflow(resources, { ...options, initImage })
          : buildSdxlApiWorkflow(resources, { ...options, initImage });
        return runInference({
          ...input,
          path: "/generate/sync",
          payload: { input: { request_id: requestId, workflow_json: build() } },
          initImageBase64,
          attachInitImage: (filename) => ({ input: { request_id: requestId, workflow_json: build(filename) } }),
        });
      });
    } }),
  def({ name: "vast_get_job", description: "Get the durable result of a rent/inference job after reconnecting. running: poll again; completed: inspect result; unknown: inspect Vast before retrying. A server restart never automatically replays a billed operation.", inputShape: { requestId }, handler: async ({ requestId }) => getJob(requestId) }),
];
