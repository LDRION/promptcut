import { runCapture } from "../ffmpeg.js";
import { spawn } from "node:child_process";
import type { Edl } from "./edl.js";

/**
 * Deterministic QA — the cheap checks that don't need eyes. Before the render: a clip
 * must be ONE shot (a source scene-cut inside a 0.8s clip reads as a glitchy double
 * cut), not a repeat of another clip, not a dark/empty frame. After the render: black
 * and frozen stretches in the output. Scene-cut straddles are fixed on the spot by
 * sliding the clip onto one side of the cut; the rest is handed to the critic loop.
 */

export type QaKind = "scene-cut" | "repeat" | "dark" | "black" | "freeze";

export interface QaIssue {
  i: number;
  kind: QaKind;
  detail: string;
  /** True when preflight already fixed it. */
  fixed?: boolean;
}

type Log = (m: string) => void;

const W = 64;
const H = 36;
const SCAN_FPS = 30;
const EDGE = 0.06; // a cut this close to the clip's edge is invisible

/** Frame indices where a new shot starts (same detector as understanding/style.py). */
export function detectCuts(frames: Float32Array[], fps: number): number[] {
  const n = frames.length;
  if (n < 3) return [];
  const px = frames[0].length;
  const diff: number[] = [];
  const hdiff: number[] = [];
  const hist = (f: Float32Array) => {
    const h = new Float32Array(16);
    for (let p = 0; p < px; p++) h[Math.min(15, f[p] >> 4)]++;
    for (let k = 0; k < 16; k++) h[k] /= px;
    return h;
  };
  let prevH = hist(frames[0]);
  for (let i = 1; i < n; i++) {
    let s = 0;
    for (let p = 0; p < px; p++) s += Math.abs(frames[i][p] - frames[i - 1][p]);
    diff.push(s / px);
    const h = hist(frames[i]);
    let hd = 0;
    for (let k = 0; k < 16; k++) hd += Math.abs(h[k] - prevH[k]);
    hdiff.push(hd);
    prevH = h;
  }
  const win = Math.max(3, Math.round(fps * 0.4));
  const minGap = Math.max(2, Math.round(fps * 0.12));
  const cuts: number[] = [];
  for (let i = 0; i < diff.length; i++) {
    const local = [...diff.slice(Math.max(0, i - win), i), ...diff.slice(i + 1, i + win + 1)].sort((a, b) => a - b);
    const base = local.length ? local[Math.floor(local.length / 2)] : 0;
    const strong = diff[i] > Math.max(9, base * 3) && hdiff[i] > 0.18;
    const veryStrong = diff[i] > Math.max(28, base * 5);
    if (!strong && !veryStrong) continue;
    if (diff[i] < (diff[i - 1] ?? 0) || diff[i] < (diff[i + 1] ?? 0)) continue;
    const frame = i + 1;
    if (cuts.length && frame - cuts[cuts.length - 1] < minGap) continue;
    cuts.push(frame);
  }
  return cuts;
}

interface WindowScan {
  cuts: number[]; // absolute source seconds
  luma: (a: number, b: number) => number; // mean luma 0..255 over [a, b] (absolute)
}

async function scanWindow(src: string, from: number, len: number): Promise<WindowScan> {
  const raw = await runCapture("ffmpeg", [
    "-v", "error", "-ss", from.toFixed(3), "-i", src, "-t", len.toFixed(3),
    "-vf", `fps=${SCAN_FPS},scale=${W}:${H},format=gray`, "-f", "rawvideo", "-pix_fmt", "gray", "-",
  ], { timeoutMs: 60_000 });
  const size = W * H;
  const frames: Float32Array[] = [];
  for (let o = 0; o + size <= raw.length; o += size) frames.push(Float32Array.from(raw.subarray(o, o + size)));
  const means = frames.map((f) => f.reduce((a, b) => a + b, 0) / size);
  return {
    cuts: detectCuts(frames, SCAN_FPS).map((k) => from + k / SCAN_FPS),
    luma: (a, b) => {
      const i0 = Math.max(0, Math.floor((a - from) * SCAN_FPS));
      const i1 = Math.min(means.length, Math.ceil((b - from) * SCAN_FPS));
      const part = means.slice(i0, Math.max(i0 + 1, i1));
      return part.length ? part.reduce((x, y) => x + y, 0) / part.length : 128;
    },
  };
}

/**
 * Slide a clip [off, off+dur] so no source cut falls inside it. Tries the side of the
 * cut that keeps more of the intended moment first. Null = no clean placement nearby.
 */
