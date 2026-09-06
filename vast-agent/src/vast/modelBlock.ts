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

function downloadCommand(resource: ModelResource): string {
  const { source, ref, targetPath, filename } = resource;
  const mkdir = `mkdir -p "${targetPath}"`;
  switch (source) {
    case "huggingface":
      // `hf` is the current Hugging Face CLI (huggingface-cli is deprecated).
      // With a resolved filename only that one weight file is fetched, instead
      // of the whole repo including duplicate formats.
      return (
        `${mkdir} && hf download "${ref}"` +
        (filename ? ` "${filename}"` : "") +
        ` --local-dir "${targetPath}"` +
        (resource.revision ? ` --revision "${resource.revision}"` : "")
      );
    case "civitai":
      // -C - resumes a partial download; the token is read from the instance's
      // environment and never written into the template itself.
      return (
        `${mkdir} && curl -fL -C - -H "Authorization: Bearer $CIVITAI_API_TOKEN" ` +
        `-o "${targetPath}/${filename ?? `${resource.name}.safetensors`}" ` +
        `"https://civitai.com/api/download/models/${ref}"`
      );
    case "url":
    default:
      return `${mkdir} && curl -fL -C - -o "${targetPath}/${filename ?? resource.name}" "${ref}"`;
  }
}

export function buildManagedBlock(resources: ModelResource[]): string {
  if (resources.length === 0) {
    return `${START_MARKER}\n${STATE_PREFIX}[]\n${END_MARKER}`;
  }
  const lines = [START_MARKER, `${STATE_PREFIX}${JSON.stringify(resources)}`];
  for (const resource of resources) {
    lines.push(`# ${resource.role}: ${resource.name}${resource.weight !== undefined ? ` (weight ${resource.weight})` : ""}`);
    lines.push(downloadCommand(resource));
  }
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

/** Replaces the managed block in `onstart`, leaving everything else untouched. */
export function injectManagedBlock(onstart: string | undefined | null, resources: ModelResource[]): string {
  const block = buildManagedBlock(resources);
  const source = onstart ?? "";
  const start = source.indexOf(START_MARKER);
  const end = source.indexOf(END_MARKER);
  if (start === -1 || end === -1) {
    const trimmed = source.trimEnd();
    return trimmed ? `${trimmed}\n\n${block}\n` : `${block}\n`;
  }
  const before = source.slice(0, start);
  const after = source.slice(end + END_MARKER.length);
  return `${before}${block}${after}`;
}
