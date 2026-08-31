#!/usr/bin/env bash
set -Eeuo pipefail
ROOT=${SAYURI_ROOT:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)}
for name in vllm media; do
  pid_file="$ROOT/$name.pid"; [[ -s $pid_file ]] || continue; pid=$(<"$pid_file")
  if kill -0 "$pid" 2>/dev/null; then kill "$pid" || true; fi
  rm -f "$pid_file"
done
