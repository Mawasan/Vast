import { config } from "../core/config.js";
import { isCivitaiUrl, resourceDownloadUrl } from "./modelBlock.js";
import type { ModelResource } from "../core/types.js";

/**
 * Pre-flight for a template's managed downloads.
 *
 * A worker that cannot fetch its checkpoint still boots — Vast logs
 * "Provisioning encountered issues but instance startup will continue" — and
 * then answers generation requests with ComfyUI's "Value not in list" error,
 * after the GPU has already been paid for. Checking the download URLs before
 * a workergroup is created turns that into a plain, free error message.
 */

export interface UnreachableResource {
  name: string;
  role: string;
  url: string;
  status: number | null;
  reason: string;
}

function civitaiToken(): string | undefined {
  return config.civitaiToken;
}

/**
 * Civitai 401s on HEAD even with a token that downloads the same file fine,
 * so ask for a single byte with a ranged GET instead.
 */
async function probe(url: string, headers: Record<string, string>): Promise<number | null> {
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { ...headers, Range: "bytes=0-0", "User-Agent": "vast-agent" },
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
    });
    // Read nothing beyond the headers; the range keeps the body at one byte.
    await response.body?.cancel();
    return response.status;
  } catch {
    return null;
  }
}

/** Statuses that mean the file genuinely cannot be fetched by a worker. */
function blockingReason(status: number | null, civitai: boolean): string | null {
  if (status === null) return null; // network hiccup — do not block on it
  if (status === 401 || status === 403) {
    return civitai
      ? "needs a Civitai token the worker does not have (set CIVITAI_API_TOKEN on the agent and CIVITAI_TOKEN/CIVIT on the Vast account)"
      : "is not publicly downloadable (HTTP " + status + ")";
  }
  if (status === 404 || status === 410) return `no longer exists at its pinned URL (HTTP ${status})`;
  return null; // 429/5xx and anything else: transient, let the worker retry
}

export async function findUnreachableResources(resources: ModelResource[]): Promise<UnreachableResource[]> {
  const checks = resources.map(async (resource): Promise<UnreachableResource | null> => {
    const url = resourceDownloadUrl(resource);
    if (!url) return null; // Hugging Face repo download, resolved by the CLI
    const civitai = isCivitaiUrl(url);
    const token = civitai ? civitaiToken() : undefined;
    let status = await probe(url, token ? { Authorization: `Bearer ${token}` } : {});
    if (civitai && token && (status === 401 || status === 403)) {
      // Civitai also documents the token as a query parameter; the worker
      // tries both, so the check has to as well.
      const separator = url.includes("?") ? "&" : "?";
      status = await probe(`${url}${separator}token=${encodeURIComponent(token)}`, {});
    }
    const reason = blockingReason(status, civitai);
    return reason ? { name: resource.name, role: resource.role, url, status, reason } : null;
  });
  return (await Promise.all(checks)).filter((value): value is UnreachableResource => value !== null);
}

export function describeUnreachable(templateName: string, unreachable: UnreachableResource[]): string {
  const details = unreachable.map((item) => `${item.role} "${item.name}" ${item.reason}`).join("; ");
  return (
    `Template "${templateName}" cannot provision: ${details}. ` +
    "No worker was started, so nothing was billed. Fix the download access, then prepare the template again."
  );
}
