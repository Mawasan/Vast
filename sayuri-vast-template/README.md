# Sayuri Vast.ai Template

This package is a ready-to-build Vast.ai stack for comparing the same Sayuri core in two modes:

- **CORE**: Qwen3.5-122B-A10B-FP8 only.
- **FULL**: the same Qwen core + Chatterbox Multilingual V3 TTS + Wan2.2 T2V-A14B video generation.

## Target host

Recommended FULL host:

- **3x A100 80 GB = 240 GB VRAM**
- **256 GB system RAM minimum**, 384 GB preferred for comfortable video CPU-offload
- **500 GB disk** minimum
- fast NVMe and strong download bandwidth

GPU assignment:

- GPU 0 + 1: Qwen3.5-122B-A10B-FP8 via vLLM, tensor parallel = 2
- GPU 2: media GPU. Chatterbox is loaded for TTS; before a Wan video job, TTS is unloaded so Wan can use almost the whole 80 GB GPU.

The official Qwen FP8 checkpoint is about 127 GB. A100/Ampere can store FP8 weights, but vLLM executes them as weight-only W8A16 rather than native FP8 compute. That is expected on A100.

## Ports

- `8000`: vLLM OpenAI-compatible API (`/v1`)
- `8100`: Sayuri media API
  - `GET /health`
  - `POST /tts`
  - `POST /video`

## Modes

### CORE

Set:

```bash
SAYURI_MODE=core
```

Use a 2x A100 80 GB host. Only Qwen starts.

### FULL

Set:

```bash
SAYURI_MODE=full
```

Use a 3x A100 80 GB host. Qwen + media API start.

## Vast.ai template settings

After pushing the Docker image to a registry, use these values in Vast:

- Image: `YOUR_REGISTRY/sayuri-vast:latest`
- Launch mode: SSH
- Direct SSH: enabled
- Disk: 500 GB
- Ports: `8000`, `8100`
- On-start:

```bash
env >> /etc/environment
bash /workspace/sayuri/start.sh
```

Environment variables:

```text
SAYURI_MODE=full
QWEN_MODEL=Qwen/Qwen3.5-122B-A10B-FP8
LLM_GPUS=0,1
MEDIA_GPU=2
MAX_MODEL_LEN=32768
GPU_MEMORY_UTILIZATION=0.92
PRELOAD_MODELS=1
```

For a private API, add `SAYURI_API_KEY` in your **Vast account environment settings**, not in a public template.

## Build

From the folder containing this package:

```bash
docker build -t YOUR_REGISTRY/sayuri-vast:latest .
docker push YOUR_REGISTRY/sayuri-vast:latest
```

Then replace `YOUR_REGISTRY` in `vast-template.json` and create the Vast template.

## First launch

The first image build/provision downloads and installs a lot. Model files are intentionally not baked into the Docker image. They go to `/workspace` so a persistent Vast volume/cache can survive container recreation.

Important paths:

```text
/workspace/hf-cache                 Qwen/Hugging Face cache
/workspace/models/Wan2.2-T2V-A14B  Wan checkpoint
/workspace/sayuri/logs              service logs
/workspace/sayuri/outputs           temporary media outputs
```

Check status:

```bash
bash /workspace/sayuri/status.sh
```

## Test Qwen

```bash
curl http://127.0.0.1:8000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model":"Qwen/Qwen3.5-122B-A10B-FP8",
    "messages":[{"role":"user","content":"Antworte kurz auf Deutsch: Wer bist du?"}],
    "max_tokens":100
  }'
```

If `SAYURI_API_KEY` is set, also send:

```text
Authorization: Bearer <key>
```

## Test TTS

```bash
curl -X POST http://127.0.0.1:8100/tts \
  -F 'text=Hallo. Ich bin Sayuri.' \
  -F 'language_id=de' \
  -o sayuri.wav
```

With a voice reference:

```bash
curl -X POST http://127.0.0.1:8100/tts \
  -F 'text=Hallo. Ich bin Sayuri.' \
  -F 'language_id=de' \
  -F 'reference_audio=@sayuri-reference.wav' \
  -o sayuri.wav
```

## Test video

Wan A14B is intentionally invoked on demand. This frees the TTS model first and uses CPU offload when necessary.

```bash
curl -X POST http://127.0.0.1:8100/video \
  -F 'prompt=cinematic anime woman with dark blue hair walking through a rainy neon city, consistent face, natural motion' \
  -F 'size=1280*720' \
  -F 'frame_num=81' \
  -F 'seed=42' \
  -o sayuri-video.mp4
```

Video generation can be much slower than chat and TTS because the A14B checkpoint is large and may offload parts to CPU.

## Comparing CORE vs FULL fairly

Use the **same Qwen checkpoint, same prompt set, same context length and same vLLM settings** in both runs. Measure:

- Qwen startup VRAM
- idle VRAM
- tokens/sec
- time-to-first-token
- TTS latency / real-time factor
- video generation time
- peak GPU 2 VRAM
- total Vast cost per hour

That isolates the cost of voice/video instead of accidentally comparing different LLM configurations.

## Notes

- `MAX_MODEL_LEN=32768` is deliberate. Do not start with the native maximum context unless you have measured KV-cache headroom.
- Qwen is run on two GPUs. Do not put Wan on GPU 0 or 1 in FULL mode.
- For development, you can swap Wan A14B for a smaller video checkpoint by changing the provisioning/model variables, but the default here is the stronger A14B path.
- The package is a deployment scaffold, not a claim that every future upstream release will remain dependency-compatible. Qwen/vLLM, Chatterbox and Wan evolve quickly, which is why their Python environments are isolated.
