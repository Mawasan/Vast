#!/usr/bin/env bash
set -euo pipefail
ROOT=${SAYURI_ROOT:-/workspace/sayuri}
for f in "$ROOT/vllm.pid" "$ROOT/media.pid"; do
  if [[ -f "$f" ]]; then
    kill "$(cat "$f")" 2>/dev/null || true
    rm -f "$f"
  fi
done
