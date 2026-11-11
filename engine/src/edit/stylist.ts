import { createHash } from "node:crypto";
import { open, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { probeDuration } from "../ffmpeg.js";
import type { MeasuredStyle } from "../understand.js";
import type { StyleProfile } from "./edl.js";
import { askJson, loadPrompt, siberiEnabled } from "./llm.js";
import { buildSheet, stripCells, type SheetCell } from "./sheets.js";
import { DEFAULT_SUB_STYLE, normalizeSubStyle, SUB_ANIMATIONS, SUB_FONTS, SUB_POSITIONS } from "./subtitles.js";
import { isTransition, normalizeMix, TRANSITION_DOC, TRANSITIONS, type TransitionMix, type TransitionType } from "./transitions.js";

/**
 * The STYLIST: Siberi looks at the reference edit and writes down its look in the
 * engine's own terms — subtitle style (font, size, tracking, colours, glow, position,
 * animation) from a sheet of mid-shot stills, and the transition vocabulary from
 * frame-by-frame strips around its cuts. Merged with style.py's measurements
 * (pacing, flash/dip rates, grade) into one StyleProfile.
 */

type Log = (m: string) => void;

const STRIP_OFFSETS = [-2, -1, 0, 1, 2, 3, 5, 7];
const STRIP_ROWS = 5;

const LOOK_SCHEMA = `{
  "vibe": "одна строка: жанр, настроение, темп эдита",
  "hasSubtitles": true | false,
  "subtitle": {
    "font": "одно имя из списка шрифтов",
    "sizePct": число (высота шрифта в % от высоты кадра),
    "bold": true | false,
    "italic": true | false,
    "uppercase": true | false,
    "spacing": число em (0 обычная, 0.15 заметная, 0.3+ широкая разрядка),
    "color": "#RRGGBB основной текст",
    "accentColor": "#RRGGBB выделенных слов или пустая строка",
    "outline": число 0–6 (толщина обводки, px при 1080p),
    "shadow": число 0–4,
    "glow": true | false,
    "position": "${SUB_POSITIONS.join(" | ")}",
    "animation": "${SUB_ANIMATIONS.join(" | ")}",
    "maxWords": число слов в одной надписи (1–8),
    "twoLines": true | false
  },
  "notes": "2–3 предложения: что делает стиль узнаваемым"
}`;

const TRANSITION_SCHEMA = `{
  "rows": { "A": "тип", "B": "тип", … },
  "mix": { "cut": доля, "flash": доля, … },
  "notes": "одна строка о манере склеек"
}`;

function fontsList(): string {
  return Object.entries(SUB_FONTS).map(([name, desc]) => `- ${name} — ${desc}`).join("\n");
}

function transitionsList(): string {
  return TRANSITIONS.map((t) => `- ${t} — ${TRANSITION_DOC[t]}`).join("\n");
}

/** Mid-shot stills spread across the reference — where subtitles sit fully drawn. */
export function lookCells(video: string, dur: number, cutTimes: number[], n = 12): SheetCell[] {
  const bounds = [0, ...cutTimes.filter((t) => t > 0 && t < dur), dur];
  const shots: [number, number][] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    if (bounds[i + 1] - bounds[i] >= 0.35) shots.push([bounds[i], bounds[i + 1]]);
  }
  const picks: number[] = [];
  if (shots.length >= n) {
    for (let k = 0; k < n; k++) {
      const [a, b] = shots[Math.floor(((k + 0.5) * shots.length) / n)];
      picks.push(a + (b - a) * 0.6);
    }
  } else {
    for (let k = 0; k < n; k++) picks.push(dur * (0.04 + (0.92 * (k + 0.5)) / n));
  }
  return picks.map((t, k) => ({ video, t, label: `${k + 1}` }));
}

/** Cuts to show frame-by-frame: spread across the edit, away from the very edges. */
function pickStripCuts(cutTimes: number[], dur: number): number[] {
  const usable = cutTimes.filter((t) => t > 0.4 && t < dur - 0.4);
  if (!usable.length) return [];
  const n = Math.min(STRIP_ROWS, usable.length);
  return Array.from({ length: n }, (_, k) => usable[Math.floor(((k + 0.5) * usable.length) / n)]);
}

