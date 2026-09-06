import { isIP } from "node:net";
import { config } from "../core/config.js";

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
  const response = await fetch(url, {
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
    if (size > 32 * 1024 * 1024) throw new Error("Worker output exceeds 32 MB. Use worker S3 URLs for larger media.");
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
  return { endpoint: input.endpoint, output: result,
    note: "Output schema belongs to the worker. A local_path is a file on the GPU, not a downloadable URL. Configure worker S3 output for persistent media URLs." };
}
