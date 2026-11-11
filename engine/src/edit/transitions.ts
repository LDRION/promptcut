/**
 * Cut transitions, the AMV way: every clip is rendered on its own, so a transition is
 * an ENTRY effect on the incoming clip's first frames (plus, for flash/dip, a matching
 * exit on the outgoing clip's last frames). That keeps clips independent — cacheable,
 * parallel, stream-copy concat — while still reading as a proper transition on screen.
 */

export type TransitionType = "cut" | "flash" | "zoom" | "whip" | "shake" | "glitch" | "blur" | "dip";

export const TRANSITIONS: TransitionType[] = ["cut", "flash", "zoom", "whip", "shake", "glitch", "blur", "dip"];

/** Human description — shown to Siberi (reading the reference, directing, reviewing). */
export const TRANSITION_DOC: Record<TransitionType, string> = {
  cut: "чистая склейка, без эффекта",
  flash: "белая вспышка на стыке (засветка 2–4 кадра)",
  zoom: "зум-панч: кадр влетает приближенным и отъезжает",
  whip: "вжух: боковой пролёт со смазом движения",
  shake: "тряска камеры на ударе",
  glitch: "глитч: RGB-сдвиг + цифровой шум на 2–3 кадра",
  blur: "расфокус → резкость (кадр проявляется из размытия)",
  dip: "провал в чёрное между кадрами",
};

export type TransitionMix = Partial<Record<TransitionType, number>>;

/** Default mix when there is no reference: mostly clean cuts, accents on the loud parts. */
export const DEFAULT_MIX: TransitionMix = { cut: 0.55, flash: 0.12, zoom: 0.12, shake: 0.08, blur: 0.06, glitch: 0.04, whip: 0.03 };

export function isTransition(v: unknown): v is TransitionType {
  return typeof v === "string" && (TRANSITIONS as string[]).includes(v);
}

/** Normalise any weights object into a clean mix that sums to 1 (unknown keys dropped). */
export function normalizeMix(raw: unknown): TransitionMix | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const mix: TransitionMix = {};
  let sum = 0;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const n = Number(v);
    if (isTransition(k) && Number.isFinite(n) && n > 0) {
      mix[k] = n;
      sum += n;
    }
  }
  if (sum <= 0) return undefined;
  for (const k of Object.keys(mix) as TransitionType[]) mix[k] = Math.round((mix[k]! / sum) * 1000) / 1000;
  return mix;
}

// Which transitions fit which part of the song: loud cuts can hit hard, quiet ones breathe.
const LOUD: TransitionType[] = ["flash", "zoom", "whip", "shake", "glitch"];
const SOFT: TransitionType[] = ["cut", "blur", "dip"];

/** Tiny deterministic PRNG (mulberry32) so auto-assigned transitions are reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministically assign a transition per cut, following the mix but biased by the
 * song: chorus cuts draw from the punchy ones, verse cuts from the soft ones. Never
 * three identical flashy transitions in a row.
 */
export function assignTransitions(bands: ("verse" | "build" | "chorus")[], mix: TransitionMix = DEFAULT_MIX, seed = 7): TransitionType[] {
  const rand = rng(seed);
  const m = normalizeMix(mix) ?? DEFAULT_MIX;
  const out: TransitionType[] = [];
  bands.forEach((band, i) => {
    const weights = TRANSITIONS.map((t) => {
      let w = m[t] ?? 0;
      if (band === "chorus" && LOUD.includes(t)) w *= 1.8;
      if (band === "verse" && LOUD.includes(t)) w *= 0.35;
      if (band === "verse" && SOFT.includes(t)) w *= 1.4;
      if (t !== "cut" && out[i - 1] === t && out[i - 2] === t) w = 0;
      return w;
    });
    const total = weights.reduce((a, b) => a + b, 0);
    if (i === 0 || total <= 0) { out.push("cut"); return; }
    let r = rand() * total;
    let pick: TransitionType = "cut";
    for (let k = 0; k < TRANSITIONS.length; k++) {
      r -= weights[k];
      if (r <= 0) { pick = TRANSITIONS[k]; break; }
    }
    out.push(pick);
  });
  return out;
}

