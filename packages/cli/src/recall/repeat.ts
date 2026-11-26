// Repeat suppression: a bullet the prompt hook injected in this session stays out
// for the next REPEAT_WINDOW prompts, since the agent already has it in context.
// The pipeline only reads the set; the hook owns `.sessions/recall-seen-<session>.json`.

import { createHash } from "crypto";
import * as fs from "fs";
import { debugLog, sessionMarker } from "../phren-paths.js";
import { errorMessage } from "../utils.js";

/** Prompts a bullet stays suppressed for after it was injected. */
export const REPEAT_WINDOW = 12;

/** One session's injection history: its prompt counter and, per bullet hash, the prompt it was last injected at. */
export interface RecallSeen {
  prompt: number;
  seen: Record<string, number>;
}

/** Hash of the chunk selection chose, ignoring metadata comments, case and whitespace. */
export function bulletHash(chunk: string): string {
  const normalised = chunk.replace(/<!--[\s\S]*?-->/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
  return createHash("sha256").update(normalised).digest("hex").slice(0, 16);
}

function seenFile(phrenPath: string, sessionId: string): string {
  return sessionMarker(phrenPath, `recall-seen-${sessionId.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
}

export function readRecallSeen(phrenPath: string, sessionId: string): RecallSeen {
  try {
    const parsed = JSON.parse(fs.readFileSync(seenFile(phrenPath, sessionId), "utf8")) as Partial<RecallSeen>;
    const prompt = typeof parsed.prompt === "number" && Number.isFinite(parsed.prompt) ? parsed.prompt : 0;
    const seen = parsed.seen && typeof parsed.seen === "object" ? parsed.seen : {};
    return { prompt, seen };
  } catch {
    return { prompt: 0, seen: {} };
  }
}

/** Hashes injected within the last `window` prompts before the current one (`state.prompt`). */
export function recentlyInjected(state: RecallSeen, window = REPEAT_WINDOW): Set<string> {
  const recent = new Set<string>();
  for (const [hash, at] of Object.entries(state.seen)) {
    if (typeof at === "number" && state.prompt - at <= window) recent.add(hash);
  }
  return recent;
}

/** Atomic and best-effort; drops entries that have left the window. */
export function writeRecallSeen(phrenPath: string, sessionId: string, state: RecallSeen, window = REPEAT_WINDOW): void {
  const seen: Record<string, number> = {};
  for (const [hash, at] of Object.entries(state.seen)) {
    if (typeof at === "number" && state.prompt - at < window) seen[hash] = at;
  }
  try {
    const file = seenFile(phrenPath, sessionId);
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ prompt: state.prompt, seen }));
    fs.renameSync(tmp, file);
  } catch (err: unknown) {
    debugLog(`recall-seen write failed: ${errorMessage(err)}`);
  }
}

/** After a compact or clear the injected bullets are gone from the agent's context, so they may come back. */
export function clearRecallSeen(phrenPath: string, sessionId: string): void {
  try {
    fs.rmSync(seenFile(phrenPath, sessionId), { force: true });
  } catch (err: unknown) {
    debugLog(`recall-seen clear failed: ${errorMessage(err)}`);
  }
}
