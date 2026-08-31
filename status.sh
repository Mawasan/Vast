#!/usr/bin/env bash
ROOT=${SAYURI_ROOT:-/workspace/sayuri}
echo "=== NVIDIA ==="
nvidia-smi || true
echo
echo "=== Sayuri processes ==="
ps aux | grep -E 'vllm serve|uvicorn media_api' | grep -v grep || true
echo
echo "=== Last vLLM log lines ==="
tail -n 20 "$ROOT/logs/vllm.log" 2>/dev/null || true
echo
echo "=== Last media log lines ==="
tail -n 20 "$ROOT/logs/media.log" 2>/dev/null || true
