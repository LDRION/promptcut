import { test } from "node:test";
import assert from "node:assert/strict";
import { detectCuts, placeClear } from "../src/edit/qa.js";
import { parseVerdict, pickShown } from "../src/edit/critic.js";
import { stepsFor } from "../src/edit/montage.js";
import { tweakGrade } from "../src/edit/refine.js";
import { extractJson } from "../src/edit/llm.js";
import { limitEpics, sanitizeClips } from "../src/edit/director.js";

test("placeClear slides a clip off a source cut, keeping the bigger part", () => {
  // Cut at 10.2 inside [10, 11]: most of the clip is after the cut → start after it.
  assert.equal(placeClear(10, 1, [10.2], 100), 10.24);
  // Cut at 10.8: most of the clip is before it → end before it.
  assert.equal(placeClear(10, 1, [10.8], 100), 9.76);
  // No cut inside → unchanged; cuts at the very edge don't count.
  assert.equal(placeClear(10, 1, [9, 10.03, 12], 100), 10);
  // Cuts on both sides too close → no clean placement.
  assert.equal(placeClear(10, 1, [9.7, 10.5, 11.2], 100), null);
});

test("detectCuts finds a hard cut and ignores smooth motion", () => {
  const frame = (v: number) => new Float32Array(64 * 36).fill(v);
  const frames: Float32Array[] = [];
  for (let i = 0; i < 30; i++) frames.push(frame(40 + i * 0.5)); // slow drift
  for (let i = 0; i < 30; i++) frames.push(frame(180 + i * 0.5)); // new shot
  assert.deepEqual(detectCuts(frames, 30), [30]);
});

test("stepsFor turns the reference's shot length into beats per band", () => {
  assert.deepEqual(stepsFor(undefined, 120), [2, 4, 6]);
  // 1s shots at 120 BPM = 2 beats per shot.
  assert.deepEqual(stepsFor(1, 120), [1, 2, 3]);
  assert.deepEqual(stepsFor(3, 120), [4, 6, 9]);
});

test("parseVerdict keeps only valid, in-range, engine-vocabulary fixes", () => {
  const v = parseVerdict({
    score: 12,
    summary: "ok",
    clips: [
      { i: 2, action: "replace", reason: "пустой кадр" },
      { i: 2, action: "replace", reason: "дубль" },
      { i: 3, camera: "face", transition: "ZOOM" },
      { i: 4, transition: "teleport", camera: "drone" },
      { i: 99, action: "replace" },
      { i: 5, epic: false },
    ],
    subtitle: { sizePct: 1, position: "left", glow: true, font: "Wingdings" },
    grade: { brightness: 0.5, contrast: 0, saturation: "x" },
  }, 10, [0, 1, 2]);
  assert.equal(v.score, 10);
  assert.deepEqual(v.replace, [{ i: 2, reason: "пустой кадр" }]);
  assert.deepEqual(v.patches.get(3), { camera: "face", transition: "zoom" });
  assert.equal(v.patches.has(4), false);
  assert.deepEqual(v.patches.get(5), { epic: false });
  assert.deepEqual(v.subtitle, { sizePct: 2.2, glow: true });
  assert.deepEqual(v.grade, { brightness: 0.08, contrast: undefined, saturation: undefined });
});

test("pickShown shows everything that fits, else a spread plus the flagged clips", () => {
  assert.deepEqual(pickShown(5, [3]), [0, 1, 2, 3, 4]);
  const got = pickShown(100, [77, 3], 12);
  assert.equal(got.length, 12);
  assert.ok(got.includes(77) && got.includes(3));
  assert.deepEqual(got, [...got].sort((a, b) => a - b));
});

test("tweakGrade nudges eq and keeps the rest of the chain", () => {
  const g = tweakGrade("eq=contrast=1.14:saturation=0.82:gamma=0.94:brightness=-0.03,curves=all='0/0 1/1',unsharp=5:5:0.4", { brightness: 0.05, saturation: -0.1 });
  assert.equal(g, "eq=contrast=1.14:saturation=0.72:gamma=0.94:brightness=0.02,curves=all='0/0 1/1',unsharp=5:5:0.4");
  assert.match(tweakGrade("unsharp=5:5:0.5", { contrast: 0.1 }), /^eq=contrast=1\.10.*,unsharp=5:5:0\.5$/);
});

test("extractJson survives fences, prose and sloppy quotes", () => {
  assert.deepEqual(extractJson('Вот:\n```json\n{"a": 1}\n```\nИспользуйте код с осторожностью.'), { a: 1 });
  assert.deepEqual(extractJson('json\n{"a": {"b": "x}"}} trailing'), { a: { b: "x}" } });
  assert.deepEqual(extractJson("{'a': 2,}"), { a: 2 });
  assert.throws(() => extractJson("no json here"));
});

test("sanitizeClips clamps offsets, validates transitions and accents", () => {
  const clips = sanitizeClips([
    { srcOffset: 500, camera: "drone", transition: "Glitch", accent: "МАЛЬЧИКИ", note: "x" },
    { srcOffset: -3, camera: "face", transition: "warp", accent: ["", "a", "b", "c"], note: "" },
  ] as any, 3, 100, [1, 1, 1]);
  assert.equal(clips.length, 3);
  assert.equal(clips[0].srcOffset, 99);
  assert.equal(clips[0].camera, "auto");
  assert.equal(clips[0].transition, "glitch");
  assert.deepEqual(clips[0].accent, ["МАЛЬЧИКИ"]);
  assert.equal(clips[1].srcOffset, 0);
  assert.equal(clips[1].transition, undefined);
  assert.deepEqual(clips[1].accent, ["a", "b"]);
});

test("limitEpics keeps only the loudest contiguous run of flagged cuts", () => {
  const clips = Array.from({ length: 10 }, (_, i) => ({ srcOffset: i, epic: i >= 2 && i <= 8 }));
  const sections = [0, 0, 0.6, 0.7, 0.9, 1, 0.95, 0.7, 0.6, 0];
  assert.equal(limitEpics(clips, sections, 3), 4);
  assert.deepEqual(clips.map((c, i) => (c.epic ? i : -1)).filter((i) => i >= 0), [4, 5, 6]);
  assert.equal(limitEpics(clips, sections, 3), 0);
});

test("limitReplacements puts proven QA findings first and caps the churn", async () => {
  const { limitReplacements } = await import("../src/edit/conductor.js");
  const critic = Array.from({ length: 12 }, (_, i) => ({ i, reason: "critic" }));
  const qa = [
    { i: 9, kind: "black" as const, detail: "black" },
    { i: 3, kind: "scene-cut" as const, detail: "fixed", fixed: true },
    { i: 5, kind: "freeze" as const, detail: "freeze" },
  ];
  const got = limitReplacements(critic, qa, 16);
  assert.equal(got.length, 4);
  assert.deepEqual(got.map((r) => r.i), [9, 0, 1, 2]);
  assert.equal(got[0].reason, "black");
  assert.equal(limitReplacements([], [], 4).length, 0);
});
