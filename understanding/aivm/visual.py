"""Visual breakdown: detect scene cuts, extract keyframes, build labelled contact sheets.

The contact sheets are the artefact an LLM actually *looks* at: a handful of grid
images (timestamp burned into every cell) instead of hundreds of separate frames.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

from .util import fmt_ts, log, run

_PTS_RE = re.compile(r"pts_time:([0-9.]+)")


@dataclass
class Keyframe:
    t: float
    path: Path
    is_scene: bool
    sheet: int = -1   # contact sheet index (0-based)
    cell: int = -1    # cell number within the sheet (1-based)


@dataclass
class VisualResult:
    keyframes: list[Keyframe] = field(default_factory=list)
    scene_cuts: list[float] = field(default_factory=list)
    sheets: list[Path] = field(default_factory=list)
    cols: int = 4
    rows: int = 4


def detect_scenes(src: Path, *, threshold: float = 0.4, scan_width: int = 320) -> list[float]:
    """Full-decode (downscaled) pass that returns timestamps of detected shot changes."""
    res = run([
        "ffmpeg", "-i", str(src),
        "-filter:v", f"scale={scan_width}:-2,select='gt(scene,{threshold})',showinfo",
        "-an", "-f", "null", "-",
    ], check=False)
    cuts = [float(m) for m in _PTS_RE.findall(res.stderr or "")]
    log(f"scenes: {len(cuts)} cuts (threshold {threshold})")
    return sorted(set(cuts))


def build_keyframe_times(scene_cuts: list[float], duration: float, *,
                         interval: float = 4.0, max_frames: int = 160,
                         extra: list[float] | None = None) -> list[float]:
    """Union of scene cuts + uniform samples (+ optional extras), deduped & capped."""
    times: set[float] = {0.0}
    times.update(c for c in scene_cuts if 0 < c < duration)
    n = int(duration // interval) if duration else 0
    times.update(min(i * interval, max(0.0, duration - 0.1)) for i in range(1, n + 1))
    if extra:
        times.update(t for t in extra if 0 <= t < duration)

    ordered = sorted(times)
    # Dedupe near-identical timestamps (keep the earlier one).
    deduped: list[float] = []
    for t in ordered:
        if not deduped or t - deduped[-1] >= interval / 2:
            deduped.append(round(t, 2))

    if len(deduped) > max_frames:  # thin uniformly but always keep first & last
        step = len(deduped) / max_frames
        deduped = [deduped[min(int(i * step), len(deduped) - 1)] for i in range(max_frames)]
    return deduped


def extract_frames(src: Path, times: list[float], frames_dir: Path, *,
                   scene_set: set[float] | None = None, width: int = 480) -> list[Keyframe]:
    frames_dir.mkdir(parents=True, exist_ok=True)
    scene_set = scene_set or set()
    out: list[Keyframe] = []
    for i, t in enumerate(times):
        dst = frames_dir / f"f{i:04d}_{int(t):05d}.jpg"
        run([
            "ffmpeg", "-y", "-ss", f"{t:.3f}", "-i", str(src),
            "-frames:v", "1", "-vf", f"scale={width}:-2", "-q:v", "3", str(dst),
        ], check=False)
        if dst.exists():
            out.append(Keyframe(t=t, path=dst, is_scene=t in scene_set))
    log(f"extracted {len(out)}/{len(times)} keyframes")
    return out


def build_contact_sheets(keyframes: list[Keyframe], sheets_dir: Path, *,
                         cols: int = 4, rows: int = 4, thumb_w: int = 384,
                         pad: int = 6, label_h: int = 22) -> list[Path]:
    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError:
        log("Pillow not installed; skipping contact sheets (frames still on disk)")
        return []

    sheets_dir.mkdir(parents=True, exist_ok=True)
    font = _load_font(int(label_h * 0.7))
    per_sheet = cols * rows
    sheets: list[Path] = []

    for s in range(0, len(keyframes), per_sheet):
        batch = keyframes[s:s + per_sheet]
        sheet_idx = s // per_sheet
        # Derive a uniform thumb height from the first frame's aspect ratio.
        with Image.open(batch[0].path) as probe:
            ar = probe.height / probe.width
        thumb_h = int(thumb_w * ar)
        cell_w = thumb_w + pad
        cell_h = thumb_h + label_h + pad
        used_rows = max(1, -(-len(batch) // cols))  # ceil, so short sheets aren't half empty
        canvas = Image.new("RGB", (cols * cell_w + pad, used_rows * cell_h + pad), (18, 18, 18))
        draw = ImageDraw.Draw(canvas)

        for j, kf in enumerate(batch):
            r, c = divmod(j, cols)
            x = pad + c * cell_w
            y = pad + r * cell_h
            with Image.open(kf.path) as im:
                im = im.convert("RGB").resize((thumb_w, thumb_h))
                canvas.paste(im, (x, y + label_h))
            tag = ("● " if kf.is_scene else "") + fmt_ts(kf.t)
            draw.text((x + 2, y + 2), tag, fill=(255, 230, 120), font=font)
            kf.sheet = sheet_idx
            kf.cell = j + 1

        out = sheets_dir / f"sheet_{sheet_idx:03d}.jpg"
        canvas.save(out, quality=85)
        sheets.append(out)

    log(f"built {len(sheets)} contact sheet(s) ({cols}x{rows})")
    return sheets


def _load_font(size: int):
    from PIL import ImageFont
    for name in ("arial.ttf", "C:/Windows/Fonts/arial.ttf", "DejaVuSans.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except Exception:  # noqa: BLE001
            continue
    try:
        return ImageFont.load_default(size)
    except TypeError:
        return ImageFont.load_default()


def analyze_visual(src: Path, workdir: Path, duration: float, *,
                   threshold: float = 0.4, interval: float = 4.0,
                   max_frames: int = 160, width: int = 480,
                   cols: int = 4, rows: int = 4,
                   extra_times: list[float] | None = None) -> VisualResult:
    scene_cuts = detect_scenes(src, threshold=threshold)
    times = build_keyframe_times(scene_cuts, duration, interval=interval,
                                 max_frames=max_frames, extra=extra_times)
    keyframes = extract_frames(src, times, workdir / "frames",
                               scene_set=set(scene_cuts), width=width)
    sheets = build_contact_sheets(keyframes, workdir / "sheets",
                                  cols=cols, rows=rows)
    return VisualResult(keyframes=keyframes, scene_cuts=scene_cuts,
                        sheets=sheets, cols=cols, rows=rows)
