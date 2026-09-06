import { isIP } from "node:net";
import { rootCertificates } from "node:tls";
import { Agent } from "undici";
import { config } from "../core/config.js";

const VAST_ROOT_CA_URL = "https://console.vast.ai/static/jvastai_root.cer";
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
let vastWorkerAgentPromise: Promise<Agent> | undefined;

export function isPublicIpv4(ip: string): boolean {
  if (isIP(ip) !== 4) return false;
  const [a,b] = ip.split(".").map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0)) ||
    (a === 198 && (b === 18 || b === 19)));
}
export async function workerUrl(raw: string): Promise<URL> {
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Invalid worker address returned by Vast.");
  // Vast routes use public worker IPs. Restricting to literals avoids DNS rebinding.
  if (!isPublicIpv4(url.hostname)) throw new Error("Vast worker must have a public IPv4 address.");
  return url;
}

async function vastWorkerAgent(): Promise<Agent> {
  vastWorkerAgentPromise ??= (async () => {
    const response = await fetch(VAST_ROOT_CA_URL);
    if (!response.ok) throw new Error(`Vast worker certificate request failed (${response.status}).`);
    const certificate = (await response.text()).trim();
    if (!certificate.startsWith("-----BEGIN CERTIFICATE-----") || !certificate.endsWith("-----END CERTIFICATE-----")) {
      throw new Error("Vast worker certificate response was invalid.");
    }
    return new Agent({ connect: { ca: [...rootCertificates, certificate] } });
  })().catch(error => {
    vastWorkerAgentPromise = undefined;
    throw error;
  });
  return vastWorkerAgentPromise;
}

async function workerFetch(url: URL, init: RequestInit): Promise<Response> {
  if (url.protocol !== "https:") return fetch(url, init);
  const dispatcher = await vastWorkerAgent();
  return fetch(url, { ...init, dispatcher } as RequestInit & { dispatcher: Agent });
}

function outputAssets(body: Record<string, unknown>): Record<string, unknown>[] {
  const response = body.response && typeof body.response === "object" ? body.response as Record<string, unknown> : undefined;
  const payload = response ?? body;
  const candidates = [payload.output, body.output];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate.filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === "object");
  }
  return [];
}

function viewLocation(asset: Record<string, unknown>): { filename: string; subfolder?: string; type: string } | null {
  const explicitFilename = typeof asset.filename === "string" ? asset.filename.trim() : "";
  const explicitSubfolder = typeof asset.subfolder === "string" ? asset.subfolder.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "") : "";
  if (explicitFilename) {
    if (explicitFilename.includes("..") || /[\\/]/.test(explicitFilename) || explicitSubfolder.includes("..")) return null;
    return { filename: explicitFilename, subfolder: explicitSubfolder || undefined, type: typeof asset.type === "string" ? asset.type : "output" };
  }
  if (typeof asset.local_path !== "string") return null;
  const normalized = asset.local_path.trim().replace(/\\/g, "/");
  const marker = "/output/";
  const relative = normalized.includes(marker) ? normalized.slice(normalized.lastIndexOf(marker) + marker.length) : normalized.split("/").pop() ?? "";
  const parts = relative.split("/").filter(Boolean);
  if (parts.length === 0 || parts.some(part => part === "." || part === "..")) return null;
  const filename = parts.pop()!;
  if (!filename || /[\\/]/.test(filename)) return null;
  return { filename, subfolder: parts.length ? parts.join("/") : undefined, type: "output" };
}

