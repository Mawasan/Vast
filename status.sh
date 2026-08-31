#!/usr/bin/env bash
ROOT=${SAYURI_ROOT:-/workspace/sayuri}
echo "=== NVIDIA ==="
nvidia-smi || true
echo
echo "=== Sayuri processes ==="
for f in "$ROOT/vllm.pid" "$ROOT/media.pid"; do
  [[ -s $f ]] || continue
  pid=$(<"$f")
  if kill -0 "$pid" 2>/dev/null; then echo "$(basename "$f"): running ($pid)"; else echo "$(basename "$f"): stale"; fi
done
echo
echo "=== Last vLLM log lines ==="
tail -n 20 "$ROOT/logs/vllm.log" 2>/dev/null || true
echo
echo "=== Last media log lines ==="
tail -n 20 "$ROOT/logs/media.log" 2>/dev/null || true
