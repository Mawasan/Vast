#!/usr/bin/env python3
"""Idempotently install the exact ComfyUI artifacts declared in models.json."""
from __future__ import annotations

import json
import os
import sys
import urllib.request
from pathlib import Path

ROOT = Path(os.environ.get("COMFYUI_DIR", "/workspace/ComfyUI"))
MANIFEST = Path(__file__).with_name("models.json")


def download(url: str, target: Path) -> None:
    partial = target.with_suffix(target.suffix + ".part")
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.is_file() and target.stat().st_size:
        print(f"[Vast Models] Model already installed: {target.name}")
        return
    start = partial.stat().st_size if partial.exists() else 0
    headers = {"Range": f"bytes={start}-"} if start else {}
    print(f"[Vast Models] Downloading {target.name} ({'resuming' if start else 'new'})...")
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=60) as response:
            # A server that ignores Range returns 200; restart instead of corrupting.
            mode = "ab" if start and response.status == 206 else "wb"
            with partial.open(mode) as out:
                while chunk := response.read(1024 * 1024):
                    out.write(chunk)
    except Exception as exc:
        raise RuntimeError(f"download failed for {target.name}: {exc}") from exc
    if not partial.is_file() or not partial.stat().st_size:
        raise RuntimeError(f"download failed for {target.name}: empty artifact")
    partial.replace(target)
    print(f"[Vast Models] Model installed successfully: {target.name}")


def main() -> int:
    data = json.loads(MANIFEST.read_text(encoding="utf-8"))
    for model in data["models"]:
        print(f"[Vast Models] Checking {model['displayName']}...")
        for file in model["files"]:
            download(file["url"], ROOT / "models" / file["path"])
    print("[Vast Models] Active model set is ready.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"[Vast Models] ERROR: {error}", file=sys.stderr)
        raise SystemExit(1)
