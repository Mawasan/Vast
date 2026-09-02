#!/usr/bin/env bash
set -Eeuo pipefail
COMFYUI_DIR=${COMFYUI_DIR:-/workspace/ComfyUI}; COMFYUI_PORT=${COMFYUI_PORT:-8188}
LOG_DIR=${VAST_COMFYUI_LOG_DIR:-/workspace/vast-comfyui-logs}; mkdir -p "$LOG_DIR"
[[ -x "$COMFYUI_DIR/.venv/bin/python" ]] || { echo "Run comfyui/provision.sh first" >&2; exit 2; }
bash "$(dirname -- "${BASH_SOURCE[0]}")/stop.sh" || true
nohup "$COMFYUI_DIR/.venv/bin/python" "$COMFYUI_DIR/main.py" --listen 0.0.0.0 --port "$COMFYUI_PORT" >"$LOG_DIR/comfyui.log" 2>&1 &
echo $! > "$LOG_DIR/comfyui.pid"
echo "[Vast ComfyUI] Started on port $COMFYUI_PORT"
