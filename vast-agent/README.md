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

Required/optional environment variables (see `.env.example`):

| Variable | Required | Purpose |
|---|---|---|
| `VAST_API_KEY` | yes | Vast.ai console API key |
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
are included). Set `VAST_API_KEY` (and optionally `HF_TOKEN` /
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
    "vast-agent": { "url": "https://<your-railway-app>.up.railway.app/mcp" }
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

## Tests

```bash
npm test
```

Runs the tool handlers end to end against a mock Vast.ai API
(`test/mockVast.js`), covering name resolution, LoRA add/remove/weight, base
model swaps, env-var surgery, the confirm gate, and that a destroy which
leaves the instance alive is reported as a failure. No real account is
touched.

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
OpenAI/Anthropic provider code, no image generation or training, and no other
GPU cloud provider (AWS/RunPod/etc). This service only ever talks to
Vast.ai, Hugging Face, and Civitai.
