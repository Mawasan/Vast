#!/usr/bin/env bash
set -Eeuo pipefail
LOG_DIR=${VAST_COMFYUI_LOG_DIR:-/workspace/vast-comfyui-logs}; pid_file="$LOG_DIR/comfyui.pid"
[[ -s "$pid_file" ]] || exit 0
pid=$(<"$pid_file"); if kill -0 "$pid" 2>/dev/null; then kill "$pid" || true; fi
rm -f "$pid_file"
