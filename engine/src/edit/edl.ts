import { readFile } from "node:fs/promises";
import type { Format } from "../config.js";
import type { SubtitleStyle } from "./subtitles.js";
import type { TransitionMix, TransitionType } from "./transitions.js";
import type { LookStats } from "./grade.js";

/**
 * EDL = Edit Decision List: the JSON contract between the BRAIN (prompt + video
 * understanding → which moments, in what order, with what camera) and the HANDS
 * (this render engine). The brain authors one clip per planned cut.
 */
export type CameraStyle = "auto" | "face" | "whip" | "push";

/** Clip-local spoken words [start, end, TEXT] (seconds from the clip's start). */
export interface ClipCue {
  words: [number, number, string][];
  /** Words painted in the accent colour (matched case/punctuation-insensitively). */
  accent?: string[];
}

export interface EdlClip {
  /** Seconds into the source video to take this clip from. */
  srcOffset: number;
  /** Per-clip camera move; default "auto" (face-lock if a face is found, else follow motion). */
  camera?: CameraStyle;
  /** How this clip ENTERS (the cut into it). Default "cut". */
  transition?: TransitionType;
  /**
   * EPIC beat: the director flags the drop / climax moments. The engine reacts —
   * a white flash + chroma burst + zoom-punch on entry, and the music swells up
   * across the epic span. This is the "wow" the montage builds toward.
   */
  epic?: boolean;
  /** White flash on entry (the AMV beat-cut accent). Overrides the EDL default. */
  flash?: boolean;
  /** RGB-split / chromatic aberration strength in px (≈3–8). 0/undefined = off. */
  chroma?: number;
  /** Key word(s) of this clip's line to paint in the accent colour. */
  accent?: string[];
  /** Karaoke speech subtitle for this clip (auto-derived from the transcript, stored
   *  so prompt-refines re-render with the same words). */
  sub?: ClipCue;
  /** Free-text reason the director chose this moment. Ignored by the renderer. */
  note?: string;
  /** Resolved-edit metadata (filled when an edit is emitted): position on the edit timeline. */
  start?: number;
  dur?: number;
}

/** Beats per cut in [chorus, build, verse] bands — the edit's pacing. */
export type CutSteps = [number, number, number];

export interface Edl {
  source: string;          // path to the source video
  music: string;           // path to the music track
  maxDuration?: number;    // cap the edit length, seconds
  format?: Format;         // output geometry (square | vertical); persisted for refine
  /** ffmpeg filter chain overriding the default colour grade (e.g. an "AMV" look). */
  grade?: string;
  /** Default white-flash on every clip unless the clip sets flash:false. */
  flashDefault?: boolean;
  /** Default chroma strength for every clip unless the clip overrides it. */
  chromaDefault?: number;
  /** Subtitle look (copied from the reference by Siberi, or the engine default). */
  subtitle?: SubtitleStyle;
  /** Pacing: beats per cut per song band. Default [2, 4, 6]. */
  cutSteps?: CutSteps;
  /** Path to the source transcript JSON — lets a refine re-derive subtitles for moved clips. */
  transcript?: string;
  /** Resolved-edit metadata (filled when an edit is emitted). */
  tempo?: number;
  srcDur?: number;
  clips: EdlClip[];        // ordered; clip i renders cut i (cycles if fewer than cuts)
}

/**
 * Style profile of a reference video: measured by understanding/style.py (pacing,
 * flashes, grade) and READ by Siberi from its frames (subtitle look, transitions, vibe).
 */
export interface StyleProfile {
  flashRate?: number;       // 0..1 fraction of cuts that should carry a flash
  chroma?: number;          // RGB-split px to apply on accent cuts
  grade?: string;           // ffmpeg grade matched to the reference's look
  cutDensity?: string;      // high | medium | low (informational)
  avgShotLen?: number;      // seconds per shot in the reference
  /** Share of each transition type in the reference. */
  transitions?: TransitionMix;
  /** Subtitle look to reproduce. */
  subtitle?: SubtitleStyle;
  /** One-line description of the reference's feel, in Siberi's words. */
  vibe?: string;
  /** Free-text notes Siberi made about the reference (for the director and critic). */
  notes?: string;
  /** The reference's measured look — the target the colour matching moves footage toward. */
  look?: LookStats;
}

export async function loadEdl(path: string): Promise<Edl> {
  const edl = JSON.parse(await readFile(path, "utf8")) as Edl;
  if (!edl.source || !edl.music) throw new Error("EDL must set 'source' and 'music'.");
  if (!Array.isArray(edl.clips) || edl.clips.length === 0) {
    throw new Error("EDL must have a non-empty 'clips' array.");
  }
  return edl;
}
