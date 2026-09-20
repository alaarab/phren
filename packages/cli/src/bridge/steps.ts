import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { withTranscriptIndex } from "./transcript-index.js";
import { refreshTranscript, transcriptPath, visibleEvent } from "./transcripts.js";
import { claudeName } from "./models.js";
import { BridgeError, object, objects, type Json, type Provider } from "./protocol.js";

/** What a working agent is doing right now, in the words the lock screen
 * uses: the newest tool call in its transcript, or that it is writing or
 * reading. Bounded to the tail; cached until the file changes. */
const cache = new Map<string, { key: string; step?: string }>();
const modelCache = new Map<string, { key: string; model?: string }>();
const TAIL_ROWS = 24, MODEL_TAIL_ROWS = 200, LIMIT = 40;
// A command often opens with `export FOO=1`-style assignments; they name the
// computer's setup, not the work, and can carry an absolute path.
const SHELL_ASSIGNMENTS = /^(?:(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s;]*)[;\s]+)+/;
// The scratchpad a wrapper like Claude Code runs in is a temp path the account
// name hides inside; only its last component tells the person anything.
const TEMP_ROOTS = [tmpdir(), "/private/tmp", "/tmp"].map(root => root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
const TEMP_PATH = new RegExp(`(?:${TEMP_ROOTS.join("|")})(?:/[A-Za-z0-9._@+-]+)+`, "g");
const collapseTemp = (value: string) => value.replace(TEMP_PATH, m => "…/" + (m.split("/").filter(Boolean).pop() ?? ""));

export async function currentStep(source: Provider, session: string): Promise<string | undefined> {
  let file: string;
  try { file = await transcriptPath(source, session); await refreshTranscript(file, source, session); } catch (error) { if (error instanceof BridgeError) return undefined; throw error; }
  return withTranscriptIndex(file, async (handle, index) => {
    const key = `${index.revision}:${index.lines}`;
    const cached = cache.get(file);
    if (cached?.key === key) return cached.step;
    let step: string | undefined;
    for await (const row of index.rows(handle, index.lines, Math.max(0, index.lines - TAIL_ROWS))) {
      if (!row.bytes) continue;
      let raw: Json | undefined;
      try { raw = visibleEvent(object(JSON.parse(row.bytes.toString())), source); } catch { continue; }
      if (!raw) continue;
      const decided = stepOf(raw, source);
      if (decided) { step = decided; break; }
    }
    cache.delete(file); cache.set(file, { key, step });
    while (cache.size > 128) cache.delete(cache.keys().next().value!);
    return step;
  });
}

/** The model the agent's newest answer ran on, for the lock screen's row
 * label. Codex names it once per turn; Claude stamps it on every assistant
 * row, and its raw id reads as the family and version the phone shows. */
export async function currentModel(source: Provider, session: string): Promise<string | undefined> {
  let file: string;
  try { file = await transcriptPath(source, session); await refreshTranscript(file, source, session); } catch (error) { if (error instanceof BridgeError) return undefined; throw error; }
  return withTranscriptIndex(file, async (handle, index) => {
    const key = `${index.revision}:${index.lines}`;
    const cached = modelCache.get(file);
    if (cached?.key === key) return cached.model;
    let model: string | undefined;
    for await (const row of index.rows(handle, index.lines, Math.max(0, index.lines - MODEL_TAIL_ROWS))) {
      if (!row.bytes) continue;
      let raw: Json | undefined;
      // Model metadata need not be a visible transcript row (OpenCode strips it).
      try { raw = object(JSON.parse(row.bytes.toString())); } catch { continue; }
      if (!raw) continue;
      const decided = modelOf(raw, source);
      if (decided) { model = decided; break; }
    }
    modelCache.delete(file); modelCache.set(file, { key, model });
    while (modelCache.size > 128) modelCache.delete(modelCache.keys().next().value!);
    return model;
  });
}

/** The model a visible row names, in the shape the chat header reads. */
export function modelOf(raw: Json, source: Provider): string | undefined {
  if (source === "claude" && (raw.type !== "assistant" || raw.isSidechain === true || raw.isMeta === true)) return undefined;
  if (source === "codex" && raw.type !== "turn_context") return undefined;
  if ((source === "phren" || source === "opencode") && raw.type !== "assistant/message") return undefined;
  const message = source === "phren" || source === "opencode" ? object(object(raw.data).message) : object(raw.message);
  const value = source === "codex" ? object(raw.payload).model : message.model;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const name = source === "claude" ? claudeName(value.trim()) : value.trim();
  return name.slice(0, 100);
}

/** One row's verdict, newest first: a tool call names the step; an
 * assistant text means a reply is being written; a person's turn means the
 * agent is reading it. Tool results and bookkeeping say nothing. */
export function stepOf(raw: Json, source: Provider): string | undefined {
  if (source === "codex") {
    const payload = object(raw.payload);
    if (raw.type !== "response_item") return undefined;
    if (["function_call", "custom_tool_call"].includes(String(payload.type))) return describe(String(payload.name ?? ""), payload.arguments ?? payload.input);
    if (payload.type === "message") return payload.role === "assistant" ? "Writing a reply" : payload.role === "user" ? "Reading your message" : undefined;
    return undefined;
  }
  if (source === "copilot") {
    const data = object(raw.data);
    if (raw.type === "tool.execution_start") return describe(String(data.toolName ?? ""), data.arguments);
    if (raw.type === "assistant.message") return "Writing a reply";
    if (raw.type === "user.message") return "Reading your message";
    return undefined;
  }
  const message = source === "phren" || source === "opencode" ? object(object(raw.data).message) : object(raw.message);
  const role = source === "phren" || source === "opencode" ? (raw.type === "assistant/message" ? "assistant" : raw.type === "user/message" ? "user" : "tool") : String(raw.type);
  const blocks = objects(message.content);
  if (role === "assistant") {
    const call = [...blocks].reverse().find(b => b.type === "tool_use");
    if (call) return describe(String(call.name ?? ""), call.input);
    return blocks.some(b => b.type === "text") || typeof message.content === "string" ? "Writing a reply" : undefined;
  }
  if (role === "user") {
    if (blocks.some(b => b.type === "tool_result")) return undefined;
    return blocks.some(b => b.type === "text") || typeof message.content === "string" ? "Reading your message" : undefined;
  }
  return undefined;
}

export function describe(tool: string, args: unknown): string {
  let input: Json = {};
  if (typeof args === "string") { try { input = object(JSON.parse(args)); } catch { input = {}; } } else input = object(args);
  const text = (...keys: string[]) => { for (const key of keys) { const v = input[key]; if (typeof v === "string" && v.trim()) return v; if (Array.isArray(v) && v.every(p => typeof p === "string")) return (v as string[]).join(" "); } return ""; };
  const firstLine = (v: string) => v.split(/\r?\n/).map(l => l.trim()).find(l => l) ?? "";
  const base = (v: string) => path.basename(v.split(" · ")[0].trim()) || "file";
  const name = tool.toLowerCase();
  let value: string;
  if (["bash", "shell", "exec_command", "exec", "parallel", "tools", "write_stdin", "container.exec"].includes(name)) {
    // Drop the shell wrapper, a leading run of variable assignments, and a
    // `cd <dir> &&`, and keep the home directory (and the account name in it)
    // and any scratchpad path off the lock screen.
    const command = collapseTemp(firstLine(text("command", "cmd")).replace(/^(?:\/\S*\/)?(?:bash|sh|zsh)\s+-l?c\s+/, "")
      .replace(/^(['"])(.*)\1$/, "$2").replace(SHELL_ASSIGNMENTS, "").replace(/^cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*/, "").replace(SHELL_ASSIGNMENTS, "").split(homedir()).join("~"));
    value = command ? `${tool}: ${command}` : tool;
  } else if (["edit", "multiedit", "write", "notebookedit", "patch", "apply_patch", "str_replace_editor", "str_replace"].includes(name)) {
    const patchTarget = /\*\*\* (?:Update|Add|Delete) File: (.+)/.exec(text("input", "patch"))?.[1];
    value = `Editing ${base(text("file_path", "filePath", "path") || patchTarget || "")}`;
  } else if (["read", "ls", "list"].includes(name)) value = `Reading ${base(text("file_path", "filePath", "path"))}`;
  else if (["grep", "glob", "search", "websearch", "browse"].includes(name)) { const q = firstLine(text("pattern", "query")); value = q ? `Searching ${q}` : tool; }
  else if (["fetch", "webfetch"].includes(name)) { let host = ""; try { host = new URL(text("url")).host; } catch { /* not a URL */ } value = host ? `Fetching ${host}` : tool; }
  else if (["task", "agent"].includes(name)) { const d = firstLine(text("description", "name")); value = d ? `Delegating ${d}` : tool; }
  else { const d = firstLine(text("command", "cmd", "query", "description")); value = d ? `${tool}: ${d}` : tool || "Working"; }
  return value.length > LIMIT ? value.slice(0, LIMIT - 1) + "…" : value;
}
