import type { ModelResource } from "../core/types.js";

/**
 * Graph surgery on ComfyUI workflows in the UI/graph format (nodes + links
 * with slot indices), which is what this repo's `comfyui/workflows/*.json`
 * use. Every operation keeps the invariants the repo's own workflow tests
 * assert: link ids unique and referenced from both ends, matching types,
 * and every node reachable backwards from SaveImage.
 */

/** [link_id, source_node, output_slot, target_node, input_slot, type] */
export type WorkflowLink = [number, number, number, number, number, string];

export interface WorkflowNode {
  id: number;
  type: string;
  pos: [number, number];
  size: [number, number];
  flags: Record<string, unknown>;
  order: number;
  mode: number;
  inputs: Array<{ name: string; type: string; link: number | null }>;
  outputs: Array<{ name: string; type: string; slot_index?: number; links: number[] }>;
  properties: Record<string, unknown>;
  widgets_values?: unknown[];
  title?: string;
}

export interface Workflow {
  last_node_id: number;
  last_link_id: number;
  nodes: WorkflowNode[];
  links: WorkflowLink[];
  groups: unknown[];
  config: Record<string, unknown>;
  extra: Record<string, unknown>;
  version: number;
}

const LORA_LOADER = "LoraLoader";
const CHECKPOINT_LOADER = "CheckpointLoaderSimple";

export interface LoraEntry {
  filename: string;
  strengthModel: number;
  strengthClip: number;
  nodeId: number;
}

function node(wf: Workflow, id: number): WorkflowNode {
  const n = wf.nodes.find((x) => x.id === id);
  if (!n) throw new Error(`Workflow has no node ${id}`);
  return n;
}

function outputSlot(n: WorkflowNode, type: string): number {
  const idx = n.outputs.findIndex((o) => o.type === type);
  if (idx === -1) throw new Error(`Node ${n.id} (${n.type}) has no ${type} output`);
  return idx;
}

function checkpointNode(wf: Workflow): WorkflowNode {
  const n = wf.nodes.find((x) => x.type === CHECKPOINT_LOADER);
  if (!n) throw new Error(`Workflow has no ${CHECKPOINT_LOADER} node`);
  return n;
}

/**
 * The node currently supplying MODEL/CLIP to the rest of the graph: the
 * checkpoint, or the last LoraLoader already chained onto it.
 */
function chainHead(wf: Workflow): { node: WorkflowNode; modelSlot: number; clipSlot: number } {
  let current = checkpointNode(wf);
  for (;;) {
    const modelSlot = outputSlot(current, "MODEL");
    const next = wf.nodes.find(
      (n) =>
        n.type === LORA_LOADER &&
        n.inputs.some((i) => {
          const link = wf.links.find((l) => l[0] === i.link);
          return link && link[1] === current.id && link[2] === modelSlot;
        })
    );
    if (!next) {
      return { node: current, modelSlot, clipSlot: outputSlot(current, "CLIP") };
    }
    current = next;
  }
}

export function listLoras(wf: Workflow): LoraEntry[] {
  const ordered: LoraEntry[] = [];
  let current = checkpointNode(wf);
  for (;;) {
    const modelSlot = outputSlot(current, "MODEL");
    const next = wf.nodes.find(
      (n) =>
        n.type === LORA_LOADER &&
        n.inputs.some((i) => {
          const link = wf.links.find((l) => l[0] === i.link);
          return link && link[1] === current.id && link[2] === modelSlot;
        })
    );
    if (!next) return ordered;
    const [filename, strengthModel, strengthClip] = (next.widgets_values ?? []) as [
      string,
      number,
      number
    ];
    ordered.push({ filename, strengthModel, strengthClip, nodeId: next.id });
    current = next;
  }
}

function findLoraNode(wf: Workflow, filename: string): WorkflowNode | undefined {
  const needle = filename.toLowerCase();
  return wf.nodes.find(
    (n) =>
      n.type === LORA_LOADER &&
      String((n.widgets_values ?? [])[0] ?? "").toLowerCase().includes(needle)
  );
}

