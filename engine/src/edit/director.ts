import type { CameraStyle, Edl, EdlClip, StyleProfile } from "./edl.js";
import type { Plan } from "./montage.js";
import { askJson, loadSystemPrompt } from "./llm.js";
import { normalizeSubStyle } from "./subtitles.js";
import { isTransition, TRANSITION_DOC, TRANSITIONS, type TransitionMix } from "./transitions.js";

/**
 * The DIRECTOR: the LLM reads the user's prompt + what's in the footage (digest or
 * motion hotspots) + the beat-driven cut grid + the reference's style, and authors the
 * EDL — which moment lands on which cut, how the cut is made, which word to accent.
 * The engine just renders. Runs through the Siberi AI gateway (llm.ts).
 */

const CAMERAS: CameraStyle[] = ["auto", "face", "whip", "push"];

export interface FootageInfo {
  srcDur: number;
  /** Timestamped timeline from understanding/ — transcript, scene cuts, audio sections. */
  digestText?: string;
  /** Motion-scored candidate moments; the fallback when there is no digest. */
  motionHotspots?: { t: number; score: number }[];
  /** Source times worth cutting to (spoken lines) — fallback pool for replacements. */
  candidates?: number[];
}

export interface DirectOptions {
  prompt: string;
  plan: Plan;
  footage: FootageInfo;
  style?: StyleProfile | null;
  source: string;
  music: string;
  maxDuration?: number;
}

// Фолбэк, если engine/prompts/system-prompt.md отсутствует.
const DEFAULT_SYSTEM = `Ты — РЕЖИССЁР promptcut: собираешь кинематографичный эдит под бит музыки.
На каждую склейку выбери момент исходника по смыслу промпта, переход и камеру.
Самое сильное — на chorus/дроп, на verse пусть дышит спокойный материал.`;

const CLIP_SCHEMA_DOC = `{
  "vibe": "одна строка — драматургическая арка эдита",
  "clips": [
    {
      "srcOffset": число секунд в исходнике,
      "camera": "auto" | "face" | "whip" | "push",
      "transition": "${TRANSITIONS.join(" | ")}",
      "epic": true | false,
      "accent": "одно слово ДОСЛОВНО из реплики, звучащей в этом моменте (или пусто)",
      "note": "короткая причина выбора"
    }
  ]
}`;

function planTable(plan: Plan): string {
  const rows = plan.cuts.map(
    (c) => `#${c.i}  start=${c.start}s  dur=${c.dur}s  ${c.band} (${c.section})`,
  );
  return `Tempo ${plan.tempo} BPM · ${plan.nClips} склеек · музыка ${plan.musicDur.toFixed(1)}s\n${rows.join("\n")}`;
}

function footageBlock(f: FootageInfo): string {
  const parts = [`Длительность исходника: ${f.srcDur.toFixed(1)}s`];
  if (f.digestText) parts.push(`ДАЙДЖЕСТ исходника:\n${f.digestText}`);
  else if (f.motionHotspots?.length) {
    const spots = f.motionHotspots
      .map((h) => `${h.t.toFixed(1)}s (движение ${h.score.toFixed(1)})`)
      .join(", ");
    parts.push(`Дайджеста нет. ГОРЯЧИЕ ТОЧКИ движения (самые живые таймкоды):\n${spots}`);
  } else {
    parts.push("Ни дайджеста, ни горячих точек — распредели выборы разумно по всему исходнику.");
  }
  return parts.join("\n\n");
}

function mixText(mix: TransitionMix | undefined): string {
  if (!mix) return "нет данных";
  return Object.entries(mix)
    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
    .map(([k, v]) => `${k} ${Math.round((v ?? 0) * 100)}%`)
    .join(", ");
}

function transitionsDoc(): string {
  return `ПЕРЕХОДЫ (движок умеет):\n${TRANSITIONS.map((t) => `- ${t} — ${TRANSITION_DOC[t]}`).join("\n")}`;
}

