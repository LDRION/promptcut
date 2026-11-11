/**
 * Speech subtitles in the REFERENCE's style: font, size, position, tracking, colours,
 * an accent colour for key words, soft glow, and the way words appear (karaoke fill,
 * word-by-word reveal, typewriter, one-word pop, phrase fade). Text + timing come from
 * the source transcript (word-level Whisper); each clip burns only the words spoken in
 * its window, shifted to clip-local time. Rendered as ASS → ffmpeg `ass` filter.
 */

import type { ClipCue } from "./edl.js";

/** A transcript segment in SOURCE time; words = [start, end, text]. */
export interface TranscriptSeg {
  start: number;
  end: number;
  text: string;
  words?: [number, number, string][];
}

export type SubAnimation = "karaoke" | "reveal" | "type" | "word" | "fade" | "static";
export type SubPosition = "bottom" | "lower" | "center" | "upper";

export const SUB_ANIMATIONS: SubAnimation[] = ["karaoke", "reveal", "type", "word", "fade", "static"];
export const SUB_POSITIONS: SubPosition[] = ["bottom", "lower", "center", "upper"];

/** Fonts that exist on a stock Windows install, by look — what Siberi picks from. */
export const SUB_FONTS: Record<string, string> = {
  "Century Gothic": "геометрический гротеск, чистый и широкий (эдиты по сериалам/аниме)",
  "Segoe UI Light": "тонкий гротеск, воздушный",
  "Segoe UI": "нейтральный гротеск средней толщины",
  "Bahnschrift": "узкий DIN-гротеск, технический",
  "Arial": "классический жирный гротеск (при bold)",
  "Arial Black": "очень жирный, тяжёлый",
  "Impact": "узкий сверхжирный, мемный/TikTok",
  "Georgia": "антиква с засечками, драматичная",
  "Times New Roman": "классическая антиква",
  "Consolas": "моноширинный, «печатная машинка»",
  "Ink Free": "рукописный, небрежный",
  "Segoe Script": "каллиграфический рукописный",
};

export interface SubtitleStyle {
  font: string;
  /** Font size as % of the content square's height. */
  sizePct: number;
  bold: boolean;
  italic: boolean;
  uppercase: boolean;
  /** Letter spacing in em (0 = normal, 0.3 = wide tracking). */
  spacing: number;
  /** #RRGGBB */
  color: string;
  /** Not-yet-sung colour for karaoke. */
  dimColor: string;
  /** Colour for accent (key) words; empty = no accents. */
  accentColor: string;
  outlineColor: string;
  /** Outline thickness in px at 1080p. */
  outline: number;
  /** Drop shadow depth in px at 1080p. */
  shadow: number;
  /** Soft glow around the letters (in the accent/text colour). */
  glow: boolean;
  position: SubPosition;
  animation: SubAnimation;
  maxWords: number;
  /** Allow a phrase to wrap onto two lines. */
  twoLines: boolean;
}

/** The engine's own look when there is no reference (322-style karaoke). */
export const DEFAULT_SUB_STYLE: SubtitleStyle = {
  font: "Arial",
  sizePct: 5.2,
  bold: true,
  italic: false,
  uppercase: true,
  spacing: 0,
  color: "#FFFFFF",
  dimColor: "#A8A8A8",
  accentColor: "",
  outlineColor: "#101010",
  outline: 3.4,
  shadow: 1.6,
  glow: false,
  position: "lower",
  animation: "karaoke",
  maxWords: 5,
  twoLines: true,
};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const HEX = /^#?([0-9a-f]{6})$/i;

function hex(v: unknown, fallback: string): string {
  const m = typeof v === "string" ? v.trim().match(HEX) : null;
  return m ? `#${m[1].toUpperCase()}` : fallback;
}

function num(v: unknown, fallback: number, lo: number, hi: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? clamp(n, lo, hi) : fallback;
}

