# VAST Agent

A standalone agent for managing **Vast.ai** only: templates, instances, and the
Hugging Face / Civitai model search needed to build templates. It is not part
of any chat assistant, general agent framework, or other cloud provider
integration, and it does not depend on any specific LLM.

All Vast.ai / Hugging Face / Civitai logic lives in `src/vast` and
`src/sources`, completely independent of how a client talks to it. Two thin,
interchangeable adapters sit on top:

- **MCP** (`src/mcp/server.ts`) — the primary interface. Works over stdio
  (local clients) or Streamable HTTP (`POST /mcp`, remote clients).
- **HTTP REST** (`src/http/server.ts`) — `GET /api/tools` to list tools,
  `POST /api/tools/:name` to call one, for anything that isn't an MCP client.

Any client that reaches one of these gets the exact same Vast.ai behavior.

## Setup

```bash
cd vast-agent
npm install
cp .env.example .env   # fill in VAST_API_KEY at minimum
npm run build
```

The agent reads `vast-agent/.env` on startup, so the keys only have to be
written down once — no exporting them every session, and it works the same on
Windows, macOS and Linux. Real environment variables always take precedence
over the file, which is why Railway (where the platform sets them and no
`.env` exists) needs no change. `.env` is gitignored.

On Windows, create it in PowerShell (note: the Unix `KEY=value command`
prefix does **not** exist in PowerShell):

```powershell
cd vast-agent
Copy-Item .env.example .env
notepad .env            # paste the keys, save
```

Required/optional environment variables (see `.env.example`):

| Variable | Required | Purpose |
|---|---|---|
| `VAST_API_KEY` | yes | Vast.ai console API key |
| `VAST_AGENT_ACCESS_TOKEN` | yes for HTTP | protects the public MCP and REST endpoints |
| `HF_TOKEN` | no | gated/private Hugging Face repos |
| `CIVITAI_API_TOKEN` | no | NSFW-gated Civitai content / rate limits |
| `VAST_URL` | no | override API base (default `https://console.vast.ai`) |
| `PORT` | no | HTTP port (Railway sets this automatically) |
| `VAST_AGENT_TRANSPORT` | no | `http` (default) or `stdio` |
| `VAST_AGENT_DATA_DIR` | no | where the local memory JSON file lives |
| `VAST_AGENT_REQUIRE_CONFIRMATION` | no | set `false` to skip the confirm gate (not recommended) |

No secret is ever hardcoded, logged, or echoed back in a tool result — the
logger and HTTP error path redact any configured secret value.

## Running locally

```bash
npm run start:stdio   # for a local MCP client speaking stdio
npm run start:http    # HTTP + MCP-over-HTTP on $PORT (default 8080)
```

`GET /health` never touches the Vast.ai API — it only reports whether a key
is configured, so Railway's health check works even if Vast.ai is down.

## Deploying to Railway

Push this directory as its own Railway service (`Dockerfile` + `railway.json`
are included). Set `VAST_API_KEY`, `VAST_AGENT_ACCESS_TOKEN` and optionally `HF_TOKEN` /
`CIVITAI_API_TOKEN`) as service variables. Railway provides `PORT`
automatically; the container listens on it and answers `/health`.

## Using it from a client

**Claude Code / Cursor / any local MCP client (stdio):**

```json
{
  "mcpServers": {
    "vast-agent": {
      "command": "node",
      "args": ["/absolute/path/to/vast-agent/dist/index.js"],
      "env": { "VAST_AGENT_TRANSPORT": "stdio", "VAST_API_KEY": "..." }
    }
  }
}
```

**Codex / Cursor / Claude Code against a shared Railway deployment (Streamable HTTP):**

```json
{
  "mcpServers": {
    "vast-agent": {
      "url": "https://<your-railway-app>.up.railway.app/mcp",
      "headers": { "Authorization": "Bearer ${VAST_AGENT_ACCESS_TOKEN}" }
    }
  }
}
```

**Anything else:** plain REST — `GET /api/tools`, `POST /api/tools/<name>` with a JSON body.

Whichever client you use, the tool set and behavior are identical — the agent
itself doesn't know or care which LLM is calling it.

## Irreversible actions

`vast_destroy_instance` and `vast_delete_template` require `confirm: true` in
the call. Without it, they perform **no** API call and instead return a
`confirmation_required` preview of what would happen. `vast_destroy_instance`
additionally polls the instance after destroying it and only reports success
once the instance id no longer resolves — a stop/pause is never treated as a
destroy.

## Say it in one sentence

The tools are built so a single natural-language request maps to a single
call — no hash-hunting or path bookkeeping first:

> "Take my Illustrious template and add the Akira LoRA."

```json
{ "template": "illustrious", "name": "akira", "source": "civitai", "ref": "1234567" }
```

- **Templates are addressed by name** (partial, case-insensitive), hash_id, or
  numeric id. An ambiguous name fails listing the real candidates instead of
  guessing; an unknown one lists the templates you actually have.
- **The download directory is derived** from the template's own `COMFYUI_DIR`
  (falling back to `/workspace/ComfyUI`), into `models/loras` for a LoRA and
  `models/checkpoints` for a base model. Override with `targetPath` anytime.