/** Re-points every link leaving (fromNode, fromSlot) to (toNode, toSlot). */
function reroute(
  wf: Workflow,
  from: { node: WorkflowNode; slot: number },
  to: { node: WorkflowNode; slot: number }
): void {
  const moved = wf.links.filter((l) => l[1] === from.node.id && l[2] === from.slot);
  for (const link of moved) {
    link[1] = to.node.id;
    link[2] = to.slot;
  }
  const movedIds = new Set(moved.map((l) => l[0]));
  from.node.outputs[from.slot].links = from.node.outputs[from.slot].links.filter(
    (id) => !movedIds.has(id)
  );
  to.node.outputs[to.slot].links.push(...movedIds);
}

function addLink(
  wf: Workflow,
  source: { node: WorkflowNode; slot: number },
  target: { node: WorkflowNode; inputIndex: number },
  type: string
): void {
  const id = ++wf.last_link_id;
  wf.links.push([id, source.node.id, source.slot, target.node.id, target.inputIndex, type]);
  source.node.outputs[source.slot].links.push(id);
  target.node.inputs[target.inputIndex].link = id;
}

export interface LoraSpec {
  filename: string;
  strengthModel?: number;
  strengthClip?: number;
  /** Pinned download URL, recorded the way this repo records checkpoint artifacts. */
  url?: string;
  title?: string;
}

/**
 * Appends a LoraLoader to the end of the MODEL/CLIP chain, so multiple LoRAs
 * stack in the order they were added. Adding one that is already present just
 * updates its strengths.
 */
export function addLora(wf: Workflow, spec: LoraSpec): Workflow {
  const strengthModel = spec.strengthModel ?? 1.0;
  const strengthClip = spec.strengthClip ?? strengthModel;

  const existing = findLoraNode(wf, spec.filename);
  if (existing) {
    existing.widgets_values = [spec.filename, strengthModel, strengthClip];
    return wf;
  }

  const head = chainHead(wf);
  const loader: WorkflowNode = {
    id: ++wf.last_node_id,
    type: LORA_LOADER,
    pos: [head.node.pos[0] + 40, head.node.pos[1] + 200 + listLoras(wf).length * 140],
    size: [320, 126],
    flags: {},
    order: 0,
    mode: 0,
    inputs: [
      { name: "model", type: "MODEL", link: null },
      { name: "clip", type: "CLIP", link: null },
    ],
    outputs: [
      { name: "MODEL", type: "MODEL", slot_index: 0, links: [] },
      { name: "CLIP", type: "CLIP", slot_index: 1, links: [] },
    ],
    properties: {
      "Node name for S&R": LORA_LOADER,
      cnr_id: "comfy-core",
      // Mirrors how CheckpointLoaderSimple records its artifact in this repo.
      ...(spec.url ? { models: [{ name: spec.filename, url: spec.url, directory: "loras" }] } : {}),
    },
    widgets_values: [spec.filename, strengthModel, strengthClip],
    ...(spec.title ? { title: spec.title } : {}),
  };
  wf.nodes.push(loader);

  // Downstream consumers move onto the new loader, which then draws from the
  // previous head — inserting it into the chain rather than branching it.
  reroute(wf, { node: head.node, slot: head.modelSlot }, { node: loader, slot: 0 });
  reroute(wf, { node: head.node, slot: head.clipSlot }, { node: loader, slot: 1 });
  addLink(wf, { node: head.node, slot: head.modelSlot }, { node: loader, inputIndex: 0 }, "MODEL");
  addLink(wf, { node: head.node, slot: head.clipSlot }, { node: loader, inputIndex: 1 }, "CLIP");

  recomputeOrder(wf);
  return wf;
}

