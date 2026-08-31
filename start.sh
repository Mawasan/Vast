#!/usr/bin/env bash
set -euo pipefail

ROOT=${SAYURI_ROOT:-/workspace/sayuri}
MODE=${SAYURI_MODE:-full}
QWEN_MODEL=${QWEN_MODEL:-Qwen/Qwen3.5-122B-A10B-FP8}
LLM_GPUS=${LLM_GPUS:-0,1}
MEDIA_GPU=${MEDIA_GPU:-2}
MAX_MODEL_LEN=${MAX_MODEL_LEN:-32768}
GPU_MEMORY_UTILIZATION=${GPU_MEMORY_UTILIZATION:-0.92}
LLM_PORT=${LLM_PORT:-8000}
MEDIA_PORT=${MEDIA_PORT:-8100}
HF_HOME=${HF_HOME:-/workspace/hf-cache}
WAN_ROOT=${WAN_ROOT:-$ROOT/Wan2.2}
WAN_CKPT=${WAN_CKPT:-/workspace/models/Wan2.2-T2V-A14B}
WAN_TASK=${WAN_TASK:-t2v-A14B}
SAYURI_API_KEY=${SAYURI_API_KEY:-}

mkdir -p "$ROOT/logs" "$ROOT/outputs"
export HF_HOME

# Kill only previous Sayuri services from this package.
pkill -f "vllm serve $QWEN_MODEL" 2>/dev/null || true
pkill -f "uvicorn media_api:app" 2>/dev/null || true
sleep 1

VLLM_ARGS=(
  serve "$QWEN_MODEL"
  --host 0.0.0.0
  --port "$LLM_PORT"
  --tensor-parallel-size 2
  --max-model-len "$MAX_MODEL_LEN"
  --gpu-memory-utilization "$GPU_MEMORY_UTILIZATION"
  --reasoning-parser qwen3
  --enable-auto-tool-choice
  --tool-call-parser qwen3_coder
)
if [[ -n "$SAYURI_API_KEY" ]]; then
  VLLM_ARGS+=(--api-key "$SAYURI_API_KEY")
fi

nohup env CUDA_VISIBLE_DEVICES="$LLM_GPUS" \
  "$ROOT/envs/llm/bin/vllm" "${VLLM_ARGS[@]}" \
  > "$ROOT/logs/vllm.log" 2>&1 &
echo $! > "$ROOT/vllm.pid"

if [[ "$MODE" == "full" ]]; then
  nohup env CUDA_VISIBLE_DEVICES="$MEDIA_GPU" \
    SAYURI_API_KEY="$SAYURI_API_KEY" \
    WAN_ROOT="$WAN_ROOT" \
    WAN_CKPT="$WAN_CKPT" \
    WAN_TASK="$WAN_TASK" \
    VIDEO_PYTHON="$ROOT/envs/video/bin/python" \
    OUTPUT_DIR="$ROOT/outputs" \
    "$ROOT/envs/tts/bin/python" -m uvicorn media_api:app \
      --app-dir "$ROOT/services" --host 0.0.0.0 --port "$MEDIA_PORT" \
    > "$ROOT/logs/media.log" 2>&1 &
  echo $! > "$ROOT/media.pid"
fi

echo "Sayuri started in mode=$MODE"
echo "LLM API:   http://<host>:$LLM_PORT/v1"
if [[ "$MODE" == "full" ]]; then
  echo "Media API: http://<host>:$MEDIA_PORT (POST /tts, POST /video)"
fi
