import { runCapture } from "../ffmpeg.js";

/**
 * Score a ~1s window by CONTINUOUS motion, penalising hard cuts. A source scene-cut
 * shows up as one frame pair changing far more than the others — those windows are
 * rejected so we don't pick moments that already contain the source's own cuts.
 */
async function motionScore(video: string, offset: number): Promise<number> {
  try {
    const raw = await runCapture("ffmpeg", [
      "-v", "error",
      "-ss", offset.toFixed(2),
      "-i", video,
      "-vf", "fps=8,scale=64:36,format=gray",
      "-frames:v", "8",
      "-f", "rawvideo",
      "-pix_fmt", "gray",
      "-",
    ]);
    const frameSize = 64 * 36;
    const n = Math.floor(raw.length / frameSize);
    if (n < 2) return 0;

    const diffs: number[] = [];
    for (let t = 1; t < n; t++) {
      const a = t * frameSize;
      const b = (t - 1) * frameSize;
      let s = 0;
      for (let p = 0; p < frameSize; p++) s += Math.abs(raw[a + p] - raw[b + p]);
      diffs.push(s / frameSize);
    }

    const sorted = [...diffs].sort((x, y) => x - y);
    const median = sorted[Math.floor(sorted.length / 2)] || 0;
    const peak = Math.max(...diffs);
    // A big spike over the median = a scene cut inside this window → penalise hard.
    if (median > 0 && peak / median > 3.5) return median * 0.15;
    return median;
  } catch {
    return 0;
  }
}

export interface Moment {
  t: number;
  score: number;
}

/**
 * Probe candidate offsets spread across the recording and score each ~1s window by
 * continuous motion. The raw material for both the auto-picker and the director's
 * hotspot fallback. Returned in chronological order.
 */
export async function scanMoments(
  video: string,
  srcDur: number,
  candCount: number,
  onProgress?: (msg: string) => void,
): Promise<Moment[]> {
  const lo = Math.min(5, srcDur * 0.02);
  const hi = Math.max(lo + 1, srcDur - 3);

  const scored: Moment[] = [];
  for (let i = 0; i < candCount; i++) {
    const t = lo + ((hi - lo) * i) / (candCount - 1);
    scored.push({ t, score: await motionScore(video, t) });
    if (onProgress && (i % 30 === 0 || i === candCount - 1)) {
      onProgress(`сканирую моменты ${i + 1}/${candCount}…`);
    }
  }
  return scored;
}

/**
 * Return the `count` liveliest (high-motion) offsets — i.e. actual action, not
 * static menus / lobbies / scoreboards. Returned in chronological order.
 */
export async function pickLivelyOffsets(
  video: string,
  count: number,
  srcDur: number,
  onProgress?: (msg: string) => void,
): Promise<number[]> {
  const lo = Math.min(5, srcDur * 0.02);
  const hi = Math.max(lo + 1, srcDur - 3);
  const candCount = Math.min(160, Math.max(count * 3, 24));

  const scored = await scanMoments(video, srcDur, candCount, onProgress);
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, count).map((s) => s.t).sort((a, b) => a - b);

  // Fallback to an even spread if probing found nothing usable.
  if (top.length < count) {
    const out: number[] = [];
    for (let i = 0; i < count; i++) out.push(lo + ((hi - lo) * i) / Math.max(1, count - 1));
    return out;
  }
  return top;
}
