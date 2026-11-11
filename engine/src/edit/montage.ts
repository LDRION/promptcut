import { copyFile, mkdir, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { run, probeDuration } from "../ffmpeg.js";
import { detectBeats, type BeatInfo } from "./beats.js";
import { pickLivelyOffsets } from "./moments.js";
import { trackFaces, buildFollowCrop, type ClipTraj } from "./facelock.js";
import { autoAccent, bareWord, cueToAss, deriveCue, DEFAULT_SUB_STYLE, type SubtitleStyle, type TranscriptSeg } from "./subtitles.js";
import { assignTransitions, entryFilter, exitFilter, isTransition, type TransitionType } from "./transitions.js";
import type { CameraStyle, ClipCue, CutSteps, Edl, StyleProfile } from "./edl.js";
import { formatSpec, render as R, GRADES, type Format } from "../config.js";

// How far the face-lock punches in (bigger = tighter on the head, less room to pan).
const ZOOM = 1.3;
// Land visual cuts a hair BEFORE the beat — compensates the perceived cut latency
// that made transitions feel late. Shifts the whole grid earlier by this much.
const BEAT_LEAD = 0.06;
// Shortest shot we allow: anything below reads as a glitch, not a cut.
const MIN_SHOT = 0.25;
// Bump when the render recipe changes, so stale cached clips are never reused.
const CACHE_VERSION = 3;

export const DEFAULT_STEPS: CutSteps = [2, 4, 6];

export type Progress = (msg: string) => void;

export interface CutGrid {
  tempo: number;
  cuts: number[]; // boundary times; nClips = cuts.length - 1
  sectionAt: (t: number) => number; // 0 = verse/quiet, 1 = chorus/loud
  chorusBeats: number;
  musicDur: number;
}

// Beat detection decodes the whole track — memoise it, the conductor plans and then
// renders (possibly several QA rounds) against the same music file.
const beatCache = new Map<string, Promise<BeatInfo>>();
async function beatsFor(musicPath: string): Promise<BeatInfo> {
  const st = await stat(musicPath);
  const key = `${path.resolve(musicPath)}|${st.size}|${st.mtimeMs}`;
  let p = beatCache.get(key);
  if (!p) {
    p = detectBeats(musicPath);
    beatCache.set(key, p);
    p.catch(() => beatCache.delete(key));
  }
  return p;
}

/**
 * Pacing copied from a reference: its average shot length, expressed in beats of
 * OUR track, spread over the song's bands (chorus cuts faster, verse holds longer).
 */
export function stepsFor(avgShotLen: number | undefined, tempo: number): CutSteps {
  if (!avgShotLen || !tempo || avgShotLen <= 0) return DEFAULT_STEPS;
  const beat = 60 / tempo;
  const b = Math.min(12, Math.max(1, avgShotLen / beat));
  return [
    Math.max(1, Math.round(b * 0.7)),
    Math.max(1, Math.round(b)),
    Math.max(2, Math.round(b * 1.5)),
  ];
}

/**
 * Beats + loudness structure → the cut grid. Cuts always land on detected beats;
 * loud blocks (choruses/drops) cut often, quiet spans (verses) hold the shot.
 */
async function computeCutGrid(musicPath: string, maxDuration?: number, steps: CutSteps = DEFAULT_STEPS): Promise<CutGrid> {
  const { tempo, beats, energy } = await beatsFor(musicPath);
  // Section curve = loudness envelope smoothed over the whole track, normalised 0..1.
  const win = Math.round(energy.hz * 1.5);
  const sectionVals = energy.values.map((_, idx) => {
    let sum = 0;
    let cnt = 0;
    for (let k = -win; k <= win; k++) {
      const j = idx + k;
      if (j >= 0 && j < energy.values.length) {
        sum += energy.values[j];
        cnt++;
      }
    }
    return cnt ? sum / cnt : 0;
  });
  const sMin = Math.min(...sectionVals);
  const sMax = Math.max(...sectionVals);
  const sectionAt = (t: number): number => {
    const v = sectionVals[Math.max(0, Math.min(sectionVals.length - 1, Math.round(t * energy.hz)))] ?? 0;
    return (v - sMin) / (sMax - sMin || 1);
  };

  const musicDur = await probeDuration(musicPath);
  const limit = maxDuration && maxDuration > 0 ? Math.min(musicDur, maxDuration) : musicDur;
  const within = beats.filter((b) => b > 0.05 && b < limit);

  const cuts = [0];
  let bi = 0;
  let chorusBeats = 0;
  while (bi < within.length) {
    const b = within[bi];
    if (b - cuts[cuts.length - 1] >= MIN_SHOT + BEAT_LEAD) cuts.push(b);
    const sec = sectionAt(b);
    if (sec >= 0.6) chorusBeats++;
    bi += sec >= 0.6 ? steps[0] : sec >= 0.35 ? steps[1] : steps[2];
  }
  // Fold a sliver at the very end into the last shot.
  if (cuts.length > 1 && limit - cuts[cuts.length - 1] < MIN_SHOT) cuts.pop();
  if (cuts[cuts.length - 1] < limit - 0.05) cuts.push(limit);
  if (cuts.length < 2) throw new Error("Не нашёл биты в музыке — попробуй другой трек.");

  return { tempo, cuts, sectionAt, chorusBeats, musicDur };
}

export interface PlanCut {
  i: number;
  start: number;
  dur: number;
  section: number; // 0..1 loudness
  band: "verse" | "build" | "chorus";
}

export interface Plan {
  tempo: number;
  music: string;
  musicDur: number;
  nClips: number;
  cutSteps: CutSteps;
  cuts: PlanCut[];
}

const bandOf = (s: number): PlanCut["band"] => (s >= 0.6 ? "chorus" : s >= 0.35 ? "build" : "verse");

/**
 * Phase 1 for the director: the beat-driven cut grid the EDL must fill (one clip per
 * cut). With a reference's `avgShotLen`, the pacing follows the reference.
 */
export async function planEdit(musicPath: string, maxDuration?: number, avgShotLen?: number): Promise<Plan> {
  const { tempo } = await beatsFor(musicPath);
  const cutSteps = stepsFor(avgShotLen, tempo);
  const g = await computeCutGrid(musicPath, maxDuration, cutSteps);
  const cuts: PlanCut[] = [];
  for (let i = 0; i < g.cuts.length - 1; i++) {
    const start = g.cuts[i];
    const dur = g.cuts[i + 1] - start;
    const s = g.sectionAt(start + dur / 2);
    cuts.push({
      i,
      start: Math.round(start * 1000) / 1000,
      dur: Math.round(dur * 1000) / 1000,
      section: Math.round(s * 100) / 100,
      band: bandOf(s),
    });
  }
  return { tempo: g.tempo, music: musicPath, musicDur: g.musicDur, nClips: cuts.length, cutSteps, cuts };
}

/** Merge overlapping/adjacent [start,end] ranges (join when the gap ≤ `gap`). */
function mergeRanges(ranges: [number, number][], gap = 0.3): [number, number][] {
  if (!ranges.length) return [];
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [sorted[0]];
  for (const [s, e] of sorted.slice(1)) {
    const last = out[out.length - 1];
    if (s <= last[1] + gap) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

/**
 * Music volume automation: swell up over the epic spans, base level elsewhere.
 * Ranges are merged first (a run of epic cuts = one continuous swell) and capped, so
 * the expression stays small. Smooth ramps (no clicks). Null = nothing to swell.
 */
function swellExpr(epicRanges: [number, number][], boost = 0.55, ramp = 0.25): string | null {
  const merged = mergeRanges(epicRanges).slice(0, 24);
  if (!merged.length) return null;
  const bump = merged
    .map(([s, e]) =>
      `clip((t-${(s - ramp).toFixed(3)})/${ramp},0,1)-clip((t-${e.toFixed(3)})/${ramp},0,1)`)
    .join("+");
  // Single-quoted so the commas inside clip() stay literal in the filtergraph.
  return `volume=volume='1+${boost}*min(1,${bump})':eval=frame`;
}

/**
 * Auto mode has no director to point at the drop, so pick the single loudest
 * CONTIGUOUS run of clips (~15%, capped) as the epic span — one clean climax instead
 * of a flash on every loud beat.
 */
function pickAutoEpics(sections: number[]): boolean[] {
  const n = sections.length;
  const out = new Array(n).fill(false);
  if (n < 3) return out;
  const L = Math.max(2, Math.min(24, Math.round(n * 0.15)));
  let bestStart = 0;
  let best = -1;
  for (let s = 0; s + L <= n; s++) {
    let sum = 0;
    for (let k = s; k < s + L; k++) sum += sections[k];
    if (sum > best) { best = sum; bestStart = s; }
  }
  if (best / L >= 0.5) for (let k = bestStart; k < bestStart + L; k++) out[k] = true;
  return out;
}

export interface MakeEditOptions {
  music: string;
  source: string;
  outDir: string;
  finalName?: string;
  onProgress?: Progress;
  maxDuration?: number;
  /** Director's decisions; without one, moments are picked by motion (auto mode). */
  edl?: Edl;
  /** Reference style (grade, pacing, transitions mix, subtitle look). */
  style?: StyleProfile;
  format?: Format;
  transcript?: TranscriptSeg[];
  /** Path to the transcript JSON, recorded in the resolved EDL so refines keep subtitles. */
  transcriptPath?: string;
  /** Reuse byte-identical clips across renders (QA rounds re-render only what changed). */
  cacheDir?: string;
}

export interface EditResult {
  video: string;
  /** The resolved EDL actually rendered (also written to outDir/edit.json). */
  edl: Edl;
  rendered: number;
  reused: number;
}

/**
 * Beat-synced cinematic montage. The camera is GLUED to the tracked head (face-lock),
 * subtitles ride the spoken words in the reference's look, every cut enters with its
 * transition, and the director's EPIC beats explode (flash + chroma + zoom-punch + a
 * music swell). Clean full-frame 60fps output in the chosen format.
 */
export async function makeEdit(opts: MakeEditOptions): Promise<EditResult> {
  const {
    music: musicPath, source: sourcePath, outDir, finalName = "edit.mp4",
    onProgress = () => {}, maxDuration, edl, style, format = edl?.format ?? "square",
    transcript, cacheDir,
  } = opts;
  await mkdir(outDir, { recursive: true });
  if (cacheDir) await mkdir(cacheDir, { recursive: true });
  const { width: W, height: H, square: SQ } = formatSpec(format);
  const FPS = R.fps;

  onProgress("Разбираю музыку на биты…");
  const { tempo: bpm } = await beatsFor(musicPath);
  const steps = edl?.cutSteps ?? stepsFor(style?.avgShotLen, bpm);
  const grid = await computeCutGrid(musicPath, maxDuration, steps);
  const { cuts, tempo, chorusBeats } = grid;
  const nClips = cuts.length - 1;

  const srcDur = await probeDuration(sourcePath);
  const musicAbs = path.resolve(musicPath);
  const srcAbs = path.resolve(sourcePath);

  onProgress(`Темп ${tempo} BPM · ${nClips} склеек (шаг ${steps.join("/")} бита) · ${chorusBeats} «громких» битов · ${format} @${FPS}fps`);

  const bands = Array.from({ length: nClips }, (_, i) =>
    bandOf(grid.sectionAt(cuts[i] + (cuts[i + 1] - cuts[i]) / 2)));

  // Per-cut decisions: source offset, camera, transition, epic flag + look accents.
  // From the EDL if the director gave one, else auto (motion offsets, loud-section epics).
  const offsets: number[] = [];
  const styles: CameraStyle[] = [];
  const epics: boolean[] = [];
  const flashes: boolean[] = [];
  const chromas: number[] = [];
  const subs: (ClipCue | undefined)[] = [];
  const accents: (string[] | undefined)[] = [];
  let transitions: TransitionType[];
  const fallbackTransitions = assignTransitions(bands, style?.transitions);
  // Epic RGB-split follows the reference: glitchy references get a real burst, clean
  // ones only a hint. The resolved EDL stores the value, so refines keep the look.
  const epicChroma = !style ? 4 : (style.chroma ?? 0) > 0 || (style.transitions?.glitch ?? 0) >= 0.1 ? 4 : 2;
  if (edl) {
    onProgress(`EDL: ${edl.clips.length} клип(ов) от режиссёра`);
    transitions = [];
    for (let i = 0; i < nClips; i++) {
      const clip = edl.clips[i] ?? edl.clips[edl.clips.length - 1]; // cycle/clamp if fewer
      const epic = Boolean(clip.epic);
      offsets.push(clip.srcOffset);
      styles.push(clip.camera ?? "auto");
      epics.push(epic);
      transitions.push(isTransition(clip.transition) ? clip.transition : fallbackTransitions[i]);
      // Flash on the drop onset, not every epic cut in a row.
      const epicOnset = epic && !epics[i - 1];
      flashes.push(epicOnset || (clip.flash ?? edl.flashDefault ?? false));
      chromas.push(epic ? (clip.chroma ?? epicChroma) : (clip.chroma ?? edl.chromaDefault ?? style?.chroma ?? 0));
      subs.push(clip.sub);
      accents.push(clip.accent);
    }
  } else {
    onProgress("Выбираю живые моменты (по движению)…");
    const picked = await pickLivelyOffsets(srcAbs, nClips, srcDur, onProgress);
    const sects = Array.from({ length: nClips }, (_, i) =>
      grid.sectionAt(cuts[i] + (cuts[i + 1] - cuts[i]) / 2));
    const autoEpic = pickAutoEpics(sects);
    transitions = fallbackTransitions;
    for (let i = 0; i < nClips; i++) {
      offsets.push(picked[i] ?? 0);
      styles.push("auto");
      epics.push(autoEpic[i]);
      // Flash only on the drop ONSET, not every cut — keep it punchy, not strobey.
      flashes.push(autoEpic[i] && !autoEpic[i - 1]);
      chromas.push(autoEpic[i] ? epicChroma : (style?.chroma ?? 0));
      subs.push(undefined);
      accents.push(undefined);
    }
  }
  const grade = edl?.grade ?? style?.grade ?? GRADES.cinematic;
  const subStyle: SubtitleStyle = edl?.subtitle ?? style?.subtitle ?? DEFAULT_SUB_STYLE;

  // Clip durations from the beat grid; lead the whole grid so cuts land on the beat,
  // not a hair after it. Clamp source offsets so a clip never runs past the source.
  const durs: number[] = [];
  for (let i = 0; i < nClips; i++) durs.push(Math.max(0.1, cuts[i + 1] - cuts[i]));
  if (durs.length) durs[0] = Math.max(0.1, durs[0] - BEAT_LEAD);
  const segs = durs.map((d, i) => ({
    off: Math.min(Math.max(0, offsets[i] ?? 0), Math.max(0, srcDur - d)),
    dur: d,
  }));

  // Spoken words per clip (director's stored words win; else derive from transcript),
  // plus the accent word painted in the reference's accent colour.
  // Only words actually spoken in the clip can be accented — the director sometimes
  // names a word from a neighbouring line (or a placeholder); then pick one ourselves.
  const cues = segs.map((s, i) => {
    const cue = subs[i] ?? deriveCue(transcript, s.off, s.dur) ?? undefined;
    if (!cue) return undefined;
    const spoken = new Set(cue.words.map((w) => bareWord(w[2])));
    const wanted = (accents[i]?.length ? accents[i] : cue.accent)?.filter((a) => spoken.has(bareWord(a)));
    if (wanted?.length) return { ...cue, accent: wanted };
    const auto = subStyle.accentColor ? autoAccent(cue) : undefined;
    return { ...cue, accent: auto ? [auto] : undefined };
  });
  // Where each clip actually sits in the rendered video (the beat lead shifts every
  // clip after the first) — what the critic, the render QA and the refine flow see.
  const starts: number[] = [];
  const epicRanges: [number, number][] = [];
  let tl = 0;
  for (let i = 0; i < nClips; i++) {
    starts.push(tl);
    if (epics[i]) epicRanges.push([tl, tl + segs[i].dur]);
    tl += segs[i].dur;
  }

  // Emit the resolved EDL (the AI's decisions) so the edit is reproducible & editable.
  const resolved: Edl = {
    source: srcAbs,
    music: musicAbs,
    maxDuration,
    format,
    grade,
    subtitle: subStyle,
    cutSteps: steps,
    transcript: opts.transcriptPath ?? edl?.transcript,
    tempo,
    srcDur: Math.round(srcDur * 100) / 100,
    clips: segs.map((s, i) => ({
      srcOffset: Math.round(s.off * 1000) / 1000,
      camera: styles[i],
      transition: transitions[i],
      epic: epics[i],
      flash: flashes[i],
      chroma: chromas[i],
      accent: cues[i]?.accent,
      sub: cues[i],
      note: edl?.clips[i]?.note,
      start: Math.round(starts[i] * 1000) / 1000,
      dur: Math.round(s.dur * 1000) / 1000,
    })),
  };
  await writeFile(path.join(outDir, "edit.json"), JSON.stringify(resolved, null, 2));

  // Everything that determines a clip's pixels → a cache key. Identical key = reuse.
  const keys = segs.map((s, i) => createHash("sha1").update(JSON.stringify({
    v: CACHE_VERSION, src: srcAbs, off: s.off.toFixed(3), dur: s.dur.toFixed(3), cam: styles[i],
    tr: transitions[i], next: transitions[i + 1], epic: epics[i], flash: flashes[i], chroma: chromas[i],
    cue: cues[i] ?? null, sub: cues[i] ? subStyle : null, grade, format, fps: FPS, crf: R.crf, preset: R.preset,
  })).digest("hex").slice(0, 20));
  const cached = (i: number) => (cacheDir ? path.join(cacheDir, `${keys[i]}.mp4`) : "");
  const todo = segs.map((_, i) => i).filter((i) => !(cacheDir && existsSync(cached(i))));
  const todoSet = new Set(todo);

  // Face-lock only matters for clips we actually have to render.
  const needTrack = todo.filter((i) => styles[i] !== "whip" && styles[i] !== "push");
  const trajOf = new Map<number, ClipTraj>();
  let srcW = 0;
  let srcH = 0;
  if (needTrack.length) {
    onProgress("Трекаю головы в кадре (mediapipe, покадрово)…");
    const track = await trackFaces(srcAbs, needTrack.map((i) => segs[i]), 15);
    srcW = track.w;
    srcH = track.h;
    needTrack.forEach((i, k) => trajOf.set(i, track.clips[k]));
    const locked = track.clips.filter((c) => c.found).length;
    if (track.error) onProgress(`⚠ трекер лиц не сработал: ${track.error}`);
    onProgress(`Face-lock: камера приклеена к голове в ${locked}/${needTrack.length} клипах (иначе — медленный наезд)`);
  }
  const subbed = cues.filter(Boolean).length;
  if (subbed) onProgress(`Субтитры под речь: ${subbed}/${nClips} клипов · ${subStyle.font}, ${subStyle.animation}`);
  if (epicRanges.length) onProgress(`Эпик-моменты: ${epicRanges.length} (вспышка + свелл музыки)`);
  if (cacheDir && todo.length < nClips) onProgress(`Кэш: ${nClips - todo.length} клипов без изменений, рендерю ${todo.length}`);

  // Frame the SQ×SQ content square onto the final canvas per format → label [fr].
  const frameToCanvas = (sqLabel: string): string => {
    if (W === SQ && H === SQ) return `[${sqLabel}]vignette=PI/6[fr]`;
    // Vertical: darkened blurred cover behind the centered square + vignette.
    return (
      `[${sqLabel}]split=2[fg][bgsrc];` +
      `[bgsrc]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},` +
      `gblur=sigma=32,eq=brightness=-0.28:saturation=0.7,setsar=1[bg];` +
      `[bg][fg]overlay=${(W - SQ) / 2}:${(H - SQ) / 2},vignette=PI/6[fr]`
    );
  };

  const slots: (string | null)[] = new Array(nClips).fill(null);
  let rendered = 0;
  const renderClip = async (i: number): Promise<void> => {
    const dur = segs[i].dur;
    if (dur < 0.08) return;
    const off = segs[i].off;
    const pad = String(i).padStart(4, "0");
    const clip = `clip${pad}.mp4`;

    // Camera: face-lock follow-crop, else a slow center push.
    const traj = trajOf.get(i);
    const fc = traj ? buildFollowCrop(traj, srcW, srcH, `fl${pad}.cmds`, ZOOM) : null;

    let content: string;
    if (fc) {
      await writeFile(path.join(outDir, `fl${pad}.cmds`), fc.cmds);
      content = `[0:v]${fc.filter},scale=${SQ}:${SQ}:flags=lanczos,fps=${FPS},${grade}`;
    } else {
      // Center square + gentle push (z 1.0→1.07 over the clip).
      const frames = Math.max(2, Math.round(dur * FPS));
      const push =
        `zoompan=z='min(1.0+0.07*on/${frames},1.07)':d=1:` +
        `x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${SQ}x${SQ}:fps=${FPS}`;
      content =
        `[0:v]crop='min(iw\\,ih)':'min(iw\\,ih)',scale=${SQ}:${SQ}:flags=lanczos,fps=${FPS},${push},${grade}`;
    }

    // Entry transition; an epic onset also punches in unless the transition already moves.
    const tr = transitions[i];
    content += entryFilter(tr, SQ, FPS);
    if (epics[i] && !epics[i - 1] && !["zoom", "whip", "shake"].includes(tr)) content += entryFilter("zoom", SQ, FPS);
    const c = Math.round(chromas[i]);
    if (c > 0) content += `,rgbashift=rh=${c}:bh=${-c}`;
    if (flashes[i] && tr !== "flash") content += entryFilter("flash", SQ, FPS);
    content += exitFilter(transitions[i + 1], dur);
    content += `[sq]`;

    // Subtitle burned on the final canvas.
    let tail = `[fr]format=yuv420p[v]`;
    const cue = cues[i];
    if (cue?.words.length) {
      await writeFile(path.join(outDir, `sub${pad}.ass`), cueToAss(cue, W, H, subStyle, SQ));
      tail = `[fr]ass=sub${pad}.ass,format=yuv420p[v]`;
    }

    await run("ffmpeg", [
      "-y",
      "-ss", off.toFixed(3),
      "-i", srcAbs,
      "-t", dur.toFixed(3),
      "-an",
      "-filter_complex", `${content};${frameToCanvas("sq")};${tail}`,
      "-map", "[v]",
      "-r", String(FPS),
      "-c:v", "libx264", "-preset", R.preset, "-crf", String(R.crf),
      "-pix_fmt", "yuv420p",
      clip,
    ], { cwd: outDir, timeoutMs: 300_000 });
    if (cacheDir) await copyFile(path.join(outDir, clip), cached(i));
    slots[i] = clip;
    rendered++;
    if (rendered % 8 === 0 || rendered === todo.length) onProgress(`клип ${rendered}/${todo.length}…`);
  };

  // Cache hits are copied in; the rest renders across a bounded worker pool.
  for (let i = 0; i < nClips; i++) {
    if (todoSet.has(i)) continue;
    const clip = `clip${String(i).padStart(4, "0")}.mp4`;
    await copyFile(cached(i), path.join(outDir, clip));
    slots[i] = clip;
  }
  const POOL = Math.max(1, Math.min(4, os.cpus().length - 1));
  let nextIdx = 0;
  await Promise.all(
    Array.from({ length: POOL }, async () => {
      while (nextIdx < todo.length) {
        const i = todo[nextIdx++];
        await renderClip(i);
      }
    }),
  );
  const clips = slots.filter((c): c is string => c !== null);
  if (clips.length === 0) throw new Error("Не получилось нарезать ни одного клипа.");

  onProgress("Склеиваю и накладываю музыку…");
  await writeFile(path.join(outDir, "concat.txt"), clips.map((c) => `file '${c}'`).join("\n"));
  await run("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", "concat.txt", "-c", "copy", "body.mp4"], { cwd: outDir });

  const swell = swellExpr(epicRanges);
  await run("ffmpeg", [
    "-y",
    "-i", "body.mp4",
    "-i", musicAbs,
    "-map", "0:v", "-map", "1:a",
    ...(swell ? ["-af", swell] : []),
    "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
    "-shortest",
    finalName,
  ], { cwd: outDir });

  return { video: path.join(outDir, finalName), edl: resolved, rendered, reused: nClips - todo.length };
}
