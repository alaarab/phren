import * as fs from "fs";
import * as path from "path";
import { lookupEventsLogFile } from "../phren-paths.js";
import { debugLog } from "../shared.js";
import { errorMessage } from "../utils.js";

const MAX_LOG_LINES = 500;
const ROTATE_BYTES = 500_000;
const MAX_SNIPPET_CHARS = 240;

/**
 * A single "lookup event" — emitted each time a memory search lands on a result.
 * Powers the live activity feed in the web UI (SSE) and the VS Code extension
 * (file watcher). Kept deliberately compact so the JSONL stays cheap to tail.
 */
export interface LookupEvent {
  /** ISO timestamp of when the lookup happened. */
  at: string;
  /** The search query that surfaced this memory. */
  query: string;
  /** Project the memory belongs to. */
  project: string;
  /** Memory filename (e.g. "findings.md", "reference/api/auth.md"). */
  filename: string;
  /** Doc type: findings, reference, summary, task, skill, claude. */
  type: string;
  /** Source key / path of the memory, when available. */
  path?: string;
  /** Short snippet of the matched content. */
  snippet?: string;
  /** What triggered the lookup: "search" (MCP search) | "inject" (hook). */
  source: string;
  /** Originating session id, when known. */
  session?: string;
}

function clampSnippet(snippet: string | undefined): string | undefined {
  if (!snippet) return undefined;
  const flat = snippet.replace(/\s+/g, " ").trim();
  if (flat.length <= MAX_SNIPPET_CHARS) return flat;
  return flat.slice(0, MAX_SNIPPET_CHARS - 1) + "…";
}

/**
 * Append one or more lookup events to the live log. Best-effort: a logging
 * failure must never break a search, so all errors are swallowed (debug-logged).
 */
export function recordLookupEvents(
  phrenPath: string,
  events: Array<Omit<LookupEvent, "at"> & { at?: string }>,
): void {
  if (!events.length) return;
  const logPath = lookupEventsLogFile(phrenPath);
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const now = new Date().toISOString();
    const lines = events.map((e) =>
      JSON.stringify({
        at: e.at ?? now,
        query: e.query,
        project: e.project,
        filename: e.filename,
        type: e.type,
        ...(e.path ? { path: e.path } : {}),
        ...(e.snippet ? { snippet: clampSnippet(e.snippet) } : {}),
        source: e.source,
        ...(e.session ? { session: e.session } : {}),
      }),
    );
    fs.appendFileSync(logPath, lines.join("\n") + "\n");
  } catch (err: unknown) {
    debugLog(`recordLookupEvents write failed: ${errorMessage(err)}`);
    return;
  }

  try {
    const stat = fs.statSync(logPath);
    if (stat.size > ROTATE_BYTES) {
      const content = fs.readFileSync(logPath, "utf8");
      const kept = content.split("\n").filter(Boolean).slice(-MAX_LOG_LINES);
      fs.writeFileSync(logPath, kept.join("\n") + "\n");
    }
  } catch (err: unknown) {
    debugLog(`recordLookupEvents rotation failed: ${errorMessage(err)}`);
  }
}

/** Read the most recent lookup events (newest first), parsed from the JSONL log. */
export function readRecentLookups(phrenPath: string, limit = 40): LookupEvent[] {
  const logPath = lookupEventsLogFile(phrenPath);
  try {
    if (!fs.existsSync(logPath)) return [];
    const lines = fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean);
    const recent = lines.slice(-limit).reverse();
    const out: LookupEvent[] = [];
    for (const line of recent) {
      try {
        const parsed = JSON.parse(line) as LookupEvent;
        if (parsed && typeof parsed.at === "string") out.push(parsed);
      } catch {
        // Skip malformed lines rather than failing the whole read.
      }
    }
    return out;
  } catch (err: unknown) {
    debugLog(`readRecentLookups failed: ${errorMessage(err)}`);
    return [];
  }
}
