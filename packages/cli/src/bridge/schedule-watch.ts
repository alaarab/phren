import { open, stat } from "node:fs/promises";
import { findPane, paneIdentity, snapshot } from "./herdr.js";
import { readPaneText } from "./pane-text.js";
import { object, objects, type Json, type Provider } from "./protocol.js";
import { transcriptPath } from "./transcripts.js";
import { stripTerminal } from "../terminal-text.js";
import type { ScheduleHarness, ScheduleRunOutcome } from "./schedule-format.js";

/** Watching a scheduled run in its Herdr pane: how it ended, whether the final
 * reply asks the owner something, and a startup screen that blocked it. */

export const STARTUP_BLOCK_WINDOW_MS = 90_000;
export const STARTUP_BLOCK_WINDOW_OPEN_MS = 5_000;
const STARTUP_LATE_TRANSCRIPT_MS = 30_000;
const STARTUP_PANE_READ_LIMIT = 3;
const STARTUP_PROMPT_TAIL_LINES = 12;
const STARTUP_BLOCK_STATUSES = ["blocked", "waiting"];
const STARTUP_PROMPT_MARKER = /[?❯]|\(y\/?n\)|^\s*\d+[.)]\s/m;

export function classifyStartupBlock(input: { elapsedMs: number; transcriptActive: boolean; status: unknown; lines: readonly string[] }): string | undefined {
  if (input.elapsedMs < STARTUP_BLOCK_WINDOW_MS || input.elapsedMs > STARTUP_BLOCK_WINDOW_MS + STARTUP_BLOCK_WINDOW_OPEN_MS) return undefined;
  if (input.transcriptActive) return undefined;
  if (!STARTUP_BLOCK_STATUSES.includes(String(input.status))) return undefined;
  const lines = input.lines.map(line => stripTerminal(line).trim()).filter(Boolean);
  const text = lines.slice(-STARTUP_PROMPT_TAIL_LINES).join("\n");
  if (!text || !STARTUP_PROMPT_MARKER.test(text)) return undefined;
  return text.slice(0, 4000);
}

async function paneRecentLines(server: string, paneId: string): Promise<string[]> {
  const text = await readPaneText(server, paneId, { method: "pane.read", source: "recent", lines: 40, what: "Scheduled run pane read" });
  return text ? text.split(/\r?\n/) : [];
}

/** The watch loop's own words for a failure, instead of assuming Herdr went away. */
export function watchFailureReason(error: unknown): string {
  const first = (error instanceof Error ? error.message : String(error)).split("\n")[0].replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 200);
  return `Watching the scheduled prompt failed: ${first || "unknown error"}`;
}

interface StartupWatch {
  source: ScheduleHarness;
  startedAt: number;
  sessionId?: string;
  onBlocked?: (promptText: string) => void | Promise<void>;
}

export interface StartupWatchEnv {
  now?: () => number;
  pause?: (ms: number) => Promise<void>;
  readPane?: (server: string, paneId: string) => Promise<string[]>;
  resolveSession?: (server: string, pane: Json) => Promise<string | undefined>;
  transcriptStamp?: (source: ScheduleHarness, sessionId: string | undefined) => Promise<{ size: number; mtimeMs: number } | undefined>;
  panes?: (server: string) => Promise<Json[]>;
  finalTurn?: (source: ScheduleHarness, sessionId: string | undefined) => Promise<FinalTurn | undefined>;
}

export interface FinalTurn { completed: boolean; lastAssistant?: string }

/** The public text of one assistant row, without reasoning or tool output. */
export function publicAssistant(raw: Json, source: Provider): string | undefined {
  if (source === "codex") {
    const payload = object(raw.payload);
    if (raw.type !== "response_item" || payload.type !== "message" || payload.role !== "assistant" || payload.channel === "analysis") return;
    const text = typeof payload.content === "string" ? payload.content : objects(payload.content)
      .filter(block => ["text", "output_text"].includes(String(block.type))).map(block => String(block.text ?? "")).join("\n");
    return text.trim() || undefined;
  }
  if (source === "claude") {
    const message = object(raw.message);
    if (raw.type !== "assistant" || message.role !== "assistant") return;
    const text = typeof message.content === "string" ? message.content : objects(message.content)
      .filter(block => block.type === "text").map(block => String(block.text ?? "")).join("\n");
    return text.trim() || undefined;
  }
  if (source === "opencode") {
    const data = object(raw.data), message = object(data.message);
    if (raw.type !== "assistant/message" || message.role !== "assistant") return;
    const text = typeof message.content === "string" ? message.content : objects(message.content)
      .filter(block => block.type === "text").map(block => String(block.text ?? "")).join("\n");
    return text.trim() || undefined;
  }
  return;
}