/** The reference's style in words the director can act on (not a raw JSON dump). */
export function styleBlock(style: StyleProfile | null | undefined): string {
  const lines = [transitionsDoc()];
  if (!style) {
    lines.push("Референса нет — переходы по вкусу: в основном чистые склейки, акценты на громких местах.");
    return lines.join("\n\n");
  }
  const ref: string[] = [];
  if (style.vibe) ref.push(`Вайб: ${style.vibe}`);
  if (style.avgShotLen) ref.push(`Средний шот референса: ${style.avgShotLen}s (${style.cutDensity ?? "?"})`);
  ref.push(`Микс переходов референса: ${mixText(style.transitions)} — повторяй ЭТО распределение, а не свой вкус.`);
  if (style.subtitle) {
    const s = style.subtitle;
    ref.push(`Субтитры: ${s.font}, ${s.animation}${s.accentColor ? `, одно ключевое слово в реплике выделяется цветом ${s.accentColor}` : ""}.`);
  }
  if (style.notes) ref.push(`Заметки стилиста: ${style.notes}`);
  lines.push(`СТИЛЬ РЕФЕРЕНСА:\n${ref.join("\n")}`);
  return lines.join("\n\n");
}

/** Compress understanding/'s digest.json into a timeline the director can read fast. */
export function digestToPrompt(digest: any, maxChars = 20_000): string {
  const lines: string[] = [];
  if (digest.title) lines.push(`Title: ${digest.title} (${Math.round(digest.duration ?? 0)}s)`);

  const sections = digest.audio?.sections ?? [];
  if (sections.length) {
    lines.push("Audio sections:");
    for (const s of sections.slice(0, 40)) {
      const tempo = s.tempo ? ` ~${Math.round(s.tempo)}bpm` : "";
      lines.push(`  [${Math.round(s.start)}-${Math.round(s.end)}s] ${s.kind}/${s.energy}${tempo}`);
    }
  }

  const cuts: number[] = digest.scene_cuts ?? [];
  if (cuts.length) {
    const shown = cuts.length > 150 ? cuts.filter((_, i) => i % Math.ceil(cuts.length / 150) === 0) : cuts;
    lines.push(`Scene cuts (s): ${shown.map((t) => Math.round(t * 10) / 10).join(", ")}`);
  }

  let transcript: { start: number; text: string }[] = digest.transcript ?? [];
  if (transcript.length) {
    lines.push("Transcript:");
    let body = transcript.map((s) => `  [${Math.round(s.start * 10) / 10}s] ${s.text}`);
    // Evenly thin the transcript if the whole digest would blow the budget.
    const budget = maxChars - lines.join("\n").length;
    while (body.join("\n").length > budget && body.length > 40) {
      body = body.filter((_, i) => i % 2 === 0);
    }
    lines.push(...body);
  }
  return lines.join("\n").slice(0, maxChars);
}

interface RawClip {
  srcOffset: number;
  camera: string;
  transition?: string;
  epic?: boolean;
  flash?: boolean;
  chroma?: number;
  accent?: string | string[];
  note: string;
}

function accentList(v: unknown): string[] | undefined {
  const list = (Array.isArray(v) ? v : [v])
    .map((w) => String(w ?? "").trim())
    .filter((w) => w && w.length <= 40);
  return list.length ? list.slice(0, 2) : undefined;
}

/**
 * Epic is the climax, not the whole chorus: keep at most `max` flagged cuts — the
 * loudest contiguous run of them — so the flash/chroma/swell still means something.
 */
export function limitEpics(clips: EdlClip[], sections: number[], max: number): number {
  const flagged = clips.map((c, i) => (c.epic ? i : -1)).filter((i) => i >= 0);
  if (flagged.length <= max) return 0;
  let bestStart = 0;
  let best = -1;
  for (let s = 0; s + max <= flagged.length; s++) {
    const sum = flagged.slice(s, s + max).reduce((a, i) => a + (sections[i] ?? 0), 0);
    if (sum > best) { best = sum; bestStart = s; }
  }
  const keep = new Set(flagged.slice(bestStart, bestStart + max));
  let dropped = 0;
  clips.forEach((c, i) => { if (c.epic && !keep.has(i)) { c.epic = false; dropped++; } });
  return dropped;
}

