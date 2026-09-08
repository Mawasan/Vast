import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { buildManagedBlock } = await import("../dist/vast/modelBlock.js");

function findBash() {
  for (const candidate of ["bash", "C:/Program Files/Git/bin/bash.exe", "/usr/bin/bash"]) {
    try {
      execFileSync(candidate, ["-c", "true"], { stdio: "ignore" });
      return candidate;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

const posix = (path) => path.replace(/\\/g, "/");

/**
 * Runs a generated block the way Vast does: inside a `set -euo pipefail`
 * provisioning script, with a stub `curl` on PATH that fails for URLs
 * containing any of `failing`.
 */
function runBlock(resources, failing) {
  const shell = findBash();
  if (!shell) return null;
  const dir = mkdtempSync(join(tmpdir(), "akira-block-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "curl"),
    [
      "#!/usr/bin/env bash",
      'out=""; url=""',
      'while [ $# -gt 0 ]; do',
      '  case "$1" in',
      '    -o) out="$2"; shift 2;;',
      '    -H|--retry|--retry-delay) shift 2;;',
      '    -C) shift 2;;',
      "    -fL) shift;;",
      '    *) url="$1"; shift;;',
      "  esac",
      "done",
      `for bad in ${failing.map((f) => `'${f}'`).join(" ")}; do`,
      '  case "$url" in *"$bad"*) exit 22;; esac',
      "done",
      'printf weights > "$out"',
    ].join("\n"),
    { mode: 0o755 }
  );
  const script = join(dir, "provision.sh");
  writeFileSync(
    script,
    ["#!/usr/bin/env bash", "set -euo pipefail", buildManagedBlock(resources), 'echo "AFTER_BLOCK"'].join("\n")
  );
  // The stub directory has to enter PATH in the shell's own path syntax,
  // which is not the Windows one this test process sees.
  const stdout = execFileSync(
    shell,
    ["-c", `PATH="$(cd '${posix(bin)}' && pwd)":$PATH bash '${posix(script)}' 2>&1`],
    { encoding: "utf8" }
  );
  return { dir, stdout };
}

function animaResources(root) {
  return [
    {
      name: "Anima base",
      role: "base",
      source: "civitai",
      ref: "3301424",
      url: "https://civitai.com/api/download/models/3301424?fileId=3186469",
      targetPath: `${posix(root)}/diffusion_models`,
      filename: "anima.safetensors",
    },
    {
      name: "Anima VAE",
      role: "vae",
      source: "url",
      ref: "https://huggingface.co/x/resolve/main/vae.safetensors",
      url: "https://huggingface.co/x/resolve/main/vae.safetensors",
      targetPath: `${posix(root)}/vae`,
      filename: "vae.safetensors",
    },
  ];
}

test("a gated Civitai model is fetched with the token as header and as query parameter", () => {
  const block = buildManagedBlock(animaResources("/tmp/models"));
  assert.match(block, /Authorization: Bearer \$akira_token/);
  assert.match(block, /token=\$\{akira_token\}/);
  assert.match(block, /CIVITAI_API_TOKEN:-\$\{CIVITAI_TOKEN:-\$\{CIVIT:-\}\}/);
  assert.match(block, /\.akira-missing-models/);
});

test("one failing download no longer aborts the rest of the provisioning script", (t) => {
  const root = mkdtempSync(join(tmpdir(), "akira-models-"));
  const resources = animaResources(root);
  const run = runBlock(resources, ["civitai.com"]);
  if (!run) return t.skip("bash is not available on this machine");
  try {
    assert.match(run.stdout, /AFTER_BLOCK/, "the script must continue past the managed block");
    assert.match(run.stdout, /provisioning could not fetch: Anima base/);
    assert.ok(
      existsSync(join(root, "vae", "vae.safetensors")),
      "a freely downloadable file must still be fetched after a gated one fails"
    );
    assert.ok(
      !existsSync(join(root, "diffusion_models", "anima.safetensors")),
      "a failed download must not leave a zero-byte file that a later resume treats as complete"
    );
  } finally {
    rmSync(run.dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("every file downloads when nothing fails", (t) => {
  const root = mkdtempSync(join(tmpdir(), "akira-models-"));
  const run = runBlock(animaResources(root), []);
  if (!run) return t.skip("bash is not available on this machine");
  try {
    assert.ok(!/could not fetch/.test(run.stdout), run.stdout);
    assert.ok(existsSync(join(root, "diffusion_models", "anima.safetensors")));
    assert.ok(existsSync(join(root, "vae", "vae.safetensors")));
  } finally {
    rmSync(run.dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("model names are quoted, so a name cannot run as a shell command", () => {
  const [base] = animaResources("/tmp/models");
  const block = buildManagedBlock([{ ...base, name: "evil'; touch /tmp/pwned; '" }]);
  assert.match(block, /'evil'\\''; touch \/tmp\/pwned; '\\'''/);
});
