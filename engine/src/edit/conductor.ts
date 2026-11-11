import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { probeDuration } from "../ffmpeg.js";
import { measureStyle, runDigest } from "../understand.js";
import type { Format } from "../config.js";
import type { Edl, StyleProfile } from "./edl.js";
import { digestToPrompt, directCuts, directReplace, type FootageInfo, type ReplaceRequest } from "./director.js";
import { reviewEdit, type Verdict } from "./critic.js";
import { siberiEnabled } from "./llm.js";
import { makeEdit, planEdit, type EditResult, type Plan } from "./montage.js";
import { scanMoments } from "./moments.js";
import { inspectRender, preflight, type QaIssue } from "./qa.js";
import { tweakGrade } from "./refine.js";
import { lookCells, readStyle } from "./stylist.js";
import { matchGrade, measureLook } from "./grade.js";
import { normalizeSubStyle, type TranscriptSeg } from "./subtitles.js";
import type { SheetCell } from "./sheets.js";

/**
 * The CONDUCTOR: Siberi runs the whole production, not just one step.
 *
 *   reference ─► STYLIST reads its look (subtitles, transitions, pacing, grade)
 *   footage   ─► digest (speech, scenes) ─► DIRECTOR authors the EDL on the beat grid
 *   EDL       ─► preflight (one shot per clip, no repeats) ─► render
 *   render    ─► CRITIC reviews the frames ─► fixes ─► re-render (only changed clips)
 *
 * …until the critic is satisfied or the rounds run out; the best-scored render wins.
 * Every Siberi step degrades gracefully: no key / no answer → the engine's own
 * deterministic path still produces an edit.
 */

type Log = (m: string) => void;

const DEFAULT_PROMPT =
  "Собери эдит в стиле референса: самые эмоциональные и сильные моменты, " +
  "реплики с чувством на куплетах, кульминация — на дропе.";

export interface ConductOptions {
  source: string;
  music: string;
  reference?: string | null;
  prompt?: string;
  maxDuration?: number;
  format?: Format;
  /** This job's folder: rounds, sheets, reports, the final edit.mp4 + edit.json. */
  outDir: string;
  /** Shared across jobs: clip cache + style cache. */
  cacheRoot: string;
  /** Let Siberi review the render and fix it. Default on when a key is configured. */
  review?: boolean;
  /** Fix-and-re-render rounds after the first render. */
  maxRounds?: number;
  /** Stop as soon as the critic scores at least this. */
  targetScore?: number;
}

export interface RoundReport {
  round: number;
  video: string;
  score?: number;
  summary?: string;
  issues: string[];
  /** What was changed for the NEXT round because of this review. */
  fixes: string[];
  rendered: number;
  reused: number;
}

export type ConductEvent =
  | { type: "style"; style: StyleProfile; sheets: string[] }
  | { type: "round"; report: RoundReport };

export interface ConductResult {
  video: string;
  edl: Edl;
  style: StyleProfile | null;
  rounds: RoundReport[];
  best: number;
}

const LEGIBILITY = new Set(["sizePct", "position", "outline", "shadow", "glow"]);

/** True when [off, off+dur] overlaps any used window by more than a third of the clip. */
function clashes(off: number, dur: number, used: [number, number][]): boolean {
  return used.some(([a, b]) => Math.min(off + dur, b) - Math.max(off, a) > dur / 3);
}

/** A source moment no clip uses yet: speech first, then motion hotspots, then an even sweep. */
function freshMoment(dur: number, used: [number, number][], f: FootageInfo, srcDur: number): number | null {
  const sweep = Array.from({ length: 64 }, (_, k) => ((k + 0.5) * srcDur) / 64);
  for (const t of [...(f.candidates ?? []), ...(f.motionHotspots ?? []).map((h) => h.t), ...sweep]) {
    const off = Math.min(Math.max(0, t), Math.max(0, srcDur - dur));
    if (!clashes(off, dur, used)) return Math.round(off * 1000) / 1000;
  }
  return null;
}

/** What a render depends on — equal signatures mean a re-render would change nothing. */
function signature(e: Edl): string {
  return JSON.stringify([e.grade, e.subtitle, e.clips.map((c) => [c.srcOffset, c.camera, c.transition, c.epic])]);
}

