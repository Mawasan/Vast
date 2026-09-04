import { vastClient } from "../core/vastClient.js";
import { store } from "../core/store.js";
import type { VastInstanceSummary } from "../core/types.js";

function summarize(row: Record<string, unknown>): VastInstanceSummary {
  return {
    id: row.id as number,
    label: (row.label as string | null) ?? null,
    actual_status: (row.actual_status as string | null) ?? null,
    cur_state: (row.cur_state as string | null) ?? null,
    gpu_name: (row.gpu_name as string | null) ?? null,
    num_gpus: (row.num_gpus as number | null) ?? null,
    dph_total: (row.dph_total as number | null) ?? null,
    image: (row.image as string | null) ?? row.image_uuid as string | null ?? null,
    template_id: (row.template_id as number | null) ?? null,
    template_hash_id: (row.template_hash_id as string | null) ?? null,
    ssh_host: (row.ssh_host as string | null) ?? null,
    ssh_port: (row.ssh_port as number | null) ?? null,
  };
}

/** Lists every instance owned by the authenticated account, paging through the v1 API. */
export async function listInstances(): Promise<VastInstanceSummary[]> {
  const rows: Record<string, unknown>[] = [];
  let afterToken: string | undefined;
  for (;;) {
    const params: Record<string, unknown> = {
      select_filters: {},
      order_by: [{ col: "id", dir: "asc" }],
      limit: 100,
    };
    if (afterToken) params.after_token = afterToken;
    const res = (await vastClient.get("/api/v1/instances/", params)) as {
      instances?: Record<string, unknown>[];
      next_token?: string;
    };
    rows.push(...(res.instances ?? []));
    if (!res.next_token) break;
    afterToken = res.next_token;
  }
  const summaries = rows.map(summarize);
  for (const s of summaries) {
    await store.rememberInstance({ id: s.id, label: s.label });
  }
  return summaries;
}

export async function getInstance(id: number): Promise<VastInstanceSummary | null> {
  try {
    const res = (await vastClient.get(`/instances/${id}/`, { owner: "me" })) as {
      instances?: Record<string, unknown> | null;
    };
    if (!res.instances) return null;
    return summarize(res.instances);
  } catch (err) {
    if ((err as { status?: number }).status === 404) return null;
    throw err;
  }
}

/** Actually destroys the instance (not stop/pause). Confirmation is enforced by the tool layer. */
export async function destroyInstance(id: number): Promise<unknown> {
  const res = await vastClient.delete(`/instances/${id}/`, {});
  await store.rememberInstance({ id, lastAction: "destroy_requested" });
  return res;
}

export interface DestroyVerification {
  destroyed: boolean;
  attempts: number;
  lastSeen: VastInstanceSummary | null;
}

/**
 * Polls the instance until it is confirmed gone. Destroy is only considered
 * successful once the instance id no longer resolves to a real instance.
 */
export async function verifyDestroyed(
  id: number,
  { retries = 6, delayMs = 2000 }: { retries?: number; delayMs?: number } = {}
): Promise<DestroyVerification> {
  let lastSeen: VastInstanceSummary | null = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    lastSeen = await getInstance(id);
    const gone = lastSeen === null || lastSeen.actual_status === null;
    if (gone) {
      await store.forgetInstance(id);
      return { destroyed: true, attempts: attempt, lastSeen: null };
    }
    if (attempt < retries) await new Promise((r) => setTimeout(r, delayMs));
  }
  return { destroyed: false, attempts: retries, lastSeen };
}
