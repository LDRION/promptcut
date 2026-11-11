import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Load `.env` (repo root, then engine/) into process.env before anything reads it.
 * Variables already set in the shell win — the file only fills the gaps.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = path.join(__dirname, "..");

for (const file of [path.join(ENGINE, "..", ".env"), path.join(ENGINE, ".env")]) {
  if (!existsSync(file)) continue;
  try {
    process.loadEnvFile(file);
  } catch {
    // malformed .env — ignore, the shell env still applies
  }
}
