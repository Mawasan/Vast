import { vastClient } from "../core/vastClient.js";
import { getInstance } from "./instances.js";
import { resolveTemplate } from "./templates.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Accepts accidental {filters:{filters:{...}}} wrappers without sending malformed Vast filters. */
export function normalizeOfferFilters(input: Record<string, unknown>): Record<string, unknown> {
  let filters: Record<string, unknown> = input;
  for (let depth = 0; depth < 8 && Object.hasOwn(filters, "filters"); depth += 1) {
    const keys = Object.keys(filters);
    if (keys.length !== 1 || !isRecord(filters.filters)) {
      throw new Error("Invalid offer filters: put Vast fields directly inside filters; do not mix a nested filters key with other fields.");
    }
    filters = filters.filters;
  }
  if (Object.hasOwn(filters, "filters")) {
    throw new Error("Invalid offer filters: too many nested filters wrappers.");
  }
  return filters;
}

export async function searchOffers(filters: Record<string, unknown>, limit = 10, diskGb = 40) {
  const normalizedFilters = normalizeOfferFilters(filters);
  const result = await vastClient.post("/bundles/", {
    verified: { eq: true }, rentable: { eq: true }, rented: { eq: false },
    ...normalizedFilters, type: "ondemand", limit, allocated_storage: diskGb, order: [["dph_total", "asc"]],
  }) as { offers?: Record<string, unknown>[] };
  if (!Array.isArray(result.offers)) throw new Error("Vast returned an invalid offer list.");
  return result.offers;
}
export async function rentInstance(input: { offerId: number; template: string; diskGb: number; maxHourlyUsd: number; label?: string }) {
  const template = await resolveTemplate(input.template);
  const [offer] = await searchOffers({ id: { eq: input.offerId } }, 1, input.diskGb);
  if (!offer || offer.id !== input.offerId || offer.rentable === false) throw new Error("Offer is no longer available. Search again.");
  const rate = typeof offer.dph_total === "number" ? offer.dph_total : NaN;
  if (!Number.isFinite(rate) || rate < 0 || rate > input.maxHourlyUsd) throw new Error("Offer price is unavailable or exceeds maxHourlyUsd.");
  const result = await vastClient.putOnce(`/asks/${input.offerId}/`, {
    client_id: "me", template_hash_id: template.hash_id, disk: input.diskGb,
    label: input.label, target_state: "running", cancel_unavail: true,
  }) as { success?: boolean; new_contract?: number };
  if (result.success !== true || !Number.isInteger(result.new_contract)) throw new Error("Rental was not confirmed. Inspect instances before making another rental.");
  return { instanceId: result.new_contract, quotedHourlyUsd: rate, status: "provisioning", note: "GPU/disk billing applies; network traffic may cost extra. Running container does not yet guarantee model readiness." };
}
export async function setInstanceState(id: number, state: "running" | "stopped") {
  const before = await getInstance(id);
  if (!before) throw new Error(`Instance ${id} was not found.`);
  if (before.actual_status === state) return { requestedState: state, reached: true, instance: before };
  const result = await vastClient.putOnce(`/instances/${id}/`, { state }) as { success?: boolean };
  if (result.success !== true) throw new Error("Vast did not acknowledge the state change.");
  const instance = await getInstance(id);
  return { requestedState: state, reached: instance?.actual_status === state, instance,
    note: state === "stopped" ? "Stop preserves disk; storage charges continue." : "Start resumes GPU billing; inspect status until running." };
}
