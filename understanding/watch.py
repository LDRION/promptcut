#!/usr/bin/env python3
"""AIvideomusic — make any video readable by an LLM in seconds.

Usage:
    python watch.py <youtube-url | local-file> [options]

Produces out/<id>/digest.md (+ digest.json + sheets/*.jpg): a single timestamped
document interleaving speech transcript, scene cuts and soundtrack analysis.
"""
from __future__ import annotations

import argparse
import hashlib
import re
import sys
from pathlib import Path

from aivm import audio_analysis, ingest as ingest_mod, transcribe, visual
from aivm.digest import write_digest
from aivm.subtitles import load_subtitles
from aivm.util import extract_wav, has_audio_stream, log, require_ffmpeg

_YT_ID = re.compile(r"(?:v=|youtu\.be/|/shorts/|/embed/)([\w-]{11})")


def slug_for(source: str) -> str:
    m = _YT_ID.search(source)
    if m:
        return f"yt_{m.group(1)}"
    if ingest_mod.is_url(source):
        return "url_" + hashlib.sha1(source.encode()).hexdigest()[:10]
    stem = re.sub(r"[^\w.-]+", "_", Path(source).stem)[:40]
    return stem or "video"


def parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Turn a video into an LLM-readable digest.")
    p.add_argument("source", help="YouTube URL or path to a local video/audio file")
    p.add_argument("--out", default="out", help="output root dir (default: out)")
    p.add_argument("--interval", type=float, default=4.0, help="uniform keyframe interval, s")
    p.add_argument("--scene-threshold", type=float, default=0.4, help="ffmpeg scene sensitivity")
    p.add_argument("--max-frames", type=int, default=160, help="cap on total keyframes")
    p.add_argument("--width", type=int, default=480, help="keyframe width, px")
    p.add_argument("--cols", type=int, default=4, help="contact sheet columns")
    p.add_argument("--rows", type=int, default=4, help="contact sheet rows")
    p.add_argument("--max-height", type=int, default=720, help="max download resolution")
    p.add_argument("--whisper-model", default="large-v3", help="faster-whisper model size")
    p.add_argument("--no-visual", action="store_true", help="skip visual breakdown")
    p.add_argument("--no-audio", action="store_true", help="skip audio/transcript")
    return p.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    require_ffmpeg()

    workdir = Path(args.out) / slug_for(args.source)
    workdir.mkdir(parents=True, exist_ok=True)
    log(f"workdir: {workdir}")

    ing = ingest_mod.ingest(args.source, workdir, max_height=args.max_height)
    log(f"ingested: {ing.title!r} ({ing.duration:.0f}s)")

    transcript = []
    transcript_lang = (ing.language or "").split("-")[0]
    used_whisper = False
    audio = audio_analysis.AudioAnalysis()

    audio_present = has_audio_stream(ing.media_path)
    if not args.no_audio and audio_present:
        # --- transcript ---
        if ing.subtitle_path and ing.subtitle_path.exists():
            transcript = load_subtitles(ing.subtitle_path)
            log(f"transcript: {len(transcript)} lines from subtitles")
        else:
            log("no subtitles -> running Whisper")
            transcript, transcript_lang = transcribe.transcribe(
                ing.media_path, model_size=args.whisper_model,
                language=transcript_lang or None)
            used_whisper = True
        # --- music / sound (speech spans ground the speech labels) ---
        wav = extract_wav(ing.media_path, workdir / "audio.wav", sr=22050)
        speech_spans = [(s.start, s.end) for s in transcript]
        audio = audio_analysis.analyze(wav, speech_spans=speech_spans)
    elif not audio_present:
        log("no audio stream; skipping transcript + audio analysis")

    vis = visual.VisualResult()
    if not args.no_visual:
        extra = [m["t"] for m in audio.loudest]
        vis = visual.analyze_visual(
            ing.media_path, workdir, ing.duration,
            threshold=args.scene_threshold, interval=args.interval,
            max_frames=args.max_frames, width=args.width,
            cols=args.cols, rows=args.rows, extra_times=extra)

    out = write_digest(workdir, ing, transcript, transcript_lang, used_whisper,
                       args.whisper_model, audio, vis)

    print("\n" + "=" * 60)
    print(f"Digest ready: {out['md']}")
    print(f"  JSON:   {out['json']}")
    if vis.sheets:
        print(f"  Sheets: {len(vis.sheets)} in {workdir / 'sheets'}")
    print("Read digest.md and view the contact sheets to 'watch' the video.")
    print("=" * 60)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
