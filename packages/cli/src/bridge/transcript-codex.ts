import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { object, objects, sessionId, type Json } from "./protocol.js";
import { visibleCodexExecEvent } from "./fanouts.js";
import { harnessPreamble } from "./transcript-claude.js";
import type { Entry, LocalChildAgentRelation } from "./transcripts.js";
import { readableQuestionReply } from "./codex-question-reply.js";

/** Codex's transcript reader: SubAgentActivity child links, the public rows
 * of a rollout, and code-mode calls projected into ordinary tool calls. */

export type DirectRelation = Pick<LocalChildAgentRelation, "session" | "path" | "callId" | "state">;
type ChildRelationCache = {
  dev: number; ino: number; fileSize: number; completeOffset: number; mtimeMs: number;
  relations: Map<string, DirectRelation>;
};
const childRelationCache = new Map<string, ChildRelationCache>();

function addChildRelation(line: string, found: Map<string, DirectRelation>): void {
  if (!line.includes("SubAgentActivity")) return;
  try {
    const raw = object(JSON.parse(line)), payload = object(raw.payload), item = object(payload.item);
    if (raw.type !== "event_msg" || payload.type !== "item_completed" || item.type !== "SubAgentActivity") return;
    const kind = String(item.kind), child = String(item.agent_thread_id ?? ""), agentPath = String(item.agent_path ?? "");
    const callId = String(item.id ?? "");
    // Codex 0.155 also reports "interacted" between start and completion;
    // it proves the child exists without changing its state.
    if (!["started", "interacted", "completed"].includes(kind) || !sessionId.safeParse(child).success || !callId || agentPath.length > 512) return;
    const previous = found.get(child);
    found.set(child, { session: child, path: agentPath, callId: previous?.callId || callId,
      state: kind === "completed" ? "completed" : previous?.state ?? "running" });
  } catch { /* Ignore malformed/private rows. */ }
}

