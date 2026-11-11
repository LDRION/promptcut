import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT = 120_000; // a single ffmpeg call should never take this long

/** Run a command, killing it if it hangs, rejecting on non-zero exit with captured stderr. */
export function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd });
    let stderr = "";
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      reject(new Error(`${cmd} timed out after ${(opts.timeoutMs ?? DEFAULT_TIMEOUT) / 1000}s and was killed.`));
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT);
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to start "${cmd}". Is it installed and on PATH?\n${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${code}.\n${stderr.slice(-2000)}`));
    });
  });
}

/** Run a command and return its stdout as a Buffer (killing it if it hangs). */
export function runCapture(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd });
    const chunks: Buffer[] = [];
    let stderr = "";
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      reject(new Error(`${cmd} timed out after ${(opts.timeoutMs ?? DEFAULT_TIMEOUT) / 1000}s and was killed.`));
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT);
    child.stdout.on("data", (d) => chunks.push(d as Buffer));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to start "${cmd}". ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`${cmd} exited with code ${code}.\n${stderr.slice(-2000)}`));
    });
  });
}

/** Confirm ffmpeg + ffprobe exist before we start spending API calls on a render. */
export async function assertFfmpegAvailable(): Promise<void> {
  try {
    await run("ffmpeg", ["-version"]);
    await run("ffprobe", ["-version"]);
  } catch {
    throw new Error(
      "ffmpeg/ffprobe not found on PATH. Install FFmpeg (https://ffmpeg.org/download.html) " +
        "or run with --no-render to stop before video assembly.",
    );
  }
}

/** Duration of a media file in seconds, via ffprobe. */
export function probeDuration(path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      path,
    ]);
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.on("error", reject);
    child.on("close", () => {
      const seconds = parseFloat(out.trim());
      if (Number.isFinite(seconds)) resolve(seconds);
      else reject(new Error(`Could not read duration of ${path}`));
    });
  });
}
