import "./env.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile } from "node:fs/promises";
import express from "express";
import multer from "multer";
import { makeEdit } from "./edit/montage.js";
import { refine } from "./edit/refine.js";
import { conduct, type ConductEvent } from "./edit/conductor.js";
import { digestToPrompt, directRefine } from "./edit/director.js";
import { siberiEnabled } from "./edit/llm.js";
import { downloadUrl, readDigest } from "./understand.js";
import { probeDuration } from "./ffmpeg.js";
import type { Edl } from "./edit/edl.js";
import type { TranscriptSeg } from "./edit/subtitles.js";
import type { Format } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const PUBLIC = path.join(ROOT, "public");
const UPLOADS = path.join(ROOT, "uploads");
const OUTPUT = path.join(ROOT, "output");
const CACHE = path.join(OUTPUT, ".cache");

await mkdir(UPLOADS, { recursive: true });
await mkdir(OUTPUT, { recursive: true });

const upload = multer({ dest: UPLOADS });
const app = express();
app.use(express.json());
app.use(express.static(PUBLIC));
app.use("/output", express.static(OUTPUT));

interface Job {
  logs: string[];
  events: object[];
  clients: express.Response[];
  done: boolean;
  videoUrl?: string;
  error?: string;
}
const jobs = new Map<string, Job>();

function send(job: Job, payload: object): void {
  const line = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of job.clients) res.write(line);
}

const urlOf = (file: string) => `/output/${path.relative(OUTPUT, file).split(path.sep).join("/")}`;

// Server-Sent Events stream of a job's progress (replays history, then live).
app.get("/api/logs/:id", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();
  const job = jobs.get(req.params.id);
  if (!job) {
    res.write(`data: ${JSON.stringify({ error: "Неизвестная задача" })}\n\n`);
    return;
  }
  for (const l of job.logs) res.write(`data: ${JSON.stringify({ log: l })}\n\n`);
  for (const e of job.events) res.write(`data: ${JSON.stringify(e)}\n\n`);
  if (job.done) {
    res.write(`data: ${JSON.stringify({ done: true, videoUrl: job.videoUrl, error: job.error })}\n\n`);
    res.end();
    return;
  }
  job.clients.push(res);
  req.on("close", () => {
    job.clients = job.clients.filter((c) => c !== res);
  });
});

app.get("/api/status", (_req, res) => {
  res.json({ siberi: siberiEnabled() });
});

function newJob(): { id: string; job: Job; log: (m: string) => void; emit: (e: object) => void } {
  const id = Date.now().toString(36);
  const job: Job = { logs: [], events: [], clients: [], done: false };
  jobs.set(id, job);
  return {
    id,
    job,
    log: (m) => { job.logs.push(m); send(job, { log: m }); },
    emit: (e) => { job.events.push(e); send(job, e); },
  };
}

function finish(job: Job, log: (m: string) => void, video?: string, err?: unknown): void {
  if (video) {
    job.videoUrl = urlOf(video);
    log("✅ Готово!");
  } else {
    job.error = err instanceof Error ? err.message : String(err);
    log(`❌ ${job.error}`);
  }
  job.done = true;
  send(job, { done: true, videoUrl: job.videoUrl, error: job.error });
}

const fields = upload.fields([{ name: "style" }, { name: "working" }, { name: "music" }]);

