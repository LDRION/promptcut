"""Assemble the unified, timestamped digest (digest.md + digest.json).

The digest is the whole point: one chronological document that interleaves the
transcript, scene cuts (pointing at contact-sheet cells) and soundtrack sections,
so an LLM can read it + glance at a few sheets and effectively "watch" the video.
"""
from __future__ import annotations

import dataclasses
import json
from pathlib import Path

from .audio_analysis import AudioAnalysis
from .ingest import IngestResult
from .subtitles import Segment
from .util import fmt_ts
from .visual import VisualResult

_KIND_ICON = {"music": "🎵", "mixed": "🎶", "speech": "🔊", "sound": "🔉", "quiet": "🔈"}


def _audio_marker(sec) -> str:
    icon = _KIND_ICON.get(sec.kind, "🔉")
    bits = [sec.kind, sec.energy]
    if sec.tempo:
        bits.append(f"~{sec.tempo:.0f} BPM")
    return f"{icon} {' · '.join(bits)}"


def build_timeline(transcript: list[Segment], audio: AudioAnalysis,
                   visual: VisualResult) -> list[tuple[float, int, str]]:
    events: list[tuple[float, int, str]] = []
    for sec in audio.sections:
        events.append((sec.start, 0, f"{_audio_marker(sec)}  (until {fmt_ts(sec.end)})"))
    for kf in visual.keyframes:
        if kf.is_scene:
            events.append((kf.t, 1, f"🎬 scene cut → sheet {kf.sheet} / cell {kf.cell}"))
    for seg in transcript:
        events.append((seg.start, 2, f"🗣 {seg.text}"))
    events.sort(key=lambda e: (e[0], e[1]))
    return events


def _transcript_source_label(ing: IngestResult, used_whisper: bool,
                             whisper_model: str, lang: str) -> str:
    if used_whisper:
        return f"Whisper ({whisper_model}), detected lang: {lang or '?'}"
    if ing.subtitle_path:
        kind = "auto-captions" if ing.subtitle_is_auto else "manual subtitles"
        return f"YouTube {kind} ({lang or '?'})"
    return "none"


def write_digest(workdir: Path, ing: IngestResult, transcript: list[Segment],
                 transcript_lang: str, used_whisper: bool, whisper_model: str,
                 audio: AudioAnalysis, visual: VisualResult) -> dict:
    md_path = workdir / "digest.md"
    json_path = workdir / "digest.json"
    src_label = _transcript_source_label(ing, used_whisper, whisper_model, transcript_lang)

    lines: list[str] = []
    a = lines.append
    a(f"# {ing.title or 'Untitled video'}\n")
    a(f"- **Source:** {ing.webpage_url or ing.source}")
    a(f"- **Duration:** {fmt_ts(ing.duration)} ({ing.duration:.0f}s)")
    if ing.uploader:
        a(f"- **Uploader:** {ing.uploader}")
    a(f"- **Transcript:** {src_label}, {len(transcript)} lines")
    a(f"- **Audio:** {audio.summary}")
    a(f"- **Visual:** {len(visual.scene_cuts)} scene cuts, "
      f"{len(visual.keyframes)} keyframes across {len(visual.sheets)} contact sheet(s)\n")

    a("## How to read this digest")
    a("This is a machine-generated \"video slice\". To understand the video:")
    a(f"1. **Look** at the contact sheets in `sheets/` — each cell is a keyframe with its "
      f"timestamp burned in (● = scene cut). {visual.cols}x{visual.rows} per sheet.")
    a("2. **Read** the Timeline below — transcript, scene cuts and soundtrack sections "
      "share one clock (M:SS). Scene-cut lines point to the exact sheet/cell to look at.")
    a("3. Use the Contact sheet index to map any timestamp to a frame.\n")

    if ing.chapters:
        a("## Chapters")
        for ch in ing.chapters:
            a(f"- `{fmt_ts(ch.get('start_time', 0))}` {ch.get('title', '')}")
        a("")

    a("## Timeline")
    for t, _, text in build_timeline(transcript, audio, visual):
        a(f"- `{fmt_ts(t)}` {text}")
    a("")

    a("## Contact sheet index")
    by_sheet: dict[int, list] = {}
    for kf in visual.keyframes:
        if kf.sheet >= 0:
            by_sheet.setdefault(kf.sheet, []).append(kf)
    for idx in sorted(by_sheet):
        cells = ", ".join(f"#{kf.cell}={fmt_ts(kf.t)}" for kf in by_sheet[idx])
        a(f"- `sheets/sheet_{idx:03d}.jpg`: {cells}")
    a("")

    md_path.write_text("\n".join(lines), encoding="utf-8")

    payload = {
        "title": ing.title,
        "source": ing.webpage_url or ing.source,
        "duration": ing.duration,
        "uploader": ing.uploader,
        "language": transcript_lang,
        "transcript_source": src_label,
        "chapters": ing.chapters,
        "transcript": [dataclasses.asdict(s) for s in transcript],
        "audio": dataclasses.asdict(audio),
        "scene_cuts": visual.scene_cuts,
        "keyframes": [
            {"t": kf.t, "is_scene": kf.is_scene, "sheet": kf.sheet,
             "cell": kf.cell, "path": str(kf.path.relative_to(workdir)).replace("\\", "/")}
            for kf in visual.keyframes
        ],
        "sheets": [str(s.relative_to(workdir)).replace("\\", "/") for s in visual.sheets],
    }
    json_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"md": md_path, "json": json_path}
