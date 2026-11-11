import "../env.js";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Siberi AI gateway — the owner's own hosted LLM API (siberi.online). Async task
 * flow: POST /generate {wait:false} returns a taskId; poll GET /result/:taskId until
 * status is "completed" (use `result`) or "error". Siberi also SEES: one image per
 * request via `imageBase64` (bare base64, no data: prefix) — that is how it reads the
 * reference edit and reviews our own render.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = path.join(__dirname, "..", "..", "prompts");

const BASE_URL = process.env.SIBERI_BASE_URL?.trim() || "http://127.0.0.1:5005/api/v1/ai";
const API_KEY = process.env.SIBERI_API_KEY?.trim() || "";

const START_RETRIES = 4;
const POLL_MS = 2500;

// Техническое правило вывода: только чистый JSON — иначе ответ приходится
// вытаскивать из окружающей болтовни.
const OUTPUT_RULE =
  "Формат вывода: ответь РОВНО ОДНИМ JSON-объектом по заданной схеме. " +
  "Никакого текста до или после JSON. Допустим один markdown-блок ```json … ```. " +
  "Строки — только в двойных кавычках.";

type Log = (m: string) => void;

export interface AskOptions {
  /** One image for Siberi to look at: a Buffer (JPEG/PNG bytes) or a base64 string. */
  image?: Buffer | string;
  timeoutMs?: number;
  /** Short name of the step, for logs ("режиссёр", "критик"…). */
  label?: string;
}

export function siberiEnabled(): boolean {
  return Boolean(API_KEY);
}

// Восстанавливает JSON, который LLM сгенерировал со смешанными кавычками:
// одиночные кавычки → двойные, trailing-запятые долой. Только как последний шанс.
function fixMalformedJson(raw: string): string {
  let s = raw.replace(/'/g, '"');
  s = s.replace(/,\s*([}\]])/g, "$1");
  return s;
}

/** Вырезает JSON-объект из ответа: ```json```-блок либо первый сбалансированный {...}. */
export function extractJson(text: string): any {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  let body = fence ? fence[1] : text;
  const start = body.indexOf("{");
  if (start === -1) throw new Error("в ответе нет JSON");
  let depth = 0;
  let end = -1;
  let inStr = false;
  let esc = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i];
    if (esc) { esc = false; continue; }
    if (ch === "\\") { esc = true; continue; }
    if (ch === '"') inStr = !inStr;
    if (inStr) continue;
    if (ch === "{") depth++;
    if (ch === "}") { depth--; if (depth === 0) { end = i; break; } }
  }
  body = end === -1 ? body.slice(start) : body.slice(start, end + 1);
  try {
    return JSON.parse(body);
  } catch {
    return JSON.parse(fixMalformedJson(body));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Сетевой блип (мёртвый keep-alive, таймаут) — повторяем; 429 — ждём дольше.
async function startTask(body: object, log: Log): Promise<string> {
  if (!API_KEY) throw new Error("SIBERI_API_KEY не задан — см. .env.example");
  let lastErr: unknown;
  for (let attempt = 1; attempt <= START_RETRIES; attempt++) {
    try {
      const res = await fetch(`${BASE_URL}/generate`, {
        method: "POST",
        headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 429) {
        lastErr = new Error("Siberi 429 (лимит запросов)");
        log(`   Siberi: лимит запросов — жду ${20 * attempt}с…`);
        await sleep(20_000 * attempt);
        continue;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Siberi ${res.status} ${text.slice(0, 200)}`);
      }
      const started = await res.json();
      if (!started.taskId) throw new Error("Siberi: нет taskId в ответе /generate");
      return String(started.taskId);
    } catch (e) {
      lastErr = e;
      if (e instanceof Error && /Siberi 4\d\d/.test(e.message) && !/429/.test(e.message)) throw e;
      if (attempt < START_RETRIES) await sleep(800 * attempt);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function pollResult(taskId: string, deadline: number): Promise<string> {
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    let data: any;
    try {
      const res = await fetch(`${BASE_URL}/result/${taskId}`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) continue;
      data = await res.json();
    } catch {
      continue; // один упавший тик поллинга — не повод ронять задачу
    }
    if (data.status === "completed") {
      const text = String(data.result ?? "").trim();
      if (!text) throw new Error("Siberi: пустой результат");
      return text;
    }
    if (data.status === "error") throw new Error(`Siberi: ошибка задачи — ${data.error || "неизвестно"}`);
  }
  throw new Error("Siberi: таймаут ожидания результата");
}

/** system + user (+ optional image) → raw text answer. */
export async function ask(system: string, user: string, log: Log, opts: AskOptions = {}): Promise<string> {
  const { timeoutMs = 180_000, label = "Siberi" } = opts;
  const body: Record<string, unknown> = { prompt: user, system, wait: false };
  if (opts.image) {
    body.imageBase64 = Buffer.isBuffer(opts.image)
      ? opts.image.toString("base64")
      : opts.image.replace(/^data:image\/[^;]+;base64,/, "");
  }
  const t0 = Date.now();
  log(`🚀 ${label}: запрос в Siberi${opts.image ? " (с картинкой)" : ""}…`);
  const taskId = await startTask(body, log);
  const text = await pollResult(taskId, t0 + timeoutMs);
  log(`   ${label}: ответ за ${Math.round((Date.now() - t0) / 1000)}с`);
  return text;
}

/**
 * system + user (+ image) → parsed JSON. If the model answers with prose instead of
 * JSON, ask once more with a hard reminder rather than failing the whole step.
 */
export async function askJson(system: string, user: string, log: Log, opts: AskOptions = {}): Promise<any> {
  const sys = `${system}\n\n${OUTPUT_RULE}`;
  const text = await ask(sys, user, log, opts);
  try {
    return extractJson(text);
  } catch {
    log(`   ${opts.label ?? "Siberi"}: ответ не JSON — переспрашиваю`);
    const retry = await ask(sys, `${user}\n\nВАЖНО: верни ТОЛЬКО JSON-объект по схеме, без пояснений.`, log, opts);
    return extractJson(retry);
  }
}

/** Prompts live in engine/prompts/ — edits are picked up on every request, no restart. */
export function loadPrompt(name: string, fallback: string): string {
  try {
    const text = readFileSync(path.join(PROMPTS_DIR, name), "utf8").trim();
    return text || fallback;
  } catch {
    return fallback;
  }
}

/** The director's system prompt (engine/prompts/system-prompt.md). */
export function loadSystemPrompt(fallback: string): string {
  return loadPrompt("system-prompt.md", fallback);
}
