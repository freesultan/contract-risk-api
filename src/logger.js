import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Append-only JSONL usage log. This is the evidence source for Phase 2 —
// numbers reported later must trace back to lines in this file, not estimates.
export const LOG_PATH = process.env.USAGE_LOG_PATH || path.join(__dirname, "..", "usage.log.jsonl");

export function logUsage(record) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...record }) + "\n";
  fs.appendFile(LOG_PATH, line, (err) => {
    if (err) console.error("Failed to write usage log:", err);
  });
}
