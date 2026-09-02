# Vast Anime: Illustrious + Animagine

Standalone ComfyUI template for Vast.ai. This does not change Marinara or the
Sayuri services in the repository root.

## Start from the saved template

1. In Vast, open **Templates → My Templates → Vast Anime - Illustrious + Animagine**.
2. Select it, choose a compatible NVIDIA GPU with at least 24 GB VRAM and
   keep the recommended 100 GB disk. **Rent starts billing.**
3. Wait for provisioning to download the two checkpoints (about 14 GB total).
4. Open the instance's **Open** button, then **ComfyUI** in the Instance Portal.
5. Open **Workflows** and choose **illustrious-xl** or **animagine-xl-4**.
   Edit the positive prompt and click **Run**.

Images are saved under `/workspace/ComfyUI/output/Vast/`.
Models and outputs survive stopping/restarting the same instance but are not
backed up by this template. Download important files before destroying it.

## Template configuration

- Image: `vastai/comfy:v0.30.0-cuda-13.2-py312` (official Vast ComfyUI image)
- Launch mode: Jupyter + SSH; on-start: `entrypoint.sh`
- Disk: 100 GB; private template
- Filters: `compute_cap>=800 cuda_max_good>=13 gpu_ram>=24 cpu_arch=amd64`
- Exposed ports: 1111 (portal), 8080 (Jupyter), 8188 (ComfyUI)
- ComfyUI uses internal port 18188 behind Vast's authenticated proxy.
  Do not expose 18188 or replace the on-start script with the generic launcher.
- `OPEN_BUTTON_PORT=1111`, `OPEN_BUTTON_TOKEN=1`
- `COMFYUI_ARGS=--disable-auto-launch --disable-xformers --port 18188 --enable-cors-header`
- `DATA_DIRECTORY=/workspace/`, `JUPYTER_DIR=/`
- `PORTAL_CONFIG=localhost:1111:11111:/:Instance Portal|localhost:8188:18188:/:ComfyUI|localhost:8080:18080:/:Jupyter`
- `PROVISIONING_COMFYUI_WORKFLOWS`: the two raw GitHub workflow URLs separated
  by a semicolon. Use the same published Git commit for both URLs:

```text
https://raw.githubusercontent.com/Mawasan/Vast/<COMMIT>/comfyui/workflows/illustrious-xl.json;https://raw.githubusercontent.com/Mawasan/Vast/<COMMIT>/comfyui/workflows/animagine-xl-4.json
```

The saved template pins those URLs to a commit. Later repository changes do not
silently change the template; update its URLs deliberately to publish a new version.

The official image's workflow provisioner reads `nodes[].properties.models`,
downloads the declared checkpoints and saves the workflows to
`/workspace/ComfyUI/user/default/workflows/`. Model URLs are pinned to upstream
Hugging Face revisions and were checked as public/ungated. No access token or
custom nodes are required. Supervisor starts ComfyUI after provisioning.
See the [official workflow provisioner documentation](https://github.com/vast-ai/base-image/blob/main/ROOT/opt/instance-tools/lib/provisioner/README.md).

## Models and LoRAs

Illustrious XL v1.1 and Animagine XL 4.0 opt are the only requested checkpoints.
NoobAI is not provisioned. Each workflow includes a positive/negative prompt,
appropriate SDXL dimensions, a sampler, VAE decoding and image saving.
Seeds are fixed for repeatable comparisons; change the seed for variations.

Existing LoRA files are not removed. Place compatible LoRAs in
`/workspace/ComfyUI/models/loras` and add a Load LoRA node when needed.
These starter workflows do not include trained character identities, IP-Adapter,
ControlNet, or a character-consistency guarantee.

## Validation and troubleshooting

Run `python -B -m unittest discover -s comfyui/tests -v` locally to check graph
connections, manifest alignment and sampler settings without a GPU.
These checks do not replace an actual GPU boot/image-generation test.

In the instance terminal:

```bash
supervisorctl status comfyui
supervisorctl tail -f comfyui
```

If the checkpoint download fails, inspect the provisioning logs before retrying.
Do not mark an instance ready until provisioning finishes and a test image works.

## Older generic-image scripts

`onstart.sh`, `provision.sh`, `start.sh`, `stop.sh`, and
`provision-models.py` are retained for the earlier generic-PyTorch setup.
**They are not used by this template.** In particular, do not run `start.sh`
alongside the official image's Supervisor-managed ComfyUI service.
