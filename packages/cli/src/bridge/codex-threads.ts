import { mkdir, open, readFile, stat, writeFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { bridgeRoot, object, objects, sessionId, type Json } from "./protocol.js";

/** Codex 0.155 keeps a thread's history in `thread_history_1.sqlite` and no
 * longer writes the rollout file its `state_5.sqlite` still names. The Hook
 * materializes such a thread into a rollout-shaped JSONL of its own, append
 * only, so every reader of Codex transcripts keeps working unchanged. */
const MAX_ITEMS = 20_000, OUTPUT_TAIL = 4_000;
const STALLED_AFTER_MS = 10 * 60 * 1_000;

interface Emitted { lastOrdinal: number; maxUpdated: number; count: number; done: Record<string, "call" | "done"> }

export function codexHome(): string { return process.env.CODEX_HOME || path.join(homedir(), ".codex"); }
export function materializedRoot(): string { return path.join(bridgeRoot(), "codex-threads"); }
export function materializedPath(session: string): string { return path.join(materializedRoot(), `${session}.jsonl`); }

type Db = { prepare(sql: string): { all(...args: unknown[]): unknown[]; get(...args: unknown[]): unknown }; close(): void };
async function openReadOnly(file: string): Promise<Db | undefined> {
  try {
    await stat(file);
    const sqlite = await import("node:sqlite");
    return new sqlite.DatabaseSync(file, { readOnly: true }) as unknown as Db;
  } catch { return undefined; }
}

/** Whether the thread store knows this session; cheap enough for a lookup. */
export async function codexThreadExists(session: string): Promise<boolean> {
  if (!sessionId.safeParse(session).success) return false;
  const db = await openReadOnly(path.join(codexHome(), "thread_history_1.sqlite"));
  if (!db) return false;
  try {
    const row = object(db.prepare("select count(*) as n from thread_items where thread_id = ?").get(session));
    return Number(row.n) > 0;
  } catch { return false; } finally { db.close(); }
}

/** A working pane whose projection cursor stopped at an unfinished turn can
 * keep accepting input even though none of it will be readable again. */
export async function threadHealth(session: string, agentStatus: unknown): Promise<{ stalled: boolean; since?: string }> {
  if (!sessionId.safeParse(session).success || !["working", "blocked", "waiting"].includes(String(agentStatus))) return { stalled: false };
  const stateFile = materializedPath(session) + ".state.json";
  let cursor: Emitted, cursorMtime: number;
  try {
    cursor = { lastOrdinal: -1, maxUpdated: -1, count: 0, done: {}, ...object(JSON.parse(await readFile(stateFile, "utf8"))) } as Emitted;
    cursorMtime = (await stat(stateFile)).mtimeMs;
  } catch { return { stalled: false }; }
  if (Date.now() - cursorMtime < STALLED_AFTER_MS) return { stalled: false };
  const history = await openReadOnly(path.join(codexHome(), "thread_history_1.sqlite"));
  if (!history) return { stalled: false };
  try {
    const summary = object(history.prepare("select count(*) as n, max(rollout_ordinal) as last, max(updated_at_ordinal) as updated from thread_items where thread_id = ?").get(session));
    // The store may have advanced just before the materializer catches up.
    if (cursor.count !== Number(summary.n) || cursor.lastOrdinal !== Number(summary.last) || cursor.maxUpdated !== Number(summary.updated)) return { stalled: false };
    const turn = object(history.prepare("select status, rollout_end_ordinal from thread_turns where thread_id = ? order by rollout_ordinal desc limit 1").get(session));
    if (turn.status !== "inProgress" || turn.rollout_end_ordinal !== null) return { stalled: false };
    return { stalled: true, since: new Date(cursorMtime).toISOString() };
  } catch { return { stalled: false }; } finally { history.close(); }
}

/** Bring the materialized file up to date with the store. Returns the file
 * when the thread exists there, undefined otherwise. Safe to call often:
 * an unchanged thread costs one aggregate query. */
export async function materializeCodexThread(session: string): Promise<string | undefined> {
  if (!sessionId.safeParse(session).success) return undefined;
  const history = await openReadOnly(path.join(codexHome(), "thread_history_1.sqlite"));
  if (!history) return undefined;
  try {
    const summary = object(history.prepare("select count(*) as n, max(rollout_ordinal) as last, max(updated_at_ordinal) as updated from thread_items where thread_id = ?").get(session));
    if (!Number(summary.n)) return undefined;
    const file = materializedPath(session), stateFile = file + ".state.json";
    await mkdir(materializedRoot(), { recursive: true, mode: 0o700 });
    let state: Emitted = { lastOrdinal: -1, maxUpdated: -1, count: 0, done: {} };
    try { state = { ...state, ...object(JSON.parse(await readFile(stateFile, "utf8"))) as Partial<Emitted> }; } catch { /* first time */ }
    const fresh = state.count === 0;
    if (!fresh && state.count === Number(summary.n) && state.lastOrdinal === Number(summary.last) && state.maxUpdated === Number(summary.updated)) return file;
    const rows = objects(history.prepare("select rollout_ordinal, item_type, item_json, updated_at_ordinal from thread_items where thread_id = ? order by rollout_ordinal limit ?").all(session, MAX_ITEMS));
    const lines: string[] = [];
    if (fresh) {
      const meta = await threadMeta(session);
      lines.push(JSON.stringify({ type: "session_meta", payload: { id: session, ...(meta.cwd ? { cwd: meta.cwd } : {}), source: "codex-thread-store" } }));
      if (meta.model) lines.push(JSON.stringify({ type: "turn_context", payload: { model: meta.model } }));
    }
    for (const row of rows) {
      let item: Json; try { item = object(JSON.parse(String(row.item_json))); } catch { continue; }
      const id = String(item.id ?? `ordinal-${row.rollout_ordinal}`), emitted = state.done[id];
      const call = callRow(item), output = outputRow(item);
      if (!emitted) {
        if (call) { lines.push(JSON.stringify(call)); state.done[id] = "call"; }
        else if (messageRow(item)) {
          lines.push(JSON.stringify(messageRow(item)));
          // A question the agent asked (delivered async) rides along as the
          // same event the rollout would carry, so the pending scan sees it.
          const asked = questionEvent(item);
          if (asked) lines.push(JSON.stringify(asked));
          state.done[id] = "done"; continue;
        }
        else continue;
      }
      if (state.done[id] === "call" && output) { lines.push(JSON.stringify(output)); state.done[id] = "done"; }
    }
    if (lines.length) {
      const handle = await open(file, "a", 0o600);
      try { await handle.appendFile(lines.join("\n") + "\n"); } finally { await handle.close(); }
    }
    state.count = Number(summary.n); state.lastOrdinal = Number(summary.last); state.maxUpdated = Number(summary.updated);
    const temporary = stateFile + ".tmp";
    await writeFile(temporary, JSON.stringify(state), { mode: 0o600 }); await rename(temporary, stateFile);
    return file;
  } catch { return undefined; } finally { history.close(); }
}

async function threadMeta(session: string): Promise<{ model?: string; cwd?: string }> {
  const db = await openReadOnly(path.join(codexHome(), "state_5.sqlite"));
  if (!db) return {};
  try {
    const row = object(db.prepare("select model, cwd from threads where id = ?").get(session));
    return { ...(typeof row.model === "string" && row.model ? { model: row.model } : {}), ...(typeof row.cwd === "string" && row.cwd ? { cwd: row.cwd } : {}) };
  } catch { return {}; } finally { db.close(); }
}

function finished(item: Json): boolean { return ["completed", "failed", "declined", "error"].includes(String(item.status)) || item.exitCode !== undefined && item.exitCode !== null; }

/** A message row, for the two message kinds. */
function messageRow(item: Json): Json | undefined {
  if (item.type === "userMessage") {
    const text = objects(item.content).filter(b => b.type === "text" && typeof b.text === "string").map(b => String(b.text)).join("\n");
    return text ? { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } } : undefined;
  }
  if (item.type === "agentMessage" && typeof item.text === "string" && item.text) {
    return { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: item.text }] } };
  }
  return undefined;
}

