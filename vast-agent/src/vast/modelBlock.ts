import type { ModelResource } from "../core/types.js";

/**
 * A managed, machine-generated block inside a template's `onstart` script
 * that downloads whatever base model / LoRAs are currently attached. It is
 * delimited by markers so it can be regenerated in place without touching
 * any custom commands the user has around it.
 */
const START_MARKER = "# >>> vast-agent:models >>>";
const END_MARKER = "# <<< vast-agent:models <<<";
const STATE_PREFIX = "# vast-agent:models:json=";

/** Marker file a worker leaves behind when a managed download did not land. */
export const MISSING_MODELS_MARKER = "/workspace/.akira-missing-models";

/** Single-quotes a value for `sh`, so model names from Civitai/HF stay inert. */
function sq(value: string): string {
  return `'${value.split("'").join("'\\''")}'`;
}

/** A model name that is safe to append to a shell string in double quotes. */
function label(name: string): string {
  return name.replace(/[\r\n"$`\\]/g, " ").trim() || "model";
}

/**
 * Download helpers, emitted once per block.
 *
 * Vast's provisioning script runs under `set -euo pipefail`, so a single
 * failing `curl` used to abort the whole script — and because Vast starts the
 * instance anyway after a failed provisioning ("Provisioning encountered
 * issues but instance startup will continue"), ComfyUI then came up with
 * empty model directories and answered generation requests with
 * "Value not in list". Every download therefore runs through `akira_fetch`,
 * whose failures are collected instead of aborting: one gated Civitai model
 * can no longer take the freely downloadable VAE and text encoder down with
 * it, and the log names exactly which files are missing.
 */
const HELPERS = [
  `akira_missing=''`,
  // Vast's own provisioner reads CIVITAI_TOKEN; this account sets CIVIT.
  // Accept both plus the agent's own name so the token is found whichever
  // way the account or template spells it.
  `akira_civitai_token() { printf '%s' "\${CIVITAI_API_TOKEN:-\${CIVITAI_TOKEN:-\${CIVIT:-}}}"; }`,
  `akira_fetch() {`,
  `  akira_label="$1"; akira_out="$2"; akira_url="$3"; akira_kind="$4"`,
  `  mkdir -p "$(dirname "$akira_out")"`,
  `  if [ -s "$akira_out" ]; then echo "akira: $akira_label already present"; return 0; fi`,
  `  rm -f "$akira_out"`,
  `  akira_token=''`,
  `  if [ "$akira_kind" = civitai ]; then akira_token="$(akira_civitai_token)"; fi`,
  `  if [ -n "$akira_token" ]; then`,
  `    if curl -fL --retry 3 --retry-delay 5 -C - -H "Authorization: Bearer $akira_token" -o "$akira_out" "$akira_url"; then return 0; fi`,
  // Civitai documents ?token= for command-line downloaders; try both forms
  // before declaring a gated file unreachable.
  `    case "$akira_url" in *\\?*) akira_sep='&';; *) akira_sep='?';; esac`,
  `    rm -f "$akira_out"`,
  `    if curl -fL --retry 3 --retry-delay 5 -C - -o "$akira_out" "\${akira_url}\${akira_sep}token=\${akira_token}"; then return 0; fi`,
  `    echo "akira: $akira_label could not be downloaded even with a Civitai token" >&2`,
  `  else`,
  `    if curl -fL --retry 3 --retry-delay 5 -C - -o "$akira_out" "$akira_url"; then return 0; fi`,
  `    if [ "$akira_kind" = civitai ]; then echo "akira: $akira_label needs a Civitai token (set CIVITAI_API_TOKEN, CIVITAI_TOKEN or CIVIT on the account or template)" >&2; fi`,
  `  fi`,
  `  rm -f "$akira_out"`,
  `  return 1`,
  `}`,
].join("\n");

const FOOTER = [
  `if [ -n "$akira_missing" ]; then`,
  `  echo "akira: provisioning could not fetch:$akira_missing" >&2`,
  `  printf '%s\\n' "$akira_missing" > ${MISSING_MODELS_MARKER} 2>/dev/null || true`,
  `else`,
  `  rm -f ${MISSING_MODELS_MARKER} 2>/dev/null || true`,
  `fi`,
].join("\n");

/** The URL a resource is fetched from, when one can be named up front. */
export function resourceDownloadUrl(resource: ModelResource): string | null {
  if (resource.url) return resource.url;
  if (resource.source === "civitai") return `https://civitai.com/api/download/models/${resource.ref}`;
  if (resource.source === "url") return resource.ref;
  // A Hugging Face repo without a pinned file is resolved by the CLI instead.
  return null;
}

/**
 * True only for real Civitai hosts over HTTPS. This decides whether the
 * account's Civitai token is attached, so a substring test is not enough:
 * `civitai.com` can appear in the path or a subdomain suffix of a URL someone
 * else controls.
 */
export function isCivitaiUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && (parsed.hostname === "civitai.com" || parsed.hostname.endsWith(".civitai.com"));
  } catch {
    return false;
  }
}

