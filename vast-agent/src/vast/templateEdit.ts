import { resolveTemplate, updateTemplate } from "./templates.js";
import { buildManagedBlock, injectManagedBlock, parseManagedModels } from "./modelBlock.js";
import { parseDockerEnv, removeEnvVar, setEnvVar } from "../core/dockerEnv.js";
import { store } from "../core/store.js";
import { getHuggingFaceModelInfo, pickPrimaryWeightFile } from "../sources/huggingface.js";
import { pickPrimaryCivitaiFile, resolveCivitaiVersion } from "../sources/civitai.js";
import type { ModelResource, ModelRole, ModelSourceKind, VastTemplate } from "../core/types.js";

const HF_HOST = "https://huggingface.co";

/**
 * Surgical template mutations. Each of these resolves the template (by name,
 * id, or hash), changes exactly the thing being asked for, and writes the
 * result back via `updateTemplate` — nothing here ever creates a new template
 * or touches unrelated fields.
 */

async function loadTemplate(ref: string): Promise<VastTemplate> {
  const t = await resolveTemplate(ref);
  if (!t.hash_id) throw new Error(`Template "${t.name ?? ref}" has no hash_id, so it cannot be edited.`);
  return t;
}

export async function listModelsInTemplate(ref: string): Promise<ModelResource[]> {
  const t = await loadTemplate(ref);
  return parseManagedModels(t.onstart);
}

async function writeModels(t: VastTemplate, resources: ModelResource[]) {
  const onstart = injectManagedBlock(t.onstart, resources);
  return updateTemplate(t.hash_id as string, { onstart });
}

/**
 * Where a resource belongs on the instance when the caller didn't say. Follows
 * the ComfyUI layout this repo provisions, honouring a COMFYUI_DIR the
 * template already sets so a custom install path keeps working.
 */
function defaultTargetPath(t: VastTemplate, role: ModelRole): string {
  const comfyDir = parseDockerEnv(t.env).envVars.COMFYUI_DIR ?? "/workspace/ComfyUI";
  return `${comfyDir}/models/${role === "lora" ? "loras" : "checkpoints"}`;
}

export interface ResourceRequest {
  /** Display name; derived from the source when omitted. */
  name?: string;
  /** Omitted only when `name` refers to a LoRA the agent has seen before. */
  source?: ModelSourceKind;
  ref?: string;
  targetPath?: string;
  filename?: string;
  weight?: number;
}

/**
 * A request may name a LoRA the agent already knows ("add the akira lora
 * again") instead of repeating its source and ref. Fills those back in.
 */
async function withRememberedSource(
  req: ResourceRequest
): Promise<ResourceRequest & { source: ModelSourceKind; ref: string }> {
  if (req.source && req.ref) return req as ResourceRequest & { source: ModelSourceKind; ref: string };
  if (!req.name) {
    throw new Error("Provide either source + ref, or the name of a model/LoRA used before.");
  }
  const known = await store.findLora(req.name);
  if (!known) {
    throw new Error(
      `"${req.name}" is not a LoRA this agent has seen before, so source and ref are required. Search Hugging Face or Civitai for it first.`
    );
  }
  return { ...req, source: req.source ?? known.source, ref: req.ref ?? known.ref };
}

/**
 * Fills in whatever the caller left out: the exact weight filename (so one
 * file is downloaded instead of a whole repo), a display name, and the target
 * directory. Filename lookup is best-effort — if the source can't be reached,
 * the download falls back to fetching the full repo/version.
 */
