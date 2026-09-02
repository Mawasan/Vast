# ComfyUI anime model set

This directory is independent of Sayuri. It is a directly usable Vast instance template: the on-start command below clones this repository, installs the pinned ComfyUI runtime, downloads the manifest, and starts ComfyUI on port 8188. It is also the single source of truth for the ComfyUI checkpoints a Vast worker is allowed to advertise or use.

## Vast template

Choose a current **Vast PyTorch** image with an NVIDIA GPU, at least 24 GB VRAM, 80 GB disk, SSH enabled, and port `8188` exposed. Set this as the Vast **On-start command**:

```bash
if [ ! -d /workspace/vast/.git ]; then git clone https://github.com/Mawasan/Vast.git /workspace/vast; fi; VAST_REPO_ROOT=/workspace/vast bash /workspace/vast/comfyui/onstart.sh
```

For the first run, use 100 GB disk and wait for the two 6–7 GB checkpoints to download. On subsequent starts they remain under `/workspace/ComfyUI/models` as long as the instance disk persists. Open `http://<instance-ip>:8188` through Vast's exposed-port UI. ComfyUI has no built-in authentication: keep this port private or restrict it through Vast/firewall access controls.

The active set is deliberately small: Illustrious XL v1.1 for character cards, Danbooru-oriented anime prompts, and complex scenes; Animagine XL 4.0 for clean, polished illustrations. NoobAI is not installed or listed. Each download is written as a `.part` file, resumes when possible, and becomes active only after an atomic rename.

For recurring characters, train or install one compatible character LoRA per character (normally strength 0.6–0.8) in `ComfyUI/models/loras`, retain curated reference images outside the ephemeral worker, and use IP-Adapter reference conditioning. Add OpenPose or Depth ControlNet for difficult poses and multi-character layout. IP-Adapter and ControlNet are deliberately not installed by this small checkpoint script because their custom-node and auxiliary-model versions must be pinned together in the worker image.

Both checkpoints are roughly 6–7 GB. Plan 24 GB VRAM for comfortable SDXL at 1024px with identity or pose conditioning; 48 GB is a better serverless target for concurrent or multi-character work. Bake ComfyUI and version-pinned custom nodes into a worker image, then attach persistent model storage or bake this manifest's exact artifacts into a versioned image before making an endpoint live.