/** Splices a LoraLoader out, reconnecting its consumers to its own sources. */
export function removeLora(wf: Workflow, filename: string): Workflow {
  const loader = findLoraNode(wf, filename);
  if (!loader) {
    throw new Error(
      `Workflow has no LoRA matching "${filename}". Present: ` +
        (listLoras(wf).map((l) => l.filename).join(", ") || "(none)")
    );
  }

  const inboundModel = wf.links.find((l) => l[0] === loader.inputs[0].link);
  const inboundClip = wf.links.find((l) => l[0] === loader.inputs[1].link);
  if (!inboundModel || !inboundClip) throw new Error(`LoRA node ${loader.id} is not fully connected`);

  const modelSource = { node: node(wf, inboundModel[1]), slot: inboundModel[2] };
  const clipSource = { node: node(wf, inboundClip[1]), slot: inboundClip[2] };

  reroute(wf, { node: loader, slot: 0 }, modelSource);
  reroute(wf, { node: loader, slot: 1 }, clipSource);

  const dropped = new Set([inboundModel[0], inboundClip[0]]);
  wf.links = wf.links.filter((l) => !dropped.has(l[0]));
  modelSource.node.outputs[modelSource.slot].links = modelSource.node.outputs[
    modelSource.slot
  ].links.filter((id) => !dropped.has(id));
  clipSource.node.outputs[clipSource.slot].links = clipSource.node.outputs[
    clipSource.slot
  ].links.filter((id) => !dropped.has(id));
  wf.nodes = wf.nodes.filter((n) => n.id !== loader.id);

  recomputeOrder(wf);
  return wf;
}

export function setLoraStrength(wf: Workflow, filename: string, strength: number): Workflow {
  const loader = findLoraNode(wf, filename);
  if (!loader) {
    throw new Error(
      `Workflow has no LoRA matching "${filename}". Present: ` +
        (listLoras(wf).map((l) => l.filename).join(", ") || "(none)")
    );
  }
  const current = (loader.widgets_values ?? []) as [string, number, number];
  loader.widgets_values = [current[0], strength, strength];
  return wf;
}

export function getCheckpoint(wf: Workflow): { filename: string; url?: string } {
  const loader = checkpointNode(wf);
  const artifact = (loader.properties.models as Array<{ url?: string }> | undefined)?.[0];
  return {
    filename: String((loader.widgets_values ?? [])[0] ?? ""),
    ...(artifact?.url ? { url: artifact.url } : {}),
  };
}

export function setCheckpoint(wf: Workflow, filename: string, url?: string): Workflow {
  const loader = checkpointNode(wf);
  loader.widgets_values = [filename];
  if (url) {
    loader.properties.models = [{ name: filename, url, directory: "checkpoints" }];
  }
  return wf;
}

/** Assigns each node an execution order consistent with its dependencies. */
function recomputeOrder(wf: Workflow): void {
  const incoming = new Map<number, number[]>();
  for (const n of wf.nodes) {
    incoming.set(
      n.id,
      n.inputs
        .map((i) => wf.links.find((l) => l[0] === i.link)?.[1])
        .filter((id): id is number => id !== undefined)
    );
  }
  const assigned = new Map<number, number>();
  let next = 0;
  let progressed = true;
  while (assigned.size < wf.nodes.length && progressed) {
    progressed = false;
    for (const n of wf.nodes) {
      if (assigned.has(n.id)) continue;
      if ((incoming.get(n.id) ?? []).every((dep) => assigned.has(dep))) {
        assigned.set(n.id, next++);
        progressed = true;
      }
    }
  }
  for (const n of wf.nodes) n.order = assigned.get(n.id) ?? n.order;
}

export interface WorkflowValidation {
  valid: boolean;
  errors: string[];
}

/**
 * Re-checks the structural invariants the repo's own workflow tests assert,
 * so a patched graph can be proven consistent before it is written back.
 */
