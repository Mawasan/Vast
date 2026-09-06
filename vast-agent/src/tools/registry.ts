import { z } from "zod";
import * as templates from "../vast/templates.js";
import * as instances from "../vast/instances.js";
import * as templateEdit from "../vast/templateEdit.js";
import * as hf from "../sources/huggingface.js";
import * as civitai from "../sources/civitai.js";
import { confirmationRequired, needsConfirmation } from "../core/confirm.js";
import { store } from "../core/store.js";

export interface ToolDef<Shape extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  description: string;
  inputShape: Shape;
  destructive?: boolean;
  handler: (input: z.infer<z.ZodObject<Shape>>) => Promise<unknown>;
}

const templateRef = z
  .string()
  .describe("Template name (partial, case-insensitive), hash_id, or numeric id — e.g. \"illustrious\"");

const modelResourceFields = {
  source: z
    .enum(["huggingface", "civitai", "url"])
    .optional()
    .describe("Optional only when `name` refers to a LoRA this agent has attached before"),
  ref: z
    .string()
    .optional()
    .describe("HF repo id, Civitai model or model-version id (as a string), or a direct download URL"),
  name: z
    .string()
    .optional()
    .describe("Display name; also used to look up a previously used LoRA when source/ref are omitted"),
  targetPath: z
    .string()
    .optional()
    .describe("Download directory on the instance; defaults to the template's ComfyUI models/loras or models/checkpoints"),
  filename: z
    .string()
    .optional()
    .describe("Exact weight file; auto-detected from the source when omitted"),
};

function def<Shape extends z.ZodRawShape>(t: ToolDef<Shape>): ToolDef {
  return t as unknown as ToolDef;
}

