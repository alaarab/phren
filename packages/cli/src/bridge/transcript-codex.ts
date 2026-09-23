import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { object, objects, sessionId, type Json } from "./protocol.js";
import { visibleCodexExecEvent } from "./fanouts.js";
import { harnessPreamble } from "./transcript-claude.js";
import type { Entry, LocalChildAgentRelation } from "./transcripts.js";

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
  if (raw.type !== "response_item") return undefined;
  if (p.type === "message" && ["user", "assistant"].includes(String(p.role)) && p.channel !== "analysis") {
    const text = typeof p.content === "string" ? p.content : objects(p.content).map(b => typeof b.text === "string" ? b.text : "").join("\n");
    return p.role === "user" && harnessPreamble(text) ? undefined : raw;
  }
  if (["function_call", "custom_tool_call", "function_call_output", "custom_tool_call_output"].includes(String(p.type))) return raw;
  return undefined;
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

function shellCommand(expression: string, source: string): string | undefined {
  const inline = resolveString(expression, source);
  if (inline !== undefined) return inline;
  const inner = /^\{([\s\S]*)\}$/.exec(expression.trim())?.[1];
  if (inner === undefined) return undefined;
  const body = inner.trim();
  if (/^[A-Za-z_$][\w$]*$/.test(body)) return resolveString(body, source);
  const property = /(?:^|[,{])\s*(?:command|cmd)\s*:\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[A-Za-z_$][\w$]*)/.exec(body);
  return property ? resolveString(property[1], source) : undefined;
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