/** Codex 0.155 asks through an agent message with `questions` attached. */
function questionEvent(item: Json): Json | undefined {
  if (item.type !== "agentMessage" || item.delivery !== "async" || !Array.isArray(item.questions) || !item.questions.length) return undefined;
  return { type: "event_msg", payload: { type: "item_completed", item: { type: "AgentMessage", id: String(item.id ?? ""),
    content: [{ type: "Text", text: String(item.text ?? "") }], delivery: "async", questions: objects(item.questions).slice(0, 8) } } };
}

/** The call row an item starts with; tool inputs, not reasoning. */
function callRow(item: Json): Json | undefined {
  const id = String(item.id ?? "");
  switch (item.type) {
    case "commandExecution":
      return { type: "response_item", payload: { type: "function_call", name: "shell", call_id: id, arguments: JSON.stringify({ command: String(item.command ?? "").slice(0, 4000), ...(typeof item.cwd === "string" ? { workdir: item.cwd } : {}) }) } };
    case "fileChange":
      return { type: "response_item", payload: { type: "function_call", name: "apply_patch", call_id: id, arguments: JSON.stringify({ files: objects(item.changes).slice(0, 50).map(c => ({ path: String(c.path ?? ""), kind: String(object(c.kind).type ?? c.kind ?? "") })) }) } };
    case "mcpToolCall":
      return { type: "response_item", payload: { type: "function_call", name: `mcp__${String(item.server ?? "mcp")}__${String(item.tool ?? "tool")}`, call_id: id, arguments: JSON.stringify(object(item.arguments)) } };
    case "webSearch":
      return { type: "response_item", payload: { type: "function_call", name: "web_search", call_id: id, arguments: JSON.stringify({ query: String(item.query ?? "").slice(0, 2000) }) } };
    default: return undefined;
  }
}

