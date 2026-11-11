"""Transition reader (prototype): dump EVERY native frame in a small window around a
moment, tiled into one labelled strip — so the LLM can actually SEE an animation/
transition unfold micro-frame by micro-frame, not just sampled stills.

    python strip.py <video> <center_sec> [window_sec=0.7] [out.jpg]
"""
from __future__ import annotations

import math
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


def probe_fps(video: str) -> float:
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=r_frame_rate", "-of", "csv=p=0", video],
        capture_output=True, text=True,
    )
    num, den = r.stdout.strip().split("/")
    return float(num) / float(den or 1)


def font(size: int):
    for n in ("arialbd.ttf", "arial.ttf", "C:/Windows/Fonts/arial.ttf"):
        try:
            return ImageFont.truetype(n, size)
        except Exception:
            continue
    return ImageFont.load_default()


def main() -> int:
    video = sys.argv[1]
    center = float(sys.argv[2])
    window = float(sys.argv[3]) if len(sys.argv) > 3 else 0.7
    out = sys.argv[4] if len(sys.argv) > 4 else "strip.jpg"

    fps = probe_fps(video)
    start = max(0.0, center - window / 2)
    tmp = Path(tempfile.mkdtemp())
    subprocess.run(
        ["ffmpeg", "-y", "-ss", f"{start:.3f}", "-i", video, "-t", f"{window:.3f}",
         "-vf", "scale=300:-2", "-vsync", "0", "-q:v", "3", str(tmp / "f_%03d.jpg")],
        capture_output=True,
    )
    frames = sorted(tmp.glob("f_*.jpg"))
    if not frames:
        print("no frames extracted")
        return 1

    cols = 6
    rows = math.ceil(len(frames) / cols)
    with Image.open(frames[0]) as p0:
        tw, th = p0.size
    pad, lab = 4, 18
    cw, ch = tw + pad, th + lab + pad
    canvas = Image.new("RGB", (cols * cw + pad, rows * ch + pad), (15, 15, 18))
    draw = ImageDraw.Draw(canvas)
    f = font(13)
    for i, fr in enumerate(frames):
        r, c = divmod(i, cols)
        x, y = pad + c * cw, pad + r * ch
        with Image.open(fr) as im:
            canvas.paste(im.convert("RGB"), (x, y + lab))
        t = start + i / fps
        draw.text((x + 2, y + 1), f"{i:02d} | {t:.3f}s", fill=(255, 220, 90), font=f)
    canvas.save(out, quality=90)
    print(f"{len(frames)} frames @ {fps:.2f}fps -> {out}  (window {start:.2f}-{start+window:.2f}s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
