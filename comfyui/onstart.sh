#!/usr/bin/env bash
set -Eeuo pipefail
ROOT=${VAST_REPO_ROOT:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}
bash "$ROOT/comfyui/provision.sh"
bash "$ROOT/comfyui/start.sh"
