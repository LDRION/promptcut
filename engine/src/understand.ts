import path from "node:path";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/**
 * Bridges to the Python side (understanding/): URL download via yt-dlp, the numeric
 * style measurement of a reference, and the footage digest the director reads.
 * Every helper degrades to null instead of throwing — a missing signal never kills a render.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
export const UND_DIR = path.join(ROOT, "..", "understanding");
const UND_PY = path.join(UND_DIR, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");

type Log = (m: string) => void;

/** Fetch a URL (YouTube…) into `dir` with the understanding venv's yt-dlp. */
export function downloadUrl(url: string, dir: string, prefix: string, kind: "video" | "audio",
                            log: Log): Promise<string> {
  return new Promise((resolve, reject) => {
    const tmpl = path.join(dir, `${prefix}.%(ext)s`);
    const args = ["-m", "yt_dlp", "--no-playlist", "-o", tmpl, url];
    if (kind === "audio") args.push("-x", "--audio-format", "mp3");
    else args.push("-f", "bestvideo[height<=720]+bestaudio/best[height<=720]/best",
                   "--merge-output-format", "mp4");
    log(`⬇ качаю по ссылке (${kind}): ${url}`);
    const p = spawn(UND_PY, args);
    let err = "";
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("error", (e) => reject(new Error(`yt-dlp не запустился: ${e.message}`)));
    p.on("close", async (code) => {
      if (code !== 0) return reject(new Error(`yt-dlp код ${code}: ${err.slice(-300)}`));
      const got = (await readdir(dir)).filter((f) => f.startsWith(`${prefix}.`) && !f.endsWith(".part"));
      if (!got.length) return reject(new Error("скачанный файл не найден"));
      resolve(path.join(dir, got[0]));
    });
  });
}

/** What understanding/style.py measures on a reference. */
export interface MeasuredStyle {
  durationSec: number;
  fps: number;
  cuts: number;
  cutTimes: number[];
  avgShotLen: number;
  cutDensity: string;
  flashRate: number;
  dipRate: number;
  chroma: number;
  grade: string;
  stats: { brightness?: number; saturation?: number; contrast?: number; warmth?: number };
}

/** Numeric style measurement of a reference video (pacing, flashes, grade). */
export function measureStyle(video: string, outJson: string, log: Log): Promise<MeasuredStyle | null> {
  if (!existsSync(UND_PY)) {
    log("⚠ understanding/.venv не найден — замер стиля пропускаю");
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    log("📏 Замеряю референс (склейки, вспышки, грейд)…");
    const p = spawn(UND_PY, ["style.py", path.resolve(video), path.resolve(outJson)], { cwd: UND_DIR });
    let err = "";
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("error", () => { log("⚠ замер стиля не запустился"); resolve(null); });
    p.on("close", async (code) => {
      if (code !== 0) {
        log(`⚠ замер стиля дал ошибку (${err.slice(-160)})`);
        resolve(null);
        return;
      }
      try {
        const prof = JSON.parse(await readFile(path.resolve(outJson), "utf8")) as MeasuredStyle;
        log(`   ${prof.cuts} склеек · шот ~${prof.avgShotLen}s (${prof.cutDensity}) · ` +
            `вспышки ${Math.round(prof.flashRate * 100)}% · провалы ${Math.round((prof.dipRate ?? 0) * 100)}%`);
        resolve(prof);
      } catch {
        resolve(null);
      }
    });
  });
}

function digestPath(video: string): string {
  // watch.py's slug for a local file: sanitized stem, up to 40 chars.
  const slug = path.parse(video).name.replace(/[^\w.-]+/g, "_").slice(0, 40) || "video";
  return path.join(UND_DIR, "out", slug, "digest.json");
}

/** An already-built digest for this video (newer than the file), or null. No recompute. */
export async function readDigest(video: string): Promise<any | null> {
  const file = digestPath(video);
  try {
    const [d, v] = await Promise.all([stat(file), stat(video)]);
    if (d.mtimeMs < v.mtimeMs) return null;
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Footage digest via understanding/watch.py — transcript (word-level), scene cuts,
 * audio sections — so the director picks moments by MEANING, not just motion.
 * Reuses a digest already built for the same file.
 */
export async function runDigest(video: string, log: Log): Promise<any | null> {
  const ready = await readDigest(video);
  if (ready) {
    log("✅ Дайджест исходника уже есть — беру готовый");
    return ready;
  }
  if (!existsSync(UND_PY)) {
    log("⚠ understanding/.venv не найден — дайджест пропускаю, режиссёр пойдёт по движению");
    return Promise.resolve(null);
  }
  const whisper = process.env.PROMPTCUT_WHISPER ?? "small";
  return new Promise<any | null>((resolve) => {
    log(`👀 Смотрю исходник (understanding, whisper=${whisper})…`);
    const p = spawn(UND_PY, ["watch.py", path.resolve(video), "--whisper-model", whisper], { cwd: UND_DIR });
    const timer = setTimeout(() => { try { p.kill(); } catch {} }, 30 * 60_000);
    p.stderr.on("data", (d) => {
      for (const line of d.toString().split(/\r?\n/)) {
        const t = line.trim();
        if (t && !/\d+%\|/.test(t)) log(`   ${t.slice(0, 160)}`);
      }
    });
    p.on("error", () => { clearTimeout(timer); resolve(null); });
    p.on("close", async (code) => {
      clearTimeout(timer);
      if (code !== 0) { log(`⚠ дайджест не получился (код ${code})`); resolve(null); return; }
      try {
        const digest = JSON.parse(await readFile(digestPath(video), "utf8"));
        log("✅ Дайджест готов — режиссёр видит, что в кадре");
        resolve(digest);
      } catch (e) {
        log(`⚠ digest.json не прочитался (${e instanceof Error ? e.message : e})`);
        resolve(null);
      }
    });
  });
}
