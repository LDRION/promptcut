import { test } from "node:test";
import assert from "node:assert/strict";
import { matchGrade, statsOf } from "../src/edit/grade.js";

test("statsOf: flat grey has no saturation or contrast", () => {
  const s = statsOf(new Uint8Array(3 * 100).fill(128))!;
  assert.ok(Math.abs(s.brightness - 128 / 255) < 1e-6);
  assert.equal(s.saturation, 0);
  assert.ok(s.contrast < 1e-6);
  assert.equal(s.warmth, 0);
  assert.equal(statsOf(new Uint8Array(0)), null);
});

test("statsOf: warm red pixels read as warm and saturated", () => {
  const px = new Uint8Array(3 * 10);
  for (let i = 0; i < 10; i++) px.set([200, 60, 40], i * 3);
  const s = statsOf(px)!;
  assert.ok(s.warmth > 0.5 && s.saturation > 0.7);
});

const param = (g: string, k: string) => Number(g.match(new RegExp(`${k}=(-?[\\d.]+)`))![1]);

test("matchGrade darkens, saturates and warms toward a moody reference", () => {
  const ref = { brightness: 0.19, saturation: 0.57, contrast: 0.35, warmth: 0.1 };
  const src = { brightness: 0.51, saturation: 0.14, contrast: 0.48, warmth: 0.02 };
  const g = matchGrade(ref, src);
  assert.ok(param(g, "gamma") < 1, g);
  assert.ok(param(g, "saturation") > 1, g);
  assert.ok(param(g, "contrast") >= 1, g); // dark ≠ flat: never flatten toward a dark ref
  assert.match(g, /colorbalance=rm=0\.\d+:bm=-0\.\d+/);
  assert.match(g, /unsharp/);
});

test("matchGrade is a near no-op for a matching look and stays clamped", () => {
  const look = { brightness: 0.4, saturation: 0.3, contrast: 0.45, warmth: 0.05 };
  const same = matchGrade(look, look, false);
  assert.equal(same, "eq=contrast=1.00:saturation=1.00:gamma=1.00:brightness=0.00");
  const wild = matchGrade({ brightness: 0, saturation: 1, contrast: 1, warmth: -1 }, { brightness: 1, saturation: 0, contrast: 0.01, warmth: 1 });
  assert.ok(param(wild, "gamma") >= 0.72 && param(wild, "saturation") <= 1.8 && param(wild, "contrast") <= 1.3, wild);
});
