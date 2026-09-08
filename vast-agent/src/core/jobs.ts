import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { config, redact } from "./config.js";

export interface Job {
  requestId: string;
  kind: string;
  fingerprint: string;
  status: "running" | "completed" | "unknown";
  createdAt: string;
  result?: unknown;
  error?: string;
}
const active = new Map<string, Job>();
let gate: Promise<unknown> = Promise.resolve();
const pathFor = (id: string) => join(config.dataDir, "jobs", createHash("sha256").update(id).digest("hex") + ".json");
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
async function save(job: Job) {
  await mkdir(join(config.dataDir, "jobs"), { recursive: true });
  const path = pathFor(job.requestId), tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, redact(JSON.stringify(job)), { mode: 0o600 });
  await rename(tmp, path);
}
export async function getJob(requestId: string): Promise<Job> {
  const live = active.get(requestId);
  if (live) return structuredClone(live);
  const job = JSON.parse(await readFile(pathFor(requestId), "utf8")) as Job;
  if (job.status === "running") {
    job.status = "unknown";
    job.error = "Agent restarted during execution. Inspect Vast before retrying; the operation is never automatically resubmitted.";
  }
  return job;
}
/** Persist before sending, deduplicate reconnects, and never replay ambiguous mutations. Single replica. */
export async function submitJob(requestId: string, kind: string, input: unknown, run: () => Promise<unknown>): Promise<Job> {
  const fingerprint = createHash("sha256").update(canonical({ kind, input })).digest("hex");
  const operation = gate.then(async () => {
    try {
      const existing = await getJob(requestId);
      if (existing.fingerprint !== fingerprint) throw new Error("requestId already belongs to different arguments; use the original arguments or a new ID.");
      return existing;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const job: Job = { requestId, kind, fingerprint, status: "running", createdAt: new Date().toISOString() };
    await save(job);
    active.set(requestId, job);
    void (async () => {
      const finished = { ...job };
      try { finished.result = await run(); finished.status = "completed"; }
      catch (error) { finished.status = "unknown"; finished.error = redact((error as Error).message); }
      try { await save(finished); active.delete(requestId); }
      catch { job.status = "unknown"; job.error = "Could not persist outcome. Inspect Vast before retrying."; }
    })();
    return structuredClone(job);
  });
  gate = operation.catch(() => undefined);
  return operation;
}
