# Sayuri on Vast.ai

This repository provisions Sayuri onto a normal Vast PyTorch instance; it does not require building or publishing a custom Docker image. `core` starts only the OpenAI-compatible Qwen API on GPUs 0 and 1. `full` additionally starts the media API on GPU 2. The Qwen process receives `CUDA_VISIBLE_DEVICES=0,1`, so it cannot reserve GPU 2. The media process receives only GPU 2, where Chatterbox is loaded on demand and explicitly unloaded before Wan begins.

## Vast.ai settings

Choose a current Vast PyTorch image with CUDA support for A100, SSH enabled, and a three-GPU machine with exactly 3 x A100 80 GB. Set disk to 600 GB (500 GB is an absolute lower bound), RAM to at least 256 GB and preferably 384 GB, and expose TCP ports `8000` and `8100`. Do not expose these ports publicly without a firewall or `SAYURI_API_KEY`.

Set the instance environment to:

```text
SAYURI_MODE=full
QWEN_MODEL=Qwen/Qwen3.5-122B-A10B-FP8
LLM_GPUS=0,1
MEDIA_GPU=2
MAX_MODEL_LEN=32768
GPU_MEMORY_UTILIZATION=0.90
PRELOAD_MODELS=1
HF_HOME=/workspace/hf-cache
```

For CORE, use a 2 x A100 80 GB host and set `SAYURI_MODE=core`; do not set `MEDIA_GPU`. If you use an API key, set `SAYURI_API_KEY` only in Vast’s private environment-variable UI. It is never stored in this repository.

The Vast on-start command is intentionally simple because provisioning is long-running and should be watched over SSH:

```bash
cd /workspace/sayuri && bash start.sh
```

## First start

```bash
cd /workspace
git clone https://github.com/Mawasan/Vast.git /workspace/sayuri
cd /workspace/sayuri
bash provision.sh
bash start.sh
bash test.sh
```

The Hugging Face cache is `/workspace/hf-cache`; Wan weights are `/workspace/models/Wan2.2-T2V-A14B`; logs and temporary media are under `/workspace/sayuri/logs` and `/workspace/sayuri/outputs`. Re-running `provision.sh` reuses environments and cached models; Wan is marked complete only after a successful download.

## API checks

```bash
curl http://127.0.0.1:8000/v1/chat/completions -H 'Content-Type: application/json' -d '{"model":"Qwen/Qwen3.5-122B-A10B-FP8","messages":[{"role":"user","content":"Antworte kurz auf Deutsch: Wer bist du?"}],"max_tokens":100}'
curl -X POST http://127.0.0.1:8100/tts -F 'text=Hallo. Ich bin Sayuri.' -F 'language_id=de' -o sayuri.wav
curl -X POST http://127.0.0.1:8100/video -F 'prompt=cinematic rainy neon city at night' -F 'size=1280*720' -F 'frame_num=81' -F 'seed=42' -o sayuri-video.mp4
```

With `SAYURI_API_KEY`, add `-H 'Authorization: Bearer YOUR_KEY'` to each request. Video is serialized with TTS and uses Wan’s documented `--offload_model True`, `--convert_model_dtype`, and `--t5_cpu` options to preserve VRAM headroom.

## Operations

```bash
bash status.sh
tail -f /workspace/sayuri/logs/vllm.log
tail -f /workspace/sayuri/logs/media.log
nvidia-smi
watch -n 1 nvidia-smi
bash stop.sh
```

`test.sh` waits up to six minutes for `/v1/models` and, in FULL mode, `/health`; it fails with the relevant log location if either API does not become healthy.

## Compatibility and remaining hardware validation

The Qwen model card specifically requires vLLM main/nightly and documents `--reasoning-parser qwen3` plus `--tool-call-parser qwen3_coder`; the provisioner records the resolved vLLM version. Chatterbox is pinned to an upstream commit, and Wan2.2 is checked out at a pinned upstream commit with its published dependency ranges. The official Qwen example shows eight GPUs for its full 262K context. This template deliberately requests 32K and tensor parallel size two, but whether the 122B FP8 multimodal checkpoint, runtime overhead, and useful KV cache fit robustly in 2 x A100 80 GB must be measured on the target instance before relying on it in production. Wan 720p A14B can still OOM or be slow depending on its runtime versions and CPU offload bandwidth.
