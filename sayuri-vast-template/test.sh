#!/usr/bin/env bash
set -euo pipefail
KEY=${SAYURI_API_KEY:-}
AUTH=()
if [[ -n "$KEY" ]]; then AUTH=(-H "Authorization: Bearer $KEY"); fi

echo "LLM health/models:"
curl -fsS "${AUTH[@]}" http://127.0.0.1:${LLM_PORT:-8000}/v1/models | head -c 1000 || true
echo -e "\n\nMedia health:"
curl -fsS "${AUTH[@]}" http://127.0.0.1:${MEDIA_PORT:-8100}/health || true
echo
