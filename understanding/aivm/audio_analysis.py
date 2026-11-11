"""Music / sound analysis with librosa.

Produces a coarse, timestamped soundtrack timeline: tempo, energy over time, and
sections labelled music / speech / mixed / quiet. Heuristic but fast and robust;
designed to give an LLM a real sense of the *sound* of a video, not exact MIR.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from .util import fmt_ts, log

# Tunables (relative to peak; librosa amplitude_to_db ref=max => 0 dB at the loudest point).
_SILENCE_DB = -45.0
_QUIET_DB = -30.0
_LOUD_DB = -14.0
_BIN_SEC = 1.0          # timeline resolution
_MIN_SECTION_SEC = 3.0  # merge anything shorter into a neighbour


@dataclass
class AudioSection:
    start: float
    end: float
    kind: str          # music | speech | mixed | sound | quiet
    energy: str        # silent | quiet | moderate | loud
    trend: str         # rising | steady | falling
    tempo: float | None = None


@dataclass
class AudioAnalysis:
    duration: float = 0.0
    sr: int = 0
    tempo: float = 0.0
    beats: int = 0
    has_music: bool = False
    music_fraction: float = 0.0
    speech_fraction: float = 0.0
    sections: list[AudioSection] = field(default_factory=list)
    energy_curve: list[dict] = field(default_factory=list)
    loudest: list[dict] = field(default_factory=list)
    summary: str = ""


def _energy_label(db: float) -> str:
    if db < _SILENCE_DB:
        return "silent"
    if db < _QUIET_DB:
        return "quiet"
    if db < _LOUD_DB:
        return "moderate"
    return "loud"


def _beat_salience(onset_env, frame_rate: float,
                   min_bpm: float = 50.0, max_bpm: float = 200.0) -> float:
    """Peak of the normalised onset-envelope autocorrelation within a musical
    tempo band. ~0 for noise/speech, clearly higher for a real periodic beat."""
    o = np.asarray(onset_env, dtype=float)
    if o.size < 8:
        return 0.0
    o = o - o.mean()
    ac = np.correlate(o, o, mode="full")[o.size - 1:]
    if ac[0] <= 0:
        return 0.0
    ac = ac / ac[0]
    lo = max(1, int(frame_rate * 60.0 / max_bpm))
    hi = min(len(ac) - 1, int(frame_rate * 60.0 / min_bpm))
    if hi <= lo:
        return 0.0
    return float(np.max(ac[lo:hi]))


def _overlaps_speech(start: float, end: float, spans: list[tuple[float, float]]) -> bool:
    return any(s < end and e > start for s, e in spans)


def analyze(wav_path: Path, *, sr: int = 22050,
            speech_spans: list[tuple[float, float]] | None = None) -> AudioAnalysis:
    """Analyse the soundtrack. ``speech_spans`` (from the transcript) ground the
    speech labels in real data instead of guessing from DSP alone."""
    speech_spans = speech_spans or []
    try:
        import librosa
    except ImportError:
        log("librosa not installed; skipping audio analysis")
        return AudioAnalysis()

    y, sr = librosa.load(str(wav_path), sr=sr, mono=True)
    if y.size == 0:
        return AudioAnalysis(sr=sr)
    duration = float(len(y) / sr)

    hop = 512
    rms = librosa.feature.rms(y=y, hop_length=hop)[0]
    rms_db = librosa.amplitude_to_db(rms, ref=np.max)
    flat = librosa.feature.spectral_flatness(y=y, hop_length=hop)[0]
    frame_rate = sr / hop  # ~43 Hz

    # Global tempo / beat (percussive component gives a cleaner beat estimate).
    try:
        harm, perc = librosa.effects.hpss(y)
        onset_env = librosa.onset.onset_strength(y=perc, sr=sr, hop_length=hop)
        tempo_arr, beat_frames = librosa.beat.beat_track(onset_envelope=onset_env, sr=sr, hop_length=hop)
        tempo = float(np.atleast_1d(tempo_arr)[0])
        beats = int(len(beat_frames))
        # Beat salience: how periodic the onset envelope is in a musical tempo range.
        # Real music => sharp autocorrelation peak; ambient/speech transients => flat.
        beat_salience = _beat_salience(onset_env, frame_rate)
    except Exception as e:  # noqa: BLE001
        log(f"beat tracking failed ({type(e).__name__}); continuing without tempo")
        tempo, beats, beat_salience = 0.0, 0, 0.0

    # Bin everything to _BIN_SEC resolution.
    bin_frames = max(1, int(round(frame_rate * _BIN_SEC)))
    n_bins = max(1, int(np.ceil(len(rms) / bin_frames)))
    bins = []
    for i in range(n_bins):
        sl = slice(i * bin_frames, (i + 1) * bin_frames)
        seg_db = rms_db[sl]
        seg_rms = rms[sl]
        seg_flat = flat[sl]
        if seg_db.size == 0:
            continue
        mean_db = float(np.mean(seg_db))
        # coefficient of variation of the amplitude envelope -> speech is "bursty".
        cov = float(np.std(seg_rms) / (np.mean(seg_rms) + 1e-9))
        bins.append({
            "t": i * _BIN_SEC,
            "db": mean_db,
            "cov": cov,
            "flat": float(np.mean(seg_flat)),
        })

    strong_beat = tempo > 0 and beat_salience > 0.3
    for b in bins:
        b["energy"] = _energy_label(b["db"])
        has_speech = _overlaps_speech(b["t"], b["t"] + _BIN_SEC, speech_spans)
        # "musical" = sustained (low envelope variation) AND tonal (low spectral flatness).
        musical = b["cov"] < 0.35 and b["flat"] < 0.15
        if b["energy"] == "silent":
            b["kind"] = "quiet"
        elif has_speech:
            b["kind"] = "mixed" if (musical and strong_beat) else "speech"
        elif musical and strong_beat:
            b["kind"] = "music"
        else:
            b["kind"] = "sound"  # audible but neither speech nor clearly musical

    sections = _merge_bins(bins, duration, tempo)
    music_t = sum(s.end - s.start for s in sections if s.kind in ("music", "mixed"))
    speech_t = sum(s.end - s.start for s in sections if s.kind in ("speech", "mixed"))
    music_fraction = music_t / duration if duration else 0.0
    speech_fraction = speech_t / duration if duration else 0.0
    # Require sustained tonal content to claim music — a lone tempo guess from
    # ambient noise is not enough.
    has_music = music_fraction > 0.2

    energy_curve = [{"t": round(b["t"], 1), "db": round(b["db"], 1)} for b in bins]
    loudest = _peaks(bins)

    summary = _summarize(duration, tempo, has_music, music_fraction, speech_fraction, sections)
    log(f"audio: {fmt_ts(duration)}, tempo~{tempo:.0f} BPM, music {music_fraction:.0%}, speech {speech_fraction:.0%}")

    return AudioAnalysis(
        duration=duration, sr=sr, tempo=round(tempo, 1), beats=beats,
        has_music=has_music, music_fraction=round(music_fraction, 3),
        speech_fraction=round(speech_fraction, 3), sections=sections,
        energy_curve=energy_curve, loudest=loudest, summary=summary,
    )


def _merge_bins(bins: list[dict], duration: float, tempo: float) -> list[AudioSection]:
    if not bins:
        return []
    sections: list[AudioSection] = []
    cur = None
    for b in bins:
        if cur and b["kind"] == cur.kind and b["energy"] == cur.energy:
            cur.end = b["t"] + _BIN_SEC
        else:
            if cur:
                sections.append(cur)
            cur = AudioSection(start=b["t"], end=b["t"] + _BIN_SEC,
                               kind=b["kind"], energy=b["energy"], trend="steady")
    if cur:
        cur.end = min(cur.end, duration) if duration else cur.end
        sections.append(cur)

    # Collapse sub-minimum sections into the previous one.
    merged: list[AudioSection] = []
    for s in sections:
        if merged and (s.end - s.start) < _MIN_SECTION_SEC:
            merged[-1].end = s.end
        else:
            merged.append(s)

    # Coalesce adjacent sections that ended up with the same label.
    coalesced: list[AudioSection] = []
    for s in merged:
        if coalesced and s.kind == coalesced[-1].kind and s.energy == coalesced[-1].energy:
            coalesced[-1].end = s.end
        else:
            coalesced.append(s)

    for s in coalesced:
        if s.kind in ("music", "mixed") and tempo > 0:
            s.tempo = round(tempo, 1)
    return coalesced


def _peaks(bins: list[dict], top: int = 3) -> list[dict]:
    if not bins:
        return []
    arr = np.array([b["db"] for b in bins])
    order = np.argsort(arr)[::-1]
    picked: list[int] = []
    for idx in order:
        if all(abs(idx - p) > 5 for p in picked):  # spread peaks >5s apart
            picked.append(int(idx))
        if len(picked) >= top:
            break
    picked.sort()
    return [{"t": round(bins[i]["t"], 1), "db": round(bins[i]["db"], 1)} for i in picked]


def _summarize(duration, tempo, has_music, music_f, speech_f, sections) -> str:
    parts = []
    if has_music and tempo > 0:
        parts.append(f"music present (~{tempo:.0f} BPM)")
    elif has_music:
        parts.append("music present")
    if speech_f > 0.2:
        parts.append(f"speech ~{speech_f:.0%} of runtime")
    sound_f = sum(s.end - s.start for s in sections if s.kind == "sound") / duration if duration else 0
    if sound_f > 0.15:
        parts.append(f"ambient/sfx ~{sound_f:.0%}")
    quiet_f = sum(s.end - s.start for s in sections if s.energy == "silent") / duration if duration else 0
    if quiet_f > 0.1:
        parts.append(f"{quiet_f:.0%} near-silent")
    return "; ".join(parts) or "no notable audio detected"
