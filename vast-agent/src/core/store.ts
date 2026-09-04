import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.js";

/**
 * Minimal JSON-file persistence for the small amount of state the VAST Agent
 * actually needs to remember between calls. Not a general memory store.
 */
interface KnownTemplate {
  id?: number;
  hash_id?: string;
  name?: string;
  lastSeenAt: string;
}

interface KnownInstance {
  id: number;
  label?: string | null;
  lastSeenAt: string;
  lastAction?: string;
}

interface KnownLora {
  name: string;
  source: "huggingface" | "civitai" | "url";
  ref: string;
  lastUsedAt: string;
}

interface ModelSourceRef {
  ref: string;
  lastUsedAt: string;
}

interface ActionRecord {
  ts: string;
  tool: string;
  summary: string;
}

interface StoreShape {
  templates: Record<string, KnownTemplate>;
  instances: Record<string, KnownInstance>;
  loras: Record<string, KnownLora>;
  huggingfaceRepos: ModelSourceRef[];
  civitaiModels: ModelSourceRef[];
  lastActions: ActionRecord[];
}

const EMPTY_STORE: StoreShape = {
  templates: {},
  instances: {},
  loras: {},
  huggingfaceRepos: [],
  civitaiModels: [],
  lastActions: [],
};

const MAX_LIST_LEN = 50;

function storePath(): string {
  return join(config.dataDir, "vast-agent-store.json");
}

async function load(): Promise<StoreShape> {
  try {
    const raw = await readFile(storePath(), "utf8");
    return { ...EMPTY_STORE, ...JSON.parse(raw) };
  } catch {
    return structuredClone(EMPTY_STORE);
  }
}

async function save(data: StoreShape): Promise<void> {
  await mkdir(config.dataDir, { recursive: true });
  const tmp = storePath() + ".tmp";
  await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await rename(tmp, storePath());
}

function pushCapped<T>(arr: T[], item: T): T[] {
  return [...arr, item].slice(-MAX_LIST_LEN);
}

export const store = {
  async rememberTemplate(t: KnownTemplate) {
    const data = await load();
    const key = t.hash_id ?? String(t.id);
    data.templates[key] = { ...data.templates[key], ...t, lastSeenAt: new Date().toISOString() };
    await save(data);
  },

  async forgetTemplate(key: string) {
    const data = await load();
    delete data.templates[key];
    await save(data);
  },

  async rememberInstance(i: Omit<KnownInstance, "lastSeenAt">) {
    const data = await load();
    data.instances[String(i.id)] = { ...i, lastSeenAt: new Date().toISOString() };
    await save(data);
  },

  async forgetInstance(id: number) {
    const data = await load();
    delete data.instances[String(id)];
    await save(data);
  },

  async rememberLora(l: Omit<KnownLora, "lastUsedAt">) {
    const data = await load();
    data.loras[l.name] = { ...l, lastUsedAt: new Date().toISOString() };
    await save(data);
  },

  async rememberHuggingFaceRepo(repo: string) {
    const data = await load();
    data.huggingfaceRepos = pushCapped(
      data.huggingfaceRepos.filter((r) => r.ref !== repo),
      { ref: repo, lastUsedAt: new Date().toISOString() }
    );
    await save(data);
  },

  async rememberCivitaiModel(ref: string) {
    const data = await load();
    data.civitaiModels = pushCapped(
      data.civitaiModels.filter((r) => r.ref !== ref),
      { ref, lastUsedAt: new Date().toISOString() }
    );
    await save(data);
  },

  async recordAction(tool: string, summary: string) {
    const data = await load();
    data.lastActions = pushCapped(data.lastActions, {
      ts: new Date().toISOString(),
      tool,
      summary,
    });
    await save(data);
  },

  async dump(): Promise<StoreShape> {
    return load();
  },
};