export function placeClear(off: number, dur: number, cuts: number[], srcDur: number): number | null {
  const inside = (o: number) => cuts.filter((c) => c > o + EDGE && c < o + dur - EDGE);
  const hit = inside(off);
  if (!hit.length) return off;
  const c = hit[0];
  const last = hit[hit.length - 1];
  const after = last + 0.04; // start right after the (last) cut
  const before = c - dur - 0.04; // end right before the (first) cut
  const tries = c - off > dur / 2 ? [before, after] : [after, before];
  for (const o of tries) {
    if (o >= 0 && o + dur <= srcDur && !inside(o).length) return Math.round(o * 1000) / 1000;
  }
  return null;
}

const overlap = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

/**
 * Pre-render checks on a director EDL. `durs[i]` is cut i's length. Mutates nothing —
 * returns the fixed EDL and every issue found (fixed ones marked).
 */
export async function preflight(edl: Edl, durs: number[], srcDur: number, log: Log): Promise<{ edl: Edl; issues: QaIssue[] }> {
  const clips = edl.clips.map((c) => ({ ...c }));
  const issues: QaIssue[] = [];
  const n = Math.min(clips.length, durs.length);

  let next = 0;
  const work = async () => {
    while (next < n) {
      const i = next++;
      const dur = durs[i];
      const off = Math.min(Math.max(0, clips[i].srcOffset), Math.max(0, srcDur - dur));
      const from = Math.max(0, off - dur - 0.3);
      const len = Math.min(srcDur - from, dur * 3 + 0.6);
      let scan: WindowScan;
      try {
        scan = await scanWindow(edl.source, from, len);
      } catch {
        continue; // unreadable window — let the critic judge the frame
      }
      const placed = placeClear(off, dur, scan.cuts, srcDur);
      if (placed === null) {
        issues.push({ i, kind: "scene-cut", detail: `внутри склейки смена сцены исходника (${off.toFixed(2)}s)` });
      } else if (placed !== off) {
        issues.push({ i, kind: "scene-cut", detail: `сдвинул ${off.toFixed(2)}→${placed.toFixed(2)}s: была смена сцены внутри`, fixed: true });
        clips[i].srcOffset = placed;
        delete clips[i].sub;
      }
      const at = clips[i].srcOffset;
      const luma = scan.luma(at, at + dur);
      if (luma < 16) issues.push({ i, kind: "dark", detail: `почти чёрный кадр (яркость ${Math.round(luma)})` });
    }
  };
  await Promise.all(Array.from({ length: 4 }, work));

  for (let i = 0; i < n; i++) {
    const a0 = clips[i].srcOffset;
    const a1 = a0 + durs[i];
    for (let j = 0; j < i; j++) {
      const b0 = clips[j].srcOffset;
      const shared = overlap(a0, a1, b0, b0 + durs[j]);
      if (shared > 0.5 * Math.min(durs[i], durs[j])) {
        issues.push({ i, kind: "repeat", detail: `повторяет момент склейки #${j} (${b0.toFixed(1)}s)` });
        break;
      }
    }
  }

  const fixed = issues.filter((x) => x.fixed).length;
  const open = issues.length - fixed;
  log(`🧪 Предпроверка: ${fixed} склеек выровнял по сменам сцен${open ? ` · ${open} замечаний передаю критику` : ""}`);
  return { edl: { ...edl, clips }, issues: issues.sort((a, b) => a.i - b.i) };
}

function stderrOf(args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const p = spawn("ffmpeg", args);
    let err = "";
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("error", () => resolve(""));
    p.on("close", () => resolve(err));
  });
}

/** Black and frozen stretches in the rendered edit, mapped to the clips they fall in. */
export async function inspectRender(video: string, edl: Edl): Promise<QaIssue[]> {
  const err = await stderrOf([
    "-v", "info", "-i", video, "-an",
    "-vf", "blackdetect=d=0.12:pix_th=0.06,freezedetect=n=-50dB:d=0.6",
    "-f", "null", "-",
  ]);
  const clipAt = (t: number) => {
    const k = edl.clips.findIndex((c) => (c.start ?? 0) <= t && t < (c.start ?? 0) + (c.dur ?? 0));
    return k === -1 ? edl.clips.length - 1 : k;
  };
  const issues: QaIssue[] = [];
  for (const m of err.matchAll(/black_start:([\d.]+)\s+black_end:([\d.]+)/g)) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    issues.push({ i: clipAt((a + b) / 2), kind: "black", detail: `чёрный кадр ${a.toFixed(2)}–${b.toFixed(2)}s` });
  }
  for (const m of err.matchAll(/freeze_start:\s*([\d.]+)/g)) {
    const a = Number(m[1]);
    issues.push({ i: clipAt(a + 0.1), kind: "freeze", detail: `картинка замерла с ${a.toFixed(2)}s` });
  }
  return issues;
}
