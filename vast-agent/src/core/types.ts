/** Fields accepted by Vast.ai's POST/PUT /template/ endpoint (official SDK v1.6.x shape). */
export interface VastTemplateFields {
  name?: string;
  image?: string;
  tag?: string; // image_tag in the SDK, "tag" on the wire
  href?: string;
  repo?: string;
  env?: string; // Docker-options flag string, e.g. "-e FOO=bar -p 8000:8000"
  onstart?: string; // onstart script contents
  jup_direct?: boolean;
  ssh_direct?: boolean;
  use_jupyter_lab?: boolean;
  runtype?: "args" | "ssh" | "jupyter" | string;
  use_ssh?: boolean;
  jupyter_dir?: string | null;
  docker_login_repo?: string | null;
  extra_filters?: Record<string, unknown>;
  recommended_disk_space?: number;
  readme?: string;
  readme_visible?: boolean;
  desc?: string;
  private?: boolean;
}

export interface VastTemplate extends VastTemplateFields {
  id?: number;
  hash_id?: string;
  creator_id?: number;
  created_at?: number;
}

export interface VastInstanceSummary {
  id: number;
  label?: string | null;
  actual_status?: string | null;
  cur_state?: string | null;
  gpu_name?: string | null;
  num_gpus?: number | null;
  dph_total?: number | null;
  image?: string | null;
  template_id?: number | null;
  template_hash_id?: string | null;
  ssh_host?: string | null;
  ssh_port?: number | null;
  [key: string]: unknown;
}

export type QueryOp = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "in" | "notin";
export type SelectFilters = Record<string, Partial<Record<QueryOp, unknown>>>;

export type ModelSourceKind = "huggingface" | "civitai" | "url";
export type ModelRole = "base" | "lora";

/** One model or LoRA resource attached to a template's managed download block. */
export interface ModelResource {
  /** Stable identifier within the template, e.g. the LoRA's display name. */
  name: string;
  role: ModelRole;
  source: ModelSourceKind;
  /** HF repo id, Civitai model/version id, or a direct URL, depending on `source`. */
  ref: string;
  /** Directory the resource is downloaded into on the instance. */
  targetPath: string;
  /** Optional filename override; inferred from the source if omitted. */
  filename?: string;
  /** LoRA strength/weight, only meaningful for role "lora". */
  weight?: number;
}