export function sanitizeClips(raw: RawClip[], nClips: number, srcDur: number, cutDurs: number[]): EdlClip[] {
  const clips: EdlClip[] = [];
  for (let i = 0; i < nClips; i++) {
    const c = raw[i % Math.max(1, raw.length)] ?? { srcOffset: 0, camera: "auto", note: "" };
    const dur = cutDurs[i] ?? 0.5;
    const maxOff = Math.max(0, srcDur - dur);
    const tr = String(c.transition ?? "").toLowerCase();
    clips.push({
      srcOffset: Math.min(Math.max(0, Number(c.srcOffset) || 0), maxOff),
      camera: CAMERAS.includes(c.camera as CameraStyle) ? (c.camera as CameraStyle) : "auto",
      transition: isTransition(tr) ? tr : undefined,
      epic: Boolean(c.epic),
      flash: c.flash === undefined ? undefined : Boolean(c.flash),
      chroma: c.chroma === undefined ? undefined : Math.min(8, Math.max(0, Math.round(Number(c.chroma) || 0))),
      accent: accentList(c.accent),
      note: String(c.note ?? "").slice(0, 200),
    });
  }
  return clips;
}

/** Prompt + plan + footage + style → a full EDL, or null if the director failed. */
export async function directCuts(
  opts: DirectOptions,
  log: (m: string) => void,
): Promise<Edl | null> {
  const { prompt, plan, footage, style } = opts;

  const user = [
    `ПРОМПТ ПОЛЬЗОВАТЕЛЯ:\n${prompt}`,
    `СЕТКА СКЛЕЕК:\n${planTable(plan)}`,
    footageBlock(footage),
    styleBlock(style),
    `Схема ответа:\n${CLIP_SCHEMA_DOC}`,
    `В "clips" должно быть РОВНО ${plan.nClips} элементов — по одному на склейку, в порядке склеек.`,
  ].join("\n\n");

  try {
    const data = await askJson(loadSystemPrompt(DEFAULT_SYSTEM), user, log, { label: "режиссёр" });
    const cutDurs = plan.cuts.map((c) => c.dur);
    const got = Array.isArray(data.clips) ? data.clips.length : 0;
    const clips = sanitizeClips(data.clips ?? [], plan.nClips, footage.srcDur, cutDurs);
    log(`🎬 Режиссёр: «${data.vibe ?? ""}» · ${got}/${plan.nClips} клипов`);
    const maxEpic = Math.max(2, Math.round(plan.nClips * 0.2));
    const dropped = limitEpics(clips, plan.cuts.map((c) => c.section), maxEpic);
    if (dropped) log(`   эпик: оставил ${maxEpic} самых громких склеек (снял с ${dropped})`);
    return {
      source: opts.source,
      music: opts.music,
      maxDuration: opts.maxDuration,
      grade: style?.grade,
      subtitle: style?.subtitle,
      cutSteps: plan.cutSteps,
      clips,
    };
  } catch (e) {
    log(`⚠ режиссёр не справился (${e instanceof Error ? e.message.slice(0, 160) : e})`);
    return null;
  }
}

/** A clip the critic rejected, and why. */
export interface ReplaceRequest {
  i: number;
  reason: string;
}

/**
 * Pick NEW source moments for the clips the critic rejected — the director sees the
 * footage digest, what's already used, and the reason each clip failed. Only the listed
 * clips change. Returns i → new srcOffset (+ note), or null if the director failed.
 */
