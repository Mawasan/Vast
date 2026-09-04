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

const modelResourceFields = {
  name: z.string().describe("Stable name for this resource, e.g. the LoRA's display name"),
  source: z.enum(["huggingface", "civitai", "url"]),
  ref: z
    .string()
    .describe("HF repo id, Civitai model-version id (as a string), or a direct download URL"),
  targetPath: z.string().describe("Directory on the instance to download the file(s) into"),
  filename: z.string().optional(),
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
    description: "Read a single Vast.ai template's full configuration by hash_id or numeric id.",
    inputShape: { hashId: z.string().optional(), id: z.number().int().optional() },
    handler: async ({ hashId, id }) => {
      const t = await templates.getTemplate({ hashId, id });
      if (!t) throw new Error("Template not found.");
      return t;
    },
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
      hashId: z.string(),
      name: z.string().optional(),
      image: z.string().optional(),
      tag: z.string().optional(),
      env: z.string().optional(),
      onstart: z.string().optional(),
      runtype: z.enum(["args", "ssh", "jupyter"]).optional(),
      recommended_disk_space: z.number().optional(),
      desc: z.string().optional(),
    },
    handler: async ({ hashId, ...patch }) => templates.updateTemplate(hashId, patch),
  }),

  def({
    name: "vast_duplicate_template",
    description: "Duplicate an existing template, optionally overriding some fields on the copy.",
    inputShape: {
      hashId: z.string(),
      newName: z.string().optional(),
      overrides: z
        .object({ image: z.string().optional(), env: z.string().optional(), onstart: z.string().optional() })
        .optional(),
    },
    handler: async ({ hashId, newName, overrides }) =>
      templates.duplicateTemplate(hashId, { ...(overrides ?? {}), ...(newName ? { name: newName } : {}) }),
  }),

  def({
    name: "vast_delete_template",
    description:
      "Permanently delete a Vast.ai template. Irreversible — requires confirm:true, otherwise returns a preview instead of deleting.",
    destructive: true,
    inputShape: {
      hashId: z.string().optional(),
      templateId: z.number().int().optional(),
      confirm: z.boolean().optional(),
    },
    handler: async ({ hashId, templateId, confirm }) => {
      if (needsConfirmation(confirm)) {
        return confirmationRequired("delete_template", { hashId, templateId });
      }
      return templates.deleteTemplate({ hashId, templateId });
    },
  }),

  // ---- Template editing (models / LoRAs / env / start command) -----------
  def({
    name: "vast_list_template_models",
    description: "List the base model and LoRAs currently attached to a template's managed download block.",
    inputShape: { hashId: z.string() },
    handler: async ({ hashId }) => templateEdit.listModelsInTemplate(hashId),
  }),

  def({
    name: "vast_set_template_base_model",
    description:
      "Set (or replace) the base model a template downloads on start, from Hugging Face, Civitai, or a direct URL. Keeps the rest of the template unchanged.",
    inputShape: { hashId: z.string(), ...modelResourceFields },
    handler: async ({ hashId, ...resource }) => templateEdit.setBaseModel(hashId, resource),
  }),

  def({
    name: "vast_add_lora",
    description: "Attach a LoRA (from Hugging Face, Civitai, or a direct URL) to a template. Multiple LoRAs can coexist.",
    inputShape: { hashId: z.string(), ...modelResourceFields, weight: z.number().optional() },
    handler: async ({ hashId, weight, ...resource }) => templateEdit.addLora(hashId, { ...resource, weight }),
  }),

  def({
    name: "vast_remove_lora",
    description: "Remove a previously attached LoRA from a template by name.",
    inputShape: { hashId: z.string(), name: z.string() },
    handler: async ({ hashId, name }) => templateEdit.removeLora(hashId, name),
  }),

  def({
    name: "vast_set_lora_weight",
    description: "Change the strength/weight of a LoRA already attached to a template.",
    inputShape: { hashId: z.string(), name: z.string(), weight: z.number() },
    handler: async ({ hashId, name, weight }) => templateEdit.setLoraWeight(hashId, name, weight),
  }),

  def({
    name: "vast_set_template_env_vars",
    description:
      'Set or remove individual environment variables on a template without touching the rest of its Docker options. Pass null as a value to remove a key.',
    inputShape: { hashId: z.string(), vars: z.record(z.string(), z.string().nullable()) },
    handler: async ({ hashId, vars }) => templateEdit.setEnvVars(hashId, vars),
  }),

  def({
    name: "vast_set_template_start_command",
    description:
      "Replace the custom part of a template's onstart script. Any managed model/LoRA download commands are preserved and re-appended automatically.",
    inputShape: { hashId: z.string(), script: z.string() },
    handler: async ({ hashId, script }) => templateEdit.setCustomStartCommand(hashId, script),
  }),

  def({
    name: "vast_create_template_from_model",
    description:
      "Turn a Hugging Face or Civitai model into a Vast.ai template. If existingTemplateHashId is given, reuses that template's runtime/image and only sets the base model on it (preferred); otherwise creates a new minimal template around the model.",
    inputShape: {
      source: z.enum(["huggingface", "civitai"]),
      ref: z.string().describe("HF repo id, or Civitai model-version id as a string"),
      targetPath: z.string().default("/workspace/models"),
      existingTemplateHashId: z.string().optional(),
      newTemplateName: z.string().optional(),
      baseImage: z.string().default("vastai/pytorch:latest"),
    },
    handler: async ({ source, ref, targetPath, existingTemplateHashId, newTemplateName, baseImage }) => {
      let name: string;
      let totalSizeBytes = 0;
      if (source === "huggingface") {
        const info = await hf.getHuggingFaceModelInfo(ref);
        name = info.id;
        totalSizeBytes = info.totalSizeBytes;
        await store.rememberHuggingFaceRepo(ref);
      } else {
        const version = await civitai.getCivitaiModelVersion(Number(ref));
        name = version.name;
        totalSizeBytes = version.files.reduce((sum, f) => sum + (f.sizeKB ?? 0) * 1024, 0);
        await store.rememberCivitaiModel(ref);
      }
      const estimatedDiskGb = Math.max(20, Math.ceil((totalSizeBytes / 1e9) * 1.5));

      if (existingTemplateHashId) {
        return templateEdit.setBaseModel(existingTemplateHashId, { name, source, ref, targetPath });
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