export const tools: ToolDef[] = [
  // ---- Templates ----------------------------------------------------------
  def({
    name: "vast_list_templates",
    description:
      "List Vast.ai templates. By default lists only templates you created; pass mineOnly:false to include public/recommended ones matching the filter.",
    inputShape: {
      mineOnly: z.boolean().default(true),
      nameContains: z.string().optional(),
    },
    handler: async ({ mineOnly, nameContains }) => {
      const all = mineOnly ? await templates.listMyTemplates() : await templates.searchTemplates();
      return nameContains
        ? all.filter((t) => (t.name ?? "").toLowerCase().includes(nameContains.toLowerCase()))
        : all;
    },
  }),

  def({
    name: "vast_get_template",
    description:
      "Read a single Vast.ai template's full configuration. Accepts its name (partial match), hash_id, or numeric id.",
    inputShape: { template: templateRef },
    handler: async ({ template }) => templates.resolveTemplate(template),
  }),

  def({
    name: "vast_validate_template_config",
    description:
      "Validate a template configuration (name, image, runtype, env string, disk space) without calling the Vast.ai API.",
    inputShape: {
      name: z.string().optional(),
      image: z.string().optional(),
      runtype: z.enum(["args", "ssh", "jupyter"]).optional(),
      env: z.string().optional(),
      recommended_disk_space: z.number().optional(),
    },
    handler: async (fields) => templates.validateTemplateFields(fields, { isCreate: true }),
  }),

  def({
    name: "vast_create_template",
    description:
      "Create a new Vast.ai template from scratch. Prefer vast_duplicate_template or the edit tools when a similar template already exists, to reuse configuration instead of starting over.",
    inputShape: {
      name: z.string(),
      image: z.string(),
      tag: z.string().optional(),
      env: z.string().optional().describe('Docker options string, e.g. "-e KEY=value -p 8000:8000"'),
      onstart: z.string().optional(),
      runtype: z.enum(["args", "ssh", "jupyter"]).default("ssh"),
      use_ssh: z.boolean().optional(),
      recommended_disk_space: z.number().optional(),
      desc: z.string().optional(),
      private: z.boolean().default(true),
    },
    handler: async (fields) => templates.createTemplate(fields),
  }),

  def({
    name: "vast_update_template",
    description:
      "Apply a partial update to an existing template (only the fields you pass are changed; everything else is preserved). Use this instead of creating a new template for small edits.",
    inputShape: {
      template: templateRef,
      name: z.string().optional(),
      image: z.string().optional(),
      tag: z.string().optional(),
      env: z.string().optional(),
      onstart: z.string().optional(),
      runtype: z.enum(["args", "ssh", "jupyter"]).optional(),
      recommended_disk_space: z.number().optional(),
      desc: z.string().optional(),
    },
    handler: async ({ template, ...patch }) =>
      templates.updateTemplate(await templates.resolveTemplateHashId(template), patch),
  }),

  def({
    name: "vast_duplicate_template",
    description: "Duplicate an existing template, optionally overriding some fields on the copy.",
    inputShape: {
      template: templateRef,
      newName: z.string().optional(),
      overrides: z
        .object({ image: z.string().optional(), env: z.string().optional(), onstart: z.string().optional() })
        .optional(),
    },
    handler: async ({ template, newName, overrides }) =>
      templates.duplicateTemplate(await templates.resolveTemplateHashId(template), {
        ...(overrides ?? {}),
        ...(newName ? { name: newName } : {}),
      }),
  }),

  def({
    name: "vast_delete_template",
    description:
      "Permanently delete a Vast.ai template. Irreversible — requires confirm:true, otherwise returns a preview instead of deleting.",
    destructive: true,
    inputShape: { template: templateRef, confirm: z.boolean().optional() },
    handler: async ({ template, confirm }) => {
      const resolved = await templates.resolveTemplate(template);
      if (needsConfirmation(confirm)) {
        return confirmationRequired("delete_template", {
          name: resolved.name,
          hashId: resolved.hash_id,
          id: resolved.id,
        });
      }
      return templates.deleteTemplate({ hashId: resolved.hash_id, templateId: resolved.id });
    },
  }),

  // ---- Template editing (models / LoRAs / env / start command) -----------
  def({
    name: "vast_list_template_models",
    description: "List the base model and LoRAs currently attached to a template's managed download block.",
    inputShape: { template: templateRef },
    handler: async ({ template }) => templateEdit.listModelsInTemplate(template),
  }),

  def({
    name: "vast_set_template_base_model",
    description:
      "Set (or replace) the base model a template downloads on start, from Hugging Face, Civitai, or a direct URL. The exact weight file and download directory are resolved automatically; the rest of the template is left untouched.",
    inputShape: { template: templateRef, ...modelResourceFields },
    handler: async ({ template, ...resource }) => templateEdit.setBaseModel(template, resource),
  }),

  def({
    name: "vast_add_lora",
    description:
      "Attach a LoRA (Hugging Face, Civitai, or a direct URL) to a template, keeping its existing runtime and any LoRAs already attached.",
    inputShape: { template: templateRef, ...modelResourceFields, weight: z.number().optional() },
    handler: async ({ template, ...resource }) => templateEdit.addLora(template, resource),
  }),

  def({
    name: "vast_remove_lora",
    description: "Remove an attached LoRA from a template by name (partial match is fine).",
    inputShape: { template: templateRef, name: z.string() },
    handler: async ({ template, name }) => templateEdit.removeLora(template, name),
  }),

  def({
    name: "vast_set_lora_weight",
    description: "Change the strength/weight of a LoRA already attached to a template.",
    inputShape: { template: templateRef, name: z.string(), weight: z.number() },
    handler: async ({ template, name, weight }) => templateEdit.setLoraWeight(template, name, weight),
  }),

  def({
    name: "vast_set_template_env_vars",
    description:
      "Set or remove individual environment variables on a template without touching the rest of its Docker options. Pass null as a value to remove a key. Never put secrets here — use Vast.ai's account environment variables for those.",
    inputShape: { template: templateRef, vars: z.record(z.string(), z.string().nullable()) },
    handler: async ({ template, vars }) => templateEdit.setEnvVars(template, vars),
  }),

  def({
    name: "vast_set_template_start_command",
    description:
      "Replace the custom part of a template's onstart script. Any managed model/LoRA download commands are preserved and re-appended automatically.",
    inputShape: { template: templateRef, script: z.string() },
    handler: async ({ template, script }) => templateEdit.setCustomStartCommand(template, script),
  }),

  def({
    name: "vast_check_account_env_vars",
    description:
      "List the NAMES (never the values) of the environment variables set on your Vast.ai account, which instances inherit. Use this to check that e.g. CIVITAI_API_TOKEN or HF_TOKEN exists before a template's download command relies on it.",
    inputShape: {},
    handler: async () => {
      const names = await templates.listAccountEnvVarNames();
      return {
        names,
        hfTokenPresent: names.includes("HF_TOKEN"),
        civitaiTokenPresent: names.includes("CIVITAI_API_TOKEN"),
      };
    },
  }),

  def({
    name: "vast_create_template_from_model",
    description:
      "Turn a Hugging Face or Civitai model into a Vast.ai template. If existingTemplateHashId is given, reuses that template's runtime/image and only sets the base model on it (preferred); otherwise creates a new minimal template around the model.",
    inputShape: {
      source: z.enum(["huggingface", "civitai"]),
      ref: z.string().describe("HF repo id, or Civitai model / model-version id as a string"),
      targetPath: z.string().optional(),
      existingTemplate: templateRef
        .optional()
        .describe("Name/hash/id of a template to reuse instead of creating a new one — strongly preferred"),
      newTemplateName: z.string().optional(),
      baseImage: z.string().default("vastai/pytorch:latest"),
    },
    handler: async ({ source, ref, targetPath, existingTemplate, newTemplateName, baseImage }) => {
      let name: string;
      let totalSizeBytes = 0;
      if (source === "huggingface") {
        const info = await hf.getHuggingFaceModelInfo(ref);
        name = info.id.split("/").pop() ?? info.id;
        totalSizeBytes = hf.pickPrimaryWeightFile(info.files)?.sizeBytes ?? info.totalSizeBytes;
      } else {
        const version = await civitai.resolveCivitaiVersion(Number(ref));
        name = version.name;
        totalSizeBytes = (civitai.pickPrimaryCivitaiFile(version)?.sizeKB ?? 0) * 1024;
      }
      const estimatedDiskGb = Math.max(20, Math.ceil((totalSizeBytes / 1e9) * 1.5) + 10);

      if (existingTemplate) {
        return templateEdit.setBaseModel(existingTemplate, { name, source, ref, targetPath });
      }

      const created = await templates.createTemplate({
        name: newTemplateName ?? `${name} template`,
        image: baseImage,
        runtype: "ssh",
        use_ssh: true,
        recommended_disk_space: estimatedDiskGb,
      });
      if (!created.hash_id) throw new Error("Template was created but no hash_id was returned by Vast.ai.");
      return templateEdit.setBaseModel(created.hash_id, { name, source, ref, targetPath });
    },
  }),

  // ---- Instances ------------------------------------------------------------
  def({
    name: "vast_list_instances",
    description: "List all of your active Vast.ai instances with status, GPU, price, and template info.",
    inputShape: {},
    handler: async () => instances.listInstances(),
  }),

  def({
    name: "vast_get_instance",
    description: "Get full details for one Vast.ai instance by id.",
    inputShape: { id: z.number().int() },
    handler: async ({ id }) => {
      const inst = await instances.getInstance(id);
      if (!inst) throw new Error(`Instance ${id} not found (it may already be destroyed).`);
      return inst;
    },
  }),

  def({
    name: "vast_destroy_instance",
    description:
      "Permanently destroy a Vast.ai instance (not stop/pause). Irreversible — requires confirm:true. After destroying, verifies the instance id no longer exists before reporting success.",
    destructive: true,
    inputShape: { id: z.number().int(), confirm: z.boolean().optional() },
    handler: async ({ id, confirm }) => {
      if (needsConfirmation(confirm)) {
        const preview = await instances.getInstance(id).catch(() => null);
        return confirmationRequired("destroy_instance", { id, currentState: preview });
      }
      await instances.destroyInstance(id);
      const verification = await instances.verifyDestroyed(id);
      await store.recordAction(
        "vast_destroy_instance",
        `instance ${id}: ${verification.destroyed ? "confirmed destroyed" : "NOT confirmed destroyed"}`
      );
      if (!verification.destroyed) {
        throw new Error(
          `Destroy was requested for instance ${id}, but it still exists after ${verification.attempts} checks. Treat this as NOT destroyed and investigate.`
        );
      }
      return { destroyed: true, id, attempts: verification.attempts };
    },
  }),

  // ---- Hugging Face ----------------------------------------------------------
  def({
    name: "huggingface_search_models",
    description: "Search Hugging Face Hub for models (checkpoints, LoRAs, etc.) by keyword.",
    inputShape: { query: z.string(), limit: z.number().int().min(1).max(50).default(10), pipelineTag: z.string().optional() },
    handler: async (input) => hf.searchHuggingFaceModels(input),
  }),

  def({
    name: "huggingface_get_model_info",
    description:
      "Get details for a specific Hugging Face model: files, approximate total size, gating, and inferred model type (checkpoint/lora/etc).",
    inputShape: { repoId: z.string() },
    handler: async ({ repoId }) => {
      const info = await hf.getHuggingFaceModelInfo(repoId);
      await store.rememberHuggingFaceRepo(repoId);
      return info;
    },
  }),

  // ---- Civitai ----------------------------------------------------------------
  def({
    name: "civitai_search_models",
    description: "Search Civitai for models (checkpoints, LoRAs) by keyword.",
    inputShape: {
      query: z.string(),
      limit: z.number().int().min(1).max(50).default(10),
      types: z.array(z.enum(["Checkpoint", "LORA", "TextualInversion", "VAE", "ControlNet"])).optional(),
    },
    handler: async (input) => civitai.searchCivitaiModels(input),
  }),

  def({
    name: "civitai_get_model_info",
    description: "Get details for a specific Civitai model by its numeric model id, including its latest version and files.",
    inputShape: { modelId: z.number().int() },
    handler: async ({ modelId }) => {
      const info = await civitai.getCivitaiModelInfo(modelId);
      await store.rememberCivitaiModel(String(modelId));
      return info;
    },
  }),

  def({
    name: "civitai_get_model_version",
    description: "Get details for a specific Civitai model VERSION by its numeric version id (needed for exact download URLs/base model).",
    inputShape: { versionId: z.number().int() },
    handler: async ({ versionId }) => civitai.getCivitaiModelVersion(versionId),
  }),

  // ---- Misc ---------------------------------------------------------------
  def({
    name: "vast_whoami",
    description: "Return the authenticated Vast.ai account info (used internally to scope 'my templates').",
    inputShape: {},
    handler: async () => templates.getCurrentUser(),
  }),

  def({
    name: "vast_agent_memory",
    description: "Dump the VAST Agent's small local memory: known template/instance ids, recent model sources, and recent actions.",
    inputShape: {},
    handler: async () => store.dump(),
  }),
];

export function getTool(name: string): ToolDef | undefined {
  return tools.find((t) => t.name === name);
}