/**
 * Which moments to replace this round. Findings the deterministic QA can prove (black,
 * repeat, dark, unfixable scene cut) go first; the critic's own picks fill the rest.
 * Capped at a quarter of the edit: the critic reads stills and sometimes misreads a
 * whole sheet — a full re-pick on that basis churns the edit instead of fixing it.
 */
export function limitReplacements(critic: ReplaceRequest[], qa: QaIssue[], n: number): ReplaceRequest[] {
  const out: ReplaceRequest[] = [];
  for (const q of qa) {
    if (q.fixed || !["black", "repeat", "dark", "scene-cut"].includes(q.kind)) continue;
    if (!out.some((r) => r.i === q.i)) out.push({ i: q.i, reason: q.detail });
  }
  for (const r of critic) if (!out.some((x) => x.i === r.i)) out.push(r);
  return out.slice(0, Math.max(2, Math.ceil(n * 0.25)));
}

/** Turn a critic verdict into the next round's EDL. Returns what changed, in words. */
async function applyVerdict(
  edl: Edl,
  v: Verdict,
  qa: QaIssue[],
  ctx: { footage: FootageInfo; prompt: string; srcDur: number; log: Log; lockLook: boolean },
): Promise<{ edl: Edl; fixes: string[] }> {
  const next: Edl = { ...edl, clips: edl.clips.map((c) => ({ ...c })) };
  const fixes: string[] = [];

  for (const [i, p] of v.patches) {
    const c = next.clips[i];
    if (!c) continue;
    const bits: string[] = [];
    if (p.camera && p.camera !== c.camera) { c.camera = p.camera; bits.push(`камера ${p.camera}`); }
    if (p.transition && p.transition !== c.transition) { c.transition = p.transition; bits.push(`переход ${p.transition}`); }
    if (typeof p.epic === "boolean" && p.epic !== Boolean(c.epic)) {
      c.epic = p.epic;
      if (!p.epic) c.flash = undefined;
      bits.push(p.epic ? "в кульминацию" : "без эпика");
    }
    if (bits.length) fixes.push(`#${i}: ${bits.join(", ")}`);
  }

  // Unfixable deterministic findings (black output, repeats, dark frames) join the
  // critic's own replace list — they are objectively wrong, whatever the score.
  const replace = limitReplacements(v.replace, qa, next.clips.length);
  if (replace.length < v.replace.length) {
    ctx.log(`   критик просит заменить ${v.replace.length} моментов — меняю ${replace.length} за раунд`);
  }
  if (replace.length) {
    const picks = await directReplace(next, replace, ctx.footage, ctx.prompt, ctx.log);
    const used = next.clips.map((c): [number, number] => [c.srcOffset, c.srcOffset + (c.dur ?? 0.5)]);
    let auto = 0;
    for (const { i } of replace) {
      const c = next.clips[i];
      if (!c) continue;
      const dur = c.dur ?? 0.5;
      // A "replacement" that lands on an already-used moment (the director re-picking
      // the same hotspot) is no replacement — take a fresh candidate instead.
      let pick = picks?.get(i);
      if (!pick || clashes(pick.srcOffset, dur, used)) {
        const fresh = freshMoment(dur, used, ctx.footage, ctx.srcDur);
        pick = fresh === null ? undefined : { srcOffset: fresh, note: "автозамена: свежий момент исходника" };
        if (pick) auto++;
      }
      if (!pick) continue;
      c.srcOffset = pick.srcOffset;
      if (pick.note) c.note = pick.note;
      delete c.sub; // new moment → its words are re-derived from the transcript
      delete c.accent;
      used[i] = [pick.srcOffset, pick.srcOffset + dur];
      fixes.push(`#${i}: новый момент ${pick.srcOffset.toFixed(1)}s (${dur.toFixed(2)}s)`);
    }
    if (auto) ctx.log(`   ${auto} замен режиссёр повторил — подобрал свежие моменты сам`);
  }

  // With a reference, the font and colours ARE the style being copied — the critic may
  // only fix legibility (size, position, outline, shadow, glow), not repaint the text.
  const subFix = v.subtitle && ctx.lockLook
    ? Object.fromEntries(Object.entries(v.subtitle).filter(([k]) => LEGIBILITY.has(k)))
    : v.subtitle;
  if (subFix && Object.keys(subFix).length && next.subtitle) {
    next.subtitle = normalizeSubStyle(subFix, next.subtitle);
    fixes.push(`субтитры: ${Object.entries(subFix).map(([k, val]) => `${k}=${val}`).join(", ")}`);
  }
  if (v.grade && next.grade) {
    next.grade = tweakGrade(next.grade, v.grade);
    fixes.push(`цвет: ${Object.entries(v.grade).filter(([, val]) => val !== undefined).map(([k, val]) => `${k} ${val! > 0 ? "+" : ""}${val}`).join(", ")}`);
  }
  return { edl: next, fixes };
}

