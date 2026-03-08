import * as fs from "fs";
import * as path from "path";
import { appendAuditLog as appendAuditLogShared, debugLog, runtimeFile } from "./shared.js";

export interface AuditLogEntry {
  at: string;
  event: string;
  details: string;
  raw: string;
}

export const appendAuditLog = appendAuditLogShared;

export function readAuditLog(cortexPath: string, limit: number = 200): AuditLogEntry[] {
  const logPath = runtimeFile(cortexPath, "audit.log");
  if (!fs.existsSync(logPath)) return [];
  try {
    return fs.readFileSync(logPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .slice(-Math.max(0, limit))
      .map((line: string) => {
        const match = line.match(/^\[([^\]]+)\]\s+(\S+)\s*(.*)$/);
        return {
          at: match?.[1] || "",
          event: match?.[2] || "",
          details: match?.[3] || "",
          raw: line,
        };
      });
  } catch (err: unknown) {
    debugLog(`readAuditLog failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

interface RetrievalLogEntry {
  file: string;
  section: string;
  retrievedAt: string;
}

export function recordRetrieval(cortexPath: string, file: string, section: string): void {
  const dir = path.join(cortexPath, ".runtime");
  fs.mkdirSync(dir, { recursive: true });
  const logPath = path.join(dir, "retrieval-log.jsonl");
  const entry: RetrievalLogEntry = { file, section, retrievedAt: new Date().toISOString() };
  fs.appendFileSync(logPath, JSON.stringify(entry) + "\n");

  try {
    const stat = fs.statSync(logPath);
    if (stat.size > 500_000) {
      const content = fs.readFileSync(logPath, "utf8");
      const lines = content.split("\n").filter(Boolean);
      fs.writeFileSync(logPath, lines.slice(-1000).join("\n") + "\n");
    }
  } catch (err: unknown) {
    debugLog(`recordRetrieval rotation failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
