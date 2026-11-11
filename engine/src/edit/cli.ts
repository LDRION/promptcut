import "../env.js";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { makeEdit, planEdit } from "./montage.js";
import { conduct } from "./conductor.js";
import { readStyle } from "./stylist.js";
import { measureStyle } from "../understand.js";
import { loadEdl } from "./edl.js";
import { assertFfmpegAvailable } from "../ffmpeg.js";
import type { Format } from "../config.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const log = (m: string) => console.log(`  ${m}`);

/** plan: beats → the cut grid the director must fill (one clip per cut). */
async function cmdPlan(): Promise<void> {
  const music = arg("music");
  if (!music) throw new Error("plan: --music <file> required");
  const max = arg("max") ? Number(arg("max")) : undefined;
  await assertFfmpegAvailable();
  const plan = await planEdit(music, max);
  const out = arg("out") ?? "plan.json";
  await writeFile(out, JSON.stringify(plan, null, 2));
  console.log(`\nTempo ${plan.tempo} BPM · ${plan.nClips} cuts · music ${plan.musicDur.toFixed(1)}s`);
  for (const c of plan.cuts) {
    console.log(
      `  #${String(c.i).padStart(3)}  ${c.start.toFixed(2).padStart(7)}s  ` +
        `dur ${c.dur.toFixed(2)}s  ${c.band.padEnd(6)} (${c.section})`,
    );
  }
  console.log(`\nPlan → ${out}. Author an EDL with ${plan.nClips} clips, then: render --edl <edl.json>\n`);
}

/** render: an EDL (director's choices) — or --music/--source for the old auto mode. */
async function cmdRender(): Promise<void> {
  await assertFfmpegAvailable();
  const edlPath = arg("edl");

  let music: string;
  let source: string;
  let max: number | undefined;
  let edl;
  if (edlPath) {
    edl = await loadEdl(edlPath);
    music = edl.music;
    source = edl.source;
    max = edl.maxDuration;
  } else {
    music = arg("music") ?? "";
    source = arg("source") ?? "";
    max = arg("max") ? Number(arg("max")) : undefined;
    if (!music || !source) {
      throw new Error("render: provide --edl <file> OR --music <file> --source <file>");
    }
  }

  const outDir = arg("out") ?? path.join("output", `edit-${Date.now()}`);
  const format = (arg("format") as Format) ?? edl?.format ?? "square";
  console.log(`\n🎬 render\n  music:  ${music}\n  source: ${source}${edlPath ? `\n  edl:    ${edlPath}` : ""}\n  format: ${format}\n`);
  const result = await makeEdit({ music, source, outDir, onProgress: log, maxDuration: max, edl, format });
  console.log(`\n✅ ${result.video}\n`);
}

/** style: Siberi reads a reference edit → style profile JSON. */
async function cmdStyle(): Promise<void> {
  const ref = process.argv[3];
  if (!ref) throw new Error("style: <reference video> required");
  const outDir = arg("out") ?? path.join("output", `style-${Date.now()}`);
  await mkdir(outDir, { recursive: true });
  const measured = await measureStyle(ref, path.resolve(outDir, "measured.json"), log);
  const profile = await readStyle({ reference: ref, measured, workDir: outDir }, log);
  await writeFile(path.join(outDir, "style.json"), JSON.stringify(profile, null, 2));
  console.log(`\n${JSON.stringify(profile, null, 2)}\n\n✅ ${path.join(outDir, "style.json")}\n`);
}

/** make: the full Siberi-conducted pipeline — style → direct → render → review → fix. */
async function cmdMake(): Promise<void> {
  await assertFfmpegAvailable();
  const source = arg("source");
  const music = arg("music");
  if (!source || !music) throw new Error("make: --source <video> --music <audio> required");
  const outDir = arg("out") ?? path.join("output", `make-${Date.now()}`);
  const result = await conduct({
    source,
    music,
    reference: arg("style"),
    prompt: arg("prompt"),
    maxDuration: arg("max") ? Number(arg("max")) : undefined,
    format: (arg("format") as Format) ?? "square",
    outDir,
    cacheRoot: path.join("output", ".cache"),
    review: arg("review") !== "0",
    maxRounds: arg("rounds") ? Number(arg("rounds")) : undefined,
  }, log);
  const scores = result.rounds.map((r) => r.score ?? "—").join(" → ");
  console.log(`\n✅ ${result.video}\n   оценки по раундам: ${scores} · лучший: раунд ${result.best}\n`);
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (cmd === "make") return cmdMake();
  if (cmd === "style") return cmdStyle();
  if (cmd === "plan") return cmdPlan();
  if (cmd === "render") return cmdRender();
  console.error(
    "Usage:\n" +
      "  make   --source <video> --music <audio> [--style <ref video>] [--prompt \"…\"]\n" +
      "         [--max N] [--format square|vertical] [--rounds 2] [--review 0] [--out <dir>]\n" +
      "  style  <ref video> [--out <dir>]\n" +
      "  plan   --music <file> [--max N] [--out plan.json]\n" +
      "  render --edl <edl.json> [--out <dir>]\n" +
      "  render --music <file> --source <file> [--max N]   (auto, no EDL)\n",
  );
  process.exit(1);
}

main().catch((e) => {
  console.error(`\n❌ ${e instanceof Error ? e.message : e}\n`);
  process.exit(1);
});
