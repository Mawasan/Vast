#!/usr/bin/env node
/**
 * Read-only smoke test against the real Vast.ai, Hugging Face and Civitai
 * APIs. Run it wherever the agent is deployed, with the real keys in the
 * environment:
 *
 *   VAST_API_KEY=... HF_TOKEN=... CIVITAI_API_TOKEN=... npm run smoke
 *
 * It only reads. It never creates, edits, destroys or deletes anything, and
 * it never prints a key.
 */
import { tools } from "../dist/tools/registry.js";
import { config, redact } from "../dist/core/config.js";

const call = (name, input = {}) => {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`no such tool: ${name}`);
  if (tool.destructive) throw new Error(`refusing to run destructive tool ${name} in a smoke test`);
  return tool.handler(input);
};

const checks = [
  {
    name: "Vast.ai auth",
    needs: "VAST_API_KEY",
    run: async () => {
      const me = await call("vast_whoami");
      return `authenticated as user id ${me.id}`;
    },
  },
  {
    name: "Vast.ai list templates",
    needs: "VAST_API_KEY",
    run: async () => {
      const list = await call("vast_list_templates", { mineOnly: true });
      const names = list.map((t) => t.name).filter(Boolean);
      return `${list.length} template(s)${names.length ? `: ${names.slice(0, 5).join(", ")}` : ""}`;
    },
  },
  {
    name: "Vast.ai read one template",
    needs: "VAST_API_KEY",
    run: async () => {
      const list = await call("vast_list_templates", { mineOnly: true });
      if (list.length === 0) return "skipped — you have no templates yet";
      const first = list[0];
      const t = await call("vast_get_template", { template: first.name ?? first.hash_id });
      return `resolved "${t.name}" by name -> ${t.hash_id} (image ${t.image ?? "?"})`;
    },
  },
  {
    name: "Vast.ai list instances",
    needs: "VAST_API_KEY",
    run: async () => {
      const list = await call("vast_list_instances");
      if (list.length === 0) return "0 instances running";
      return list
        .map((i) => `#${i.id} ${i.actual_status} ${i.gpu_name ?? "?"} $${i.dph_total ?? "?"}/h`)
        .join(" | ");
    },
  },
  {
    name: "Vast.ai account env vars",
    needs: "VAST_API_KEY",
    run: async () => {
      const res = await call("vast_check_account_env_vars");
      return (
        `${res.names.length} name(s) set — ` +
        `HF_TOKEN ${res.hfTokenPresent ? "present" : "MISSING"}, ` +
        `CIVITAI_API_TOKEN ${res.civitaiTokenPresent ? "present" : "MISSING"} ` +
        "(needed on the instance for gated downloads)"
      );
    },
  },
  {
    name: "Hugging Face search",
    run: async () => {
      const hits = await call("huggingface_search_models", { query: "illustrious", limit: 3 });
      return `${hits.length} hit(s): ${hits.map((h) => h.id).join(", ")}`;
    },
  },
  {
    name: "Hugging Face model info + file pick",
    run: async () => {
      const info = await call("huggingface_get_model_info", {
        repoId: "OnomaAIResearch/Illustrious-XL-v1.1",
      });
      const gb = (info.totalSizeBytes / 1e9).toFixed(1);
      return `type=${info.inferredType}, ${info.files.length} file(s), ~${gb} GB, sha ${String(info.sha).slice(0, 8)}`;
    },
  },
  {
    name: "Civitai search",
    run: async () => {
      const hits = await call("civitai_search_models", { query: "anime", limit: 3 });
      return `${hits.length} hit(s): ${hits.map((h) => `${h.name} [${h.type}]`).join(", ")}`;
    },
  },
];

const icon = { pass: "PASS", skip: "SKIP", fail: "FAIL" };

async function main() {
  console.log("VAST Agent smoke test — read-only, nothing is created or destroyed.\n");
  console.log(
    `keys detected: VAST_API_KEY ${config.vastApiKey ? "yes" : "no"}, ` +
      `HF_TOKEN ${config.hfToken ? "yes" : "no"}, ` +
      `CIVITAI_API_TOKEN ${config.civitaiToken ? "yes" : "no"}\n`
  );

  let failed = 0;
  for (const check of checks) {
    if (check.needs === "VAST_API_KEY" && !config.vastApiKey) {
      console.log(`${icon.skip}  ${check.name} — VAST_API_KEY not set`);
      continue;
    }
    try {
      const detail = await check.run();
      console.log(`${icon.pass}  ${check.name} — ${redact(String(detail))}`);
    } catch (err) {
      failed++;
      console.log(`${icon.fail}  ${check.name} — ${redact(err.message)}`);
    }
  }

  console.log(failed === 0 ? "\nAll reachable checks passed." : `\n${failed} check(s) failed.`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