/** Share of each transition in a list — what the edit actually uses. */
export function mixOf(list: TransitionType[]): TransitionMix {
  const mix: TransitionMix = {};
  for (const t of list) mix[t] = (mix[t] ?? 0) + 1;
  for (const k of Object.keys(mix) as TransitionType[]) mix[k] = Math.round((mix[k]! / list.length) * 100) / 100;
  return mix;
}

const centerX = "iw/2-(iw/zoom/2)";
const centerY = "ih/2-(ih/zoom/2)";

/**
 * ffmpeg filter fragment (leading comma, or "") for the ENTRY of a clip. Operates on
 * the SQ×SQ content stream at `fps`, where t/on start at 0 on the clip's first frame.
 */
export function entryFilter(type: TransitionType | undefined, sq: number, fps: number): string {
  const frames = (sec: number) => Math.max(2, Math.round(sec * fps));
  switch (type) {
    case "flash":
      return ",fade=t=in:st=0:d=0.09:color=white";
    case "zoom": {
      const pf = frames(0.22);
      // Ease-out: starts 20% in, settles to 1.0 — the classic beat punch.
      return `,zoompan=z='if(lt(on,${pf}),1+0.2*pow(1-on/${pf},2),1)':d=1:x='${centerX}':y='${centerY}':s=${sq}x${sq}:fps=${fps}`;
    }
    case "whip": {
      const pf = frames(0.16);
      // Slide in from the right while zoomed, with a directional smear on the first frames.
      return (
        `,zoompan=z='if(lt(on,${pf}),1+0.14*pow(1-on/${pf},2),1)':d=1:` +
        `x='${centerX}+(iw-iw/zoom)/2*pow(1-min(on/${pf},1),2)':y='${centerY}':s=${sq}x${sq}:fps=${fps}` +
        `,dblur=angle=0:radius=28:enable='lt(t,0.05)',dblur=angle=0:radius=12:enable='between(t,0.05,0.11)'`
      );
    }
    case "shake": {
      const pf = frames(0.3);
      const amp = Math.round(sq * 0.028);
      return (
        `,zoompan=z='1.07':d=1:` +
        `x='${centerX}+${amp}*max(0,1-on/${pf})*sin(on*2.3)':` +
        `y='${centerY}+${amp}*max(0,1-on/${pf})*cos(on*1.9)':s=${sq}x${sq}:fps=${fps}`
      );
    }
    case "glitch":
      return (
        ",rgbashift=rh=16:bh=-16:gv=6:enable='lt(t,0.07)'" +
        ",rgbashift=rh=-8:bh=8:enable='between(t,0.07,0.12)'" +
        ",noise=alls=38:allf=t+u:enable='lt(t,0.1)'"
      );
    case "blur":
      return (
        ",gblur=sigma=24:enable='lt(t,0.05)'" +
        ",gblur=sigma=12:enable='between(t,0.05,0.1)'" +
        ",gblur=sigma=5:enable='between(t,0.1,0.16)'"
      );
    case "dip":
      return ",fade=t=in:st=0:d=0.16";
    default:
      return "";
  }
}

/**
 * ffmpeg filter fragment for the EXIT of a clip, given the NEXT clip's transition:
 * a flash burns to white on both sides of the cut, a dip goes through black.
 */
export function exitFilter(next: TransitionType | undefined, dur: number): string {
  if (next === "flash" && dur > 0.25) return `,fade=t=out:st=${(dur - 0.05).toFixed(3)}:d=0.05:color=white`;
  if (next === "dip" && dur > 0.35) return `,fade=t=out:st=${(dur - 0.12).toFixed(3)}:d=0.12`;
  return "";
}
