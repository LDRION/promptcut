import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, "..", "..", "python", "face_track.py");
// Prefer the project's understanding venv (mediapipe installed there); else system python.
const VENV_PY = path.join(__dirname, "..", "..", "..", "understanding", ".venv",
  process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const PYTHON = existsSync(VENV_PY) ? VENV_PY : "python";

export interface Segment {
  off: number;
  dur: number;
}

/** [t_rel, cx, cy, faceWidth?] — normalised to the source frame; nulls = no face. */
type TrajPoint = [number, number | null, number | null, (number | null)?];

// Face-lock framing: the crop is ~this many face-widths wide (head + shoulders)…
const FACE_SPAN = 4.2;
// …but never smaller than this many source px (upscaling a tinier crop turns to mush).
const MIN_CROP = 220;

export interface ClipTraj {
  found: boolean;
  det: number;
  traj: TrajPoint[];
}

export interface TrackResult {
  w: number;
  h: number;
  srcFps: number;
  clips: ClipTraj[];
  /** Why tracking produced nothing (tracker crashed, bad output) — for the log. */
  error?: string;
}

/**
 * Dense face trajectory per segment via MediaPipe (python/face_track.py). Falls back
 * to all-not-found if python/mediapipe is unavailable, so the render still happens
 * (camera degrades to motion-following). Runs in understanding's venv when present
 * (`pip install mediapipe opencv-python-headless` there), else the system `python`.
 */
export function trackFaces(
  video: string,
  segments: Segment[],
  sampleFps = 15,
): Promise<TrackResult> {
  const notFound = (error?: string): TrackResult => ({
    w: 0, h: 0, srcFps: 0,
    clips: segments.map(() => ({ found: false, det: 0, traj: [] })),
    error,
  });

  return new Promise((resolve) => {
    let py;
    try {
      py = spawn(PYTHON, [SCRIPT]);
    } catch (e) {
      resolve(notFound(`python не запустился: ${e instanceof Error ? e.message : e}`));
      return;
    }
    let out = "";
    let err = "";
    let settled = false;
    const finish = (v: TrackResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => {
      try { py.kill("SIGKILL"); } catch {}
      finish(notFound("трекер завис и был остановлен"));
    }, 600_000);

    // MediaPipe/TFLite chatter goes to stderr too — keep only the tail for diagnostics.
    const lastError = () =>
      err.split(/\r?\n/).filter((l) => /Error|Traceback|failed/i.test(l)).slice(-2).join(" · ").trim().slice(0, 240);
    py.stdout.on("data", (d) => (out += d.toString()));
    py.stderr.on("data", (d) => (err = (err + d.toString()).slice(-8000)));
    py.on("error", (e) => finish(notFound(`python не запустился: ${e.message}`)));
    py.on("close", () => {
      try {
        const parsed = JSON.parse(out) as TrackResult;
        finish(parsed?.clips?.length === segments.length ? parsed : notFound("трекер вернул не то число клипов"));
      } catch {
        finish(notFound(lastError() || "трекер ничего не вернул"));
      }
    });

    py.stdin.write(JSON.stringify({ video, sampleFps, segments }));
    py.stdin.end();
  });
}

/** Linear-fill nulls (hold at the ends), then zero-phase EMA to kill jitter. */
function smooth(vals: (number | null)[], alpha = 0.45): number[] {
  const n = vals.length;
  const known = [...vals.keys()].filter((k) => vals[k] != null);
  if (known.length === 0) return new Array(n).fill(0.5);
  const out = vals.map((v, k) => {
    if (v != null) return v;
    const lo = known.filter((j) => j < k).pop();
    const hi = known.find((j) => j > k);
    if (lo == null) return vals[hi!]!;
    if (hi == null) return vals[lo]!;
    const f = (k - lo) / (hi - lo);
    return vals[lo]! * (1 - f) + vals[hi]! * f;
  });
  for (let k = 1; k < n; k++) out[k] = alpha * out[k] + (1 - alpha) * out[k - 1];
  for (let k = n - 2; k >= 0; k--) out[k] = alpha * out[k] + (1 - alpha) * out[k + 1];
  return out;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export interface FollowCrop {
  /** ffmpeg filter fragment: a face-following crop of side `sq`, expects `[0:v]` in. */
  filter: string;
  /** sendcmd script contents to write next to the render (referenced by basename). */
  cmds: string;
  sq: number;
}

/**
 * Turn a clip's face trajectory into a face-following square crop, driven by an
 * ffmpeg `sendcmd` script (the crop x/y is nudged every ~1/30s to the smoothed head
 * position). The crop is sized to the FACE (head-and-shoulders), so a small face — a
 * streamer's facecam in a corner — gets a real close-up; `zoom` caps how wide a crop
 * a big face gets. The head is biased into the upper third. Returns null if the
 * trajectory is unusable (caller falls back to a motion camera).
 */
export function buildFollowCrop(
  clip: ClipTraj,
  srcW: number,
  srcH: number,
  cmdsBasename: string,
  zoom = 1.3,
): FollowCrop | null {
  if (!clip.found || clip.traj.length < 2 || !srcW || !srcH) return null;

  const ts = clip.traj.map((p) => p[0]);
  const cx = smooth(clip.traj.map((p) => p[1]));
  const cy = smooth(clip.traj.map((p) => p[2]));

  const side = Math.min(srcW, srcH);
  const sizes = clip.traj.map((p) => p[3]).filter((v): v is number => typeof v === "number" && v > 0).sort((a, b) => a - b);
  const faceW = sizes.length ? sizes[Math.floor(sizes.length / 2)] * srcW : 0;
  let sq = Math.round(side / zoom);
  if (faceW > 0) sq = Math.min(sq, Math.max(MIN_CROP, Math.round(faceW * FACE_SPAN)));
  sq -= sq % 2;
  sq = Math.max(2, Math.min(sq, side));

  // Upsample to ~30 keyframes/sec so the crop glides rather than steps.
  const lines: string[] = [];
  const at = (i: number) => {
    const px = clamp(Math.round(cx[i] * srcW - sq / 2), 0, srcW - sq);
    const py = clamp(Math.round(cy[i] * srcH - sq * 0.45), 0, srcH - sq);
    return { px, py };
  };
  const push = (t: number, px: number, py: number) =>
    lines.push(`${t.toFixed(3)} crop x ${px};`, `${t.toFixed(3)} crop y ${py};`);

  for (let i = 0; i < ts.length - 1; i++) {
    const a = at(i);
    const b = at(i + 1);
    const steps = Math.max(1, Math.round((ts[i + 1] - ts[i]) * 30));
    for (let s = 0; s < steps; s++) {
      const f = s / steps;
      push(ts[i] + (ts[i + 1] - ts[i]) * f,
           Math.round(a.px + (b.px - a.px) * f),
           Math.round(a.py + (b.py - a.py) * f));
    }
  }
  const last = at(ts.length - 1);
  push(ts[ts.length - 1], last.px, last.py);

  const first = at(0);
  return {
    sq,
    cmds: lines.join("\n") + "\n",
    filter: `sendcmd=f=${cmdsBasename},crop=${sq}:${sq}:${first.px}:${first.py}`,
  };
}