export async function directReplace(
  edl: Edl,
  requests: ReplaceRequest[],
  footage: FootageInfo,
  prompt: string,
  log: (m: string) => void,
): Promise<Map<number, { srcOffset: number; note?: string }> | null> {
  if (!requests.length) return new Map();
  const used = edl.clips
    .map((c, i) => `#${i} ${(c.srcOffset ?? 0).toFixed(1)}–${((c.srcOffset ?? 0) + (c.dur ?? 0)).toFixed(1)}s ${c.note ?? ""}`.trim())
    .join("\n");
  const asks = requests
    .map((r) => `#${r.i} (dur=${edl.clips[r.i]?.dur ?? "?"}s, сейчас ${edl.clips[r.i]?.srcOffset ?? "?"}s): ${r.reason}`)
    .join("\n");

  const user = [
    `ПРОМПТ ЭДИТА:\n${prompt || "эдит в стиле референса"}`,
    `Критик забраковал эти склейки — подбери для каждой ДРУГОЙ момент исходника:\n${asks}`,
    `Уже использованы (не повторяй эти промежутки):\n${used}`,
    footageBlock(footage),
    `Схема ответа:\n{ "clips": [ { "i": номер склейки, "srcOffset": секунда исходника, "note": "почему этот момент" } ] }`,
  ].join("\n\n");

  try {
    const data = await askJson(loadSystemPrompt(DEFAULT_SYSTEM), user, log, { label: "режиссёр·замены" });
    const out = new Map<number, { srcOffset: number; note?: string }>();
    const wanted = new Set(requests.map((r) => r.i));
    for (const c of Array.isArray(data.clips) ? data.clips : []) {
      const i = Number(c?.i);
      const off = Number(c?.srcOffset);
      if (!wanted.has(i) || !Number.isFinite(off)) continue;
      const dur = edl.clips[i]?.dur ?? 0.5;
      out.set(i, {
        srcOffset: Math.min(Math.max(0, off), Math.max(0, footage.srcDur - dur)),
        note: c.note ? String(c.note).slice(0, 200) : undefined,
      });
    }
    return out;
  } catch (e) {
    log(`⚠ режиссёр не подобрал замены (${e instanceof Error ? e.message.slice(0, 160) : e})`);
    return null;
  }
}

/** Free-form instruction + the finished edit's EDL → a modified EDL, or null. */
export async function directRefine(
  edl: Edl,
  instruction: string,
  log: (m: string) => void,
  footage?: FootageInfo,
): Promise<{ edl: Edl; actions: string[] } | null> {
  const srcDur = edl.srcDur ?? 0;
  // The words are re-derived from the transcript at render time — don't bloat the prompt.
  const compact = { ...edl, clips: edl.clips.map(({ sub: _sub, ...c }) => c) };

  const user = [
    `Пользователь посмотрел готовый эдит и просит правку:\n${instruction}`,
    `Текущий EDL (srcOffset — секунда исходника; start/dur — место на таймлайне эдита):\n${JSON.stringify(compact, null, 1)}`,
    footage ? footageBlock(footage) : "",
    `Схема ответа:\n{\n  "summary": "что поменял, на языке пользователя",\n  "grade": "ffmpeg eq-фильтр или пустая строка = оставить текущий",\n  "subtitle": { …только поля стиля субтитров, которые меняешь, или {} },\n  "clips": [ …как в схеме клипов… ]\n}`,
    `Верни ПОЛНЫЙ массив clips той же длины (${edl.clips.length}): нетронутые правкой клипы копируй как есть.`,
    `Схема клипа:\n${CLIP_SCHEMA_DOC}`,
    transitionsDoc(),
  ].filter(Boolean).join("\n\n");

  try {
    const data = await askJson(loadSystemPrompt(DEFAULT_SYSTEM), user, log, { label: "режиссёр·правка" });
    const cutDurs = edl.clips.map((c) => c.dur ?? 0.5);
    const clips = sanitizeClips(data.clips ?? [], edl.clips.length, srcDur, cutDurs);
    // Keep the timeline metadata from the original clips — only the picks change. A clip
    // that moved in the source loses its stored words so they're re-derived.
    const merged = edl.clips.map((orig, i) => {
      const next: EdlClip = { ...orig, ...clips[i] };
      if (Math.abs((orig.srcOffset ?? 0) - clips[i].srcOffset) > 0.01) delete next.sub;
      if (!clips[i].transition) next.transition = orig.transition;
      return next;
    });
    const next: Edl = { ...edl, clips: merged };
    if (typeof data.grade === "string" && data.grade.trim()) next.grade = data.grade.trim();
    if (data.subtitle && typeof data.subtitle === "object" && Object.keys(data.subtitle).length && edl.subtitle) {
      next.subtitle = normalizeSubStyle(data.subtitle, edl.subtitle);
    }
    return { edl: next, actions: [String(data.summary ?? "готово")] };
  } catch (e) {
    log(`⚠ режиссёр не справился (${e instanceof Error ? e.message.slice(0, 160) : e})`);
    return null;
  }
}
