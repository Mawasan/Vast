import { config } from "../core/config.js";

/**
 * Civitai public REST API (https://developer.civitai.com/site/). A token is
 * only required for NSFW-gated content or higher rate limits.
 */
const CIVITAI_API = "https://civitai.com/api/v1";

function headers(): Record<string, string> {
  return config.civitaiToken ? { Authorization: `Bearer ${config.civitaiToken}` } : {};
}

export interface CivitaiModelFile {
  name: string;
  sizeKB?: number;
  downloadUrl?: string;
  primary?: boolean;
}

export interface CivitaiModelVersionSummary {
  id: number;
  name: string;
  baseModel?: string;
  files: CivitaiModelFile[];
}

export interface CivitaiModelSummary {
  id: number;
  name: string;
  type?: string; // Checkpoint, LORA, TextualInversion, ...
  nsfw?: boolean;
  creator?: string;
  tags?: string[];
  latestVersion?: CivitaiModelVersionSummary;
}

function mapVersion(v: Record<string, unknown>): CivitaiModelVersionSummary {
  const files = ((v.files as Array<Record<string, unknown>>) ?? []).map((f) => ({
    name: f.name as string,
    sizeKB: f.sizeKB as number | undefined,
    downloadUrl: f.downloadUrl as string | undefined,
    primary: f.primary as boolean | undefined,
  }));
  return {
    id: v.id as number,
    name: v.name as string,
    baseModel: v.baseModel as string | undefined,
    files,
  };
}

function mapModel(m: Record<string, unknown>): CivitaiModelSummary {
  const versions = (m.modelVersions as Array<Record<string, unknown>>) ?? [];
  return {
    id: m.id as number,
    name: m.name as string,
    type: m.type as string | undefined,
    nsfw: m.nsfw as boolean | undefined,
    creator: (m.creator as { username?: string } | undefined)?.username,
    tags: m.tags as string[] | undefined,
    latestVersion: versions[0] ? mapVersion(versions[0]) : undefined,
  };
}

export async function searchCivitaiModels(opts: {
  query: string;
  limit?: number;
  /** e.g. "Checkpoint", "LORA" */
  types?: string[];
}): Promise<CivitaiModelSummary[]> {
  const params = new URLSearchParams({ query: opts.query, limit: String(opts.limit ?? 10) });
  for (const t of opts.types ?? []) params.append("types", t);
  const res = await fetch(`${CIVITAI_API}/models?${params.toString()}`, { headers: headers() });
  if (!res.ok) {
    throw new Error(`Civitai search failed (${res.status}): ${await res.text()}`);
  }
  const data = (await res.json()) as { items?: Array<Record<string, unknown>> };
  return (data.items ?? []).map(mapModel);
}

export async function getCivitaiModelInfo(modelId: number): Promise<CivitaiModelSummary> {
  const res = await fetch(`${CIVITAI_API}/models/${modelId}`, { headers: headers() });
  if (!res.ok) {
    throw new Error(`Civitai model lookup failed for ${modelId} (${res.status}): ${await res.text()}`);
  }
  return mapModel((await res.json()) as Record<string, unknown>);
}

export async function getCivitaiModelVersion(versionId: number): Promise<CivitaiModelVersionSummary> {
  const res = await fetch(`${CIVITAI_API}/model-versions/${versionId}`, { headers: headers() });
  if (!res.ok) {
    throw new Error(`Civitai model version lookup failed for ${versionId} (${res.status}): ${await res.text()}`);
  }
  return mapVersion((await res.json()) as Record<string, unknown>);
}
