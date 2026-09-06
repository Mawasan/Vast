import { vastClient } from "../core/vastClient.js";
import { resolveTemplate } from "./templates.js";

export type EndpointSummary = {
  id: number;
  endpointName: string;
  state: string | null;
  maxWorkers: number | null;
  coldWorkers: number | null;
};

export type WorkergroupSummary = {
  id: number;
  endpointId: number | null;
  endpointName: string | null;
  templateId: number | null;
  templateHash: string | null;
  gpuRam: number | null;
};

function rows(value: unknown): Record<string, unknown>[] {
  const root = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return Array.isArray(root.results) ? root.results.filter((row): row is Record<string, unknown> => Boolean(row && typeof row === "object")) : [];
}

export async function listEndpoints(): Promise<EndpointSummary[]> {
  return rows(await vastClient.get("/endptjobs")).flatMap((row) => {
    if (typeof row.id !== "number" || typeof row.endpoint_name !== "string") return [];
    return [{
      id: row.id,
      endpointName: row.endpoint_name,
      state: typeof row.endpoint_state === "string" ? row.endpoint_state : null,
      maxWorkers: typeof row.max_workers === "number" ? row.max_workers : null,
      coldWorkers: typeof row.cold_workers === "number" ? row.cold_workers : null,
    }];
  });
}

export async function listWorkergroups(): Promise<WorkergroupSummary[]> {
  return rows(await vastClient.get("/workergroups/")).flatMap((row) => {
    if (typeof row.id !== "number") return [];
    return [{
      id: row.id,
      endpointId: typeof row.endpoint_id === "number" ? row.endpoint_id : null,
      endpointName: typeof row.endpoint_name === "string" ? row.endpoint_name : null,
      templateId: typeof row.template_id === "number" ? row.template_id : null,
      templateHash: typeof row.template_hash === "string" ? row.template_hash : null,
      gpuRam: typeof row.gpu_ram === "number" ? row.gpu_ram : null,
    }];
  });
}

function endpointNameFor(templateName: string, hash: string): string {
  const slug = templateName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 42) || "model";
  return `akira-${slug}-${hash.slice(0, 6)}`;
}

export async function prepareTemplateEndpoint(templateRef: string, requestedName?: string) {
  const template = await resolveTemplate(templateRef);
  if (!template.hash_id || typeof template.id !== "number") throw new Error("The selected template has no usable Vast id/hash.");
  const [endpoints, workergroups] = await Promise.all([listEndpoints(), listWorkergroups()]);
  const existingGroup = workergroups.find((group) => group.templateHash === template.hash_id || group.templateId === template.id);
  if (existingGroup) {
    const endpoint = endpoints.find((item) => item.id === existingGroup.endpointId || item.endpointName === existingGroup.endpointName);
    if (!endpoint) throw new Error("A workergroup exists for this template, but its endpoint could not be found.");
    return { created: false, template: template.name, templateHash: template.hash_id, endpoint, workergroup: existingGroup };
  }

  const endpointName = requestedName?.trim() || endpointNameFor(template.name ?? template.hash_id, template.hash_id);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{2,63}$/.test(endpointName)) throw new Error("Endpoint name must be 3-64 letters, numbers, dots, underscores, or hyphens.");
  let endpoint = endpoints.find((item) => item.endpointName === endpointName);
  let createdEndpoint = false;
  if (!endpoint) {
    const response = await vastClient.post("/endptjobs/", {
      endpoint_name: endpointName,
      min_load: 0,
      target_util: 0.9,
      cold_mult: 1,
      cold_workers: 0,
      max_workers: 1,
    }) as Record<string, unknown>;
    const id = typeof response.result === "number" ? response.result : typeof response.id === "number" ? response.id : null;
    if (id === null) throw new Error("Vast created no usable endpoint id.");
    endpoint = { id, endpointName, state: "active", maxWorkers: 1, coldWorkers: 0 };
    createdEndpoint = true;
  }

  try {
    const response = await vastClient.post("/workergroups/", {
      endpoint_id: endpoint.id,
      endpoint_name: endpoint.endpointName,
      template_hash: template.hash_id,
      template_id: template.id,
      search_params: {
        verified: { eq: true },
        rentable: { eq: true },
        rented: { eq: false },
        gpu_ram: { gte: 24 },
      },
      min_load: 0,
      target_util: 0.9,
      cold_mult: 1,
      cold_workers: 0,
      max_workers: 1,
      test_workers: 1,
      gpu_ram: 24,
    }) as Record<string, unknown>;
    const id = typeof response.id === "number" ? response.id : typeof response.result === "number" ? response.result : null;
    if (id === null) throw new Error("Vast created no usable workergroup id.");
    return {
      created: true,
      template: template.name,
      templateHash: template.hash_id,
      endpoint,
      workergroup: { id, endpointId: endpoint.id, endpointName: endpoint.endpointName, templateId: template.id, templateHash: template.hash_id, gpuRam: 24 },
    };
  } catch (error) {
    if (createdEndpoint) {
      try { await vastClient.delete(`/endptjobs/${endpoint.id}/`); } catch { /* return the original error */ }
    }
    throw error;
  }
}
