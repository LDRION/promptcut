import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  assignTransitions, entryFilter, exitFilter, mixOf, normalizeMix, TRANSITIONS,
} from "../src/edit/transitions.js";

test("normalizeMix drops unknown keys and sums to 1", () => {
  const mix = normalizeMix({ cut: 2, zoom: 1, sparkle: 5, flash: -1, whip: "1" })!;
  assert.deepEqual(Object.keys(mix).sort(), ["cut", "whip", "zoom"]);
  const sum = Object.values(mix).reduce((a, b) => a + (b ?? 0), 0);
  assert.ok(Math.abs(sum - 1) < 0.01);
  assert.equal(normalizeMix({ nope: 1 }), undefined);
  assert.equal(normalizeMix(null), undefined);
});

test("assignTransitions is deterministic, starts clean, never 3 flashy in a row", () => {
  const bands = Array.from({ length: 60 }, (_, i) => (i % 10 < 4 ? "chorus" : i % 10 < 7 ? "build" : "verse") as const);
  const mix = { cut: 0.1, flash: 0.9 };
  const a = assignTransitions(bands, mix);
  assert.deepEqual(a, assignTransitions(bands, mix));
  assert.equal(a[0], "cut");
  for (let i = 2; i < a.length; i++) {
    if (a[i] !== "cut") assert.ok(!(a[i] === a[i - 1] && a[i] === a[i - 2]), `3x ${a[i]} at ${i}`);
  }
});

test("assignTransitions follows the mix", () => {
  const bands = Array.from({ length: 400 }, () => "build" as const);
  const got = mixOf(assignTransitions(bands, { cut: 0.5, zoom: 0.5 }));
  assert.ok((got.cut ?? 0) > 0.35 && (got.zoom ?? 0) > 0.35, JSON.stringify(got));
  assert.equal(got.glitch, undefined);
});

test("exit fades only for flash/dip into a long enough clip", () => {
  assert.match(exitFilter("flash", 1), /color=white/);
  assert.match(exitFilter("dip", 1), /fade=t=out/);
  assert.equal(exitFilter("zoom", 1), "");
  assert.equal(exitFilter("dip", 0.2), "");
});

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

test("every entry filter is a valid ffmpeg graph", { skip: !hasFfmpeg }, () => {
  for (const t of TRANSITIONS) {
    const vf = `format=yuv420p${entryFilter(t, 96, 30)}${exitFilter("flash", 0.5)}`;
    const r = spawnSync("ffmpeg", [
      "-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=96x96:rate=30",
      "-t", "0.5", "-vf", vf, "-f", "null", "-",
    ], { encoding: "utf8" });
    assert.equal(r.status, 0, `${t}: ${r.stderr}`);
  }
});
