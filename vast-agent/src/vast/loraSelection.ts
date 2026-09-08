import type { ModelResource } from "../core/types.js";

/** One LoRA a caller wants applied, with an optional strength override. */
export interface LoraChoice {
  name: string;
  weight?: number;
}

/**
 * Picks which of a template's LoRAs go into the workflow.
 *
 * A template used to carry exactly the LoRAs its one endpoint needed, so the
 * workflow simply chained all of them. Running several styles from a single
 * endpoint means the template holds every LoRA and the *request* decides
 * which ones apply — stacking five character LoRAs on one image is not a
 * useful default.
 *
 * Omitting `choices` keeps the old behaviour: every attached LoRA, in the
 * order the template lists them.
 */
export function selectLoras(resources: ModelResource[], choices?: LoraChoice[]): ModelResource[] {
  if (choices === undefined) return resources;
  const attached = resources.filter((resource) => resource.role === "lora");
  const others = resources.filter((resource) => resource.role !== "lora");

  const picked: ModelResource[] = [];
  for (const choice of choices) {
    const needle = choice.name.trim().toLowerCase();
    if (!needle) continue;
    const match = attached.find((lora) => lora.name.toLowerCase() === needle)
      ?? attached.find((lora) => lora.name.toLowerCase().includes(needle))
      ?? attached.find((lora) => (lora.filename ?? "").toLowerCase().includes(needle));
    if (!match) {
      throw new Error(
        `No LoRA matching "${choice.name}" on this template. Attached: ` +
          (attached.map((lora) => lora.name).join(", ") || "(none)")
      );
    }
    if (picked.some((lora) => lora.name === match.name)) continue;
    picked.push(choice.weight === undefined ? match : { ...match, weight: choice.weight });
  }
  // The caller's order is the chain order, so a deliberate pick stays honest.
  return [...others, ...picked];
}
