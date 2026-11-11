import { test } from "node:test";
import assert from "node:assert/strict";
import { autoAccent, cueToAss, deriveCue, normalizeSubStyle, DEFAULT_SUB_STYLE } from "../src/edit/subtitles.js";

const cue = {
  words: [[0, 0.3, "не"], [0.3, 0.8, "скучайте,"], [0.8, 1.4, "мальчики!"]] as [number, number, string][],
  accent: ["МАЛЬЧИКИ"],
};

test("normalizeSubStyle clamps numbers, rejects unknown fonts and bad colours", () => {
  const s = normalizeSubStyle({ font: "Comic Sans", sizePct: 40, spacing: -1, color: "red", accentColor: "#00ff00", animation: "explode" });
  assert.equal(s.font, DEFAULT_SUB_STYLE.font);
  assert.equal(s.sizePct, 9);
  assert.equal(s.spacing, 0);
  assert.equal(s.color, DEFAULT_SUB_STYLE.color);
  assert.equal(s.accentColor, "#00FF00");
  assert.equal(s.animation, DEFAULT_SUB_STYLE.animation);
  assert.equal(normalizeSubStyle({ accentColor: "" }, { ...DEFAULT_SUB_STYLE, accentColor: "#FF0000" }).accentColor, "");
});

test("cueToAss: font, centred position, accent colour on the accent word only", () => {
  const style = normalizeSubStyle({ font: "Century Gothic", sizePct: 3.4, spacing: 0.3, accentColor: "#7CFF4F", animation: "static", uppercase: true });
  const ass = cueToAss(cue, 1080, 1080, style);
  assert.match(ass, /Style: Sub,Century Gothic,37,/);
  assert.match(ass, /\\an5\\pos\(540,778\)/);
  // #7CFF4F → &H4FFF7C& (BGR), applied to МАЛЬЧИКИ! only.
  assert.match(ass, /\\1c&H4FFF7C&\}МАЛЬЧИКИ!/);
  assert.match(ass, /\\1c&HFFFFFF&\}СКУЧАЙТЕ,/);
});

test("cueToAss: glow adds a blurred layer under the text", () => {
  const ass = cueToAss(cue, 1080, 1920, normalizeSubStyle({ glow: true }), 1080);
  const lines = ass.split("\n").filter((l) => l.startsWith("Dialogue:"));
  assert.ok(lines.some((l) => l.startsWith("Dialogue: 1,") && l.includes(",Glow,") && /\\blur\d/.test(l)));
  assert.ok(lines.some((l) => l.startsWith("Dialogue: 2,") && l.includes(",Sub,")));
  // A heavy outline is legible by itself — no extra shade layer.
  assert.ok(!lines.some((l) => l.includes(",Shade,")));
  // Vertical canvas: the text sits inside the centred content square.
  assert.match(ass, /\\pos\(540,1198\)/);
});

test("cueToAss: word animation = one event per word; karaoke has \\kf timing", () => {
  const word = cueToAss(cue, 1080, 1080, normalizeSubStyle({ animation: "word" }));
  assert.equal(word.split("\n").filter((l) => l.startsWith("Dialogue: 2,")).length, 3);
  const kara = cueToAss(cue, 1080, 1080, normalizeSubStyle({ animation: "karaoke" }));
  assert.match(kara, /\\kf30/);
  assert.match(kara, /\\kf60/);
});

test("deriveCue keeps words spoken inside the window, in clip time", () => {
  const got = deriveCue([{ start: 10, end: 12, text: "a b c", words: [[9.8, 10.1, "a"], [10.4, 10.9, "b"], [11.9, 12.4, "c"]] }], 10, 1.5);
  assert.deepEqual(got?.words.map((w) => w[2]), ["b"]);
  assert.ok(Math.abs(got!.words[0][0] - 0.4) < 1e-9);
  assert.equal(deriveCue([], 0, 1), null);
});

test("autoAccent picks the longest meaningful word", () => {
  assert.equal(autoAccent(cue), "мальчики");
  assert.equal(autoAccent({ words: [[0, 1, "да"], [1, 2, "ты"]] }), undefined);
});

test("cueToAss: thin outline-less styles get a dark shade that follows the reveal", () => {
  const ass = cueToAss(cue, 1080, 1080, normalizeSubStyle({ outline: 0, animation: "reveal" }));
  const shade = ass.split("\n").find((l) => l.startsWith("Dialogue: 0,") && l.includes(",Shade,"));
  assert.ok(shade, ass);
  assert.match(shade!, /\\3c&H000000&\\3a&HFF&\\t\(300,301,\\3a&H78&\)\}СКУЧАЙТЕ,/);
  assert.match(ass, /Style: Shade,/);
});