function measuredText(m: MeasuredStyle | null): string {
  if (!m) return "Замеров нет.";
  const s = m.stats ?? {};
  return [
    `Склеек: ${m.cuts} за ${Math.round(m.durationSec)}с, средний шот ${m.avgShotLen}с (${m.cutDensity}).`,
    `Измерено на склейках: вспышки ${Math.round(m.flashRate * 100)}%, провалы в чёрное ${Math.round((m.dipRate ?? 0) * 100)}%.`,
    `Картинка: яркость ${s.brightness ?? "?"}, насыщенность ${s.saturation ?? "?"}, контраст ${s.contrast ?? "?"}, теплота ${s.warmth ?? "?"}.`,
  ].join("\n");
}

/** Blend Siberi's per-cut reading with the measured flash/dip rates into one mix. */
function blendMix(rows: TransitionType[], llmMix: TransitionMix | undefined, m: MeasuredStyle | null): TransitionMix | undefined {
  const acc: Record<string, number> = {};
  const add = (mix: TransitionMix | undefined, w: number) => {
    for (const [k, v] of Object.entries(mix ?? {})) acc[k] = (acc[k] ?? 0) + (v ?? 0) * w;
  };
  if (rows.length) {
    const counted: TransitionMix = {};
    for (const r of rows) counted[r] = (counted[r] ?? 0) + 1 / rows.length;
    add(counted, 0.5);
  }
  add(llmMix, rows.length ? 0.5 : 1);
  if (m) {
    acc.flash = Math.max(acc.flash ?? 0, m.flashRate);
    acc.dip = Math.max(acc.dip ?? 0, m.dipRate ?? 0);
  }
  return normalizeMix(acc);
}

async function fileKey(file: string): Promise<string> {
  const st = await stat(file);
  const fh = await open(file, "r");
  try {
    const buf = Buffer.alloc(Math.min(2 * 1024 * 1024, st.size));
    await fh.read(buf, 0, buf.length, 0);
    return createHash("sha1").update(buf).update(`${st.size}|v2`).digest("hex").slice(0, 16);
  } finally {
    await fh.close();
  }
}

export interface ReadStyleOptions {
  reference: string;
  measured: MeasuredStyle | null;
  /** Where the sheets are written (and shown in the UI). */
  workDir: string;
  /** Profiles are cached by reference content — re-running on the same ref is instant. */
  cacheDir?: string;
}

