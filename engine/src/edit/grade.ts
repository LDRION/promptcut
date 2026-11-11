import { runCapture } from "../ffmpeg.js";

/**
 * Colour matching: measure the frames the edit will actually show and build a grade
 * that moves THEM toward the reference's look (brightness, contrast, saturation,
 * warmth). A fixed "reference grade" can't do that — the same eq that suits dark
 * series footage barely touches a bright stream, and over-cooks an already moody one.
 */

export interface LookStats {
  brightness: number; // mean luma 0..1
  saturation: number; // mean HSV saturation 0..1
  contrast: number; // luma std / 128
  warmth: number; // (mean R − mean B) / 255
}

const W = 64;
const H = 36;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Same statistics as understanding/style.py, over RGB24 pixels. */
export function statsOf(rgb: Uint8Array): LookStats | null {
  const n = Math.floor(rgb.length / 3);
  if (!n) return null;
  let sumL = 0;
  let sumL2 = 0;
  let sumS = 0;
  let sumR = 0;
  let sumB = 0;
  for (let p = 0; p < n; p++) {
    const r = rgb[p * 3];
    const g = rgb[p * 3 + 1];
    const b = rgb[p * 3 + 2];
    const l = 0.299 * r + 0.587 * g + 0.114 * b;
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    sumL += l;
    sumL2 += l * l;
    sumS += mx > 0 ? (mx - mn) / mx : 0;
    sumR += r;
    sumB += b;
  }
  const mean = sumL / n;
  return {
    brightness: mean / 255,
    saturation: sumS / n,
    contrast: Math.sqrt(Math.max(0, sumL2 / n - mean * mean)) / 128,
    warmth: (sumR - sumB) / n / 255,
  };
}

/** Look statistics of a video over the given timestamps (one tiny frame each). */
export async function measureLook(video: string, times: number[]): Promise<LookStats | null> {
  const frames: Uint8Array[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < times.length) {
      const t = times[next++];
      try {
        const raw = await runCapture("ffmpeg", [
          "-v", "error", "-ss", Math.max(0, t).toFixed(3), "-i", video, "-frames:v", "1",
          "-vf", `scale=${W}:${H}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
        ], { timeoutMs: 30_000 });
        if (raw.length >= W * H * 3) frames.push(raw.subarray(0, W * H * 3));
      } catch {
        // unreadable frame — skip it
      }
    }
  }));
  if (!frames.length) return null;
  const all = new Uint8Array(frames.length * W * H * 3);
  frames.forEach((f, k) => all.set(f, k * W * H * 3));
  return statsOf(all);
}

/**
 * eq (+ colorbalance) chain that moves `src` toward `ref`. Clamped so it styles the
 * footage without wrecking it: darkening goes mostly through gamma (keeps blacks),
 * saturation and contrast are ratios, warmth nudges red/blue midtones.
 */
export function matchGrade(ref: LookStats, src: LookStats, sharpen = true): string {
  const dB = ref.brightness - src.brightness;
  const gamma = clamp(1 + dB * 1.2, 0.72, 1.15);
  const brightness = clamp(dB * 0.25, -0.08, 0.04);
  // Contrast relative to brightness: a dark reference has a small absolute spread but
  // deep shadows against its highlights — matching raw spread would flatten the image.
  const rel = (s: LookStats) => s.contrast / Math.max(0.05, s.brightness);
  const contrast = clamp(rel(ref) / rel(src), 0.9, 1.3);
  const saturation = clamp(ref.saturation / Math.max(0.05, src.saturation), 0.6, 1.8);
  const parts = [
    `eq=contrast=${contrast.toFixed(2)}:saturation=${saturation.toFixed(2)}:` +
      `gamma=${gamma.toFixed(2)}:brightness=${brightness.toFixed(2)}`,
  ];
  const dW = ref.warmth - src.warmth;
  if (Math.abs(dW) >= 0.02) {
    const m = clamp(dW * 1.2, -0.25, 0.25);
    parts.push(`colorbalance=rm=${m.toFixed(2)}:bm=${(-m).toFixed(2)}`);
  }
  if (sharpen) parts.push("unsharp=5:5:0.4");
  return parts.join(",");
}
