import path from "node:path";
import type { CameraStyle, Edl, EdlClip, StyleProfile } from "./edl.js";
import type { ReplaceRequest } from "./director.js";
import { askJson, loadPrompt } from "./llm.js";
import type { QaIssue } from "./qa.js";
import { buildSheet, type SheetCell } from "./sheets.js";
import { SUB_FONTS, SUB_POSITIONS, type SubtitleStyle } from "./subtitles.js";
import { isTransition, TRANSITIONS } from "./transitions.js";

/**
 * The CRITIC: Siberi reviews our own render the way an editor would — one frame per
 * clip on a labelled sheet (with the reference's frames in the first row), plus the
 * edit's clip table and the deterministic QA findings. It returns a score and fixes
 * expressed in the engine's vocabulary, so the conductor can apply them and re-render.
 */

type Log = (m: string) => void;

const MAX_CELLS = 24;
const CAMERAS: CameraStyle[] = ["auto", "face", "whip", "push"];

export interface GradeDelta {
  brightness?: number;
  contrast?: number;
  saturation?: number;
}

export interface Verdict {
  score: number;
  summary: string;
  issues: string[];
  replace: ReplaceRequest[];
  patches: Map<number, Partial<EdlClip>>;
  subtitle?: Partial<SubtitleStyle>;
  grade?: GradeDelta;
  /** Clips that were on the sheet (the critic can only judge those). */
  shown: number[];
}

export interface ReviewInput {
  video: string;
  edl: Edl;
  bands?: string[];
  style?: StyleProfile | null;
  /** 3–4 reference stills for side-by-side comparison. */
  refCells?: SheetCell[];
  prompt: string;
  qa: QaIssue[];
  workDir: string;
  round: number;
}

const VERDICT_SCHEMA = `{
  "score": число 0–10,
  "summary": "2–3 предложения: что хорошо и что главное мешает",
  "issues": ["#N: проблема", "…"],
  "clips": [ {"i": N, "action": "replace", "reason": "…"} | {"i": N, "camera": "…"} | {"i": N, "transition": "…"} | {"i": N, "epic": true|false} ],
  "subtitle": { …только меняемые поля стиля субтитров… },
  "grade": { "brightness": 0, "contrast": 0, "saturation": 0 }
}`;

/** Which clips go on the sheet: all if they fit, else an even spread + every flagged one. */
export function pickShown(n: number, flagged: number[], max = MAX_CELLS): number[] {
  if (n <= max) return Array.from({ length: n }, (_, i) => i);
  const set = new Set(flagged.filter((i) => i >= 0 && i < n).slice(0, Math.floor(max / 3)));
  const rest = max - set.size;
  for (let k = 0; k < rest; k++) set.add(Math.floor(((k + 0.5) * n) / rest));
  return [...set].sort((a, b) => a - b).slice(0, max);
}

/** The moment inside a clip that shows it best: its subtitle mostly drawn, entry effect over. */
function frameTime(c: EdlClip): number {
  const start = c.start ?? 0;
  const dur = c.dur ?? 0.5;
  const words = c.sub?.words ?? [];
  let local = dur * 0.6;
  if (words.length) {
    const last = words[words.length - 1];
    local = (last[0] + last[1]) / 2;
  }
  return start + Math.min(Math.max(local, Math.min(0.2, dur * 0.5)), dur - 0.04);
}

function clipRow(c: EdlClip, i: number, band?: string): string {
  const words = c.sub?.words.map((w) => w[2]).join(" ") ?? "";
  const bits = [
    `#${i}`,
    `t=${(c.start ?? 0).toFixed(1)}s`,
    `dur=${(c.dur ?? 0).toFixed(2)}`,
    band ?? "",
    `src=${c.srcOffset.toFixed(1)}s`,
    `tr=${c.transition ?? "cut"}`,
    `cam=${c.camera ?? "auto"}`,
    c.epic ? "EPIC" : "",
    words ? `субтитр="${words.slice(0, 60)}"` : "",
    c.note ? `(${c.note.slice(0, 60)})` : "",
  ];
  return bits.filter(Boolean).join(" ");
}

function styleSummary(edl: Edl, style?: StyleProfile | null): string {
  const s = edl.subtitle;
  const lines: string[] = [];
  if (style?.vibe) lines.push(`Вайб референса: ${style.vibe}`);
  if (style?.notes) lines.push(`Заметки стилиста: ${style.notes}`);
  if (s) {
    lines.push(`Текущие субтитры: ${s.font}, ${s.sizePct}% кадра, разрядка ${s.spacing}em, ${s.color}` +
      `${s.accentColor ? ` + акцент ${s.accentColor}` : ""}, обводка ${s.outline}, тень ${s.shadow}` +
      `${s.glow ? ", свечение" : ""}, ${s.position}, ${s.animation}`);
  }
  if (edl.grade) lines.push(`Текущий грейд: ${edl.grade}`);
  return lines.join("\n");
}

const num = (v: unknown, lo: number, hi: number): number | undefined => {
  const n = Number(v);
  return Number.isFinite(n) && n !== 0 ? Math.max(lo, Math.min(hi, n)) : undefined;
};