export function validateWorkflow(wf: Workflow): WorkflowValidation {
  const errors: string[] = [];
  const nodes = new Map(wf.nodes.map((n) => [n.id, n]));
  if (nodes.size !== wf.nodes.length) errors.push("duplicate node ids");

  const links = new Map(wf.links.map((l) => [l[0], l]));
  if (links.size !== wf.links.length) errors.push("duplicate link ids");

  for (const [id, source, outSlot, target, inSlot, kind] of links.values()) {
    const src = nodes.get(source);
    const tgt = nodes.get(target);
    if (!src || !tgt) {
      errors.push(`link ${id} references a missing node`);
      continue;
    }
    const output = src.outputs[outSlot];
    const input = tgt.inputs[inSlot];
    if (!output || !input) {
      errors.push(`link ${id} references a missing slot`);
      continue;
    }
    if (input.link !== id) errors.push(`link ${id}: target input does not point back at it`);
    if (!output.links.includes(id)) errors.push(`link ${id}: source output does not list it`);
    if (output.type !== kind || input.type !== kind) errors.push(`link ${id}: type mismatch`);
  }

  for (const n of wf.nodes) {
    for (const input of n.inputs) {
      if (input.link !== null && !links.has(input.link)) {
        errors.push(`node ${n.id} input "${input.name}" points at missing link ${input.link}`);
      }
    }
    for (const output of n.outputs) {
      for (const id of output.links) {
        if (!links.has(id)) errors.push(`node ${n.id} output "${output.name}" lists missing link ${id}`);
      }
    }
  }

  const sink = wf.nodes.find((n) => n.type === "SaveImage");
  if (!sink) {
    errors.push("workflow has no SaveImage node");
  } else {
    const reached = new Set<number>();
    const pending = [sink.id];
    while (pending.length) {
      const id = pending.pop() as number;
      if (reached.has(id)) continue;
      reached.add(id);
      for (const input of nodes.get(id)?.inputs ?? []) {
        const link = input.link === null ? undefined : links.get(input.link);
        if (link) pending.push(link[1]);
      }
    }
    const orphans = wf.nodes.filter((n) => !reached.has(n.id)).map((n) => `${n.id} (${n.type})`);
    if (orphans.length) errors.push(`nodes not reachable from SaveImage: ${orphans.join(", ")}`);
  }

  return { valid: errors.length === 0, errors };
}

export interface SyncResult {
  workflow: Workflow;
  changes: string[];
  validation: WorkflowValidation;
}

/**
 * Makes a workflow match a template's attached models: the checkpoint becomes
 * the template's base model, and the LoRA chain becomes exactly the template's
 * LoRAs at their configured weights. The template stays the single source of
 * truth, so downloading a LoRA and actually using it stop drifting apart.
 */
export function syncWorkflowToResources(wf: Workflow, resources: ModelResource[]): SyncResult {
  const changes: string[] = [];
  const fileOf = (r: ModelResource) => r.filename ?? `${r.name}.safetensors`;

  const base = resources.find((r) => r.role === "base");
  if (base) {
    const currentCheckpoint = getCheckpoint(wf).filename;
    const wanted = fileOf(base);
    if (currentCheckpoint !== wanted) {
      setCheckpoint(wf, wanted, base.url);
      changes.push(`checkpoint: ${currentCheckpoint || "(none)"} -> ${wanted}`);
    }
  }

  const wanted = resources.filter((r) => r.role === "lora");
  const wantedFiles = new Set(wanted.map(fileOf));

  for (const present of listLoras(wf)) {
    if (!wantedFiles.has(present.filename)) {
      removeLora(wf, present.filename);
      changes.push(`removed LoRA ${present.filename}`);
    }
  }

  for (const lora of wanted) {
    const filename = fileOf(lora);
    const strength = lora.weight ?? 1.0;
    const present = listLoras(wf).find((l) => l.filename === filename);
    if (!present) {
      addLora(wf, { filename, strengthModel: strength, strengthClip: strength, url: lora.url, title: lora.name });
      changes.push(`added LoRA ${filename} at ${strength}`);
    } else if (present.strengthModel !== strength) {
      setLoraStrength(wf, filename, strength);
      changes.push(`LoRA ${filename}: weight ${present.strengthModel} -> ${strength}`);
    }
  }

  return { workflow: wf, changes, validation: validateWorkflow(wf) };
}
