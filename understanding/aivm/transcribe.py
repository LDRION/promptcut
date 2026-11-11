"""Speech-to-text fallback via faster-whisper (used only when no subtitles exist).

Tries CUDA/float16 first (RTX cards), falls back to CPU/int8. For GPU you need
the CUDA 12 runtime libs: ``pip install nvidia-cublas-cu12 nvidia-cudnn-cu12``.
A CUDA device can load the model fine and still fail on the first encode when those
libs are missing (``cublas64_12.dll is not found``) — so the fallback covers the
whole transcription, not just model creation.
"""
from __future__ import annotations

from pathlib import Path

from .subtitles import Segment
from .util import log

_DEVICES = (("cuda", "float16"), ("cpu", "int8"))


def _run(model, wav_path: Path, language: str | None) -> tuple[list[Segment], str]:
    seg_iter, info = model.transcribe(
        str(wav_path),
        language=language,
        vad_filter=True,
        beam_size=5,
        word_timestamps=True,
    )

    def words_of(s):
        out = []
        for w in (getattr(s, "words", None) or []):
            txt = (w.word or "").strip()
            if txt:
                out.append([round(float(w.start), 2), round(float(w.end), 2), txt])
        return out or None

    # The iterator is lazy — materialise it here so device errors surface inside the try.
    segments = [Segment(float(s.start), float(s.end), s.text.strip(), words_of(s))
                for s in seg_iter if s.text.strip()]
    detected = getattr(info, "language", "") or (language or "")
    return segments, detected


def transcribe(wav_path: Path, *, model_size: str = "large-v3", language: str | None = None
               ) -> tuple[list[Segment], str]:
    from faster_whisper import WhisperModel

    last: Exception | None = None
    for device, compute in _DEVICES:
        try:
            model = WhisperModel(model_size, device=device, compute_type=compute)
            log(f"whisper: {model_size} on {device}/{compute}")
            segments, detected = _run(model, wav_path, language)
            log(f"whisper: {len(segments)} segments, lang={detected}")
            return segments, detected
        except Exception as e:  # noqa: BLE001 - CUDA libs missing, bad driver, OOM, etc.
            last = e
            log(f"whisper: {device}/{compute} failed ({type(e).__name__}: {str(e)[:120]}); trying next")
    raise RuntimeError(f"Could not transcribe on any device: {last}")