const FINAL_TURN_TAIL_BYTES = 512 * 1024;

/** A turn's end as the harness writes it: Claude's end_turn reply or its
 * turn_duration record, Codex's task_complete, opencode's end_turn step. */
function turnEnded(raw: Json, source: ScheduleHarness): boolean {
  const payload = object(raw.payload), message = object(raw.message), data = object(raw.data);
  if (source === "claude") return (raw.type === "assistant" && message.stop_reason === "end_turn")
    || (raw.type === "system" && raw.subtype === "turn_duration");
  if (source === "codex") return raw.type === "event_msg" && ["task_complete", "task_completed"].includes(String(payload.type));
  return data.stop_reason === "end_turn";
}

/** The last assistant reply in a transcript and whether its turn finished.
 * A person's message after the reply opens a new turn, so it clears both. */
export function finalTurnFromLines(lines: readonly string[], source: ScheduleHarness): FinalTurn {
  let completed = false, lastAssistant: string | undefined;
  for (const line of lines) {
    if (!line.trim()) continue;
    let raw: Json;
    try { raw = object(JSON.parse(line)); } catch { continue; }
    const payload = object(raw.payload);
    const userTurn = source === "claude" ? raw.type === "user" && !raw.isMeta && typeof object(raw.message).content === "string"
      : source === "codex" ? raw.type === "response_item" && payload.type === "message" && payload.role === "user"
      : raw.type === "user/message";
    if (userTurn) { completed = false; lastAssistant = undefined; continue; }
    const text = publicAssistant(raw, source);
    if (text) { lastAssistant = text; completed = false; }
    if (turnEnded(raw, source)) completed = true;
  }
  return { completed, ...(lastAssistant ? { lastAssistant } : {}) };
}

/** The final turn of a conversation, read from the tail of its transcript. */
export async function readFinalTurn(source: ScheduleHarness, sessionId: string | undefined): Promise<FinalTurn | undefined> {
  if (!sessionId) return undefined;
  const file = await transcriptPath(source, sessionId).catch(() => undefined);
  if (!file) return undefined;
  const handle = await open(file, "r").catch(() => undefined);
  if (!handle) return undefined;
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - FINAL_TURN_TAIL_BYTES), buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer.toString("utf8").split("\n");
    return finalTurnFromLines(start > 0 ? lines.slice(1) : lines, source);
  } catch { return undefined; } finally { await handle.close().catch(() => undefined); }
}

const OPTION_LINE = /^\s*(?:[-*]\s+)?\(?\d{1,2}[.)]\s+\S/;
const CHOICE_WORDS = /\b(?:choose|pick|which|options?|prefer|want|should I|shall I|let me know|decide|approve|confirm|go ahead)\b/i;

