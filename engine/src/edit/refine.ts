import type { Edl } from "./edl.js";

/**
 * Prompt-based refinement: take the resolved EDL of a finished edit + a natural-language
 * instruction, return a modified EDL. Deterministic parser for the common ops (look
 * tweaks, flashes, chroma, replace a moment by edit-time). A free-form LLM director can
 * later translate fuzzy instructions into these same edits.
 */
export interface RefineResult {
  edl: Edl;
  actions: string[];
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function gradeParam(grade: string, key: string, def: number): number {
  const m = grade.match(new RegExp(`${key}=(-?[\\d.]+)`));
  return m ? parseFloat(m[1]) : def;
}

/**
 * Nudge the grade's `eq` parameters, keeping the rest of the chain (curves, sharpen…)
 * intact. A grade without an `eq` gets one prepended.
 */
export function tweakGrade(grade: string,
                           d: { contrast?: number; saturation?: number; gamma?: number; brightness?: number }): string {
  const parts = grade.split(",");
  const k = parts.findIndex((p) => p.startsWith("eq="));
  const eq = k >= 0 ? parts[k] : "";
  const contrast = clamp(gradeParam(eq, "contrast", 1) + (d.contrast ?? 0), 0.8, 1.6);
  const saturation = clamp(gradeParam(eq, "saturation", 1) + (d.saturation ?? 0), 0.4, 2.0);
  const gamma = clamp(gradeParam(eq, "gamma", 1) + (d.gamma ?? 0), 0.7, 1.3);
  const brightness = clamp(gradeParam(eq, "brightness", 0) + (d.brightness ?? 0), -0.3, 0.3);
  const next = `eq=contrast=${contrast.toFixed(2)}:saturation=${saturation.toFixed(2)}:` +
    `gamma=${gamma.toFixed(2)}:brightness=${brightness.toFixed(2)}`;
  if (k >= 0) parts[k] = next;
  else parts.unshift(next);
  return parts.filter(Boolean).join(",");
}

const GRADE0 = "eq=contrast=1.12:saturation=1.4:gamma=0.97,unsharp=5:5:0.5";

export function refine(edl: Edl, instruction: string): RefineResult {
  const t = instruction.toLowerCase();
  const actions: string[] = [];
  const grade = edl.grade ?? GRADE0;

  // --- look / colour ---
  if (/(темн|darker|тускл)/.test(t)) {
    edl.grade = tweakGrade(grade, { gamma: -0.08, brightness: -0.04 });
    actions.push("сделал темнее");
  } else if (/(ярче|светл|brighter|lighter)/.test(t)) {
    edl.grade = tweakGrade(grade, { gamma: +0.08, brightness: +0.04 });
    actions.push("сделал ярче");
  }
  if (/(сочн|насыщ|saturat|vivid|vibran)/.test(t)) {
    edl.grade = tweakGrade(edl.grade ?? grade, { saturation: +0.25 });
    actions.push("добавил насыщенности");
  } else if (/(блёкл|блекл|обесцвет|desatur|тускл|приглуш)/.test(t)) {
    edl.grade = tweakGrade(edl.grade ?? grade, { saturation: -0.25 });
    actions.push("приглушил цвет");
  }
  if (/(контраст|contrast)/.test(t)) {
    const up = !/(меньше|ниже|less|low)/.test(t);
    edl.grade = tweakGrade(edl.grade ?? grade, { contrast: up ? +0.12 : -0.12 });
    actions.push(up ? "добавил контраст" : "убавил контраст");
  }

  // --- flashes ---
  if (/(убери|без|меньше|no|less).*(вспыш|flash)|(вспыш|flash).*(убери|меньше|off|нет)/.test(t)) {
    edl.flashDefault = false;
    for (const c of edl.clips) c.flash = false;
    actions.push("убрал вспыши");
  } else if (/(больше|добав|more).*(вспыш|flash)|(вспыш|flash).*(больше|добав)/.test(t)) {
    edl.flashDefault = true;
    for (const c of edl.clips) c.flash = true;
    actions.push("добавил вспыши на все склейки");
  }

  // --- chroma / glitch ---
  if (/(убери|без|меньше|no|less).*(хроматик|chroma|глитч|glitch)|(хроматик|глитч).*(убери|меньше|нет)/.test(t)) {
    edl.chromaDefault = 0;
    for (const c of edl.clips) c.chroma = 0;
    actions.push("убрал хроматику");
  } else if (/(больше|добав|more).*(хроматик|chroma|глитч|glitch)|(хроматик|глитч).*(больше|добав)/.test(t)) {
    edl.chromaDefault = 4;
    for (const c of edl.clips) c.chroma = Math.max(c.chroma ?? 0, 4);
    actions.push("усилил хроматику");
  }

  // --- replace a moment by edit-time: "убери/замени с 5 по 10 (сек)" ---
  const range = t.match(/(\d+(?:[.,]\d+)?)\s*(?:[-–—]|по|до|to|–)\s*(\d+(?:[.,]\d+)?)/);
  if (range && /(убери|удали|замени|replace|remove|поменя|другой момент)/.test(t)) {
    const a = parseFloat(range[1].replace(",", "."));
    const b = parseFloat(range[2].replace(",", "."));
    const srcDur = edl.srcDur ?? 0;
    let n = 0;
    edl.clips.forEach((c, i) => {
      const s = c.start ?? 0;
      const e = s + (c.dur ?? 0);
      if (e > a && s < b) {
        // shift this clip to a different part of the source (deterministic spread).
        const shift = 47 + i * 13;
        let off = (c.srcOffset ?? 0) + shift;
        if (srcDur > 1) off = off % (srcDur - (c.dur ?? 0));
        c.srcOffset = Math.round(off * 1000) / 1000;
        n++;
      }
    });
    if (n) actions.push(`заменил момент на ${a}–${b}с (${n} клип(ов) → другие кадры исходника)`);
  }

  if (actions.length === 0) {
    actions.push("инструкцию не распознал — поддерживаю: темнее/ярче/сочнее/контраст, " +
      "больше|меньше вспышек, больше|меньше хроматики, «замени с N по M секунду»");
  }
  return { edl, actions };
}