- **The exact weight file is resolved** from Hugging Face or Civitai, so one
  `.safetensors` is downloaded instead of a whole multi-format repo.
- **A Civitai id may be a model or a version id** — it resolves to the right
  download version either way.
- **A LoRA used before can be re-attached by name alone**; source and ref come
  from the agent's memory.

## Tools

Templates: `vast_list_templates`, `vast_get_template`, `vast_create_template`,
`vast_update_template` (partial/surgical), `vast_duplicate_template`,
`vast_delete_template`, `vast_validate_template_config`.

Template editing: `vast_list_template_models`, `vast_set_template_base_model`,
`vast_add_lora`, `vast_remove_lora`, `vast_set_lora_weight`,
`vast_set_template_env_vars`, `vast_set_template_start_command`,
`vast_create_template_from_model` (Hugging Face / Civitai -> template).

Instances: `vast_list_instances`, `vast_get_instance`, `vast_destroy_instance`.

Model search: `huggingface_search_models`, `huggingface_get_model_info`,
`civitai_search_models`, `civitai_get_model_info`, `civitai_get_model_version`.

Misc: `vast_whoami`, `vast_agent_memory`, `vast_check_account_env_vars`
(names only — a download command that needs `CIVITAI_API_TOKEN` on the
instance can be checked before it fails there).

## ComfyUI workflows

Downloading a LoRA onto the instance is only half the job — a generation only
applies it if the workflow graph wires it in. These tools close that gap, as
pure graph surgery on a workflow JSON (UI/graph format, as in
`comfyui/workflows/*.json`):

- `comfyui_inspect_workflow` — which checkpoint, which LoRAs at what strength,
  and whether the graph is structurally sound.
- `comfyui_sync_workflow_with_template` — rewrites the workflow so it matches a
  template's attached models: checkpoint becomes the base model, and the LoRA
  chain becomes exactly the template's LoRAs at their configured weights. The
  template stays the single source of truth, so "downloaded" and "actually
  used" can't drift apart.
- `comfyui_set_workflow_lora` / `comfyui_remove_workflow_lora` — add, re-weight,
  or splice out one LoRA directly.

A `LoraLoader` is inserted into the MODEL **and** CLIP paths between the
checkpoint and its consumers, so several LoRAs stack in order. Every patched
graph is validated before it is returned — link ids referenced from both ends,
matching slot types, every node still reachable from `SaveImage` — and a patch
that would produce a broken graph raises instead of returning it. The
workflow tools take and return JSON; they never touch a running instance's
filesystem, so the caller decides where the result is written.

## Tests

```bash
npm test
```

Runs the tool handlers end to end against a mock Vast.ai API
(`test/mockVast.js`), covering name resolution, LoRA add/remove/weight, base
model swaps, env-var surgery, the confirm gate, and that a destroy which
leaves the instance alive is reported as a failure. The workflow tests run the
graph surgery against this repo's real `comfyui/workflows/illustrious-xl.json`
and re-assert the same invariants `comfyui/tests/test_workflows.py` checks. No
real account is touched.

### Checking the real APIs

The unit tests deliberately never call out to the internet. To verify the real
Vast.ai / Hugging Face / Civitai APIs, run the read-only smoke test where the
keys live — your machine or the Railway service:

With the keys in `vast-agent/.env`, it is just:

```bash
npm run smoke
```

(Windows PowerShell: the same command — the keys come from `.env`. If you
would rather set them per session instead, PowerShell uses
`$env:VAST_API_KEY = "..."`, not the Unix `KEY=value` prefix form.)

It authenticates, lists your templates and instances, resolves one template by
name, reports which account env vars exist (names only), and searches both
model sources. It only reads — no create, edit, destroy or delete — and it
redacts any key from its output.

## Persistence

A single JSON file at `$VAST_AGENT_DATA_DIR/vast-agent-store.json` remembers
known template/instance ids and names, recently used Hugging Face repos and
Civitai model refs, known LoRAs, and the last ~50 actions. That's it — no
general chat memory, no database.

## Design notes: how template edits stay surgical

Vast.ai's template update endpoint takes a full record, not a patch. To avoid
ever needing to recreate a template for a one-field change, `vast_update_template`
and the model/LoRA/env tools always **read the current template first**, merge
only the requested change on top of it, and write the full merged record back.

- `env` (the Docker-options flag string) is parsed into structured `-e`/`-p`
  entries so a single variable or port can be set/removed without touching
  the rest (`src/core/dockerEnv.ts`).
- Base model / LoRAs are tracked as a small JSON list embedded in a
  clearly-marked, machine-generated block inside `onstart`
  (`src/vast/modelBlock.ts`). Editing that list regenerates only the block;
  any custom commands the user wrote around it are preserved untouched.

## What this is explicitly not

No chat memory, no AKIRA/Sayuri integration, no multi-agent routing, no
OpenAI/Anthropic provider code, no training, and no other
GPU cloud provider (AWS/RunPod/etc). This service only ever talks to
Vast.ai, Hugging Face, and Civitai.

