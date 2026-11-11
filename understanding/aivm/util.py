"""Shared helpers: timecodes, logging, and ffmpeg/ffprobe wrappers."""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path


def log(msg: str) -> None:
    print(f"[aivm] {msg}", file=sys.stderr, flush=True)


def have(tool: str) -> bool:
    return shutil.which(tool) is not None


def require_ffmpeg() -> None:
    missing = [t for t in ("ffmpeg", "ffprobe") if not have(t)]
    if missing:
        raise RuntimeError(
            f"Missing required tool(s) on PATH: {', '.join(missing)}. Install ffmpeg."
        )


def run(cmd: list[str], *, capture: bool = True, check: bool = True) -> subprocess.CompletedProcess:
    """Run a command. stderr is always captured so callers can parse ffmpeg output."""
    return subprocess.run(
        cmd,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=check,
    )


def fmt_ts(seconds: float) -> str:
    """Seconds -> H:MM:SS or M:SS timecode used everywhere in the digest."""
    seconds = max(0, int(round(seconds)))
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    if h:
        return f"{h}:{m:02d}:{s:02d}"
    return f"{m}:{s:02d}"


def ffprobe_info(path: Path) -> dict:
    """Return parsed ffprobe JSON (format + streams) for a media file."""
    res = run([
        "ffprobe", "-v", "quiet", "-print_format", "json",
        "-show_format", "-show_streams", str(path),
    ])
    return json.loads(res.stdout or "{}")


def media_duration(path: Path) -> float:
    info = ffprobe_info(path)
    dur = info.get("format", {}).get("duration")
    if dur:
        return float(dur)
    for st in info.get("streams", []):
        if st.get("duration"):
            return float(st["duration"])
    return 0.0


def has_audio_stream(path: Path) -> bool:
    info = ffprobe_info(path)
    return any(s.get("codec_type") == "audio" for s in info.get("streams", []))


def extract_wav(src: Path, dst: Path, *, sr: int = 16000, mono: bool = True) -> Path:
    """Decode the audio track of any media file to a PCM WAV at the given sample rate."""
    cmd = [
        "ffmpeg", "-y", "-i", str(src), "-vn",
        "-ac", "1" if mono else "2", "-ar", str(sr),
        "-c:a", "pcm_s16le", str(dst),
    ]
    run(cmd)
    return dst
