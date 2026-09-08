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
 *
 * `manual` matters for the authenticated case: Civitai answers 307 with a
 * presigned CDN URL, and following that while still carrying the bearer
 * token makes the CDN answer 400 ("only one auth mechanism"). The redirect
 * is the answer we want anyway — it means Civitai accepted the token and
 * would hand the file over. curl drops the header across hosts, which is why
 * the worker downloads the same file fine.
 */
async function probe(url: string, headers: Record<string, string>): Promise<number | null> {
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { ...headers, Range: "bytes=0-0", "User-Agent": "vast-agent" },
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    });
    // Read nothing beyond the headers; the range keeps the body at one byte.
    await response.body?.cancel();
    return response.status;
  } catch {
    return null;
  }
}

/**
 * Civitai keeps paid "early access" versions behind a Buzz purchase and
 * answers 401/403 for them no matter how valid the token is. Saying
 * "needs a token" there sends people hunting for a key that is already fine,
 * so ask Civitai what is actually going on.
 */
async function earlyAccessUntil(url: string): Promise<string | null> {
  const versionId = /\/api\/download\/models\/(\d+)/.exec(url)?.[1];
  if (!versionId) return null;
  try {
    const response = await fetch(`https://civitai.com/api/v1/model-versions/${versionId}`, {
      headers: { "User-Agent": "vast-agent" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return null;
    const body = await response.json() as { paidAccess?: { endsAt?: string } | null };
    const endsAt = body.paidAccess?.endsAt;
    return typeof endsAt === "string" ? endsAt.slice(0, 10) : null;
  } catch {
    return null;
  }
}

/** A redirect to the CDN is the success case: the source handed the file over. */
function isFetchable(status: number | null): boolean {
  return status !== null && ((status >= 200 && status < 300) || (status >= 300 && status < 400));
}

/** Statuses that mean the file genuinely cannot be fetched by a worker. */
async function blockingReason(status: number | null, civitai: boolean, url: string): Promise<string | null> {
  if (status === null) return null; // network hiccup — do not block on it
  if (isFetchable(status)) return null;
  if (status === 401 || status === 403) {
    if (!civitai) return `is not publicly downloadable (HTTP ${status})`;
    const until = await earlyAccessUntil(url);
    return until
      ? `is in Civitai early access until ${until} — it has to be bought with Buzz, no API token can download it before then`
      : "needs a Civitai token the worker does not have (set CIVITAI_API_TOKEN on the agent and CIVITAI_TOKEN/CIVIT on the Vast account)";
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
    if (civitai && token && !isFetchable(status)) {
      // Civitai also documents the token as a query parameter; the worker
      // tries both, so the check has to as well.
      const separator = url.includes("?") ? "&" : "?";
      status = await probe(`${url}${separator}token=${encodeURIComponent(token)}`, {});
    }
    const reason = await blockingReason(status, civitai, url);
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
