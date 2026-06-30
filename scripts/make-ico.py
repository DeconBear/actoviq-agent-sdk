#!/usr/bin/env python3
"""Generate a multi-resolution Windows .ico from assets/actoviq-icon.png.

Windows uses .ico (not .png) for the taskbar, window title bar, and the
NSIS installer. A single-PNG window.icon renders blurry or falls back to the
default. Embedding 16/24/32/48/64/128/256 sizes gives sharp rendering at every
DPI the taskbar/jumplist can ask for.

Run:  python scripts/make-ico.py
Writes: assets/actoviq-icon.ico
"""
from pathlib import Path
from PIL import Image

SIZES = (16, 24, 32, 48, 64, 128, 256)
ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "assets" / "actoviq-icon.png"
OUT = ROOT / "assets" / "actoviq-icon.ico"

if not SRC.exists():
    raise SystemExit(f"source not found: {SRC}")

src = Image.open(SRC).convert("RGBA")
# Ensure the largest layer is 256 (high-quality downscale source).
if src.size != (256, 256):
    src = src.resize((256, 256), Image.LANCZOS)

sizes = [(s, s) for s in SIZES]
src.save(OUT, format="ICO", sizes=sizes)
print(f"wrote {OUT.relative_to(ROOT)} ({OUT.stat().st_size} bytes, sizes={[s[0] for s in sizes]})")
