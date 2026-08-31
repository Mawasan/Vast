#!/usr/bin/env bash
set -euo pipefail

ROOT=${SAYURI_ROOT:-/workspace/sayuri}
MODEL_ROOT=${MODEL_ROOT:-/workspace/models}
HF_HOME=${HF_HOME:-/workspace/hf-cache}
MODE=${SAYURI_MODE:-full}
PRELOAD_MODELS=${PRELOAD_MODELS:-1}
QWEN_MODEL=${QWEN_MODEL:-Qwen/Qwen3.5-122B-A10B-FP8}
WAN_REPO=${WAN_REPO:-https://github.com/Wan-Video/Wan2.2.git}
WAN_MODEL=${WAN_MODEL:-Wan-AI/Wan2.2-T2V-A14B}
WAN_CKPT=${WAN_CKPT:-$MODEL_ROOT/Wan2.2-T2V-A14B}

mkdir -p "$ROOT" "$ROOT/envs" "$ROOT/logs" "$ROOT/outputs" "$MODEL_ROOT" "$HF_HOME"
export HF_HOME

if command -v apt-get >/dev/null 2>&1; then
  apt-get update -y
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    git curl ffmpeg build-essential ninja-build ca-certificates libsndfile1
fi

if ! command -v uv >/dev/null 2>&1; then
  curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="$HOME/.local/bin:$PATH"
fi
UV=$(command -v uv || true)
if [[ -z "$UV" ]]; then
  UV="$HOME/.local/bin/uv"
fi

# LLM environment. Qwen currently recommends a nightly vLLM wheel.
if [[ ! -x "$ROOT/envs/llm/bin/python" ]]; then
  "$UV" venv --python 3.12 "$ROOT/envs/llm"
fi
"$UV" pip install --python "$ROOT/envs/llm/bin/python" \
  vllm --torch-backend=auto --extra-index-url https://wheels.vllm.ai/nightly
"$UV" pip install --python "$ROOT/envs/llm/bin/python" "huggingface_hub[cli]"

if [[ "$MODE" == "full" ]]; then
  # Chatterbox is tested upstream with Python 3.11.
  if [[ ! -x "$ROOT/envs/tts/bin/python" ]]; then
    "$UV" venv --python 3.11 "$ROOT/envs/tts"
  fi
  "$UV" pip install --python "$ROOT/envs/tts/bin/python" \
    "git+https://github.com/resemble-ai/chatterbox.git" fastapi uvicorn python-multipart

  # Wan2.2 environment kept separate from vLLM/Chatterbox to prevent dependency collisions.
  if [[ ! -d "$ROOT/Wan2.2/.git" ]]; then
    git clone --depth 1 "$WAN_REPO" "$ROOT/Wan2.2"
  else
    git -C "$ROOT/Wan2.2" pull --ff-only || true
  fi
  if [[ ! -x "$ROOT/envs/video/bin/python" ]]; then
    "$UV" venv --python 3.11 "$ROOT/envs/video"
  fi
  # Install requirements without letting one optional flash-attn build sink the whole setup.
  grep -vi '^flash[_-]attn' "$ROOT/Wan2.2/requirements.txt" > "$ROOT/Wan2.2/requirements.no-flash.txt"
  "$UV" pip install --python "$ROOT/envs/video/bin/python" -r "$ROOT/Wan2.2/requirements.no-flash.txt"
  "$UV" pip install --python "$ROOT/envs/video/bin/python" "huggingface_hub[cli]"

  if [[ "$PRELOAD_MODELS" == "1" && ! -f "$WAN_CKPT/.sayuri_download_complete" ]]; then
    mkdir -p "$WAN_CKPT"
    "$ROOT/envs/video/bin/hf" download "$WAN_MODEL" --local-dir "$WAN_CKPT"
    touch "$WAN_CKPT/.sayuri_download_complete"
  fi
fi

# Optional pre-download of Qwen. vLLM will also download it automatically if omitted.
if [[ "$PRELOAD_MODELS" == "1" && ! -f "$MODEL_ROOT/.qwen_download_complete" ]]; then
  "$ROOT/envs/llm/bin/hf" download "$QWEN_MODEL" --cache-dir "$HF_HOME"
  touch "$MODEL_ROOT/.qwen_download_complete"
fi

touch "$ROOT/.provisioned"
echo "Provisioning complete: $ROOT"