/** Coerce the critic's JSON into a Verdict the conductor can apply safely. */
export function parseVerdict(data: any, n: number, shown: number[]): Verdict {
  const valid = (i: unknown): i is number => Number.isInteger(i) && (i as number) >= 0 && (i as number) < n;
  const replace: ReplaceRequest[] = [];
  const patches = new Map<number, Partial<EdlClip>>();
  for (const c of Array.isArray(data?.clips) ? data.clips : []) {
    const i = Number(c?.i);
    if (!valid(i)) continue;
    if (c.action === "replace") {
      if (!replace.some((r) => r.i === i)) replace.push({ i, reason: String(c.reason ?? "не подходит").slice(0, 160) });
      continue;
    }
    const p: Partial<EdlClip> = { ...patches.get(i) };
    if (CAMERAS.includes(c.camera)) p.camera = c.camera;
    const tr = String(c.transition ?? "").toLowerCase();
    if (isTransition(tr)) p.transition = tr;
    if (typeof c.epic === "boolean") p.epic = c.epic;
    if (Object.keys(p).length) patches.set(i, p);
  }

  let subtitle: Partial<SubtitleStyle> | undefined;
  if (data?.subtitle && typeof data.subtitle === "object") {
    const s = data.subtitle;
    const out: Partial<SubtitleStyle> = {};
    const size = num(s.sizePct, 2.2, 9);
    if (size !== undefined) out.sizePct = size;
    if (SUB_POSITIONS.includes(s.position)) out.position = s.position;
    const outline = Number(s.outline);
    if (Number.isFinite(outline)) out.outline = Math.max(0, Math.min(8, outline));
    const shadow = Number(s.shadow);
    if (Number.isFinite(shadow)) out.shadow = Math.max(0, Math.min(6, shadow));
    if (typeof s.glow === "boolean") out.glow = s.glow;
    if (typeof s.color === "string") out.color = s.color;
    if (typeof s.accentColor === "string") out.accentColor = s.accentColor;
    const spacing = Number(s.spacing);
    if (Number.isFinite(spacing)) out.spacing = Math.max(0, Math.min(0.8, spacing));
    if (typeof s.font === "string" && SUB_FONTS[s.font]) out.font = s.font;
    if (Object.keys(out).length) subtitle = out;
  }

  let grade: GradeDelta | undefined;
  if (data?.grade && typeof data.grade === "object") {
    const g: GradeDelta = {
      brightness: num(data.grade.brightness, -0.08, 0.08),
      contrast: num(data.grade.contrast, -0.15, 0.15),
      saturation: num(data.grade.saturation, -0.3, 0.3),
    };
    if (Object.values(g).some((v) => v !== undefined)) grade = g;
  }

  const score = Number(data?.score);
  return {
    score: Number.isFinite(score) ? Math.max(0, Math.min(10, score)) : 0,
    summary: String(data?.summary ?? "").slice(0, 600),
    issues: (Array.isArray(data?.issues) ? data.issues : []).map((x: unknown) => String(x).slice(0, 200)).slice(0, 20),
    replace,
    patches,
    subtitle,
    grade,
    shown,
  };
}

/** Siberi reviews one render. Null when the review itself failed (network, bad JSON). */
export async function reviewEdit(input: ReviewInput, log: Log): Promise<Verdict | null> {
  const { edl, qa } = input;
  const n = edl.clips.length;
  const shown = pickShown(n, qa.filter((q) => !q.fixed).map((q) => q.i));
  const vertical = edl.format === "vertical";
  const cellW = vertical ? 180 : 220;
  const cellH = vertical ? 320 : 220;
  const cols = 6;

  const refCells = (input.refCells ?? []).slice(0, cols).map((c, k) => ({ ...c, label: `REF${k + 1}` }));
  const cells: SheetCell[] = [
    ...refCells,
    // Pad the reference row so our clips always start on a fresh row.
    ...(refCells.length ? Array.from({ length: (cols - (refCells.length % cols)) % cols }, () => ({ video: "", t: 0 })) : []),
    ...shown.map((i) => ({ video: input.video, t: frameTime(edl.clips[i]), label: `#${i}` })),
  ];
  let image: Buffer;
  try {
    image = await buildSheet(cells, path.join(input.workDir, `review-r${input.round}.jpg`), { cols, cellW, cellH });
  } catch (e) {
    log(`⚠ критик: не собрал раскадровку (${e instanceof Error ? e.message.slice(0, 120) : e})`);
    return null;
  }

  const qaText = qa.length
    ? qa.map((q) => `#${q.i} ${q.kind}: ${q.detail}${q.fixed ? " (уже исправлено)" : ""}`).join("\n")
    : "замечаний нет";
  const user = [
    `ПРОМПТ ЭДИТА:\n${input.prompt || "эдит в стиле референса"}`,
    styleSummary(edl, input.style),
    `ЭДИТ: ${n} склеек, ${edl.format ?? "square"}, ${edl.tempo ?? "?"} BPM. На картинке склейки: ${shown.map((i) => `#${i}`).join(" ")}` +
      (refCells.length ? ` (первый ряд — REF, кадры референса)` : ""),
    `ТАБЛИЦА СКЛЕЕК:\n${shown.map((i) => clipRow(edl.clips[i], i, input.bands?.[i])).join("\n")}`,
    `АВТОПРОВЕРКА (детерминированная):\n${qaText}`,
    `Переходы движка: ${TRANSITIONS.join(", ")}. Шрифты: ${Object.keys(SUB_FONTS).join(", ")}.`,
    `Схема ответа:\n${VERDICT_SCHEMA}`,
  ].join("\n\n");

  try {
    const data = await askJson(loadPrompt("critic.md", "Оцени эдит по раскадровке и предложи правки."), user, log,
                               { image, label: `критик·раунд ${input.round}` });
    return parseVerdict(data, n, shown);
  } catch (e) {
    log(`⚠ критик не ответил (${e instanceof Error ? e.message.slice(0, 160) : e})`);
    return null;
  }
}