function plainLine(line: string): string {
  return line.replace(/[*_`#>]+/g, "").replace(/\s+/g, " ").trim().slice(0, 200);
}

/** When a finished reply ends by asking the owner something (a question, or
 * numbered options introduced as a choice), the question's first line. */
export function ownerQuestion(text: string): string | undefined {
  const lines = text.replace(/\r/g, "").split("\n").map(line => line.trimEnd());
  while (lines.length && !lines.at(-1)!.trim()) lines.pop();
  if (!lines.length) return undefined;
  let end = lines.length;
  while (end > 0 && OPTION_LINE.test(lines[end - 1])) end--;
  if (lines.length - end >= 2) {
    let intro = end - 1;
    while (intro >= 0 && !lines[intro].trim()) intro--;
    const line = intro >= 0 ? plainLine(lines[intro]) : "";
    return line && (line.endsWith("?") || (line.endsWith(":") && CHOICE_WORDS.test(line))) ? line : undefined;
  }
  const last = plainLine(lines.at(-1)!);
  if (!/\?\)?$/.test(last)) return undefined;
  let first = lines.length - 1;
  while (first > 0 && lines[first - 1].trim() && !OPTION_LINE.test(lines[first - 1])) first--;
  return plainLine(lines[first]) || last;
}

async function realTranscriptStamp(source: ScheduleHarness, sessionId: string | undefined): Promise<{ size: number; mtimeMs: number } | undefined> {
  if (!sessionId) return undefined;
  const file = await transcriptPath(source, sessionId).catch(() => undefined);
  const metadata = file ? await stat(file).catch(() => undefined) : undefined;
  return metadata ? { size: metadata.size, mtimeMs: metadata.mtimeMs } : undefined;
}

export async function watchHerdrRun(server: string, target: { workspaceId: string; tabId: string; paneId: string }, signal: AbortSignal,
  startup: StartupWatch, env: StartupWatchEnv = {}): Promise<ScheduleRunOutcome> {
  const now = env.now ?? Date.now;
  const pause = env.pause ?? ((ms: number) => new Promise<void>(resolve => { const timer = setTimeout(resolve, ms); timer.unref(); }));
  const readPane = env.readPane ?? paneRecentLines;
  const resolveSession = env.resolveSession ?? ((name: string, pane: Json) => paneIdentity(name, pane).catch(() => undefined));
  const transcriptStamp = env.transcriptStamp ?? realTranscriptStamp;
  const listPanes = env.panes ?? (async (name: string) => objects((await snapshot(name)).panes));
  const finalTurn = env.finalTurn ?? readFinalTurn;
  let sessionId = startup.sessionId;
  let transcriptActive = false;
  let stamp: { size: number; mtimeMs: number } | undefined;
  let recordedBlock = false;
  let paneReads = 0;
  while (!signal.aborted) {
    await pause(1000);
    if (signal.aborted) break;
    try {
      const pane = findPane({ panes: await listPanes(server) }, { workspace: target.workspaceId, tab: target.tabId, pane: target.paneId });
      if (!pane) return { status: "failed", reason: "The Herdr pane closed before the scheduled prompt finished." };
      const status = String(pane.agent_status);
      // Herdr reports a finished turn as idle, or as done until someone looks
      // at the pane. Either one is the agent stopping on its own.
      if (status === "idle" || status === "done") {
        if (!sessionId) sessionId = await resolveSession(server, pane);
        const turn = await finalTurn(startup.source, sessionId).catch(() => undefined);
        const question = turn?.completed && turn.lastAssistant ? ownerQuestion(turn.lastAssistant) : undefined;
        return question ? { status: "needs-you", reason: question } : { status: "finished" };
      }
      if (!["working", "starting", "blocked", "waiting", "unknown"].includes(status)) {
        return { status: "failed", reason: "The scheduled agent stopped before the prompt finished." };
      }
      const elapsedMs = now() - startup.startedAt;
      const withinWindow = elapsedMs <= STARTUP_BLOCK_WINDOW_MS + STARTUP_BLOCK_WINDOW_OPEN_MS;
      if (!transcriptActive && startup.onBlocked && !recordedBlock && withinWindow) {
        if (!sessionId) sessionId = await resolveSession(server, pane);
        const next = await transcriptStamp(startup.source, sessionId);
        if (next) {
          if (!stamp) {
            stamp = next;
            if (elapsedMs > STARTUP_LATE_TRANSCRIPT_MS) transcriptActive = true;
          } else if (next.size !== stamp.size || next.mtimeMs !== stamp.mtimeMs) {
            stamp = next;
            transcriptActive = true;
          }
        }
      }
      if (!recordedBlock && startup.onBlocked && withinWindow && !transcriptActive
          && elapsedMs >= STARTUP_BLOCK_WINDOW_MS && STARTUP_BLOCK_STATUSES.includes(status)
          && paneReads < STARTUP_PANE_READ_LIMIT) {
        paneReads++;
        const lines = await readPane(server, target.paneId);
        const prompt = classifyStartupBlock({ elapsedMs, transcriptActive, status, lines });
        if (prompt) {
          recordedBlock = true;
          await Promise.resolve(startup.onBlocked(prompt)).catch(() => undefined);
        }
      }
    } catch (error) { return { status: "failed", reason: watchFailureReason(error) }; }
  }
  return { status: "failed", reason: "Phren Hook stopped while the scheduled prompt was running." };
}