app.post("/api/generate", fields, (req, res) => {
  const files = req.files as Record<string, Express.Multer.File[]>;
  const file = (k: string) => files?.[k]?.[0];
  const url = (k: string) => (typeof req.body[`${k}Url`] === "string" ? req.body[`${k}Url`].trim() : "");
  const maxDuration = req.body.maxDuration ? Number(req.body.maxDuration) : undefined;
  const prompt = typeof req.body.prompt === "string" ? req.body.prompt.trim() : "";
  const format: Format = req.body.format === "vertical" ? "vertical" : "square";
  const review = req.body.review !== "0";
  const maxRounds = req.body.rounds !== undefined ? Number(req.body.rounds) : 2;

  const hasWorking = file("working") || url("working");
  const hasMusic = file("music") || url("music");
  if (!hasWorking || !hasMusic) {
    res.status(400).json({ error: "Нужны минимум: видео-материал и музыка (файлом или ссылкой)." });
    return;
  }

  const { id, job, log, emit } = newJob();
  res.json({ jobId: id });

  // Resolve each slot to a local path: uploaded file wins, else download the URL.
  const resolve = async (k: string, kind: "video" | "audio") => {
    const f = file(k);
    if (f) return { path: f.path, name: f.originalname };
    const u = url(k);
    if (u) return { path: await downloadUrl(u, UPLOADS, `${id}_${k}`, kind, log), name: u };
    return null;
  };

  void (async () => {
    try {
      let styleSlot: { path: string; name: string } | null = null;
      try {
        styleSlot = await resolve("style", "video");
      } catch (e) {
        log(`⚠ стиль не получен (${e instanceof Error ? e.message : e}) — собираю без стиля`);
      }
      const working = await resolve("working", "video");
      const music = await resolve("music", "audio");
      if (!working || !music) throw new Error("Не удалось получить материал/музыку.");

      log(`📥 Материал: ${working.name}`);
      log(`🎵 Музыка: ${music.name}`);
      if (styleSlot) log(`🎨 Стиль-референс: ${styleSlot.name}`);

      const outDir = path.join(OUTPUT, `web-${id}`);
      const onEvent = (e: ConductEvent) => {
        if (e.type === "style") {
          emit({ style: e.style, sheets: e.sheets.map((s) => urlOf(path.join(outDir, s))) });
        } else {
          const r = e.report;
          emit({
            round: {
              ...r,
              video: urlOf(r.video),
              sheet: urlOf(path.join(outDir, `review-r${r.round}.jpg`)),
            },
          });
        }
      };
      const result = await conduct({
        source: working.path,
        music: music.path,
        reference: styleSlot?.path,
        prompt,
        maxDuration,
        format,
        outDir,
        cacheRoot: CACHE,
        review,
        maxRounds,
      }, log, onEvent);
      finish(job, log, result.video);
    } catch (e) {
      finish(job, log, undefined, e);
    }
  })();
});

// Prompt-based refinement of an existing edit: load its EDL, apply the instruction, re-render.
app.post("/api/refine", async (req, res) => {
  const jobId = String(req.body?.jobId ?? "");
  const instruction = String(req.body?.instruction ?? "").trim();
  if (!jobId || !instruction) {
    res.status(400).json({ error: "Нужны jobId и текст правки." });
    return;
  }
  const editJson = path.join(OUTPUT, `web-${jobId}`, "edit.json");
  let edl: Edl;
  try {
    edl = JSON.parse(await readFile(editJson, "utf8")) as Edl;
  } catch {
    res.status(404).json({ error: "Не нашёл исходный эдит для правки." });
    return;
  }

  const { id, job, log } = newJob();
  res.json({ jobId: id });

  void (async () => {
    try {
      log(`✏ Правка: «${instruction}»`);
      // The director understands free-form instructions (and sees the footage digest,
      // so "replace it with a funnier moment" works); the deterministic parser
      // (темнее/вспышки/замени с N по M) is the fallback when the LLM is down.
      const digest = await readDigest(edl.source);
      const footage = { srcDur: edl.srcDur ?? (await probeDuration(edl.source)), digestText: digest ? digestToPrompt(digest) : undefined };
      let refined: Edl;
      let actions: string[];
      const viaLlm = await directRefine(edl, instruction, log, footage);
      if (viaLlm) {
        ({ edl: refined, actions } = viaLlm);
      } else {
        log("⚠ Режиссёр не ответил — применяю детерминированный разбор");
        ({ edl: refined, actions } = refine(edl, instruction));
      }
      for (const a of actions) log(`   → ${a}`);
      let transcript: TranscriptSeg[] | undefined;
      if (edl.transcript) transcript = JSON.parse(await readFile(edl.transcript, "utf8").catch(() => "[]"));
      const result = await makeEdit({
        music: refined.music, source: refined.source, outDir: path.join(OUTPUT, `web-${id}`),
        onProgress: log, maxDuration: refined.maxDuration, edl: refined, format: refined.format,
        transcript, cacheDir: path.join(CACHE, "clips"),
      });
      finish(job, log, result.video);
    } catch (e) {
      finish(job, log, undefined, e);
    }
  })();
});

const PORT = Number(process.env.PORT ?? 5174);
app.listen(PORT, () => console.log(`\n🌐 promptcut UI: http://localhost:${PORT}  ·  Siberi: ${siberiEnabled() ? "подключён" : "нет ключа"}\n`));