## General compute and inference tools

Available through the existing `/mcp` endpoint (Claude Code, Cursor, Codex,
and other MCP clients), stdio, and authenticated REST. No AKIRA dependency.
REST clients can discover full JSON input schemas at protected `GET /api/tools`.
The credential-free OpenAPI 3.1 discovery document is available at
`GET /openapi.json` and `GET /api/openapi.json` so ChatGPT Actions and other
cloud clients can import it automatically. Every tool execution still requires
`Authorization: Bearer <VAST_AGENT_ACCESS_TOKEN>`. Provider keys stay on the
agent server; an LLM requires a tool-capable client/host to execute these calls.

### ChatGPT and other cloud MCP hosts

The hosted `/mcp` endpoint implements OAuth 2.1 authorization-code flow with
PKCE and dynamic client registration. Provider credentials never leave the
server. During the first connection, the owner authorizes access by entering
`VAST_AGENT_ACCESS_TOKEN` on the agent's own HTTPS page; the cloud client gets
a scoped OAuth token instead of that secret. OAuth discovery is published at
the standard protected-resource and authorization-server metadata URLs.

| Tool | Purpose |
| --- | --- |
| `vast_search_offers` | Current on-demand offers, GPU filters, price and disk sizing |
| `vast_rent_instance` | Rent a specific offer with an existing template and a quoted hourly price ceiling |
| `vast_start_instance` / `vast_stop_instance` | Resume or stop compute; stopping preserves disk and storage charges |
| `vast_list_endpoints` | Discover existing serverless endpoint names without exposing credentials |
| `vast_generate_image` | Submit an API-format ComfyUI workflow to `/generate/sync` |
| `vast_serverless_request` | Native JSON payloads for text/image/audio/video routes supported by the chosen worker |
| `vast_get_job` | Retrieve the result after reconnecting |

Examples of natural-language requests: “Find one RTX 4090 under $0.50/hour”,
“Rent offer 123 using my Illustrious template with 60 GB disk, up to $0.50/hour”,
“Stop instance 456”, or “Run this image workflow on my ComfyUI endpoint”.
The client supplies `confirm:true` for authorized mutations/inference. It can
reuse authorization already given by the user; a missing flag returns a preview.

Rent and inference return immediately with `requestId` and `status:running`.
Poll `vast_get_job` every few seconds until `completed` or `unknown`. Retrying
with the same ID and arguments returns the same job; a changed payload under
that ID is rejected. Jobs and results live under `$VAST_AGENT_DATA_DIR/jobs`
(Railway: `/data/jobs`). Run a **single replica** against this volume. Client
disconnects do not stop jobs. Agent restarts cannot resume a lost worker response:
an interrupted operation becomes `unknown` and is never automatically replayed.
Inspect Vast before issuing a new ID in that case. No automatic GPU cleanup is
performed; the client must stop/destroy the rented instance when appropriate.

The rental ceiling is checked against the current `dph_total` quote immediately
before renting; it is not a hard lifetime spending cap or an atomic provider-side
price guarantee. Network traffic may cost extra. `cost` in inference is a Vast
workload estimate, **not dollars**. Inference can start autoscaled workers.

Generation requires an existing, configured Serverless endpoint/workergroup;
renting an ordinary instance does not enroll it into Serverless. Routing waits
up to `timeoutSeconds` (10–1800 seconds) for a worker. Worker addresses must be
public IPv4 literals; redirects and private network destinations are rejected.
The worker payload uses `{auth_data, payload}`. The Vast API key is sent only to
Vast's router, not to the worker. Paid POST/PUT requests are never automatically
retried after uncertain failures.

For ComfyUI, supply API-format nodes (`class_type` and `inputs` keyed by node ID),
not the editor's `nodes`/`links` export used by the workflow editing tools.
The checkpoint/LoRA files and custom nodes must exist on the worker. Media output
is returned as the worker provides it: configure S3 on the worker for persistent
download URLs. A `local_path` alone is explicitly identified as a worker-local
file, not a downloadable image. Binary responses return MIME type and base64;
outputs larger than 32 MB must use worker storage URLs. Requests use JSON and
non-streaming responses; multipart uploads and SSE inference are not implemented.

REST example (same argument shape as MCP):

```js
const base = "https://vast-agent-production.up.railway.app";
const headers = {
  "Authorization": `Bearer ${process.env.VAST_AGENT_ACCESS_TOKEN}`,
  "Content-Type": "application/json"
};
const response = await fetch(`${base}/api/tools/vast_search_offers`, {
  method: "POST", headers,
  body: JSON.stringify({ filters: { gpu_name: { eq: "RTX_4090" } }, limit: 5, diskGb: 60 })
});
console.log(await response.json());
```

Protocol references: [offer search](https://docs.vast.ai/api-reference/search/search-offers),
[rental](https://docs.vast.ai/api-reference/instances/create-instance),
[start/stop](https://docs.vast.ai/api-reference/instances/manage-instance),
[routing](https://docs.vast.ai/api-reference/serverless/route),
[ComfyUI payload](https://docs.vast.ai/guides/serverless/comfyui-wan-2.2).
