"""Ingest a video from a URL (yt-dlp) or a local file, plus metadata & subtitles."""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

from .util import ffprobe_info, log, media_duration

_URL_RE = re.compile(r"^https?://", re.I)

# Subtitle languages we care about, in priority order (prefixes; 'en' matches 'en-US').
_SUB_LANG_PREF = ["en", "ru"]


@dataclass
class IngestResult:
    source: str
    media_path: Path
    is_url: bool
    title: str = ""
    duration: float = 0.0
    uploader: str = ""
    webpage_url: str = ""
    description: str = ""
    language: str = ""
    chapters: list[dict] = field(default_factory=list)
    subtitle_path: Path | None = None
    subtitle_is_auto: bool = False
    info: dict = field(default_factory=dict)


def is_url(source: str) -> bool:
    return bool(_URL_RE.match(source.strip()))


def ingest(source: str, workdir: Path, *, max_height: int = 720) -> IngestResult:
    workdir.mkdir(parents=True, exist_ok=True)
    if is_url(source):
        return _ingest_url(source, workdir, max_height=max_height)
    return _ingest_local(source, workdir)


def _ingest_local(source: str, workdir: Path) -> IngestResult:
    path = Path(source).expanduser().resolve()
    if not path.exists():
        raise FileNotFoundError(f"Local file not found: {path}")
    info = ffprobe_info(path)
    tags = info.get("format", {}).get("tags", {}) or {}
    return IngestResult(
        source=source,
        media_path=path,
        is_url=False,
        title=tags.get("title", path.stem),
        duration=media_duration(path),
        info=info,
    )


def _choose_sub_lang(info: dict) -> tuple[str | None, bool]:
    """Pick the best available subtitle language. Returns (lang, is_auto)."""
    manual = info.get("subtitles") or {}
    auto = info.get("automatic_captions") or {}
    orig = (info.get("language") or "").split("-")[0]
    pref = ([orig] if orig else []) + _SUB_LANG_PREF

    def find(store: dict) -> str | None:
        for p in pref:
            for lang in store:
                if lang.split("-")[0] == p and not lang.endswith("-orig"):
                    return lang
        # fall back to anything that isn't live chat
        for lang in store:
            if "live_chat" not in lang:
                return lang
        return None

    lang = find(manual)
    if lang:
        return lang, False
    lang = find(auto)
    if lang:
        return lang, True
    return None, False


def _ingest_url(source: str, workdir: Path, *, max_height: int) -> IngestResult:
    try:
        import yt_dlp
    except ImportError as e:
        raise RuntimeError("yt-dlp is not installed (pip install yt-dlp).") from e

    # Phase 1: probe metadata + available captions (fast, no download).
    with yt_dlp.YoutubeDL({"quiet": True, "skip_download": True}) as ydl:
        info = ydl.extract_info(source, download=False)

    sub_lang, is_auto = _choose_sub_lang(info)
    outtmpl = str(workdir / "source.%(ext)s")
    opts = {
        "quiet": True,
        "no_warnings": True,
        "outtmpl": outtmpl,
        "format": (
            f"bestvideo[height<={max_height}]+bestaudio/"
            f"best[height<={max_height}]/best"
        ),
        "merge_output_format": "mp4",
        "writeinfojson": False,
        "noprogress": True,
    }
    if sub_lang:
        opts.update({
            "writesubtitles": not is_auto,
            "writeautomaticsub": is_auto,
            "subtitleslangs": [sub_lang],
            "subtitlesformat": "vtt",
        })

    log(f"downloading (≤{max_height}p)" + (f", subs: {sub_lang}{' auto' if is_auto else ''}" if sub_lang else ", no subs"))
    with yt_dlp.YoutubeDL(opts) as ydl:
        ydl.download([source])

    media_path = _find_media(workdir)
    subtitle_path = next(iter(sorted(workdir.glob("source*.vtt"))), None)

    return IngestResult(
        source=source,
        media_path=media_path,
        is_url=True,
        title=info.get("title", ""),
        duration=float(info.get("duration") or media_duration(media_path)),
        uploader=info.get("uploader", "") or info.get("channel", ""),
        webpage_url=info.get("webpage_url", source),
        description=info.get("description", "") or "",
        language=(info.get("language") or ""),
        chapters=info.get("chapters") or [],
        subtitle_path=subtitle_path,
        subtitle_is_auto=is_auto,
        info={k: info.get(k) for k in ("id", "extractor", "view_count", "upload_date")},
    )


def _find_media(workdir: Path) -> Path:
    media_exts = (".mp4", ".mkv", ".webm", ".m4a", ".mov", ".avi")
    candidates = [
        p for p in workdir.glob("source.*")
        if p.suffix.lower() in media_exts
    ]
    if not candidates:
        raise RuntimeError(f"yt-dlp produced no media file in {workdir}")
    # Prefer a real video container over audio-only.
    candidates.sort(key=lambda p: (p.suffix.lower() in (".m4a",), -p.stat().st_size))
    return candidates[0]
