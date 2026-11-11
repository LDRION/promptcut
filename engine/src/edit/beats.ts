import MusicTempo from "music-tempo";
import { runCapture } from "../ffmpeg.js";

// music-tempo's onset analysis assumes 44.1 kHz (2048-sample window, 441 hop = 10 ms).
const SAMPLE_RATE = 44100;

export interface Energy {
  hz: number; // samples per second of the envelope
  values: number[]; // loudness 0..1 over time
}

export interface BeatInfo {
  tempo: number; // BPM
  beats: number[]; // beat times in seconds
  energy: Energy; // loudness envelope, to drive music-reactive editing
}

/** RMS loudness envelope at 20 Hz, normalised to the track's 95th percentile. */
function computeEnergy(samples: Float32Array, sampleRate: number): Energy {
  const hop = Math.max(1, Math.floor(sampleRate * 0.05)); // 50 ms → 20 fps
  const values: number[] = [];
  for (let i = 0; i + hop <= samples.length; i += hop) {
    let sum = 0;
    for (let j = 0; j < hop; j++) sum += samples[i + j] * samples[i + j];
    values.push(Math.sqrt(sum / hop));
  }
  const sorted = [...values].sort((a, b) => a - b);
  const p95 = sorted[Math.floor(sorted.length * 0.95)] || 1;
  return { hz: 20, values: values.map((v) => Math.min(1, v / (p95 || 1))) };
}

/** Decode an audio file to mono PCM and estimate its tempo + beat grid. Local, no key. */
export async function detectBeats(audioPath: string): Promise<BeatInfo> {
  const pcm = await runCapture("ffmpeg", [
    "-v", "error",
    "-i", audioPath,
    "-ac", "1",
    "-ar", String(SAMPLE_RATE),
    "-f", "f32le",
    "-",
  ]);

  // Reinterpret the byte buffer as 32-bit floats.
  const samples = new Float32Array(
    pcm.buffer,
    pcm.byteOffset,
    Math.floor(pcm.byteLength / Float32Array.BYTES_PER_ELEMENT),
  );
  if (samples.length === 0) {
    throw new Error(`No audio decoded from ${audioPath} — is it a valid audio/video file?`);
  }

  const mt = new MusicTempo(Array.from(samples));
  const tempo = Math.round(Number(mt.tempo));
  const beats = (mt.beats ?? []).map(Number).filter((t) => Number.isFinite(t));
  const energy = computeEnergy(samples, SAMPLE_RATE);
  return { tempo, beats, energy };
}