/** Where the resource ends up on the instance. */
export function resourceOutputPath(resource: ModelResource): string {
  return `${resource.targetPath}/${resource.filename ?? `${resource.name}.safetensors`}`;
}

function downloadCommand(resource: ModelResource): string {
  const url = resourceDownloadUrl(resource);
  if (resource.source === "huggingface" && !url) {
    // `hf` is the current Hugging Face CLI (huggingface-cli is deprecated).
    // With a resolved filename only that one weight file is fetched, instead
    // of the whole repo including duplicate formats.
    const command =
      `mkdir -p ${sq(resource.targetPath)} && hf download ${sq(resource.ref)}` +
      (resource.filename ? ` ${sq(resource.filename)}` : "") +
      ` --local-dir ${sq(resource.targetPath)}` +
      (resource.revision ? ` --revision ${sq(resource.revision)}` : "");
    return `if ! ( ${command} ); then akira_missing="$akira_missing ${label(resource.name)}"; fi`;
  }
  const target = url ?? resource.ref;
  const kind = isCivitaiUrl(target) ? "civitai" : "plain";
  return (
    `if ! akira_fetch ${sq(resource.name)} ${sq(resourceOutputPath(resource))} ${sq(target)} ${kind}; then ` +
    `akira_missing="$akira_missing ${label(resource.name)}"; fi`
  );
}

export function buildManagedBlock(resources: ModelResource[]): string {
  if (resources.length === 0) {
    return `${START_MARKER}\n${STATE_PREFIX}[]\n${END_MARKER}`;
  }
  const lines = [START_MARKER, `${STATE_PREFIX}${JSON.stringify(resources)}`, HELPERS];
  for (const resource of resources) {
    lines.push(`# ${resource.role}: ${resource.name}${resource.weight !== undefined ? ` (weight ${resource.weight})` : ""}`);
    lines.push(downloadCommand(resource));
  }
  lines.push(FOOTER);
  lines.push(END_MARKER);
  return lines.join("\n");
}

export function parseManagedModels(onstart: string | undefined | null): ModelResource[] {
  if (!onstart) return [];
  const start = onstart.indexOf(START_MARKER);
  const end = onstart.indexOf(END_MARKER);
  if (start === -1 || end === -1) return [];
  const block = onstart.slice(start, end);
  const stateLine = block.split("\n").find((l) => l.startsWith(STATE_PREFIX));
  if (!stateLine) return [];
  try {
    return JSON.parse(stateLine.slice(STATE_PREFIX.length)) as ModelResource[];
  } catch {
    return [];
  }
}

/**
 * Replaces the managed block in `onstart` and keeps it before the user's
 * command. A long-running server start must never prevent model downloads.
 */
export function injectManagedBlock(onstart: string | undefined | null, resources: ModelResource[]): string {
  const block = buildManagedBlock(resources);
  const source = onstart ?? "";
  const start = source.indexOf(START_MARKER);
  const end = source.indexOf(END_MARKER);
  const heredocDeclaration = "cat > /tmp/akira-models.sh <<'AKIRA_PROVISION'";
  const heredocStart = source.indexOf(heredocDeclaration);
  const heredocEnd = heredocStart === -1 ? -1 : source.indexOf("\nAKIRA_PROVISION", heredocStart);

  if (start !== -1 && end !== -1) {
    const afterMarker = end + END_MARKER.length;
    if (heredocStart === -1 || heredocEnd === -1 || (start > heredocStart && afterMarker < heredocEnd)) {
      // Preserve the block's semantic location. In Vast's Comfy image it is
      // deliberately inside PROVISIONING_SCRIPT's heredoc; moving it above
      // entrypoint.sh downloads files too early and leaves ComfyUI uninstalled.
      return `${source.slice(0, start)}${block}${source.slice(afterMarker)}`;
    }

    // Repair templates damaged by the previous prepend behavior: remove the
    // outer block, then put it back inside the provisioning heredoc.
    const withoutBlock = `${source.slice(0, start)}${source.slice(afterMarker)}`;
    const repairedHeredocStart = withoutBlock.indexOf(heredocDeclaration);
    const repairedHeredocEnd = withoutBlock.indexOf("\nAKIRA_PROVISION", repairedHeredocStart);
    const strictLine = withoutBlock.indexOf("set -euo pipefail", repairedHeredocStart);
    const insertionPoint = strictLine !== -1 && strictLine < repairedHeredocEnd
      ? withoutBlock.indexOf("\n", strictLine) + 1
      : withoutBlock.indexOf("\n", repairedHeredocStart) + 1;
    return `${withoutBlock.slice(0, insertionPoint)}${block}\n${withoutBlock.slice(insertionPoint)}`;
  }

  if (heredocStart !== -1 && heredocEnd !== -1) {
    const strictLine = source.indexOf("set -euo pipefail", heredocStart);
    const insertionPoint = strictLine !== -1 && strictLine < heredocEnd
      ? source.indexOf("\n", strictLine) + 1
      : source.indexOf("\n", heredocStart) + 1;
    return `${source.slice(0, insertionPoint)}${block}\n${source.slice(insertionPoint)}`;
  }

  const custom = source.trim();
  return custom ? `${block}\n\n${custom}\n` : `${block}\n`;
}
