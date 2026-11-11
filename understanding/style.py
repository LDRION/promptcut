"""Style reader: analyse a reference video and emit a style profile the engine can
apply to other footage — the core of "drop a reference → AI copies its vibe".

Measures (not guesses):
  - cut timestamps from a frame-difference + histogram detector (ffmpeg's scene score
    misses most cuts in dark, graded edits — exactly the kind we copy)
  - pacing (average shot length → density)
  - flash / dip-to-black rate at the cuts
  - colour grade matched to the reference (contrast / saturation / gamma)

What the pixels can't tell us numerically (subtitle look, transition types) is read
by Siberi from frame sheets — see engine/src/edit/stylist.ts.

    python style.py <reference_video> [out.json]
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import numpy as np

from aivm.util import media_duration

MAX_ANALYSE_SEC = 600  # long references: the first 10 minutes say enough about the style
SCAN_W, SCAN_H = 64, 36


def probe_fps(video: str) -> float:
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=r_frame_rate", "-of", "csv=p=0", video],
        capture_output=True, text=True,
    )
    try:
        num, den = r.stdout.strip().split("/")
        return float(num) / float(den or 1)
    except Exception:
        return 30.0


def decode_gray(video: str, fps: float, limit: float) -> np.ndarray:
    """Whole reference as tiny grayscale frames (n, h, w) at ≤30 fps."""
    res = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", video, "-t", f"{limit:.2f}",
         "-vf", f"fps={fps:.3f},scale={SCAN_W}:{SCAN_H},format=gray",
         "-f", "rawvideo", "-pix_fmt", "gray", "-"],
        capture_output=True,
    )
    buf = np.frombuffer(res.stdout, dtype=np.uint8)
    n = buf.size // (SCAN_W * SCAN_H)
    return buf[: n * SCAN_W * SCAN_H].reshape(n, SCAN_H, SCAN_W).astype(np.float32)


def detect_cuts(frames: np.ndarray, fps: float) -> list[int]:
    """Frame indices where a new shot starts.

    A cut is a frame whose pixel change AND histogram change both stand out from the
    local motion level. Relative thresholds keep it working on dark footage; merging
    near neighbours keeps a flash (white-in, white-out) from counting as two cuts.
    """
    n = len(frames)
    if n < 3:
        return []
    diff = np.abs(frames[1:] - frames[:-1]).mean(axis=(1, 2))  # diff[i] = change into frame i+1
    hists = np.stack([np.histogram(f, bins=16, range=(0, 256))[0] for f in frames]).astype(np.float32)
    hists /= hists.sum(axis=1, keepdims=True) + 1e-6
    hdiff = np.abs(hists[1:] - hists[:-1]).sum(axis=1)

    win = max(3, int(round(fps * 0.4)))
    cuts: list[int] = []
    min_gap = max(2, int(round(fps * 0.12)))
    for i in range(len(diff)):
        lo, hi = max(0, i - win), min(len(diff), i + win + 1)
        local = np.concatenate([diff[lo:i], diff[i + 1:hi]])
        base = float(np.median(local)) if local.size else 0.0
        strong = diff[i] > max(9.0, base * 3.0) and hdiff[i] > 0.18
        very_strong = diff[i] > max(28.0, base * 5.0)
        if not (strong or very_strong):
            continue
        if diff[i] < diff[max(0, i - 1)] or diff[i] < diff[min(len(diff) - 1, i + 1)]:
            continue  # not the peak of this change
        frame = i + 1
        if cuts and frame - cuts[-1] < min_gap:
            continue
        cuts.append(frame)
    return cuts


def transition_marks(frames: np.ndarray, cuts: list[int], fps: float) -> dict:
    """Flash (brightness spike) and dip (through black) rates at the detected cuts."""
    if not cuts:
        return {"flash": 0.0, "dip": 0.0}
    means = frames.mean(axis=(1, 2))
    k = max(2, int(round(fps * 0.1)))
    flashes = dips = 0
    for c in cuts:
        lo, hi = max(0, c - k), min(len(means), c + k + 1)
        around = means[lo:hi]
        outer = np.concatenate([means[max(0, c - 4 * k):lo], means[hi:min(len(means), c + 4 * k)]])
        ref = float(np.median(outer)) if outer.size else float(np.median(around))
        if around.max() > 200 or around.max() - ref > 55:
            flashes += 1
        elif around.min() < 10 and ref > 30:
            dips += 1
    return {"flash": round(flashes / len(cuts), 3), "dip": round(dips / len(cuts), 3)}


def measure_grade(video: str, duration: float) -> tuple[str, dict]:
    """Sample colour frames across the clip → a tasteful grade leaning toward its look."""
    count = int(min(60, max(8, duration)))
    rate = count / duration if duration else 1.0
    res = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", video,
         "-vf", f"fps={rate:.4f},scale=64:36", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        capture_output=True,
    )
    buf = np.frombuffer(res.stdout, dtype=np.uint8)
    n = buf.size // (64 * 36 * 3)
    if n == 0:
        return "eq=contrast=1.12:saturation=1.4:gamma=0.97,unsharp=5:5:0.5", {}
    px = buf[: n * 64 * 36 * 3].reshape(-1, 3).astype(np.float32)
    luma = px @ np.array([0.299, 0.587, 0.114], np.float32)
    mx = px.max(axis=1)
    mn = px.min(axis=1)
    sat = np.divide(mx - mn, mx, out=np.zeros_like(mx), where=mx > 0)
    brightness = float(luma.mean()) / 255.0
    saturation = float(sat.mean())
    contrast = float(luma.std()) / 128.0
    warmth = float((px[:, 0].mean() - px[:, 2].mean()) / 255.0)

    # Map measured look into a tasteful, clamped grade (never destroys the footage).
    sat_mult = float(np.clip(saturation / 0.32, 0.85, 1.5))
    con = float(np.clip(0.95 + (contrast - 0.45) * 0.6, 1.0, 1.28))
    gamma = float(np.clip(0.85 + brightness * 0.4, 0.9, 1.08))
    grade = f"eq=contrast={con:.2f}:saturation={sat_mult:.2f}:gamma={gamma:.2f},unsharp=5:5:0.5"
    stats = {"brightness": round(brightness, 3), "saturation": round(saturation, 3),
             "contrast": round(contrast, 3), "warmth": round(warmth, 3)}
    return grade, stats


def analyze(video: str) -> dict:
    src_fps = probe_fps(video)
    fps = min(30.0, src_fps) or 30.0
    duration = media_duration(Path(video))
    limit = min(duration, MAX_ANALYSE_SEC) if duration else MAX_ANALYSE_SEC
    frames = decode_gray(video, fps, limit)
    cut_idx = detect_cuts(frames, fps)
    cut_times = [round(i / fps, 3) for i in cut_idx]
    span = len(frames) / fps if len(frames) else limit
    avg_shot = round(span / (len(cut_times) + 1), 3)
    density = "high" if avg_shot < 1.0 else "medium" if avg_shot < 2.0 else "low"
    marks = transition_marks(frames, cut_idx, fps)
    grade, stats = measure_grade(video, duration)
    # Chroma: only "edity" references (dense cuts + flashes) get RGB-split, and lightly.
    chroma = 2 if (density == "high" and marks["flash"] > 0.25) else 0

    return {
        "source": video,
        "durationSec": round(duration, 2),
        "fps": round(src_fps, 3),
        "cuts": len(cut_times),
        "cutTimes": cut_times[:600],
        "avgShotLen": avg_shot,
        "cutDensity": density,
        "flashRate": marks["flash"],
        "dipRate": marks["dip"],
        "chroma": chroma,
        "dominantCamera": "auto",
        "grade": grade,
        "stats": stats,
    }


def main() -> int:
    video = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) > 2 else "style.json"
    profile = analyze(video)
    Path(out).write_text(json.dumps(profile, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({k: v for k, v in profile.items() if k != "cutTimes"}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