/** The output row once the item finished. */
function outputRow(item: Json): Json | undefined {
  if (!finished(item)) return undefined;
  const id = String(item.id ?? "");
  switch (item.type) {
    case "commandExecution": {
      const text = typeof item.aggregatedOutput === "string" ? item.aggregatedOutput.slice(-OUTPUT_TAIL) : "";
      const status = typeof item.exitCode === "number" ? `[exit ${item.exitCode}]` : `[${String(item.status)}]`;
      return { type: "response_item", payload: { type: "function_call_output", call_id: id, output: `${text}${text && !text.endsWith("\n") ? "\n" : ""}${status}` } };
    }
    case "fileChange": {
      const changes = objects(item.changes).slice(0, 50);
      const kind = (c: Json) => { const t = String(object(c.kind).type ?? c.kind ?? "update"); return t === "add" ? "A" : t === "delete" ? "D" : "M"; };
      const files = changes.map(c => ({ path: String(c.path ?? ""), status: kind(c), ...(typeof c.diff === "string" ? { patch: c.diff.slice(0, 200_000) } : {}) }));
      const output = changes.length ? `${changes.length} file(s) changed\n${files.map(f => f.path).join("\n")}` : "0 file(s) changed";
      return { type: "response_item", payload: { type: "function_call_output", call_id: id, output }, ...(files.length ? { phren_changes: { [id]: files } } : {}) };
    }
    case "mcpToolCall": {
      const parts = objects(object(item.result).content).filter(b => b.type === "text" && typeof b.text === "string").map(b => String(b.text));
      const output = parts.length ? parts.join("\n").slice(-OUTPUT_TAIL) : typeof item.error === "string" ? item.error.slice(0, 2000) : String(item.status);
      return { type: "response_item", payload: { type: "function_call_output", call_id: id, output } };
    }
    case "webSearch": {
      const results = objects(item.results).slice(0, 10).map(r => [r.title, r.snippet].filter(v => typeof v === "string" && v).join(": ")).join("\n");
      return { type: "response_item", payload: { type: "function_call_output", call_id: id, output: results || "searched" } };
    }
    default: return undefined;
  }
}
