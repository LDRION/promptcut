import { mkdir, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { run } from "../ffmpeg.js";

/**
 * Contact sheets — how Siberi SEES video. It takes one image per request, so we tile
 * the frames that matter (mid-shot stills, frame-by-frame strips around a cut, one
 * frame per clip of our own render) into a single labelled JPEG.
 */

export interface SheetCell {
  video: string;
  t: number;
  /** Burned into the cell's corner so the model can refer to it ("#12", "B+3"). */
  label?: string;
}

export interface SheetOptions {
  cols: number;
  cellW: number;
  cellH: number;
}

// drawtext needs a font FILE (no fontconfig on Windows builds); fall back to no labels.
const FONT_CANDIDATES = [
  "C:/Windows/Fonts/arialbd.ttf",
  "C:/Windows/Fonts/arial.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
];
const FONT = FONT_CANDIDATES.find((f) => existsSync(f));

function labelFilter(label: string | undefined, cellW: number): string {
  if (!label || !FONT) return "";
  const text = label.replace(/[^\p{L}\p{N} #.+\-/|]/gu, "").slice(0, 24);
  const size = Math.max(12, Math.round(cellW * 0.075));
  const font = FONT.replace(/:/g, "\\:");
  return (
    `,drawtext=fontfile='${font}':text='${text}':x=5:y=5:fontsize=${size}:` +
    `fontcolor=0xFFE066:box=1:boxcolor=0x000000B0:boxborderw=4`
  );
}

/** Grab one frame per cell, fit it into cellW×cellH, label it, tile → JPEG bytes. */
export async function buildSheet(cells: SheetCell[], outPath: string, opts: SheetOptions): Promise<Buffer> {
  if (!cells.length) throw new Error("buildSheet: нет кадров");
  const { cols, cellW, cellH } = opts;
  const tmp = `${outPath}.cells`;
  await mkdir(tmp, { recursive: true });
  const rows = Math.ceil(cells.length / cols);
  const total = rows * cols;

  const grab = async (k: number): Promise<void> => {
    const out = path.join(tmp, `c${String(k).padStart(3, "0")}.jpg`);
    const cell = cells[k];
    const fit =
      `scale=${cellW}:${cellH}:force_original_aspect_ratio=decrease,` +
      `pad=${cellW}:${cellH}:(ow-iw)/2:(oh-ih)/2:color=0x111111,setsar=1`;
    try {
      if (!cell?.video) throw new Error("filler");
      await run("ffmpeg", [
        "-nostdin", "-v", "error", "-y",
        "-ss", Math.max(0, cell.t).toFixed(3), "-i", cell.video,
        "-frames:v", "1", "-vf", fit + labelFilter(cell.label, cellW), "-pix_fmt", "yuvj420p", "-q:v", "3", out,
      ], { timeoutMs: 60_000 });
      if (!existsSync(out)) throw new Error("no frame");
    } catch {
      // Past the end of the video or a filler slot — keep the grid shape with a blank.
      await run("ffmpeg", [
        "-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", `color=c=0x111111:s=${cellW}x${cellH}`,
        "-frames:v", "1", "-pix_fmt", "yuvj420p", out,
      ]);
    }
  };

  let next = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < total) await grab(next++);
  }));

  await run("ffmpeg", [
    "-nostdin", "-v", "error", "-y",
    "-framerate", "1", "-i", path.join(tmp, "c%03d.jpg"),
    "-vf", `tile=${cols}x${rows}:padding=4:margin=4:color=0x000000`,
    "-frames:v", "1", "-pix_fmt", "yuvj420p", "-q:v", "3", outPath,
  ]);
  await rm(tmp, { recursive: true, force: true });
  return readFile(outPath);
}

/**
 * Frame-by-frame strips around cut points: row r = cut r, cells = native frames at the
 * given offsets (0 = first frame of the new shot). Lets Siberi SEE how a cut is made.
 */
export function stripCells(video: string, cuts: number[], fps: number, offsets: number[]): SheetCell[] {
  const cells: SheetCell[] = [];
  cuts.forEach((c, r) => {
    const row = String.fromCharCode(65 + r);
    for (const k of offsets) {
      // An input -ss lands on the first frame with pts ≥ t, so aim half a frame early.
      cells.push({ video, t: c + (k - 0.5) / fps, label: `${row}${k >= 0 ? "+" : ""}${k}` });
    }
  });
  return cells;
}
