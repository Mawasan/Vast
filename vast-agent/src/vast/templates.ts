import { vastClient } from "../core/vastClient.js";
import { store } from "../core/store.js";
import type { SelectFilters, VastTemplate, VastTemplateFields } from "../core/types.js";

const TEMPLATE_WRITE_KEYS: (keyof VastTemplateFields)[] = [
  "name",
  "image",
  "tag",
  "href",
  "repo",
  "env",
  "onstart",
  "jup_direct",
  "ssh_direct",
  "use_jupyter_lab",
  "runtype",
  "use_ssh",
  "jupyter_dir",
  "docker_login_repo",
  "extra_filters",
  "recommended_disk_space",
  "readme",
  "readme_visible",
  "desc",
  "private",
];

const TEMPLATE_DEFAULTS: VastTemplateFields = {
  jup_direct: false,
  ssh_direct: false,
  use_jupyter_lab: false,
  runtype: "args",
  use_ssh: false,
  extra_filters: {},
  readme_visible: true,
  private: true,
};

function pickWriteFields(t: Partial<VastTemplate>): VastTemplateFields {
  const out: VastTemplateFields = {};
  for (const key of TEMPLATE_WRITE_KEYS) {
    if (t[key] !== undefined) (out as Record<string, unknown>)[key] = t[key];
  }
  return out;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateTemplateFields(
  fields: VastTemplateFields,
  { isCreate }: { isCreate: boolean }
): ValidationResult {
  const errors: string[] = [];
  if (isCreate) {
    if (!fields.name) errors.push("name is required");
    if (!fields.image) errors.push("image is required");
  }
  if (fields.runtype && !["args", "ssh", "jupyter"].includes(fields.runtype)) {
    errors.push(`runtype must be one of args, ssh, jupyter (got "${fields.runtype}")`);
  }
  if (
    fields.recommended_disk_space !== undefined &&
    (typeof fields.recommended_disk_space !== "number" || fields.recommended_disk_space <= 0)
  ) {
    errors.push("recommended_disk_space must be a positive number (GB)");
  }
  if (fields.env !== undefined && typeof fields.env !== "string") {
    errors.push("env must be a Docker-options flag string, e.g. \"-e KEY=value -p 8000:8000\"");
  }
  return { valid: errors.length === 0, errors };
}

export async function getCurrentUser(): Promise<{ id: number; [key: string]: unknown }> {
  const res = (await vastClient.get("/users/current")) as { id: number };
  return res;
}

export async function searchTemplates(filters?: SelectFilters): Promise<VastTemplate[]> {
  const res = (await vastClient.get("/template/", {
    select_cols: ["*"],
    select_filters: filters ?? {},
  })) as { templates?: VastTemplate[] };
  return res.templates ?? [];
}

export async function listMyTemplates(): Promise<VastTemplate[]> {
  const user = await getCurrentUser();
  return searchTemplates({ creator_id: { eq: user.id } });
}

export async function getTemplate(ref: { hashId?: string; id?: number }): Promise<VastTemplate | null> {
  if (!ref.hashId && ref.id === undefined) {
    throw new Error("getTemplate requires hashId or id");
  }
  const filters: SelectFilters = ref.hashId
    ? { hash_id: { eq: ref.hashId } }
    : { id: { eq: ref.id } };
  const results = await searchTemplates(filters);
  return results[0] ?? null;
}

export async function createTemplate(fields: VastTemplateFields): Promise<VastTemplate> {
  const validation = validateTemplateFields(fields, { isCreate: true });
  if (!validation.valid) {
    throw new Error(`Invalid template configuration: ${validation.errors.join("; ")}`);
  }
  const body: VastTemplateFields = { ...TEMPLATE_DEFAULTS, ...fields };
  const res = (await vastClient.post("/template/", body)) as {
    template?: VastTemplate;
    success?: boolean;
  };
  const template = res.template ?? (res as unknown as VastTemplate);
  await store.rememberTemplate({
    id: template.id,
    hash_id: template.hash_id,
    name: template.name ?? fields.name,
    lastSeenAt: new Date().toISOString(),
  });
  return template;
}

/**
 * Partial, surgical update: fetches the current template, merges only the
 * provided fields on top of it, and writes the full merged record back.
 * This avoids ever creating a brand-new template just to change one value
 * (e.g. the model, a LoRA env var, or the start command).
 */
export async function updateTemplate(
  hashId: string,
  patch: VastTemplateFields
): Promise<VastTemplate> {
  const current = await getTemplate({ hashId });
  if (!current) throw new Error(`No template found with hash_id "${hashId}"`);

  const merged: VastTemplateFields = { ...pickWriteFields(current), ...patch };
  const validation = validateTemplateFields(merged, { isCreate: false });
  if (!validation.valid) {
    throw new Error(`Invalid template configuration: ${validation.errors.join("; ")}`);
  }

  const res = (await vastClient.put("/template/", { hash_id: hashId, ...merged })) as {
    template?: VastTemplate;
  };
  const template = res.template ?? { ...current, ...merged, hash_id: hashId };
  await store.rememberTemplate({
    id: template.id ?? current.id,
    hash_id: hashId,
    name: template.name ?? current.name,
    lastSeenAt: new Date().toISOString(),
  });
  return template;
}

export async function duplicateTemplate(
  hashId: string,
  overrides: VastTemplateFields = {}
): Promise<VastTemplate> {
  const current = await getTemplate({ hashId });
  if (!current) throw new Error(`No template found with hash_id "${hashId}"`);
  const fields = pickWriteFields(current);
  const name = overrides.name ?? `${current.name ?? "template"} (copy)`;
  return createTemplate({ ...fields, ...overrides, name });
}

export async function deleteTemplate(ref: { hashId?: string; templateId?: number }): Promise<unknown> {
  if (!ref.hashId && ref.templateId === undefined) {
    throw new Error("deleteTemplate requires hashId or templateId");
  }
  const body: Record<string, unknown> = {};
  if (ref.hashId) body.hash_id = ref.hashId;
  else body.template_id = ref.templateId;
  const res = await vastClient.delete("/template/", body);
  if (ref.hashId) await store.forgetTemplate(ref.hashId);
  else if (ref.templateId !== undefined) await store.forgetTemplate(String(ref.templateId));
  return res;
}
