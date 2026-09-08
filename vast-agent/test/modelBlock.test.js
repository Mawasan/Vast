import test from "node:test";
import assert from "node:assert/strict";

const { injectManagedBlock } = await import("../dist/vast/modelBlock.js");

const resource = {
  name: "Anima",
  role: "base",
  source: "url",
  ref: "https://example.com/anima.safetensors",
  targetPath: "/workspace/ComfyUI/models/diffusion_models",
  filename: "anima.safetensors",
};

test("managed downloads stay inside Vast's provisioning heredoc", () => {
  const source = [
    "export SERVERLESS=true",
    "cat > /tmp/akira-models.sh <<'AKIRA_PROVISION'",
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "# >>> vast-agent:models >>>",
    "# vast-agent:models:json=[]",
    "# <<< vast-agent:models <<<",
    "AKIRA_PROVISION",
    "chmod +x /tmp/akira-models.sh",
    "export PROVISIONING_SCRIPT=/tmp/akira-models.sh",
    "entrypoint.sh",
  ].join("\n");
  const result = injectManagedBlock(source, [resource]);
  assert.ok(result.indexOf("# >>> vast-agent:models >>>") > result.indexOf("set -euo pipefail"));
  assert.ok(result.indexOf("# <<< vast-agent:models <<<") < result.indexOf("\nAKIRA_PROVISION"));
});

test("a managed block accidentally outside the heredoc is moved back inside", () => {
  const source = [
    "# >>> vast-agent:models >>>",
    `# vast-agent:models:json=${JSON.stringify([resource])}`,
    "# base: Anima",
    "curl https://example.com/anima.safetensors",
    "# <<< vast-agent:models <<<",
    "",
    "export SERVERLESS=true",
    "cat > /tmp/akira-models.sh <<'AKIRA_PROVISION'",
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "echo custom",
    "AKIRA_PROVISION",
    "export PROVISIONING_SCRIPT=/tmp/akira-models.sh",
    "entrypoint.sh",
  ].join("\n");
  const result = injectManagedBlock(source, [resource]);
  assert.equal(result.match(/# >>> vast-agent:models >>>/g)?.length, 1);
  assert.ok(result.indexOf("# >>> vast-agent:models >>>") > result.indexOf("set -euo pipefail"));
  assert.ok(result.indexOf("# <<< vast-agent:models <<<") < result.indexOf("echo custom"));
});
