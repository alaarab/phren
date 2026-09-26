// Agent status for the harnesses whose lifecycle hooks do not report turns,
// read from what they write themselves. The tmux snapshot asks; Herdr watches
// its agents and never needs this.
//
// OpenCode: phren's OpenCode plugin records the process's state by PID
// (`opencode-status-<pid>.json` beside the PID binding) from OpenCode's own
// session.status, session.idle and permission events.
// Copilot: its session log (`~/.copilot/session-state/<id>/events.jsonl`)
// brackets every prompt: a user message starts work, a permission request
// waits for an answer, the final answer's turn end (or session.idle, abort)
// finishes it.
import { open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { copilotForegroundSession } from "./herdr.js";
import { object } from "./protocol.js";
import { phrenStoreRoot } from "./transcripts.js";

const STATUSES = new Set(["working", "idle", "blocked"]);

/** What phren's OpenCode plugin last recorded for any of `pids`, newest first. */
export async function opencodeProcessStatus(pids: number[], root = phrenStoreRoot()): Promise<string | undefined> {
  const folder = path.join(root, ".runtime", "sessions");
  let current: string | undefined, latest = -Infinity;
  for (const pid of pids.slice(0, 16)) {
    const file = await open(path.join(folder, `opencode-status-${pid}.json`), "r").catch(() => undefined);
    if (!file) continue;
    try {
      if ((await file.stat()).size > 4_096) continue;
      const value = object(JSON.parse((await file.readFile()).toString("utf8")));
      const at = Date.parse(String(value.at));
      if (typeof value.status !== "string" || !STATUSES.has(value.status) || !(at > latest)) continue;
      current = value.status; latest = at;
    } catch { continue; } finally { await file.close(); }
  }
  return current;
}

/** The status a Copilot session log's lines leave the session in; undefined
 * when none of them says. Copilot writes a turn_start/turn_end pair per model
 * call, so only the turn that carried the final answer ends the work. */
export function copilotStatusFromEvents(lines: string[]): string | undefined {
  let status: string | undefined, final = false;
  const asking = new Set<string>();
  const working = () => asking.size ? "blocked" : "working";
  for (const line of lines) {
    let raw;
    try { raw = object(JSON.parse(line)); } catch { continue; }
    const data = object(raw.data), type = String(raw.type ?? ""), sub = !!raw.agentId;
    switch (type) {
      case "session.start": case "session.resume":
        status = "idle"; final = false; asking.clear(); break;
      case "user.message":
        final = false; status = working(); break;
      case "assistant.turn_start": case "tool.execution_start": case "tool.execution_complete":
        status = working(); break;
      case "assistant.message":
        if (!sub && data.phase === "final_answer") final = true;
        status = working(); break;
      case "assistant.turn_end":
        if (!sub && final && !asking.size) status = "idle"; break;
      case "permission.requested":
        asking.add(String(data.requestId ?? "")); status = "blocked"; break;
      case "permission.completed":
        asking.delete(String(data.requestId ?? "")); status = working(); break;
      case "session.idle": case "abort": case "session.error": case "session.shutdown":
        status = "idle"; final = false; asking.clear(); break;
    }
  }
  return status;
}

const TAIL_BYTES = 262_144;
const copilotCache = new Map<string, { size: number; mtime: number; status: string | undefined }>();

/** The status of the Copilot conversation a process shows, from the tail of
 * its session log; unchanged files are not read again. */
export async function copilotProcessStatus(pids: number[], home = process.env.COPILOT_HOME || path.join(homedir(), ".copilot")): Promise<string | undefined> {
  const session = await copilotForegroundSession(pids, home);
  if (!session) return undefined;
  const file = path.join(home, "session-state", session, "events.jsonl");
  const info = await stat(file).catch(() => undefined);
  if (!info?.isFile()) return undefined;
  const cached = copilotCache.get(file);
  if (cached && cached.size === info.size && cached.mtime === info.mtimeMs) return cached.status;
  const handle = await open(file, "r");
  let text: string;
  try {
    const length = Math.min(info.size, TAIL_BYTES);
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(length), 0, length, info.size - length);
    text = buffer.subarray(0, bytesRead).toString("utf8");
  } finally { await handle.close(); }
  const lines = text.split("\n");
  // A tail that starts mid-line drops that line.
  if (info.size > TAIL_BYTES) lines.shift();
  const status = copilotStatusFromEvents(lines);
  copilotCache.delete(file);
  while (copilotCache.size >= 64) copilotCache.delete(copilotCache.keys().next().value!);
  copilotCache.set(file, { size: info.size, mtime: info.mtimeMs, status });
  return status;
}

/** The status `agent`'s own records give for a pane running `pids`, for the
 * harnesses whose lifecycle hooks say nothing about turns. */
export async function harnessStatus(agent: string, pids: number[]): Promise<string | undefined> {
  if (!pids.length) return undefined;
  if (agent === "opencode") return opencodeProcessStatus(pids);
  if (agent === "copilot") return copilotProcessStatus(pids);
  return undefined;
}