export async function directChildAgents(file: string): Promise<DirectRelation[]> {
  const metadata = await stat(file), cached = childRelationCache.get(file);
  if (cached && cached.dev === metadata.dev && cached.ino === metadata.ino
      && cached.fileSize === metadata.size && cached.mtimeMs === metadata.mtimeMs) return [...cached.relations.values()];
  // Codex rollouts are append-only. Keep the byte position of the last full
  // JSONL row so a live transcript only scans new rows as its chat advances.
  // A truncate, replacement, or in-place rewrite starts from zero.
  const append = cached && cached.dev === metadata.dev && cached.ino === metadata.ino && metadata.size > cached.fileSize;
  const start = append ? cached.completeOffset : 0;
  const found = append ? new Map(cached.relations) : new Map<string, DirectRelation>();
  let pending = Buffer.alloc(0), completeOffset = start;
  const input = metadata.size > start ? createReadStream(file, { start, end: metadata.size - 1 }) : undefined;
  for await (const chunk of input ?? []) {
    pending = Buffer.concat([pending, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    let newline: number;
    while ((newline = pending.indexOf(0x0a)) >= 0) {
      addChildRelation(pending.subarray(0, newline).toString("utf8"), found);
      completeOffset += newline + 1; pending = pending.subarray(newline + 1);
    }
  }
  const entry = { dev: metadata.dev, ino: metadata.ino, fileSize: metadata.size, completeOffset,
    mtimeMs: metadata.mtimeMs, relations: found };
  childRelationCache.set(file, entry);
  while (childRelationCache.size > 64) childRelationCache.delete(childRelationCache.keys().next().value!);
  return [...found.values()];
}

export async function childTranscriptBelongsTo(file: string, parent: string): Promise<boolean> {
  let bytes = Buffer.alloc(0);
  for await (const chunk of createReadStream(file, { start: 0, end: 1_048_575 })) {
    bytes = Buffer.concat([bytes, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    const newline = bytes.indexOf(0x0a); if (newline >= 0) { bytes = bytes.subarray(0, newline); break; }
  }
  try {
    const raw = object(JSON.parse(bytes.toString("utf8"))), payload = object(raw.payload), source = object(payload.source);
    const subagent = object(source.subagent), spawn = object(subagent.thread_spawn);
    return raw.type === "session_meta" && String(spawn.parent_thread_id ?? payload.parent_thread_id ?? "") === parent;
  } catch { return false; }
}

/** Codex rows the phone may see: public messages, tool calls and their
 * outputs, the answering model, and turn/usage events. */
export function visibleCodexEvent(raw: Json): Json | undefined {
  if (raw.type === "phren_queue_consumed" && typeof raw.key === "string" && /^[a-f0-9]{64}$/.test(raw.key)) {
    return { type: raw.type, key: raw.key };
  }
  const execEvent = visibleCodexExecEvent(raw); if (execEvent) return execEvent;
  const p = object(raw.payload);
  // The model answering this turn is the only field of turn_context the
  // phone shows; its policies and instructions stay on the computer.
  if (raw.type === "turn_context") return typeof p.model === "string" ? { type: "turn_context", timestamp: raw.timestamp, payload: { model: p.model } } : undefined;
  if (raw.type === "event_msg" && p.type === "error") return { type: raw.type, timestamp: raw.timestamp,
    payload: { type: "error", ...(typeof p.message === "string" ? { message: p.message } : {}) } };
  if (raw.type === "event_msg" && ["token_count", "task_started", "task_complete", "task_completed", "turn_aborted", "task_aborted", "error"].includes(String(p.type))) return raw;
  if (raw.type === "event_msg" && p.type === "item_completed") return itemCall(raw, object(p.item));
  if (raw.type !== "response_item") return undefined;
  const wrapper = codeModeWrapper(raw);
  if (wrapper) return wrapper.images.length ? imageCall(raw, wrapper) : undefined;
  if (p.type === "message" && ["user", "assistant"].includes(String(p.role)) && p.channel !== "analysis") {
    const text = typeof p.content === "string" ? p.content : objects(p.content).map(b => typeof b.text === "string" ? b.text : "").join("\n");
    if (p.role === "user" && harnessPreamble(text)) return undefined;
    // An answer to an async question reads as the question and its answer,
    // not as the envelope Codex's TUI (or the Hook) sent it in.
    const answered = p.role === "user" ? readableQuestionReply(text) : undefined;
    return answered ? { ...raw, payload: { ...p, content: [{ type: "input_text", text: answered }] } } : raw;
  }
  if (["function_call", "custom_tool_call", "function_call_output", "custom_tool_call_output"].includes(String(p.type))) return raw;
  return undefined;
}

/** Codex 0.155.1 and later number their rollout rows (`ordinal`) and record
 * each action a code-mode script runs as its own `item_completed` row: the
 * command and its output, the patch, the MCP call. The `exec` call wrapping
 * those actions in JavaScript and its "Script completed" result only repeat
 * them, so the phone reads the items as the ordinary calls it already draws. */
const OUTPUT_TAIL = 4_000, MCP_OUTPUT = 65_536, PATCH_FILE = 200_000, COMMAND = 16_384;
const WRAPPED_TOOL = /\btools\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g;
const VIEW_IMAGE = /\btools\s*\.\s*view_image\s*\(/g;
/** Tools whose every call Codex records as an item (`write_stdin` finishes
 * the command it feeds; `view_image` has only a path item, so its picture is
 * taken from the wrapper's own result). */
const ITEM_TOOLS = new Set(["exec_command", "write_stdin", "apply_patch", "view_image"]);

export interface CodeModeWrapper { callId: string; images: string[] }

/** A numbered rollout's code-mode `exec` call whose every tool call is
 * recorded as an item. A script that calls anything else stays as it is. */
export function codeModeWrapper(raw: Json): CodeModeWrapper | undefined {
  const p = object(raw.payload), source = p.input, callId = p.call_id;
  if (typeof raw.ordinal !== "number" || raw.type !== "response_item" || p.type !== "custom_tool_call" || p.name !== "exec") return undefined;
  if (typeof source !== "string" || typeof callId !== "string" || !callId || source.trimStart().startsWith("*** Begin Patch")) return undefined;
  const tools = [...source.matchAll(WRAPPED_TOOL)].map(match => match[1]);
  if (!tools.length || !tools.every(tool => ITEM_TOOLS.has(tool) || /^mcp__\w+$/.test(tool))) return undefined;
  const images = [...source.matchAll(VIEW_IMAGE)].map(match => {
    const args = callArguments(source, (match.index ?? 0) + match[0].length - 1);
    return (args === undefined ? undefined : argumentString(args, source, ["path"])) ?? "";
  });
  return { callId, images };
}

/** A wrapper that viewed an image becomes the `view_image` call its result
 * (the picture) pairs with; the ImageView item names only the path. */
function imageCall(raw: Json, wrapper: CodeModeWrapper): Json {
  const file = wrapper.images.find(Boolean);
  return { type: "response_item", ...(raw.timestamp !== undefined ? { timestamp: raw.timestamp } : {}),
    payload: { type: "function_call", name: "view_image", call_id: wrapper.callId, arguments: JSON.stringify(file ? { path: file.slice(0, 4_096) } : {}) } };
}

/** The wrapper a numbered rollout's code-mode result answers, by call id. */
export function codeModeOutputCall(raw: Json): string | undefined {
  const p = object(raw.payload);
  return typeof raw.ordinal === "number" && raw.type === "response_item" && p.type === "custom_tool_call_output"
    && typeof p.call_id === "string" && p.call_id ? p.call_id : undefined;
}

/** A covered wrapper's result: an image viewer keeps only its pictures, a
 * "Script completed"/"Script running" status is hidden (the items carry the
 * actions), and a failure or abort is listed with the script it ended, whose
 * own row was hidden, so the phone draws the pair. */
export function projectCodeModeOutput(raw: Json, call: Json | undefined): Json | undefined {
  const wrapper = call && codeModeWrapper(call);
  if (!call || !wrapper) return raw;
  const p = object(raw.payload), blocks = Array.isArray(p.output) ? objects(p.output) : [];
  const images = blocks.filter(block => ["input_image", "image"].includes(String(block.type)));
  // The view_image call is already listed on the script's own row.
  if (wrapper.images.length) return images.length ? { ...raw, payload: { ...p, output: images } } : raw;
  const text = typeof p.output === "string" ? p.output : blocks.map(block => typeof block.text === "string" ? block.text : "").join("\n");
  if (/^Script (completed|running)\b/.test(text)) return undefined;
  return { type: "response_item", ...(call.timestamp !== undefined ? { timestamp: call.timestamp } : {}),
    payload: { type: "custom_tool_call", name: "exec", call_id: wrapper.callId, input: object(call.payload).input }, phren_item_output: raw };
}

/** The wrapper call a result answers, found within the rows just before it
 * (a script's own items sit between the two; 32 rows apart at most seen). */
export async function findCodeModeCall(rows: (before: number, after: number) => AsyncIterable<{ line: number; bytes?: Buffer }>,
                                       line: number, callId: string): Promise<Json | undefined> {
  const needle = Buffer.from(JSON.stringify(callId));
  for await (const row of rows(line, Math.max(0, line - 256))) {
    if (!row.bytes?.includes(needle)) continue;
    try {
      const raw = object(JSON.parse(row.bytes.toString())), p = object(raw.payload);
      if (raw.type === "response_item" && p.type === "custom_tool_call" && p.call_id === callId) return raw;
    } catch { /* Not the call. */ }
  }
  return undefined;
}

/** A shell command as the terminal shows it: the script a `sh -lc` runs. */
function commandText(value: unknown): string {
  if (typeof value === "string") return value;
  const parts = Array.isArray(value) ? value.filter((part): part is string => typeof part === "string") : [];
  if (parts.length === 3 && ["-lc", "-c"].includes(parts[1]) && /(^|\/)(ba|z|da|fi|k)?sh$/.test(parts[0])) return parts[2];
  return parts.join(" ");
}

function localPath(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  // The URL names a path on the computer Codex ran on, which may not follow
  // this platform's rules (fileURLToPath refuses `file:///work` on Windows).
  if (value.startsWith("file://")) {
    try {
      const url = new URL(value);
      if (url.host) return undefined;
      const pathname = decodeURIComponent(url.pathname);
      return /^\/[A-Za-z]:\//.test(pathname) ? pathname.slice(1) : pathname;
    } catch { return undefined; }
  }
  return value.startsWith("/") ? value : undefined;
}

/** A FileChange's files as the apply_patch text the patch card draws. */
function changePatch(changes: unknown): string {
  const sections = Object.entries(object(changes)).slice(0, 50).map(([file, value]) => {
    const change = object(value), kind = String(change.type ?? "update");
    if (kind === "add") {
      const content = typeof change.content === "string" ? change.content.slice(0, PATCH_FILE).replace(/\n$/, "") : "";
      return `*** Add File: ${file}\n` + content.split("\n").map(line => "+" + line).join("\n");
    }
    if (kind === "delete") return `*** Delete File: ${file}`;
    const moved = typeof change.move_path === "string" && change.move_path ? `\n*** Move to: ${change.move_path}` : "";
    const diff = typeof change.unified_diff === "string" ? change.unified_diff.slice(0, PATCH_FILE).replace(/\n$/, "") : "";
    return `*** Update File: ${file}${moved}${diff ? "\n" + diff : ""}`;
  });
  return ["*** Begin Patch", ...sections, "*** End Patch"].join("\n");
}

/** An action item as the call the phone draws, carrying its result under
 * `phren_item_output` for the reader to list right after it. Reasoning,
 * messages (already rows of their own) and bookkeeping items stay hidden. */
function itemCall(raw: Json, item: Json): Json | undefined {
  const id = typeof item.id === "string" && item.id ? item.id.slice(0, 200) : "";
  if (!id) return undefined;
  const stamp = raw.timestamp !== undefined ? { timestamp: raw.timestamp } : {};
  const row = (call: Json, output: Json): Json => ({ type: "response_item", ...stamp, payload: { ...call, call_id: id },
    phren_item_output: { type: "response_item", ...stamp, payload: { ...output, call_id: id } } });
  const status = typeof item.status === "string" ? item.status : "completed";
  switch (item.type) {
    case "CommandExecution": {
      const workdir = localPath(item.cwd);
      const text = [item.aggregated_output, item.formatted_output].find(v => typeof v === "string")
        ?? [item.stdout, item.stderr].filter(v => typeof v === "string").join("");
      const tail = (text as string).slice(-OUTPUT_TAIL);
      const output = typeof item.exit_code === "number" ? JSON.stringify({ output: tail, exit_code: item.exit_code })
        : `${tail}${tail && !tail.endsWith("\n") ? "\n" : ""}[${status}]`;
      return row({ type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: commandText(item.command).slice(0, COMMAND), ...(workdir ? { workdir } : {}) }) },
        { type: "function_call_output", output });
    }
    case "FileChange": {
      const said = [status === "completed" ? item.stdout : item.stderr, item.stdout, item.stderr].find(v => typeof v === "string" && v.trim()) as string | undefined;
      return row({ type: "custom_tool_call", name: "apply_patch", input: changePatch(item.changes) },
        { type: "custom_tool_call_output", output: (said ?? status).slice(-OUTPUT_TAIL) });
    }
    case "McpToolCall": {
      const result = object(item.result), ok = object(result.Ok ?? result), error = result.Err ?? item.error;
      const text = objects(ok.content).filter(block => block.type === "text" && typeof block.text === "string").map(block => String(block.text)).join("\n");
      const output = text || (error !== undefined && error !== null ? (typeof error === "string" ? error : JSON.stringify(error)) : status);
      const args = typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {});
      return row({ type: "function_call", name: `mcp__${String(item.server ?? "mcp")}__${String(item.tool ?? "tool")}`, arguments: args.slice(0, 262_144) },
        { type: "function_call_output", output: output.slice(0, MCP_OUTPUT) });
    }
    default: return undefined;
  }
}

/** Codex 0.155 code mode: the model calls one generic tool whose input is
 * JavaScript, and that source invokes `tools.apply_patch`/`tools.shell`/
 * `tools.read`. The Hook resolves each invocation into the ordinary call the
 * phone already draws, so a patch shows a diff instead of an opaque source. */
export interface CodeToolCall { name: "apply_patch" | "shell" | "read"; input: Json }
const CODE_TOOL_CALL = /\btools\s*\.\s*(apply_patch|shell|read)\s*\(/g;
const JS_ESCAPES: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", "0": "\0", "'": "'", '"': '"', "\\": "\\", "/": "/" };

function unescapeJs(value: string): string {
  return value.replace(/\\(u\{[0-9a-fA-F]{1,6}\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (_match, escape: string) => {
    if (escape[0] === "u") {
      const code = parseInt(escape[1] === "{" ? escape.slice(2, -1) : escape.slice(1), 16);
      return Number.isSafeInteger(code) && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    }
    if (escape[0] === "x") { const code = parseInt(escape.slice(1), 16); return Number.isFinite(code) ? String.fromCharCode(code) : ""; }
    return JS_ESCAPES[escape] ?? escape;
  });
}

/** The value of a string literal, or undefined when the expression is not one. */
function literalValue(expression: string): string | undefined {
  const text = expression.trim(), quote = text[0];
  if (!["'", '"', "`"].includes(quote) || text.length < 2 || text[text.length - 1] !== quote) return undefined;
  for (let index = 1; index < text.length - 1; index++) {
    if (text[index] === "\\") { index++; continue; }
    if (text[index] === quote) return undefined;
  }
  return unescapeJs(text.slice(1, -1));
}

/** Resolve a call argument: an inline literal, or an identifier assigned a
 * string literal in the same source. Computed values stay unresolved. */
function resolveString(expression: string, source: string): string | undefined {
  const literal = literalValue(expression);
  if (literal !== undefined) return literal;
  const identifier = expression.trim();
  if (!/^[A-Za-z_$][\w$]*$/.test(identifier)) return undefined;
  const declaration = new RegExp(`\\b(?:const|let|var)\\s+${identifier}\\s*=\\s*("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|\`(?:\\\\.|[^\`\\\\])*\`)`).exec(source);
  return declaration ? unescapeJs(declaration[1].slice(1, -1)) : undefined;
}

/** The `(…)` text of a call, skipping parentheses inside string literals. */
function callArguments(source: string, open: number): string | undefined {
  let depth = 0, quote = "";
  for (let index = open; index < source.length; index++) {
    const character = source[index];
    if (quote) { if (character === "\\") index++; else if (character === quote) quote = ""; continue; }
    if (character === '"' || character === "'" || character === "`") { quote = character; continue; }
    if (character === "(" || character === "{" || character === "[") depth++;
    else if (character === ")" || character === "}" || character === "]") { if (--depth === 0) return source.slice(open + 1, index); }
  }
  return undefined;
}

/** A string argument: a literal, a string identifier, or one of `keys` in an
 * object literal. */
function argumentString(expression: string, source: string, keys: string[]): string | undefined {
  const inline = resolveString(expression, source);
  if (inline !== undefined) return inline;
  const inner = /^\{([\s\S]*)\}$/.exec(expression.trim())?.[1];
  if (inner === undefined) return undefined;
  const body = inner.trim();
  if (/^[A-Za-z_$][\w$]*$/.test(body)) return resolveString(body, source);
  const property = new RegExp(`(?:^|[,{])\\s*(?:${keys.join("|")})\\s*:\\s*("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|\`(?:\\\\.|[^\`\\\\])*\`|[A-Za-z_$][\\w$]*)`).exec(body);
  return property ? resolveString(property[1], source) : undefined;
}

function shellCommand(expression: string, source: string): string | undefined {
  return argumentString(expression, source, ["command", "cmd"]);
}

/** Every recognized invocation in a code-mode source, in the order written. */
export function codeToolCalls(source: string): CodeToolCall[] | undefined {
  const calls: CodeToolCall[] = [], original = source.slice(0, 262_144);
  for (const match of source.matchAll(CODE_TOOL_CALL)) {
    const args = callArguments(source, (match.index ?? 0) + match[0].length - 1);
    if (args === undefined) continue;
    if (match[1] === "apply_patch") {
      const patch = resolveString(args, source);
      if (patch?.startsWith("*** Begin Patch")) calls.push({ name: "apply_patch", input: { patch, source: original } });
    } else if (match[1] === "shell") {
      const command = shellCommand(args, source);
      if (command !== undefined) calls.push({ name: "shell", input: { command, source: original } });
    } else {
      const file = resolveString(args, source);
      if (file !== undefined) calls.push({ name: "read", input: { file_path: file, source: original } });
    }
  }
  return calls.length ? calls : undefined;
}

/** The JS source behind a code-mode input: a raw string, or an object carrying
 * it under a code/source/script field. JSON tool arguments are not source. */
function codeToolSource(input: unknown): string | undefined {
  if (typeof input === "string") {
    const trimmed = input.trimStart();
    if (trimmed.startsWith("{")) {
      try {
        const parsed = object(JSON.parse(input));
        // A resolved call (our own projection, or ordinary JSON arguments such
        // as `command`) is not source, even when it also carries `source`.
        if (["patch", "command", "cmd", "file_path", "files"].some(key => parsed[key] !== undefined)) return undefined;
        for (const key of ["code", "source", "script", "input"]) if (typeof parsed[key] === "string") return parsed[key] as string;
        return undefined;
      } catch { return input; }
    }
    return input;
  }
  const fields = object(input);
  for (const key of ["code", "source", "script", "input"]) if (typeof fields[key] === "string") return fields[key] as string;
  return undefined;
}

const projectedCodeCalls = new Set<string>();
function rememberProjectedCodeCall(callId: string): void {
  projectedCodeCalls.delete(callId); projectedCodeCalls.add(callId);
  while (projectedCodeCalls.size > 4096) projectedCodeCalls.delete(projectedCodeCalls.values().next().value!);
}
function renameProjectedChanges(raw: Json, base: string): Json {
  const changes = object(raw.phren_changes);
  if (!Object.keys(changes).length) return raw;
  return { ...raw, phren_changes: Object.fromEntries(Object.entries(changes).map(([key, value]) => [key === base ? `${base}:1` : key, value])) };
}

/** Expand one Codex row: a code-mode call becomes one ordinary call per
 * invocation, each carrying the original source under `input.source`, and the
 * matching result follows the first. Other rows pass through unchanged. */
export function projectCodexRow(raw: Json): { rows: Json[]; base?: string } {
  if (raw.type !== "response_item") return { rows: [raw] };
  if (raw.phren_item_output !== undefined) {
    // An item's call and result, or a failed script listed with its result.
    // Only the script is source to project; an item's patch text is not.
    const { phren_item_output: output, ...call } = raw, result = object(output);
    const expanded = object(call.payload).name === "exec" ? projectCodexRow(call) : { rows: [call] as Json[] };
    if (!expanded.base) return { rows: [...expanded.rows, result] };
    return { rows: [...expanded.rows, { ...result, payload: { ...object(result.payload), call_id: `${expanded.base}:1` } }] };
  }
  const payload = object(raw.payload), type = String(payload.type), callId = typeof payload.call_id === "string" ? payload.call_id : "";
  if (type === "custom_tool_call" || type === "function_call") {
    const source = codeToolSource(payload.input ?? payload.arguments);
    const calls = source === undefined ? undefined : codeToolCalls(source);
    if (!calls) return { rows: [raw] };
    const rows = calls.map((call, index) => ({ type: "response_item", payload: { type: "function_call",
      name: call.name, call_id: `${callId}:${index + 1}`, arguments: JSON.stringify(call.input) } }));
    if (callId) rememberProjectedCodeCall(callId);
    return { rows, ...(callId ? { base: callId } : {}) };
  }
  if ((type === "custom_tool_call_output" || type === "function_call_output") && callId && projectedCodeCalls.has(callId)) {
    return { rows: [{ ...renameProjectedChanges(raw, callId), payload: { ...payload, call_id: `${callId}:1` } }], base: callId };
  }
  return { rows: [raw] };
}

/** The output row for a projected call is read before its call (newest row
 * first), so an output already collected in this page follows the first. */
export function rewriteProjectedOutput(entries: Entry[], base: string): void {
  for (const entry of entries) {
    const payload = object(entry.raw.payload);
    if (payload.call_id !== base) continue;
    entry.raw = { ...renameProjectedChanges(entry.raw, base), payload: { ...payload, call_id: `${base}:1` } };
  }
}
