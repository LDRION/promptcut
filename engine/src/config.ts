/** Output geometry + render quality for the montage.
 *
 * Two target formats: a 1:1 SQUARE (the cinematic "СериалMV" look, like the 322
 * reference) and a 9:16 VERTICAL short. The engine is parameterised by width/height
 * so both share one render path — the only difference is how the tracked square gets
 * placed on the final canvas (full-frame for square, letterboxed for vertical).
 */
export type Format = "square" | "vertical";

export interface FormatSpec {
  width: number;
  height: number;
  /** Side of the content square that the face-lock crop is scaled to. */
  square: number;
}

export const FORMATS: Record<Format, FormatSpec> = {
  square: { width: 1080, height: 1080, square: 1080 },
  vertical: { width: 1080, height: 1920, square: 1080 },
};

export function formatSpec(fmt: Format = "square"): FormatSpec {
  return FORMATS[fmt] ?? FORMATS.square;
}

export const render = {
  fps: 60, // 322 is 60 — smooth motion is half the "premium" feel
  crf: 18, // visually lossless-ish for x264
  preset: "medium",
} as const;

/** Cinematic dark grade matched to the 322 reference: desaturated, crushed blacks,
 *  cool shadows, gentle contrast + sharpen. The director may override per-edit. */
export const GRADES = {
  cinematic:
    "eq=contrast=1.14:saturation=0.82:gamma=0.94:brightness=-0.03," +
    "curves=all='0/0 0.25/0.18 0.75/0.82 1/1',unsharp=5:5:0.4",
  aura: "eq=contrast=1.12:saturation=1.4:gamma=0.97,unsharp=5:5:0.5",
} as const;

// Back-compat: existing imports of `config.width/height` default to the square canvas.
export const config = { width: FORMATS.square.width, height: FORMATS.square.height } as const;
