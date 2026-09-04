import { getTemplate, updateTemplate } from "./templates.js";
import { buildManagedBlock, injectManagedBlock, parseManagedModels } from "./modelBlock.js";
import { removeEnvVar, setEnvVar } from "../core/dockerEnv.js";
import { store } from "../core/store.js";
import type { ModelResource, VastTemplate } from "../core/types.js";

/**
 * Surgical template mutations: each of these fetches the template, changes
 * exactly the thing being asked for, and writes the result back via
 * `updateTemplate`, which itself only PUTs the merged record — nothing here
 * ever creates a new template or touches unrelated fields.
 */

async function loadTemplate(hashId: string): Promise<VastTemplate> {
  const t = await getTemplate({ hashId });
  if (!t) throw new Error(`No template found with hash_id "${hashId}"`);
  return t;
}

export async function listModelsInTemplate(hashId: string): Promise<ModelResource[]> {
  const t = await loadTemplate(hashId);
  return parseManagedModels(t.onstart);
}

async function writeModels(hashId: string, t: VastTemplate, resources: ModelResource[]) {
  const onstart = injectManagedBlock(t.onstart, resources);
  return updateTemplate(hashId, { onstart });
}

export async function setBaseModel(
  hashId: string,
  resource: Omit<ModelResource, "role">
): Promise<VastTemplate> {
  const t = await loadTemplate(hashId);
  const existing = parseManagedModels(t.onstart).filter((m) => m.role !== "base");
  const updated = [...existing, { ...resource, role: "base" as const }];
  if (resource.source === "huggingface") await store.rememberHuggingFaceRepo(resource.ref);
  if (resource.source === "civitai") await store.rememberCivitaiModel(resource.ref);
  return writeModels(hashId, t, updated);
}

export async function addLora(
  hashId: string,
  resource: Omit<ModelResource, "role">
): Promise<VastTemplate> {
  const t = await loadTemplate(hashId);
  const existing = parseManagedModels(t.onstart).filter((m) => m.name !== resource.name);
  const updated = [...existing, { ...resource, role: "lora" as const }];
  await store.rememberLora({ name: resource.name, source: resource.source, ref: resource.ref });
  return writeModels(hashId, t, updated);
}

export async function removeLora(hashId: string, name: string): Promise<VastTemplate> {
  const t = await loadTemplate(hashId);
  const updated = parseManagedModels(t.onstart).filter((m) => !(m.role === "lora" && m.name === name));
  return writeModels(hashId, t, updated);
}

export async function setLoraWeight(hashId: string, name: string, weight: number): Promise<VastTemplate> {
  const t = await loadTemplate(hashId);
  const models = parseManagedModels(t.onstart);
  const target = models.find((m) => m.role === "lora" && m.name === name);
  if (!target) throw new Error(`No LoRA named "${name}" is attached to template ${hashId}`);
  target.weight = weight;
  return writeModels(hashId, t, models);
}

export async function setEnvVars(
  hashId: string,
  vars: Record<string, string | null>
): Promise<VastTemplate> {
  const t = await loadTemplate(hashId);
  let env = t.env;
  for (const [key, value] of Object.entries(vars)) {
    env = value === null ? removeEnvVar(env, key) : setEnvVar(env, key, value);
  }
  return updateTemplate(hashId, { env });
}

/**
 * Replaces the free-form part of the start command (everything outside the
 * managed model-download block), which is preserved untouched.
 */
export async function setCustomStartCommand(hashId: string, script: string): Promise<VastTemplate> {
  const t = await loadTemplate(hashId);
  const models = parseManagedModels(t.onstart);
  const managedBlock = buildManagedBlock(models);
  const onstart = models.length > 0 ? `${script.trimEnd()}\n\n${managedBlock}\n` : script;
  return updateTemplate(hashId, { onstart });
}
