import { config } from "../core/config.js";

/**
 * Hugging Face Hub REST API (https://huggingface.co/docs/hub/api). Public
 * models work without a token; HF_TOKEN is only needed for gated/private repos.
 */
const HF_API = "https://huggingface.co";

function headers(): Record<string, string> {
  return config.hfToken ? { Authorization: `Bearer ${config.hfToken}` } : {};
}

export interface HfModelSummary {
  id: string;
  author?: string;
  downloads?: number;
  likes?: number;
  pipelineTag?: string;
  libraryName?: string;
  tags?: string[];
  lastModified?: string;
}

export interface HfFileInfo {
  path: string;
  sizeBytes?: number;
}

export interface HfModelInfo extends HfModelSummary {
  gated?: boolean | string;
  private?: boolean;
  files: HfFileInfo[];
  totalSizeBytes: number;
  inferredType: string;
}

export async function searchHuggingFaceModels(opts: {
  query: string;
  limit?: number;
  pipelineTag?: string;
}): Promise<HfModelSummary[]> {
  const params = new URLSearchParams({
    search: opts.query,
    limit: String(opts.limit ?? 10),
    full: "true",
  });
  if (opts.pipelineTag) params.set("pipeline_tag", opts.pipelineTag);
  const res = await fetch(`${HF_API}/api/models?${params.toString()}`, { headers: headers() });
  if (!res.ok) {
    throw new Error(`Hugging Face search failed (${res.status}): ${await res.text()}`);
  }
  const data = (await res.json()) as Array<Record<string, unknown>>;
  return data.map((m) => ({
    id: m.id as string,
    author: m.author as string | undefined,
    downloads: m.downloads as number | undefined,
    likes: m.likes as number | undefined,
    pipelineTag: m.pipeline_tag as string | undefined,
    libraryName: m.library_name as string | undefined,
    tags: m.tags as string[] | undefined,
    lastModified: m.lastModified as string | undefined,
  }));
}

function inferModelType(m: { tags?: string[]; pipelineTag?: string; libraryName?: string }): string {
  const tags = (m.tags ?? []).map((t) => t.toLowerCase());
  if (tags.includes("lora")) return "lora";
  if (tags.includes("textual-inversion")) return "textual-inversion";
  if (tags.includes("controlnet")) return "controlnet";
  if (m.pipelineTag === "text-to-image" || tags.includes("diffusers")) return "image-generation-checkpoint";
  if (m.pipelineTag) return m.pipelineTag;
  return "unknown";
}

export async function getHuggingFaceModelInfo(repoId: string): Promise<HfModelInfo> {
  const res = await fetch(`${HF_API}/api/models/${repoId}`, { headers: headers() });
  if (!res.ok) {
    throw new Error(`Hugging Face model lookup failed for "${repoId}" (${res.status}): ${await res.text()}`);
  }
  const m = (await res.json()) as Record<string, unknown>;

  let files: HfFileInfo[] = [];
  try {
    const treeRes = await fetch(`${HF_API}/api/models/${repoId}/tree/main?recursive=true`, {
      headers: headers(),
    });
    if (treeRes.ok) {
      const tree = (await treeRes.json()) as Array<Record<string, unknown>>;
      files = tree
        .filter((entry) => entry.type === "file")
        .map((entry) => ({
          path: entry.path as string,
          sizeBytes: (entry.size as number | undefined) ?? undefined,
        }));
    }
  } catch {
    // File listing is best-effort; base model info above is still returned.
  }

  const summary: HfModelSummary = {
    id: (m.id as string) ?? repoId,
    author: m.author as string | undefined,
    downloads: m.downloads as number | undefined,
    likes: m.likes as number | undefined,
    pipelineTag: m.pipeline_tag as string | undefined,
    libraryName: m.library_name as string | undefined,
    tags: m.tags as string[] | undefined,
    lastModified: m.lastModified as string | undefined,
  };

  return {
    ...summary,
    gated: m.gated as boolean | string | undefined,
    private: m.private as boolean | undefined,
    files,
    totalSizeBytes: files.reduce((sum, f) => sum + (f.sizeBytes ?? 0), 0),
    inferredType: inferModelType(summary),
  };
}