export async function conduct(
  opts: ConductOptions,
  log: Log,
  onEvent: (e: ConductEvent) => void = () => {},
): Promise<ConductResult> {
  const { source, music, reference, maxDuration, format = "square", outDir, cacheRoot } = opts;
  await mkdir(outDir, { recursive: true });
  const ai = siberiEnabled();
  const review = (opts.review ?? true) && ai;
  const maxRounds = Math.max(0, Math.min(4, opts.maxRounds ?? 2));
  const target = opts.targetScore ?? 8.5;
  const clipCache = path.join(cacheRoot, "clips");
  if (!ai) log("⚠ SIBERI_API_KEY не задан — Siberi не участвует, собираю на автомате");

  // 1. The reference: measured + read by Siberi's eyes.
  let style: StyleProfile | null = null;
  let refCells: SheetCell[] | undefined;
  if (reference) {
    const measured = await measureStyle(reference, path.join(outDir, "ref-measured.json"), log);
    style = await readStyle({ reference, measured, workDir: outDir, cacheDir: path.join(cacheRoot, "style") }, log);
    await writeFile(path.join(outDir, "style.json"), JSON.stringify(style, null, 2));
    onEvent({ type: "style", style, sheets: ["ref-look.jpg", "ref-cuts.jpg"] });
    if (measured) refCells = lookCells(reference, measured.durationSec, measured.cutTimes, 4);
  }

  // 2. The footage, in words the director can read.
  const srcDur = await probeDuration(source);
  const prompt = opts.prompt?.trim() || (ai ? DEFAULT_PROMPT : "");
  let transcript: TranscriptSeg[] | undefined;
  let transcriptPath: string | undefined;
  const footage: FootageInfo = { srcDur };
  if (prompt) {
    const digest = await runDigest(source, log);
    if (digest) {
      footage.digestText = digestToPrompt(digest);
      transcript = digest.transcript;
      // Spoken lines are the best stand-ins when a moment has to be replaced.
      footage.candidates = (transcript ?? []).map((s) => s.start + 0.05);
      transcriptPath = path.join(outDir, "transcript.json");
      await writeFile(transcriptPath, JSON.stringify(transcript ?? []));
    } else {
      log("🔎 Сканирую движение — горячие точки для режиссёра…");
      const moments = await scanMoments(path.resolve(source), srcDur, 64, log);
      footage.motionHotspots = moments
        .filter((m) => m.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 32)
        .sort((a, b) => a.t - b.t);
    }
  }

  // 3. Beat grid (pacing copied from the reference) → the director's EDL.
  const plan: Plan = await planEdit(music, maxDuration, style?.avgShotLen);
  const bands = plan.cuts.map((c) => c.band);
  let edl: Edl | undefined;
  let qa: QaIssue[] = [];
  if (prompt && ai) {
    log(`🎬 Промпт режиссёру: «${prompt}»`);
    edl = (await directCuts({
      prompt, plan, footage, style,
      source: path.resolve(source), music: path.resolve(music), maxDuration,
    }, log)) ?? undefined;
    if (edl) {
      edl.format = format;
      ({ edl, issues: qa } = await preflight(edl, plan.cuts.map((c) => c.dur), srcDur, log));
    } else {
      log("⚠ Режиссёр не ответил — собираю в авторежиме");
    }
  }

  // Colour: move the moments we'll actually show toward the reference's look.
  if (style?.look) {
    const picks = edl
      ? edl.clips.map((c, i) => c.srcOffset + (plan.cuts[i]?.dur ?? 0.5) / 2)
      : Array.from({ length: 24 }, (_, k) => ((k + 0.5) * srcDur) / 24);
    const step = Math.max(1, Math.ceil(picks.length / 30));
    const srcLook = await measureLook(source, picks.filter((_, k) => k % step === 0));
    if (srcLook) {
      const graded = matchGrade(style.look, srcLook);
      style = { ...style, grade: graded };
      if (edl) edl.grade = graded;
      const pct = (v: number) => Math.round(v * 100);
      log(`🎨 Цвет под референс: яркость ${pct(srcLook.brightness)}→${pct(style.look!.brightness)}%, ` +
          `насыщенность ${pct(srcLook.saturation)}→${pct(style.look!.saturation)}%, ` +
          `контраст ${pct(srcLook.contrast)}→${pct(style.look!.contrast)}%`);
    }
  }

  // 4. Render → review → fix → re-render.
  const rounds: RoundReport[] = [];
  const renders: EditResult[] = [];
  let best = 0;
  for (let r = 0; r <= maxRounds; r++) {
    log(r === 0 ? "🎞 Рендерю эдит…" : `🔁 Раунд ${r}: перерендериваю с правками критика…`);
    const res = await makeEdit({
      music, source, outDir: path.join(outDir, `r${r}`), onProgress: log, maxDuration,
      edl, style: style ?? undefined, format, transcript, transcriptPath, cacheDir: clipCache,
    });
    renders.push(res);
    const report: RoundReport = { round: r, video: res.video, issues: [], fixes: [], rendered: res.rendered, reused: res.reused };
    rounds.push(report);

    if (!review) { onEvent({ type: "round", report }); break; }

    const outQa = await inspectRender(res.video, res.edl);
    const roundQa = [...qa.filter((q) => !q.fixed), ...outQa];
    const verdict = await reviewEdit({
      video: res.video, edl: res.edl, bands, style, refCells, prompt, qa: roundQa, workDir: outDir, round: r,
    }, log);
    if (!verdict) { onEvent({ type: "round", report }); break; }

    report.score = verdict.score;
    report.summary = verdict.summary;
    report.issues = verdict.issues;
    log(`🔍 Критик: ${verdict.score}/10 — ${verdict.summary}`);
    for (const x of verdict.issues.slice(0, 8)) log(`   · ${x}`);
    // Ties go to the later round — it carries the critic's fixes.
    if (r === 0 || verdict.score >= (rounds[best].score ?? -1)) best = r;

    if (verdict.score >= target) { log("✨ Критик доволен — финал"); onEvent({ type: "round", report }); break; }
    if (r === maxRounds) { onEvent({ type: "round", report }); break; }

    if (r > 0 && verdict.score < (rounds[r - 1].score ?? 0) - 0.5) {
      log("   правки сделали хуже — останавливаюсь на лучшем раунде");
      onEvent({ type: "round", report });
      break;
    }

    const { edl: fixed, fixes } = await applyVerdict(res.edl, verdict, roundQa, { footage, prompt, srcDur, log, lockLook: Boolean(style?.subtitle) });
    report.fixes = fixes;
    onEvent({ type: "round", report });
    if (!fixes.length || signature(fixed) === signature(res.edl)) { log("   правок, меняющих картинку, нет — оставляю как есть"); break; }
    for (const f of fixes.slice(0, 12)) log(`   🔧 ${f}`);

    // Replaced moments must still be one clean shot.
    const moved = fixed.clips.map((c, i) => (c.srcOffset !== res.edl.clips[i]?.srcOffset ? i : -1)).filter((i) => i >= 0);
    if (moved.length) {
      const sub: Edl = { ...fixed, clips: moved.map((i) => fixed.clips[i]) };
      const check = await preflight(sub, moved.map((i) => fixed.clips[i].dur ?? 0.5), srcDur, () => {});
      moved.forEach((i, k) => { fixed.clips[i].srcOffset = check.edl.clips[k].srcOffset; });
      qa = check.issues.map((q) => ({ ...q, i: moved[q.i] }));
    } else {
      qa = [];
    }
    edl = fixed;
  }

  // 5. The best render becomes THE edit (edit.mp4 + edit.json at the job root).
  const win = renders[best];
  const video = path.join(outDir, "edit.mp4");
  await copyFile(win.video, video);
  await writeFile(path.join(outDir, "edit.json"), JSON.stringify(win.edl, null, 2));
  await writeFile(path.join(outDir, "report.json"), JSON.stringify({ best, rounds, style }, null, 2));
  if (rounds.length > 1 || rounds[best].score !== undefined) {
    log(`🏁 Итог: раунд ${best}${rounds[best].score !== undefined ? ` · оценка ${rounds[best].score}/10` : ""}`);
  }
  return { video, edl: win.edl, style, rounds, best };
}