/** Coerce anything an LLM returned into a valid style, on top of `base`. */
export function normalizeSubStyle(raw: unknown, base: SubtitleStyle = DEFAULT_SUB_STYLE): SubtitleStyle {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const font = typeof r.font === "string" && SUB_FONTS[r.font] ? r.font : base.font;
  const accent = r.accentColor === "" || r.accentColor === null ? "" : hex(r.accentColor, base.accentColor);
  return {
    font,
    sizePct: num(r.sizePct, base.sizePct, 2.2, 9),
    bold: typeof r.bold === "boolean" ? r.bold : base.bold,
    italic: typeof r.italic === "boolean" ? r.italic : base.italic,
    uppercase: typeof r.uppercase === "boolean" ? r.uppercase : base.uppercase,
    spacing: num(r.spacing, base.spacing, 0, 0.8),
    color: hex(r.color, base.color),
    dimColor: hex(r.dimColor, base.dimColor),
    accentColor: accent,
    outlineColor: hex(r.outlineColor, base.outlineColor),
    outline: num(r.outline, base.outline, 0, 8),
    shadow: num(r.shadow, base.shadow, 0, 6),
    glow: typeof r.glow === "boolean" ? r.glow : base.glow,
    position: SUB_POSITIONS.includes(r.position as SubPosition) ? (r.position as SubPosition) : base.position,
    animation: SUB_ANIMATIONS.includes(r.animation as SubAnimation) ? (r.animation as SubAnimation) : base.animation,
    maxWords: Math.round(num(r.maxWords, base.maxWords, 1, 8)),
    twoLines: typeof r.twoLines === "boolean" ? r.twoLines : base.twoLines,
  };
}

const TAIL = 0.25; // hold the last word a touch after it ends

/** Words spoken within [off, off+dur] → clip-local cue, or null if silent. */
export function deriveCue(
  transcript: TranscriptSeg[] | undefined,
  off: number,
  dur: number,
): ClipCue | null {
  if (!transcript?.length) return null;
  const words: [number, number, string][] = [];
  for (const seg of transcript) {
    const src = seg.words?.length
      ? seg.words
      : [[seg.start, seg.end, seg.text] as [number, number, string]];
    for (const [w0, w1, raw] of src) {
      const mid = (w0 + w1) / 2;
      if (mid < off || mid >= off + dur) continue;
      const text = raw.trim();
      if (!text) continue;
      const t0 = Math.max(0, w0 - off);
      const t1 = Math.min(dur, Math.max(t0 + 0.05, w1 - off));
      words.push([t0, t1, text]);
    }
  }
  return words.length ? { words } : null;
}