/** Reference video → full StyleProfile (measured + read by Siberi). Never throws. */
export async function readStyle(opts: ReadStyleOptions, log: Log): Promise<StyleProfile> {
  const { reference, measured: m, workDir, cacheDir } = opts;
  const base: StyleProfile = {
    flashRate: m?.flashRate,
    chroma: m?.chroma,
    grade: m?.grade,
    cutDensity: m?.cutDensity,
    avgShotLen: m?.avgShotLen,
    transitions: blendMix([], undefined, m),
    look: m?.stats?.brightness !== undefined ? {
      brightness: m.stats.brightness,
      saturation: m.stats.saturation ?? 0.3,
      contrast: m.stats.contrast ?? 0.45,
      warmth: m.stats.warmth ?? 0,
    } : undefined,
  };
  if (!siberiEnabled()) {
    log("⚠ SIBERI_API_KEY не задан — стиль беру только из замеров, без чтения глазами");
    return base;
  }

  let cacheFile = "";
  if (cacheDir) {
    try {
      cacheFile = path.join(cacheDir, `${await fileKey(reference)}.json`);
      const hit = JSON.parse(await readFile(cacheFile, "utf8")) as StyleProfile;
      log("🎨 Стиль референса уже читал — беру из кэша");
      return hit;
    } catch {
      // no cache yet
    }
  }

  await mkdir(workDir, { recursive: true });
  const dur = m?.durationSec || (await probeDuration(reference));
  const fps = m?.fps || 30;
  const cutTimes = m?.cutTimes ?? [];

  log("🎨 Siberi смотрит референс: субтитры, цвет, переходы…");
  const lookSheet = buildSheet(lookCells(reference, dur, cutTimes), path.join(workDir, "ref-look.jpg"),
                               { cols: 4, cellW: 300, cellH: 300 });
  const stripCuts = pickStripCuts(cutTimes, dur);
  const stripSheet = stripCuts.length
    ? buildSheet(stripCells(reference, stripCuts, fps, STRIP_OFFSETS), path.join(workDir, "ref-cuts.jpg"),
                 { cols: STRIP_OFFSETS.length, cellW: 150, cellH: 150 })
    : Promise.resolve(null);

  const lookAsk = lookSheet.then((image) => askJson(
    loadPrompt("stylist-look.md", "Опиши стиль субтитров и вайб референсного эдита по раскадровке."),
    [
      `ЗАМЕРЫ референса:\n${measuredText(m)}`,
      `ШРИФТЫ (выбирай только из этого списка):\n${fontsList()}`,
      `Схема ответа:\n${LOOK_SCHEMA}`,
    ].join("\n\n"),
    log, { image, label: "стилист·субтитры" },
  ));
  const cutsAsk = stripSheet.then((image) => image && askJson(
    loadPrompt("stylist-transitions.md", "Определи тип перехода в каждой строке."),
    [
      `ЗАМЕРЫ референса:\n${measuredText(m)}`,
      `Строк на картинке: ${stripCuts.length} (${stripCuts.map((_, r) => String.fromCharCode(65 + r)).join(", ")}).`,
      `ТИПЫ ПЕРЕХОДОВ:\n${transitionsList()}`,
      `Схема ответа:\n${TRANSITION_SCHEMA}`,
    ].join("\n\n"),
    log, { image, label: "стилист·переходы" },
  ));

  const [look, cuts] = await Promise.allSettled([lookAsk, cutsAsk]);
  const profile: StyleProfile = { ...base };

  if (look.status === "fulfilled" && look.value) {
    const v = look.value;
    profile.subtitle = normalizeSubStyle(v.subtitle, DEFAULT_SUB_STYLE);
    profile.vibe = typeof v.vibe === "string" ? v.vibe.slice(0, 200) : undefined;
    profile.notes = typeof v.notes === "string" ? v.notes.slice(0, 600) : undefined;
    const s = profile.subtitle;
    log(`   субтитры: ${s.font}${s.bold ? " bold" : ""}, ${s.sizePct}% кадра, разрядка ${s.spacing}em, ` +
        `${s.color}${s.accentColor ? ` + акцент ${s.accentColor}` : ""}${s.glow ? ", свечение" : ""}, ` +
        `${s.position}, анимация ${s.animation}`);
    if (profile.vibe) log(`   вайб: ${profile.vibe}`);
  } else {
    log(`⚠ стилист не прочитал субтитры (${look.status === "rejected" ? String(look.reason).slice(0, 140) : "пусто"})`);
  }

  if (cuts.status === "fulfilled" && cuts.value) {
    const rowsRaw = (cuts.value.rows ?? {}) as Record<string, unknown>;
    const rows = Object.values(rowsRaw).map((v) => String(v).toLowerCase()).filter(isTransition);
    profile.transitions = blendMix(rows, normalizeMix(cuts.value.mix), m) ?? profile.transitions;
    if (typeof cuts.value.notes === "string") profile.notes = [profile.notes, cuts.value.notes].filter(Boolean).join(" ");
    log(`   переходы по склейкам: ${rows.join(", ") || "—"}`);
  } else if (stripCuts.length) {
    log(`⚠ стилист не прочитал переходы (${cuts.status === "rejected" ? String(cuts.reason).slice(0, 140) : "пусто"})`);
  }
  if (profile.transitions) {
    const mix = Object.entries(profile.transitions)
      .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
      .map(([k, v]) => `${k} ${Math.round((v ?? 0) * 100)}%`).join(" · ");
    log(`   микс переходов: ${mix}`);
  }

  if (cacheFile && profile.subtitle && m) {
    await mkdir(path.dirname(cacheFile), { recursive: true });
    await writeFile(cacheFile, JSON.stringify(profile, null, 2));
  }
  return profile;
}
