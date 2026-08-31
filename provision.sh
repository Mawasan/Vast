#!/usr/bin/env bash
# Provision Sayuri on a normal Vast PyTorch instance. Safe to re-run.
set -Eeuo pipefail
ROOT=${SAYURI_ROOT:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)}
MODE=${SAYURI_MODE:-full}; HF_HOME=${HF_HOME:-/workspace/hf-cache}; MODEL_ROOT=${MODEL_ROOT:-/workspace/models}
PRELOAD_MODELS=${PRELOAD_MODELS:-1}; QWEN_MODEL=${QWEN_MODEL:-Qwen/Qwen3.5-122B-A10B-FP8}
WAN_MODEL=${WAN_MODEL:-Wan-AI/Wan2.2-T2V-A14B}; WAN_CKPT=${WAN_CKPT:-$MODEL_ROOT/Wan2.2-T2V-A14B}
WAN_REPO=${WAN_REPO:-https://github.com/Wan-Video/Wan2.2.git}; WAN_REV=${WAN_REV:-42bf4cfaa384bc21833865abc2f9e6c0e67233dc}
[[ $MODE == core || $MODE == full ]] || { echo 'SAYURI_MODE must be core or full' >&2; exit 2; }
mkdir -p "$ROOT"/{envs,logs,outputs} "$HF_HOME" "$MODEL_ROOT"; export HF_HOME
if command -v apt-get >/dev/null 2>&1; then apt-get update -y; DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends git curl ffmpeg libsndfile1; fi
# The Qwen3.5 model card requires vLLM main/nightly; record its resolved version.
if [[ ! -x $ROOT/envs/llm/bin/python ]]; then python3 -m venv "$ROOT/envs/llm"; fi
"$ROOT/envs/llm/bin/python" -m pip install --upgrade pip
"$ROOT/envs/llm/bin/python" -m pip install --upgrade --extra-index-url https://wheels.vllm.ai/nightly 'vllm' 'huggingface_hub[cli]>=0.30,<1'
"$ROOT/envs/llm/bin/vllm" --version | tee "$ROOT/logs/vllm-version.txt"
if [[ $MODE == full ]]; then
  if [[ ! -x $ROOT/envs/tts/bin/python ]]; then python3 -m venv "$ROOT/envs/tts"; fi
  "$ROOT/envs/tts/bin/python" -m pip install --upgrade pip
  "$ROOT/envs/tts/bin/python" -m pip install -r "$ROOT/requirements/tts.txt"
  if [[ ! -d $ROOT/Wan2.2/.git ]]; then git clone "$WAN_REPO" "$ROOT/Wan2.2"; fi
  git -C "$ROOT/Wan2.2" fetch --depth 1 origin "$WAN_REV"; git -C "$ROOT/Wan2.2" checkout --detach "$WAN_REV"
  if [[ ! -x $ROOT/envs/video/bin/python ]]; then python3 -m venv "$ROOT/envs/video"; fi
  "$ROOT/envs/video/bin/python" -m pip install --upgrade pip
  "$ROOT/envs/video/bin/python" -m pip install -r "$ROOT/requirements/video.txt"
  "$ROOT/envs/video/bin/python" -m pip install -r "$ROOT/Wan2.2/requirements.txt" --no-deps
  "$ROOT/envs/video/bin/python" -m pip install 'huggingface_hub[cli]>=0.30,<1'
fi
if [[ $PRELOAD_MODELS == 1 ]]; then
  "$ROOT/envs/llm/bin/hf" download "$QWEN_MODEL" --cache-dir "$HF_HOME"
  if [[ $MODE == full && ! -f $WAN_CKPT/.sayuri_download_complete ]]; then mkdir -p "$WAN_CKPT"; "$ROOT/envs/video/bin/hf" download "$WAN_MODEL" --local-dir "$WAN_CKPT"; touch "$WAN_CKPT/.sayuri_download_complete"; fi
fi
printf '%s\n' "mode=$MODE" "qwen=$QWEN_MODEL" "wan_revision=$WAN_REV" > "$ROOT/.provisioned"
echo "Provisioning complete: $ROOT"
