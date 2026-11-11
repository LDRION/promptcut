"""Parse WebVTT / SRT subtitles into clean timestamped segments.

YouTube auto-captions are messy: rolling cues that repeat the previous line,
inline word-level timing tags like ``<00:00:01.000><c> word</c>`` and HTML
entities. This normalises all of that into non-overlapping ``Segment``s.
"""
from __future__ import annotations

import html
import re
from dataclasses import dataclass
from pathlib import Path

# 00:00:01.234 or 01:23.456 (h optional), VTT uses '.', SRT uses ','
_TS = r"(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{3})"
_CUE_RE = re.compile(rf"({_TS})\s*-->\s*({_TS})")
_TAG_RE = re.compile(r"<[^>]+>")  # strip <c>, <00:00:01.000>, etc.


@dataclass
class Segment:
    start: float
    end: float
    text: str
    # Optional word-level timing [[start, end, word], ...] — filled by Whisper only,
    # so the montage engine can burn karaoke-synced subtitles under speech.
    words: list | None = None


def _to_seconds(h: str | None, m: str, s: str, ms: str) -> float:
    return (int(h) if h else 0) * 3600 + int(m) * 60 + int(s) + int(ms) / 1000.0


def _clean(line: str) -> str:
    line = _TAG_RE.sub("", line)
    line = html.unescape(line)
    return line.strip()


def parse_vtt(path: Path) -> list[Segment]:
    raw = Path(path).read_text(encoding="utf-8", errors="replace")
    segments: list[Segment] = []
    blocks = re.split(r"\n\s*\n", raw)
    for block in blocks:
        lines = [ln for ln in block.splitlines() if ln.strip()]
        if not lines:
            continue
        cue = None
        text_lines: list[str] = []
        for ln in lines:
            m = _CUE_RE.search(ln)
            if m:
                # group 1 = whole 1st ts; 2-5 = h,m,s,ms; group 6 = whole 2nd ts; 7-10 = h,m,s,ms
                start = _to_seconds(m.group(2), m.group(3), m.group(4), m.group(5))
                end = _to_seconds(m.group(7), m.group(8), m.group(9), m.group(10))
                cue = (start, end)
            elif ln.upper().startswith(("WEBVTT", "NOTE", "KIND", "LANGUAGE")):
                continue
            elif ln.strip().isdigit() and cue is None:
                continue  # SRT sequence number
            else:
                cleaned = _clean(ln)
                if cleaned:
                    text_lines.append(cleaned)
        if cue and text_lines:
            text = " ".join(text_lines)
            segments.append(Segment(cue[0], cue[1], text))
    return _dedupe(segments)


def _dedupe(segments: list[Segment]) -> list[Segment]:
    """Drop rolling-caption repeats: keep a line only when its text grows or changes."""
    out: list[Segment] = []
    last_text = ""
    for seg in segments:
        t = seg.text.strip()
        if not t:
            continue
        # auto-caption rolls: the next cue often re-emits the tail of the previous one
        if t == last_text:
            out[-1].end = seg.end
            continue
        if last_text and (t.startswith(last_text) or last_text.endswith(t)):
            # the new cue is the previous line plus more -> replace, extend span
            if out:
                out[-1].text = t
                out[-1].end = seg.end
                last_text = t
                continue
        out.append(Segment(seg.start, seg.end, t))
        last_text = t
    return out


def load_subtitles(path: Path) -> list[Segment]:
    return parse_vtt(path)
