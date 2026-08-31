import asyncio
import gc
import os
import re
import secrets
import subprocess
import tempfile
from pathlib import Path

import torch
import torchaudio as ta
from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask
from chatterbox.mtl_tts import ChatterboxMultilingualTTS

APP_NAME = "Sayuri Media API"
API_KEY = os.getenv("SAYURI_API_KEY", "").strip()
WAN_ROOT = Path(os.getenv("WAN_ROOT", "/workspace/sayuri/Wan2.2"))
WAN_CKPT = Path(os.getenv("WAN_CKPT", "/workspace/models/Wan2.2-T2V-A14B"))
WAN_TASK = os.getenv("WAN_TASK", "t2v-A14B")
VIDEO_PYTHON = os.getenv("VIDEO_PYTHON", "/workspace/sayuri/envs/video/bin/python")
OUTPUT_DIR = Path(os.getenv("OUTPUT_DIR", "/workspace/sayuri/outputs"))
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(title=APP_NAME, version="0.1.0")
lock = asyncio.Lock()
tts_model = None


def _auth(authorization: str | None):
    if not API_KEY:
        return
    expected = f"Bearer {API_KEY}"
    if not authorization or not secrets.compare_digest(authorization, expected):
        raise HTTPException(status_code=401, detail="Unauthorized")


def _cleanup_file(path: str):
    try:
        os.remove(path)
    except FileNotFoundError:
        pass


def load_tts():
    global tts_model
    if tts_model is None:
        tts_model = ChatterboxMultilingualTTS.from_pretrained(device="cuda", t3_model="v3")
    return tts_model


def unload_tts():
    global tts_model
    if tts_model is not None:
        del tts_model
        tts_model = None
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
        torch.cuda.ipc_collect()


@app.get("/health")
def health():
    return {
        "ok": True,
        "service": APP_NAME,
        "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
        "wan_task": WAN_TASK,
    }


@app.post("/tts")
async def tts(
    text: str = Form(...),
    language_id: str = Form("de"),
    exaggeration: float = Form(0.5),
    cfg_weight: float = Form(0.5),
    temperature: float = Form(0.8),
    reference_audio: UploadFile | None = File(None),
    authorization: str | None = Header(None),
):
    _auth(authorization)
    if not text.strip():
        raise HTTPException(status_code=400, detail="text is empty")

    async with lock:
        ref_path = None
        try:
            if reference_audio is not None:
                suffix = Path(reference_audio.filename or "voice.wav").suffix or ".wav"
                fd, ref_path = tempfile.mkstemp(prefix="sayuri-ref-", suffix=suffix)
                os.close(fd)
                with open(ref_path, "wb") as f:
                    f.write(await reference_audio.read())

            model = load_tts()
            kwargs = {
                "language_id": language_id,
                "exaggeration": exaggeration,
                "cfg_weight": cfg_weight,
                "temperature": temperature,
            }
            if ref_path:
                kwargs["audio_prompt_path"] = ref_path

            # Upstream's multilingual demo targets chunks up to ~300 chars.
            # Split longer Sayuri replies at sentence/phrase boundaries, synthesize
            # with the same voice conditioning, and join them with a tiny pause.
            parts = []
            remaining = text.strip()
            while len(remaining) > 300:
                window = remaining[:300]
                cuts = [m.end() for m in re.finditer(r"[.!?;,:]\s+", window)]
                cut = cuts[-1] if cuts else window.rfind(" ")
                if cut < 120:
                    cut = 300
                parts.append(remaining[:cut].strip())
                remaining = remaining[cut:].strip()
            if remaining:
                parts.append(remaining)

            waves = []
            for part in parts:
                w = model.generate(part, **kwargs)
                waves.append(w)
                if part != parts[-1]:
                    pause = torch.zeros(
                        (w.shape[0], int(model.sr * 0.12)),
                        dtype=w.dtype,
                        device=w.device,
                    )
                    waves.append(pause)
            wav = torch.cat(waves, dim=-1)

            fd, out_path = tempfile.mkstemp(prefix="sayuri-tts-", suffix=".wav", dir=str(OUTPUT_DIR))
            os.close(fd)
            ta.save(out_path, wav, model.sr)
            return FileResponse(
                out_path,
                media_type="audio/wav",
                filename="sayuri.wav",
                background=BackgroundTask(_cleanup_file, out_path),
            )
        finally:
            if ref_path:
                _cleanup_file(ref_path)


@app.post("/video")
async def video(
    prompt: str = Form(...),
    size: str = Form("1280*720"),
    frame_num: int = Form(81),
    seed: int = Form(42),
    sample_steps: int | None = Form(None),
    authorization: str | None = Header(None),
):
    _auth(authorization)
    if not prompt.strip():
        raise HTTPException(status_code=400, detail="prompt is empty")
    if frame_num < 5 or (frame_num - 1) % 4 != 0:
        raise HTTPException(status_code=400, detail="frame_num must be 4n+1, e.g. 81")

    async with lock:
        # Wan A14B may need nearly the whole 80 GB media GPU. Free TTS first.
        unload_tts()
        out_path = OUTPUT_DIR / f"wan-{next(tempfile._get_candidate_names())}.mp4"
        cmd = [
            VIDEO_PYTHON,
            str(WAN_ROOT / "generate.py"),
            "--task", WAN_TASK,
            "--size", size,
            "--ckpt_dir", str(WAN_CKPT),
            "--prompt", prompt,
            "--frame_num", str(frame_num),
            "--base_seed", str(seed),
            "--save_file", str(out_path),
            "--offload_model", "True",
            "--t5_cpu",
        ]
        if sample_steps is not None:
            cmd += ["--sample_steps", str(sample_steps)]

        env = os.environ.copy()
        # This API process already sees only the selected media GPU, so Wan sees it as cuda:0.
        env["CUDA_VISIBLE_DEVICES"] = "0"
        proc = subprocess.run(cmd, cwd=str(WAN_ROOT), env=env, capture_output=True, text=True)
        if proc.returncode != 0:
            raise HTTPException(
                status_code=500,
                detail={"message": "Wan generation failed", "stderr": proc.stderr[-8000:]},
            )
        if not out_path.exists():
            raise HTTPException(status_code=500, detail="Wan finished without producing a video")

        return FileResponse(
            str(out_path),
            media_type="video/mp4",
            filename="sayuri-video.mp4",
            background=BackgroundTask(_cleanup_file, str(out_path)),
        )