/** Strip punctuation for comparisons ("мальчики!" matches accent "МАЛЬЧИКИ"). */
export function bareWord(w: string): string {
  return w.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/**
 * Pick the accent word of a cue when the director didn't: the longest meaningful word
 * (≥4 letters) of the last phrase — usually the one the line lands on.
 */
export function autoAccent(cue: ClipCue): string | undefined {
  let best: string | undefined;
  for (const [, , w] of cue.words) {
    const b = bareWord(w);
    if (b.length >= 4 && (!best || b.length >= bareWord(best).length)) best = w;
  }
  return best ? bareWord(best) : undefined;
}

function ts(t: number): string {
  const cs = Math.max(0, Math.round(t * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(c).padStart(2, "0")}`;
}

/** #RRGGBB → ASS &HAABBGGRR& (alpha 00 = opaque). */
function assColor(hexColor: string, alpha = 0): string {
  const m = hexColor.match(HEX);
  const rgb = m ? m[1] : "FFFFFF";
  const a = alpha.toString(16).padStart(2, "0").toUpperCase();
  return `&H${a}${rgb.slice(4, 6)}${rgb.slice(2, 4)}${rgb.slice(0, 2)}&`.toUpperCase();
}

/** #RRGGBB → inline override colour &HBBGGRR& (\1c, \3c take no alpha). */
function tagColor(hexColor: string): string {
  return assColor(hexColor).replace(/^&H00/, "&H");
}

type Word = [number, number, string];

/** Split words into short phrases (≤ maxWords, bounded length), each shown as one event. */
function phrases(words: Word[], maxWords: number, maxChars: number): Word[][] {
  const out: Word[][] = [];
  let cur: Word[] = [];
  let chars = 0;
  for (const w of words) {
    const gap = cur.length ? w[0] - cur[cur.length - 1][1] : 0;
    if (cur.length && (cur.length >= maxWords || chars + w[2].length > maxChars || gap > 0.8)) {
      out.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(w);
    chars += w[2].length + 1;
  }
  if (cur.length) out.push(cur);
  return out;
}

const ms = (t: number) => Math.max(0, Math.round(t * 1000));

interface Layout {
  x: number;
  y: number;
}

/** Where the text block is centred, on the final canvas (content square may be letterboxed). */
function layout(style: SubtitleStyle, W: number, H: number, SQ: number): Layout {
  const top = (H - SQ) / 2;
  const rel = { bottom: 0.88, lower: 0.72, center: 0.52, upper: 0.14 }[style.position];
  return { x: Math.round(W / 2), y: Math.round(top + SQ * rel) };
}

/**
 * One phrase → the Dialogue text for a layer. `glowLayer` renders only a blurred,
 * thick outline (a halo) with the same timing, so it tracks the reveal animation —
 * in each word's own colour (glow), or in `haloColor` (the dark legibility shade).
 */
function phraseText(ph: Word[], t0: number, style: SubtitleStyle, accent: Set<string>, glowLayer: boolean,
                    haloColor?: string, haloAlpha = "70"): string {
  const breakAt = style.twoLines && ph.length >= 4 ? Math.ceil(ph.length / 2) : -1;
  const baseColor = tagColor(style.color);
  const accentColor = style.accentColor ? tagColor(style.accentColor) : "";
  const parts: string[] = [];
  let prevEnd = t0;

  ph.forEach(([w0, w1, raw], idx) => {
    const text = (style.uppercase ? raw.toUpperCase() : raw).replace(/[{}\\]/g, "");
    const isAccent = accentColor && accent.has(bareWord(raw));
    const color = isAccent ? accentColor : baseColor;
    // Glow layer paints the halo in the word's own colour, so accents glow in accent.
    const colorTag = glowLayer ? `\\3c${haloColor ?? color}` : `\\1c${color}`;
    const rel0 = ms(w0 - t0);

    switch (style.animation) {
      case "karaoke": {
        const gap = Math.max(0, Math.round((w0 - prevEnd) * 100));
        if (gap > 0 && !glowLayer) parts.push(`{\\k${gap}}`);
        const dur = Math.max(1, Math.round((w1 - w0) * 100));
        parts.push(glowLayer ? `{${colorTag}}${text} ` : `{\\kf${dur}${colorTag}}${text} `);
        break;
      }
      case "reveal": {
        // Word appears in place (no layout jump): transparent → opaque with a blur-in.
        const show = glowLayer ? `\\3a&H${haloAlpha}&` : "\\1a&H00&\\3a&H00&\\4a&H90&";
        const hide = glowLayer ? "\\3a&HFF&" : "\\1a&HFF&\\3a&HFF&\\4a&HFF&";
        parts.push(`{${colorTag}${hide}\\t(${rel0},${rel0 + 1},${show})}${text} `);
        break;
      }
      case "type": {
        // Typewriter: letters land one by one across the word's spoken duration.
        const letters = [...text];
        const step = Math.max(12, ms(w1 - w0) / Math.max(1, letters.length));
        const show = glowLayer ? `\\3a&H${haloAlpha}&` : "\\1a&H00&\\3a&H00&\\4a&H90&";
        const hide = glowLayer ? "\\3a&HFF&" : "\\1a&HFF&\\3a&HFF&\\4a&HFF&";
        letters.forEach((ch, k) => {
          const at = Math.round(rel0 + k * step);
          parts.push(`{${colorTag}${hide}\\t(${at},${at + 1},${show})}${ch}`);
        });
        parts.push(" ");
        break;
      }
      default:
        parts.push(`{${colorTag}}${text} `);
    }
    prevEnd = w1;
    if (idx === breakAt - 1 && idx < ph.length - 1) parts.push("\\N");
  });
  return parts.join("").replace(/ (\\N)/g, "$1").trimEnd();
}

/** Full ASS document for one clip's cue, sized to the output canvas. */
export function cueToAss(
  cue: ClipCue,
  W: number,
  H: number,
  styleIn: Partial<SubtitleStyle> = DEFAULT_SUB_STYLE,
  SQ = Math.min(W, H),
): string {
  const style = { ...DEFAULT_SUB_STYLE, ...styleIn };
  const font = Math.round(SQ * (style.sizePct / 100));
  const spacing = Math.round(font * style.spacing * 10) / 10;
  const scale = SQ / 1080;
  const outline = Math.round(style.outline * scale * 10) / 10;
  const shadow = Math.round(style.shadow * scale * 10) / 10;
  const { x, y } = layout(style, W, H, SQ);

  const styleLine = (name: string, primary: string, secondary: string, outlineColor: string,
                     bord: number, shad: number) => [
    `Style: ${name}`,
    style.font,
    font,
    primary,
    secondary,
    outlineColor,
    "&H96000000",
    style.bold ? "-1" : "0",
    style.italic ? "-1" : "0",
    "0", "0", "100", "100",
    spacing,
    "0",
    "1",
    bord,
    shad,
    "5", // centre-anchored; we place it with \pos
    "0", "0", "0", "1",
  ].join(",");

  const main = styleLine("Sub", assColor(style.color), assColor(style.dimColor),
                         assColor(style.outlineColor), outline, shadow);
  const glowColor = style.accentColor || style.color;
  const glowR = Math.max(3, Math.round(font * 0.18));
  const glow = styleLine("Glow", assColor(style.color, 0xff), assColor(style.color, 0xff),
                         assColor(glowColor, 0x70), glowR, 0);
  // Thin, outline-less styles (the tasteful serial-edit look) vanish on bright frames:
  // a soft dark shade under the letters keeps them legible without changing the look
  // on dark footage, where it's invisible.
  const shadeOn = style.outline < 2;
  const shadeR = Math.max(3, Math.round(font * 0.28));
  const shade = styleLine("Shade", assColor("#000000", 0xff), assColor("#000000", 0xff),
                          assColor("#000000", 0x78), shadeR, 0);
  const shadeBlur = `\\blur${Math.max(3, Math.round(font * 0.4))}`;

  const accent = new Set((cue.accent ?? []).map(bareWord).filter(Boolean));
  const maxChars = Math.max(10, Math.round((W * 0.84) / (font * (0.62 + style.spacing)))) * (style.twoLines ? 2 : 1);
  const events: string[] = [];
  const pos = `\\an5\\pos(${x},${y})`;

  const push = (layer: number, st: string, t0: number, t1: number, text: string, extra = "") =>
    events.push(`Dialogue: ${layer},${ts(t0)},${ts(t1)},${st},,0,0,0,,{${pos}${extra}}${text}`);

  if (style.animation === "word") {
    // One word at a time, popping in — each word is its own event.
    for (const [w0, w1, raw] of cue.words) {
      const word: Word[] = [[w0, w1, raw]];
      const end = Math.max(w1, w0 + 0.18);
      const pop = "\\fscx118\\fscy118\\t(0,110,\\fscx100\\fscy100)";
      const still = { ...style, animation: "static" as const };
      if (shadeOn) push(0, "Shade", w0, end, phraseText(word, w0, still, accent, true, "&H000000&", "78"), `${shadeBlur}${pop}`);
      if (style.glow) push(1, "Glow", w0, end, phraseText(word, w0, still, accent, true), `\\blur${glowR}${pop}`);
      push(2, "Sub", w0, end, phraseText(word, w0, still, accent, false), pop);
    }
  } else {
    for (const ph of phrases(cue.words, style.maxWords, maxChars)) {
      const start = ph[0][0];
      const end = ph[ph.length - 1][1] + TAIL;
      const fade = style.animation === "fade" ? "\\fad(140,120)" : "";
      if (shadeOn) push(0, "Shade", start, end, phraseText(ph, start, style, accent, true, "&H000000&", "78"), `${shadeBlur}${fade}`);
      if (style.glow) push(1, "Glow", start, end, phraseText(ph, start, style, accent, true), `\\blur${glowR}${fade}`);
      push(2, "Sub", start, end, phraseText(ph, start, style, accent, false), fade);
    }
  }

  return (
    `[Script Info]\nScriptType: v4.00+\nPlayResX: ${W}\nPlayResY: ${H}\nWrapStyle: 2\nScaledBorderAndShadow: yes\n\n` +
    `[V4+ Styles]\n` +
    `Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,` +
    `Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,` +
    `Alignment,MarginL,MarginR,MarginV,Encoding\n${main}\n${glow}\n${shade}\n\n` +
    `[Events]\n` +
    `Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text\n` +
    events.join("\n") + "\n"
  );
}
