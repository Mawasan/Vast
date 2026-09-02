#!/usr/bin/env bash
# Set up the pinned ComfyUI runtime and the model manifest on a Vast instance.
set -Eeuo pipefail
REPO_ROOT=${VAST_REPO_ROOT:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}
COMFYUI_DIR=${COMFYUI_DIR:-/workspace/ComfyUI}
COMFYUI_REV=${COMFYUI_REV:-a87667f72f5fad094b74b10dc9c9f82faea728ef}
STAMP="$COMFYUI_DIR/.vast-provisioned-$COMFYUI_REV"
export COMFYUI_DIR

if command -v apt-get >/dev/null 2>&1; then
  apt-get update -y
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends git python3-venv
fi
if [[ ! -d "$COMFYUI_DIR/.git" ]]; then git clone https://github.com/Comfy-Org/ComfyUI.git "$COMFYUI_DIR"; fi
git -C "$COMFYUI_DIR" fetch --depth 1 origin "$COMFYUI_REV"
git -C "$COMFYUI_DIR" checkout --detach "$COMFYUI_REV"
if [[ ! -f "$STAMP" ]]; then
  python3 -m venv --system-site-packages "$COMFYUI_DIR/.venv"
  "$COMFYUI_DIR/.venv/bin/python" -m pip install --upgrade pip
  "$COMFYUI_DIR/.venv/bin/python" -m pip install -r "$COMFYUI_DIR/requirements.txt"
  rm -f "$COMFYUI_DIR"/.vast-provisioned-*; touch "$STAMP"
fi
bash "$REPO_ROOT/comfyui/provision-models.sh"
echo "[Vast ComfyUI] Provisioning complete."
