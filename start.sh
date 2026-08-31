#!/usr/bin/env bash
set -Eeuo pipefail
ROOT=${SAYURI_ROOT:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)}
MODE=${SAYURI_MODE:-full}; QWEN_MODEL=${QWEN_MODEL:-Qwen/Qwen3.5-122B-A10B-FP8}; LLM_GPUS=${LLM_GPUS:-0,1}; MEDIA_GPU=${MEDIA_GPU:-2}
MAX_MODEL_LEN=${MAX_MODEL_LEN:-32768}; GPU_MEMORY_UTILIZATION=${GPU_MEMORY_UTILIZATION:-0.90}; LLM_PORT=${LLM_PORT:-8000}; MEDIA_PORT=${MEDIA_PORT:-8100}; HF_HOME=${HF_HOME:-/workspace/hf-cache}; WAN_CKPT=${WAN_CKPT:-/workspace/models/Wan2.2-T2V-A14B}; SAYURI_API_KEY=${SAYURI_API_KEY:-}
[[ $MODE == core || $MODE == full ]] || { echo 'SAYURI_MODE must be core or full' >&2; exit 2; }
[[ $LLM_GPUS == *,* && $LLM_GPUS != *"$MEDIA_GPU"* ]] || { echo 'LLM_GPUS must contain two GPUs and exclude MEDIA_GPU' >&2; exit 2; }
[[ -f $ROOT/.provisioned ]] || { echo "Run bash $ROOT/provision.sh first" >&2; exit 2; }
mkdir -p "$ROOT/logs" "$ROOT/outputs"; export HF_HOME; bash "$ROOT/stop.sh" || true
vllm_auth=(); [[ -z $SAYURI_API_KEY ]] || vllm_auth=(--api-key "$SAYURI_API_KEY")
nohup env CUDA_VISIBLE_DEVICES="$LLM_GPUS" HF_HOME="$HF_HOME" "$ROOT/envs/llm/bin/vllm" serve "$QWEN_MODEL" --host 0.0.0.0 --port "$LLM_PORT" --tensor-parallel-size 2 --max-model-len "$MAX_MODEL_LEN" --gpu-memory-utilization "$GPU_MEMORY_UTILIZATION" --reasoning-parser qwen3 --enable-auto-tool-choice --tool-call-parser qwen3_coder "${vllm_auth[@]}" >"$ROOT/logs/vllm.log" 2>&1 & echo $! > "$ROOT/vllm.pid"
if [[ $MODE == full ]]; then
  nohup env CUDA_VISIBLE_DEVICES="$MEDIA_GPU" SAYURI_API_KEY="$SAYURI_API_KEY" WAN_ROOT="$ROOT/Wan2.2" WAN_CKPT="$WAN_CKPT" VIDEO_PYTHON="$ROOT/envs/video/bin/python" OUTPUT_DIR="$ROOT/outputs" "$ROOT/envs/tts/bin/python" -m uvicorn media_api:app --app-dir "$ROOT/services" --host 0.0.0.0 --port "$MEDIA_PORT" >"$ROOT/logs/media.log" 2>&1 & echo $! > "$ROOT/media.pid"
fi
echo "Started Sayuri ($MODE). Run bash $ROOT/test.sh to wait for health checks."
