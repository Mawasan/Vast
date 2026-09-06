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

/**
 * Vast expects an object, but older edits can leave the field JSON-encoded one
 * or more times. Decode that legacy shape before it is ever written back.
 */
export function normalizeTemplateExtraFilters(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null || value === "") return {};
  let current: unknown = value;
  for (let depth = 0; depth < 8 && typeof current === "string"; depth += 1) {
    try {
      current = JSON.parse(current);
    } catch {
      throw new Error("Invalid template extra_filters: expected a JSON object, but found an invalid encoded string.");
    }
  }
  if (typeof current === "string") {
    throw new Error("Invalid template extra_filters: too many layers of JSON encoding.");
  }
  if (typeof current !== "object" || current === null || Array.isArray(current)) {
    throw new Error("Invalid template extra_filters: expected an object.");
  }
  let filters = current as Record<string, unknown>;
  for (let depth = 0; depth < 8 && Object.keys(filters).length === 1 && Object.hasOwn(filters, "filters"); depth += 1) {
    const nested = filters.filters;
    if (typeof nested !== "object" || nested === null || Array.isArray(nested)) break;
    filters = nested as Record<string, unknown>;
  }
  return filters;
}

function normalizeTemplate(t: VastTemplate): VastTemplate {
  try {
    return { ...t, extra_filters: normalizeTemplateExtraFilters(t.extra_filters) };
  } catch {
    // Keep malformed legacy data readable so a caller can repair it through an
    // explicit extra_filters patch. Other edits still reject it below.
    return t;
  }
}

function pickWriteFields(
  t: Partial<VastTemplate>,
  { replacingMalformedExtraFilters = false }: { replacingMalformedExtraFilters?: boolean } = {}
): VastTemplateFields {
  const out: VastTemplateFields = {};
  for (const key of TEMPLATE_WRITE_KEYS) {
    if (t[key] !== undefined) {
      if (key === "extra_filters") {
        try {
          (out as Record<string, unknown>)[key] = normalizeTemplateExtraFilters(t[key]);
        } catch (error) {
          if (!replacingMalformedExtraFilters) throw error;
        }
      } else {
        (out as Record<string, unknown>)[key] = t[key];
      }
    }
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
  if (fields.extra_filters !== undefined) {
    try {
      normalizeTemplateExtraFilters(fields.extra_filters);
    } catch (error) {
      errors.push((error as Error).message);
    }
  }
  return { valid: errors.length === 0, errors };
}

export async function getCurrentUser(): Promise<{ id: number; [key: string]: unknown }> {
  const res = (await vastClient.get("/users/current")) as { id: number };
  return res;
}

/**
 * Names only of the account-level environment variables Vast.ai injects into
 * instances. Values are deliberately discarded and never returned or logged —
 * these are secrets.
 */
export async function listAccountEnvVarNames(): Promise<string[]> {
  const res = (await vastClient.get("/secrets/")) as { secrets?: Record<string, unknown> };
  return Object.keys(res.secrets ?? {});
}

export async function searchTemplates(filters?: SelectFilters): Promise<VastTemplate[]> {
  const res = (await vastClient.get("/template/", {
    select_cols: ["*"],
    select_filters: filters ?? {},
  })) as { templates?: VastTemplate[] };
  return (res.templates ?? []).map(normalizeTemplate);
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

/**
 * Resolves whatever the user said into one concrete template: a hash_id, a
 * numeric id, or a (partial, case-insensitive) name like "illustrious".
 * Ambiguous or unknown names fail loudly listing the real candidates, so a
 * client never has to look up a hash_id before editing a template by name.
 */
export async function resolveTemplate(ref: string): Promise<VastTemplate> {
  const trimmed = ref.trim();
  if (!trimmed) throw new Error("No template reference given.");

  if (/^\d+$/.test(trimmed)) {
    const byId = await getTemplate({ id: Number(trimmed) });
    if (byId) return byId;
  } else {
    const byHash = await getTemplate({ hashId: trimmed });
    if (byHash) return byHash;
  }

  const mine = await listMyTemplates();
  const needle = trimmed.toLowerCase();
  const exact = mine.filter((t) => (t.name ?? "").toLowerCase() === needle);
  const matches = exact.length > 0 ? exact : mine.filter((t) => (t.name ?? "").toLowerCase().includes(needle));

  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(
      `"${ref}" matches ${matches.length} of your templates: ` +
        matches.map((t) => `${t.name} (${t.hash_id})`).join(", ") +
        ". Say which one you mean."
    );
  }
  throw new Error(
    `No template of yours matches "${ref}". Your templates: ` +
      (mine.map((t) => t.name ?? `#${t.id}`).join(", ") || "(none)")
  );
}

/** Resolves a reference and returns its hash_id, which every write path needs. */
export async function resolveTemplateHashId(ref: string): Promise<string> {
  const t = await resolveTemplate(ref);
  if (!t.hash_id) throw new Error(`Template "${t.name ?? ref}" has no hash_id, so it cannot be edited.`);
  return t.hash_id;
}

export async function createTemplate(fields: VastTemplateFields): Promise<VastTemplate> {
  const validation = validateTemplateFields(fields, { isCreate: true });
  if (!validation.valid) {
    throw new Error(`Invalid template configuration: ${validation.errors.join("; ")}`);
  }
  const body: VastTemplateFields = {
    ...TEMPLATE_DEFAULTS,
    ...fields,
    extra_filters: normalizeTemplateExtraFilters(fields.extra_filters ?? TEMPLATE_DEFAULTS.extra_filters),
  };
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

  const merged: VastTemplateFields = {
    ...pickWriteFields(current, { replacingMalformedExtraFilters: patch.extra_filters !== undefined }),
    ...patch,
  };
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
