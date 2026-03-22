import * as fs from "fs";
import * as path from "path";
import { debugLog } from "../shared.js";
import { errorMessage } from "../utils.js";

const MAX_LOG_LINES = 1000;

interface AuditLogEntry {
  at: string;
  event: string;
  details: string;
  raw: string;
}

interface RetrievalLogEntry {
  file: string;
  section: string;
  retrievedAt: string;
}

export function recordRetrieval(phrenPath: string, file: string, section: string): void {
  const dir = path.join(phrenPath, ".runtime");
  let logPath: string;
  try {
    fs.mkdirSync(dir, { recursive: true });
    logPath = path.join(dir, "retrieval-log.jsonl");
    const entry: RetrievalLogEntry = { file, section, retrievedAt: new Date().toISOString() };
    fs.appendFileSync(logPath, JSON.stringify(entry) + "\n");
  } catch (err: unknown) {
    debugLog(`recordRetrieval write failed: ${errorMessage(err)}`);
    return;
  }

  try {
    const stat = fs.statSync(logPath);
    if (stat.size > 500_000) {
      const content = fs.readFileSync(logPath, "utf8");
      const lines = content.split("\n").filter(Boolean);
      fs.writeFileSync(logPath, lines.slice(-MAX_LOG_LINES).join("\n") + "\n");
    }
  } catch (err: unknown) {
    debugLog(`recordRetrieval rotation failed: ${errorMessage(err)}`);
  }
}
