#!/usr/bin/env bash
set -Eeuo pipefail
ROOT=${SAYURI_ROOT:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)}
MODE=${SAYURI_MODE:-full}; LLM_PORT=${LLM_PORT:-8000}; MEDIA_PORT=${MEDIA_PORT:-8100}; KEY=${SAYURI_API_KEY:-}
auth=(); [[ -z $KEY ]] || auth=(-H "Authorization: Bearer $KEY")
wait_for() { local url=$1 name=$2; for _ in $(seq 1 180); do if curl -fsS "${auth[@]}" "$url" >/dev/null; then echo "$name: healthy"; return 0; fi; sleep 2; done; echo "$name did not become healthy; see $ROOT/logs" >&2; return 1; }
wait_for "http://127.0.0.1:$LLM_PORT/v1/models" vLLM
if [[ $MODE == full ]]; then wait_for "http://127.0.0.1:$MEDIA_PORT/health" media; fi