async function fetchWorkerImage(worker: URL, body: Record<string, unknown>, signal: AbortSignal): Promise<{ mimeType: string; base64: string } | undefined> {
  const asset = outputAssets(body).find(value => {
    const hasInline = ["data", "b64_json"].some(key => typeof value[key] === "string" && String(value[key]).trim());
    const hasPublicUrl = ["url", "image_url"].some(key => typeof value[key] === "string" && /^https:\/\//i.test(String(value[key])));
    return !hasInline && !hasPublicUrl && viewLocation(value) !== null;
  });
  if (!asset) return undefined;
  const location = viewLocation(asset)!;
  const view = new URL("/view", worker);
  view.searchParams.set("filename", location.filename);
  view.searchParams.set("type", location.type);
  if (location.subfolder) view.searchParams.set("subfolder", location.subfolder);
  const response = await workerFetch(view, { signal, redirect: "error" });
  if (!response.ok) throw new Error(`Worker generated an image, but /view could not retrieve it (${response.status}).`);
  const mimeType = (response.headers.get("content-type") ?? "image/png").split(";")[0];
  if (!mimeType.startsWith("image/")) throw new Error("Worker /view did not return an image.");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 24 || bytes.length > MAX_RESPONSE_BYTES) throw new Error("Worker /view returned an invalid or oversized image.");
  return { mimeType, base64: bytes.toString("base64") };
}
export async function runInference(input: { endpoint: string; path: string; payload: Record<string, unknown>; cost: number; timeoutSeconds: number }) {
  if (!config.vastApiKey) throw new Error("VAST_API_KEY is not configured.");
  if (input.payload.stream === true) throw new Error("Use stream:false; job results are delivered complete.");
  const deadline = Date.now() + input.timeoutSeconds * 1000;
  let assignment: Record<string, unknown> | undefined;
  while (Date.now() < deadline) {
    const response = await fetch("https://run.vast.ai/route/", {
      method: "POST", headers: { Authorization: `Bearer ${config.vastApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: input.endpoint, cost: input.cost }), redirect: "error",
      signal: AbortSignal.timeout(Math.min(30000, Math.max(1, deadline - Date.now()))),
    });
    if (!response.ok) throw new Error(`Vast routing failed (${response.status}). Check endpoint configuration.`);
    const body = await response.json() as Record<string, unknown>;
    if (body.url) { assignment = body; break; }
    if (body.error) throw new Error("Vast rejected the endpoint route request.");
    await new Promise(resolve => setTimeout(resolve, Math.min(3000, Math.max(1, deadline - Date.now()))));
  }
  if (!assignment) throw new Error("No ready worker before the timeout. Check serverless endpoint/workergroup scaling and provisioning.");
  const base = await workerUrl(String(assignment.url));
  if (!assignment.signature || assignment.reqnum === undefined) throw new Error("Incomplete worker authentication from Vast.");
  const url = new URL(input.path, base);
  const response = await workerFetch(url, {
    method: "POST", headers: { "Content-Type": "application/json" }, redirect: "error",
    body: JSON.stringify({ auth_data: assignment, payload: input.payload }),
    signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
  });
  // Never retry this POST: a lost response can still represent a billed generation.
  if (!response.ok) throw new Error(`Worker returned HTTP ${response.status}. It may have processed the request; inspect the worker before retrying.`);
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (!response.body) throw new Error("Worker returned an empty response.");
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > MAX_RESPONSE_BYTES) throw new Error("Worker output exceeds 32 MB. Use worker S3 URLs for larger media.");
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  const mimeType = (response.headers.get("content-type") ?? "application/json").split(";")[0];
  if (!mimeType.includes("json")) {
    if (!/^(image|audio|video)\//.test(mimeType)) throw new Error("Worker returned an unsupported response type.");
    return { endpoint: input.endpoint, mimeType, base64: bytes.toString("base64") };
  }
  const result = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
  const nested = result.response as Record<string, unknown> | undefined;
  if (result.error || result.success === false || result.status === "failed" || nested?.error || nested?.success === false) throw new Error("Worker reported generation failure. Check worker logs and workflow/model compatibility.");
  const media = await fetchWorkerImage(base, result, AbortSignal.timeout(Math.max(1, deadline - Date.now())));
  return { endpoint: input.endpoint, output: result, ...(media ? { media } : {}),
    note: media ? "Image bytes were retrieved from the assigned worker before it scaled down." : "Output schema belongs to the worker. Configure worker S3 output for persistent media URLs when media is not returned inline." };
}