async function resolveResource(
  t: VastTemplate,
  role: ModelRole,
  request: ResourceRequest
): Promise<ModelResource> {
  const req = await withRememberedSource(request);
  let filename = req.filename;
  let name = req.name;
  let ref = req.ref;
  let url: string | undefined;
  let revision: string | undefined;

  if (req.source === "huggingface") {
    try {
      const info = await getHuggingFaceModelInfo(req.ref);
      filename ??= pickPrimaryWeightFile(info.files)?.path;
      name ??= info.id.split("/").pop() ?? info.id;
      revision = info.sha;
      // Pin to the commit sha rather than a moving branch, so a workflow
      // artifact URL stays reproducible.
      if (filename && revision) {
        url = `${HF_HOST}/${req.ref}/resolve/${revision}/${filename}`;
      }
    } catch {
      // Leave unresolved; the generated command still works, just coarser.
    }
    await store.rememberHuggingFaceRepo(req.ref);
  } else if (req.source === "civitai") {
    try {
      const version = await resolveCivitaiVersion(Number(req.ref));
      // Downloads need the *version* id, which may differ from what was passed.
      ref = String(version.id);
      const file = pickPrimaryCivitaiFile(version);
      filename ??= file?.name;
      name ??= version.name;
      url = `https://civitai.com/api/download/models/${version.id}`;
    } catch {
      // Same best-effort fallback as above.
    }
    await store.rememberCivitaiModel(req.ref);
  } else {
    url = req.ref;
  }

  name ??= req.ref.split("/").pop() ?? req.ref;

  return {
    name,
    role,
    source: req.source,
    ref,
    targetPath: req.targetPath ?? defaultTargetPath(t, role),
    ...(filename ? { filename } : {}),
    ...(url ? { url } : {}),
    ...(revision ? { revision } : {}),
    ...(req.weight !== undefined ? { weight: req.weight } : {}),
  };
}

export async function setBaseModel(templateRef: string, req: ResourceRequest): Promise<VastTemplate> {
  const t = await loadTemplate(templateRef);
  const resource = await resolveResource(t, "base", req);
  const rest = parseManagedModels(t.onstart).filter((m) => m.role !== "base");
  return writeModels(t, [...rest, resource]);
}

export async function addLora(templateRef: string, req: ResourceRequest): Promise<VastTemplate> {
  const t = await loadTemplate(templateRef);
  const resource = await resolveResource(t, "lora", req);
  const rest = parseManagedModels(t.onstart).filter((m) => m.name !== resource.name);
  await store.rememberLora({ name: resource.name, source: resource.source, ref: resource.ref });
  return writeModels(t, [...rest, resource]);
}

export async function removeLora(templateRef: string, name: string): Promise<VastTemplate> {
  const t = await loadTemplate(templateRef);
  const models = parseManagedModels(t.onstart);
  const needle = name.toLowerCase();
  const remaining = models.filter(
    (m) => !(m.role === "lora" && m.name.toLowerCase().includes(needle))
  );
  if (remaining.length === models.length) {
    throw new Error(
      `No LoRA matching "${name}" on template "${t.name}". Attached: ` +
        (models.filter((m) => m.role === "lora").map((m) => m.name).join(", ") || "(none)")
    );
  }
  return writeModels(t, remaining);
}

export async function setLoraWeight(
  templateRef: string,
  name: string,
  weight: number
): Promise<VastTemplate> {
  const t = await loadTemplate(templateRef);
  const models = parseManagedModels(t.onstart);
  const needle = name.toLowerCase();
  const target = models.find((m) => m.role === "lora" && m.name.toLowerCase().includes(needle));
  if (!target) {
    throw new Error(
      `No LoRA matching "${name}" on template "${t.name}". Attached: ` +
        (models.filter((m) => m.role === "lora").map((m) => m.name).join(", ") || "(none)")
    );
  }
  target.weight = weight;
  return writeModels(t, models);
}

export async function setEnvVars(
  templateRef: string,
  vars: Record<string, string | null>
): Promise<VastTemplate> {
  const t = await loadTemplate(templateRef);
  let env = t.env;
  for (const [key, value] of Object.entries(vars)) {
    env = value === null ? removeEnvVar(env, key) : setEnvVar(env, key, value);
  }
  return updateTemplate(t.hash_id as string, { env });
}

/**
 * Replaces the free-form part of the start command. Any managed model/LoRA
 * download commands are preserved and re-appended.
 */
export async function setCustomStartCommand(templateRef: string, script: string): Promise<VastTemplate> {
  const t = await loadTemplate(templateRef);
  const models = parseManagedModels(t.onstart);
  const onstart = models.length > 0 ? `${script.trimEnd()}\n\n${buildManagedBlock(models)}\n` : script;
  return updateTemplate(t.hash_id as string, { onstart });
}
