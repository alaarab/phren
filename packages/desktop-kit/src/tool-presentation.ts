// Display-only decoding of a tool call or result, ported from the phone's
// ToolPresentation.kt (and AgentToolClassification.kt). Never evaluates tool
// arguments or discards the raw source: unfamiliar provider envelopes remain
// available in Raw details.

import { PhrenToolPresentation } from "./phren-tools.js";
import { AgentTodoPresentation, AgentSubagentPresentation, AgentToolCardJSON, WebToolPresentation, SkillCallPresentation } from "./tool-cards.js";

/** JSON as the untyped model the Kotlin reads: null, boolean, number, string, arrays, objects. */
export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject { [key: string]: JsonValue | undefined }

const MAX_JSON_BYTES = 524_288;

/** UTF-8 byte length, as `text.toByteArray().size` counts it. */
export function utf8Length(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

/** JSONSerialization with fragments allowed, bounded like the Kotlin. */
export function parseJson(text: string): JsonValue | undefined {
  if (utf8Length(text) > MAX_JSON_BYTES) return undefined;
  try { return JSON.parse(text) as JsonValue; } catch { return undefined; }
}

export function obj(v: JsonValue | undefined): JsonObject | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? v : undefined;
}
export function arr(v: JsonValue | undefined): JsonValue[] | undefined {
  return Array.isArray(v) ? v : undefined;
}
export function str(v: JsonValue | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}
export function bool(v: JsonValue | undefined): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}
export function num(v: JsonValue | undefined): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
/** `int`: a number only when exactly integral and in Int range. */
export function int(v: JsonValue | undefined): number | undefined {
  const n = num(v);
  if (n === undefined) return undefined;
  return Number.isInteger(n) && n >= -2147483648 && n <= 2147483647 ? n : undefined;
}
export function objects(v: JsonValue | undefined): JsonObject[] | undefined {
  const a = arr(v);
  if (a === undefined) return undefined;
  return a.every((e) => obj(e) !== undefined) ? (a as JsonObject[]) : undefined;
}
export function strings(v: JsonValue | undefined): string[] | undefined {
  const a = arr(v);
  if (a === undefined) return undefined;
  const out: string[] = [];
  for (const e of a) { const s = str(e); if (s === undefined) return undefined; out.push(s); }
  return out;
}

function quote(s: string, escapeSlashes: boolean): string {
  const q = JSON.stringify(s);
  return escapeSlashes ? q.replace(/\//g, "\\/") : q;
}

function sortKeys(v: JsonValue): JsonValue {
  if (Array.isArray(v)) return v.map(sortKeys);
  const o = obj(v);
  if (o !== undefined) {
    const out: JsonObject = {};
    for (const k of Object.keys(o).sort()) out[k] = sortKeys(o[k] as JsonValue);
    return out;
  }
  return v;
}

function numberString(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return String(n);
}

/** JSONSerialization `[.sortedKeys, .prettyPrinted]`: 2-space indent, `"k" : v`. */
export function prettyJson(value: JsonValue, escapeSlashes = false): string {
  return pretty(sortKeys(value), 0, escapeSlashes);
}

function pretty(v: JsonValue, depth: number, escapeSlashes: boolean): string {
  if (v === null) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return numberString(v);
  if (typeof v === "string") return quote(v, escapeSlashes);
  const pad = "  ".repeat(depth + 1);
  const outer = "  ".repeat(depth);
  if (Array.isArray(v)) {
    if (v.length === 0) return "[\n\n]";
    return "[\n" + v.map((e) => pad + pretty(e, depth + 1, escapeSlashes)).join(",\n") + "\n" + outer + "]";
  }
  const o = v as JsonObject;
  const keys = Object.keys(o);
  if (keys.length === 0) return "{\n\n}";
  return "{\n" + keys.map((k) => pad + quote(k, escapeSlashes) + " : " + pretty(o[k] as JsonValue, depth + 1, escapeSlashes)).join(",\n") + "\n" + outer + "}";
}

/** Foundation's `Character.isNewline`. */
export function isNewline(c: string): boolean {
  return c === "\n" || c === "\r" || c === "\u000B" || c === "\u000C" || c === "\u0085" || c === "\u2028" || c === "\u2029";
}

/** The newline code points the Kotlin splits on. */
export const NEWLINE_RE = /[\n\r\u000B\u000C\u0085\u2028\u2029]/;
export const NEWLINES_RE = /[\n\r\u000B\u000C\u0085\u2028\u2029]+/;

/** Foundation's `String.capitalized`: each word's first letter upper case, the rest lower. */
export function capitalized(text: string): string {
  let out = "";
  let startOfWord = true;
  for (const c of text) {
    if (/\s/.test(c) || c === "-") { out += c; startOfWord = true; continue; }
    out += startOfWord ? c.toUpperCase() : c.toLowerCase();
    startOfWord = false;
  }
  return out;
}

/** The file's type for output coloring (SyntaxTokenizer.Language.detect). */
export const SyntaxTokenizer = {
  Language: {
    PLAIN: "plain",
    SWIFT: "swift",
    JAVASCRIPT: "javascript",
  } as const,
  detect(path: string | null | undefined): SyntaxLanguage {
    const ext = (path ?? "").toLowerCase().split(".").pop() ?? "";
    if (path === null || path === undefined || !path.includes(".")) return "plain";
    switch (ext) {
      case "swift": return "swift";
      case "js": case "cjs": case "mjs": case "jsx": case "ts": case "tsx": return "javascript";
      default: return "plain";
    }
  },
};
export type SyntaxLanguage = "plain" | "swift" | "javascript";

export interface ToolPresentation {
  title: string;
  body: string;
  /** The human summary Claude Code attaches to a Bash call. */
  description: string | null;
  patch: string | null;
  path: string | null;
  /** A short qualifier after the path: "lines 10-50", "in src/". */
  note: string | null;
  /** The call reads one file, so its output is that file's text. */
  readsFile: boolean;
  /** A short phrase for a call whose first line would read as raw JSON. */
  previewOverride: string | null;
  raw: string;
  /** Whether this call looks like it wrote to files. */
  readonly editsFiles: boolean;
  /** The places the command named (`/`, `~/`, `./`). */
  readonly editedPaths: string[];
  /** Activity uses the same decoded title as the tool card, including wrappers. */
  readonly activityVerb: string;
  readonly preview: string;
  readonly outputLanguage: SyntaxLanguage;
}

interface ToolPresentationFields {
  title: string; body: string; description: string | null; patch: string | null; path: string | null;
  note: string | null; readsFile: boolean; previewOverride: string | null; raw: string;
}

const FILE_EDIT = /(<<-?\s*['"]?\w+['"]?|\bsed\s+-[a-zA-Z]*i|\btee\b|(?<![<>&|\d])>{1,2}\s*[~./\w-]+|\bopen\([^)]*['"][wa]\+?['"]|\.write_(?:text|bytes)\(|\bwriteFile(?:Sync)?\(|\bjson\.dump\(|\bgit\s+(?:apply|mv|rm|checkout|restore|stash|commit)\b|\bpatch\s+-p\d|\b(?:cp|mv|rm|touch|mkdir|ln)\s+-?\w*\s*[~./\w-]+|\bnpm\s+(?:i|install|uninstall)\b|\bpnpm\s+(?:add|remove)\b|\bpip3?\s+(?:install|uninstall)\b|\bcargo\s+(?:add|remove)\b|\bgo\s+(?:get|mod)\b)/;
const PATH_LITERAL = /(?<![\w@:/])(?:~\/|\.\/|\/)[\w.@+~-]+(?:\/[\w.@+~-]+)*/g;
const HUNK_LINE = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m;
const COMMAND_LITERAL = "(?:\"cmd\"|\\bcmd|\"command\"|\\bcommand)\\s*:\\s*(\"(?:\\\\.|[^\"\\\\])*\")";
const PATCH_LITERAL = "\\btools\\.apply_patch\\(\\s*(\"(?:\\\\.|[^\"\\\\])*\")";

function short(path: string): string {
  return path.split("/").filter((p) => p !== "").slice(-2).join("/");
}

function updatePatch(path: string | null, edits: [string, string][]): string {
  return "*** Update File: " + (path ?? "File") + "\n" + edits
    .map(([oldText, newText]) => "@@\n" + oldText.split("\n").map((l) => "-" + l).join("\n") + "\n" + newText.split("\n").map((l) => "+" + l).join("\n"))
    .join("\n");
}

function orchestrationPhrase(name: string, fields: JsonObject | undefined): string | null {
  if (name === "wait" || name === "wait_agent") {
    const timeout = fields?.["timeout_ms"];
    const milliseconds = num(timeout) ?? (str(timeout) !== undefined ? Number(str(timeout)) : undefined);
    if (milliseconds === undefined || !Number.isFinite(milliseconds) || milliseconds <= 0 || milliseconds >= Number.MAX_SAFE_INTEGER) return "waited";
    const seconds = Math.round(milliseconds / 1000);
    return seconds >= 60 ? `waited ${Math.floor(seconds / 60)} min` : `waited ${seconds}s`;
  }
  if (name === "list_agents" || name === "list_agent") return "listed agents";
  if (name === "send_message" || name === "send_message_to_agent") return "sent a message";
  return null;
}

/** The tool's own name mapping. */
function toolName(name: string): string {
  const components = name.split("__");
  if (components.length >= 3 && components[0] === "mcp") {
    const server = capitalized(components[1].replace(/_/g, " "));
    const tool = capitalized(components.slice(2).join(" ").replace(/_/g, " "));
    return server + " · " + tool;
  }
  switch (name) {
    case "exec_command": case "bash": case "shell": case "Bash": case "Shell": case "write_stdin":
      return "Shell";
    case "apply_patch": case "Edit": case "MultiEdit": case "str_replace_editor":
      return "Patch";
    case "exec": case "parallel":
      return "Tools";
    case "wait": case "wait_agent":
      return "Wait Agent";
    case "list_agents": case "list_agent":
      return "List Agents";
    case "send_message": case "send_message_to_agent":
      return "Send Message";
    case "LS":
      return "List";
    case "WebFetch":
      return "Fetch";
    case "WebSearch":
      return "Search";
    case "TodoWrite":
      return "Todos";
    case "Task": case "Agent":
      return "Agent";
    default:
      return name.includes("search") || name.includes("web") ? "Browse" : capitalized(name.replace(/_/g, " "));
  }
}

/** JSONSerialization with fragments allowed, bounded like the Swift. */
function literals(text: string, pattern: string): string[] {
  if (utf8Length(text) > MAX_JSON_BYTES) return [];
  const re = new RegExp(pattern, "g");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null && out.length < 32) {
    const parsed = parseJson(m[1]);
    if (typeof parsed === "string") out.push(parsed);
  }
  return out;
}

const shortImpl = short;
const capitalizedImpl = capitalized;
const newlineImpl = isNewline;

export namespace ToolPresentation {
  export function of(rawTitle: string, text: string): ToolPresentation {
    const parts = rawTitle.split(".");
    const name = parts.filter((p) => p !== "").slice(-1)[0] ?? rawTitle;
    let body = text;
    let title = toolName(name);
    let path: string | null = null;
    let note: string | null = null;
    let readsFile = false;
    const parsed = parseJson(text);
    const fields = obj(parsed);
    if (rawTitle === "Tool result") {
      body = unwrap(text);
    } else if (fields !== undefined) {
      path = (str(fields["file_path"]) ?? str(fields["filePath"]) ?? str(fields["path"]) ?? str(fields["notebook_path"])) ?? null;
      const edits = (objects(fields["edits"]) ?? []).flatMap((edit) => {
        const old = str(edit["old_string"]) ?? str(edit["oldString"]);
        const nw = str(edit["new_string"]) ?? str(edit["newString"]);
        return old !== undefined && nw !== undefined ? [[old, nw] as [string, string]] : [];
      });
      const oldText = str(fields["old_string"]) ?? str(fields["oldString"]) ?? str(fields["old_str"]);
      const newText = str(fields["new_string"]) ?? str(fields["newString"]) ?? str(fields["new_str"]);
      const content = str(fields["content"]) ?? str(fields["file_text"]);
      if (oldText !== undefined && newText !== undefined) {
        body = updatePatch(path, [[oldText, newText]]); title = "Patch";
      } else if (edits.length > 0) {
        body = updatePatch(path, edits); title = "Patch";
      } else if (str(fields["new_source"]) !== undefined && name === "NotebookEdit") {
        body = updatePatch(path, [["", str(fields["new_source"]) as string]]); title = "Patch";
      } else if (content !== undefined && path !== null) {
        body = "*** Add File: " + path + "\n" + content.split("\n").map((l) => "+" + l).join("\n"); title = "Patch";
      } else if ((name === "Read" || name === "read" || name === "view") && path !== null) {
        const offset = int(fields["offset"]);
        const limit = int(fields["limit"]);
        const rawRange = arr(fields["view_range"]) ?? arr(fields["viewRange"]);
        const mappedRange = rawRange?.map((v) => int(v));
        const range = mappedRange !== undefined && mappedRange.length === 2 && mappedRange.every((v) => v !== undefined)
          ? (mappedRange as number[]) : undefined;
        note = range !== undefined
          ? (range[1] < 0 ? `from line ${range[0]}` : `lines ${range[0]}–${range[1]}`)
          : offset !== undefined ? `lines ${offset}–${limit !== undefined ? String(offset + limit - 1) : "end"}` : limit !== undefined ? `first ${limit} lines` : null;
        body = path + (note !== null ? " · " + note : "");
        readsFile = true;
      } else if ((name === "Grep" || name === "Glob" || name === "grep" || name === "glob" || name === "rg") && str(fields["pattern"]) !== undefined) {
        const pathStr = str(fields["path"]);
        const scope = pathStr !== undefined ? short(pathStr) : str(fields["glob"]);
        body = (str(fields["pattern"]) as string) + (scope !== undefined ? " in " + scope : "");
        path = null;
      } else if ((objects(fields["todos"]) ?? []).length > 0) {
        body = objects(fields["todos"])!.flatMap((todo) => {
          const todoContent = str(todo["content"]); if (todoContent === undefined) return [];
          const status = str(todo["status"]) ?? "";
          return [(status === "completed" ? "☑ " : status === "in_progress" ? "◐ " : "☐ ") + todoContent];
        }).join("\n");
      } else {
        const keys = ["cmd", "command", "patch", "input", "query", "q", "url", "description", "prompt", "summary", "message", "to", "recipient", "subject"];
        let chosen: string | undefined;
        for (const k of keys) { const s = str(fields[k]); if (s !== undefined) { chosen = s; break; } }
        body = chosen ?? prettyJson(fields);
      }
    } else if (name === "exec" || name === "parallel") {
      const commands = literals(text, COMMAND_LITERAL);
      const patches = literals(text, PATCH_LITERAL);
      if (patches.length > 0) { body = patches.join("\n"); title = "Patch"; }
      else if (commands.length > 0) { body = commands.join("\n\n"); title = "Shell"; }
    }
    const hasPatch = body.includes("*** Begin Patch") || body.includes("*** Update File:") || body.includes("*** Add File:") || body.includes("*** Delete File:") ||
      body.includes("diff --git ") || HUNK_LINE.test(body);
    if (hasPatch && path === null) {
      const line = body.split("\n").find((l) => l.startsWith("*** Update File: ") || l.startsWith("*** Add File: ") || l.startsWith("*** Delete File: ") || l.startsWith("+++ b/"));
      path = line !== undefined
        ? line.replace("*** Update File: ", "").replace("*** Add File: ", "").replace("*** Delete File: ", "").replace("+++ b/", "")
        : null;
    }
    const described = str(fields?.["description"])?.trim();
    return build(title, body, described !== undefined && described !== "" ? described.slice(0, 500) : null,
      hasPatch ? body : null, path, note, readsFile, orchestrationPhrase(name, fields), text);
  }

  export function name(name: string): string { return toolName(name); }
  export function short(path: string): string { return shortImpl(path); }
  export function capitalized(text: string): string { return capitalizedImpl(text); }
  export function isNewline(c: string): boolean { return newlineImpl(c); }
  export function json(text: string): JsonValue | undefined { return parseJson(text); }
  export function unwrap(text: string, depth = 0): string {
    if (depth >= 5) return text;
    const value = parseJson(text);
    if (value === undefined) return text;
    if (typeof value === "string") return unwrap(value, depth + 1);
    const blocks = arr(value)?.every((e) => obj(e) !== undefined) ? (value as JsonObject[]) : undefined;
    if (blocks !== undefined && blocks.length > 0 && blocks.every((b) => str(b["text"]) !== undefined && (b["type"] === undefined || ["text", "input_text", "output_text"].includes(str(b["type"]) ?? "")))) {
      return blocks.map((b) => str(b["text"]) as string).map((t) => unwrap(t, depth + 1)).join("\n\n");
    }
    const fields = obj(value);
    const output = fields !== undefined ? str(fields["output"]) : undefined;
    if (fields !== undefined && output !== undefined && (fields["exit_code"] !== undefined || fields["chunk_id"] !== undefined || fields["session_id"] !== undefined)) {
      const exit = int(fields["exit_code"]);
      const status = exit !== undefined ? (exit === 0 ? null : `Exit code: ${exit}`) : null;
      const parts = [unwrap(output, depth + 1), status].filter((p): p is string => p !== null);
      return parts.join("\n");
    }
    return prettyJson(value);
  }
}

function build(title: string, body: string, description: string | null, patch: string | null, path: string | null,
  note: string | null, readsFile: boolean, previewOverride: string | null, raw: string): ToolPresentation {
  const f: ToolPresentationFields = { title, body, description, patch, path, note, readsFile, previewOverride, raw };
  return makeToolPresentation(f);
}

function makeToolPresentation(f: ToolPresentationFields): ToolPresentation {
  const editsFiles = f.patch === null && (f.title === "Shell" || f.title === "Tools") && FILE_EDIT.test(f.body);
  const editedPaths = (() => {
    if (!editsFiles) return [] as string[];
    const seen = new Set<string>(); const paths: string[] = [];
    PATH_LITERAL.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = PATH_LITERAL.exec(f.body)) !== null) {
      const p = m[0];
      if (p.length <= 2 || seen.has(p)) continue;
      seen.add(p); paths.push(p);
      if (paths.length === 24) break;
    }
    return paths;
  })();
  const outputLanguage: SyntaxLanguage = f.readsFile ? SyntaxTokenizer.detect(f.path) : "plain";
  const activityVerb = f.title === "Read" ? "Reading" : (f.title === "Patch" || f.title === "Write") ? "Editing" : "Running " + f.title;
  const preview = (() => {
    if (f.previewOverride !== null) return f.previewOverride;
    if (f.title === "Shell" && f.description !== null) return takeWhileNotNewline(f.description.slice(0, 180));
    if (f.path !== null) return short(f.path) + (f.note !== null ? " · " + f.note : "");
    const start = firstNonNewlineIndex(f.body);
    const first = takeWhileNotNewline(f.body.slice(start).slice(0, 180));
    if (["{", "[", "{}", "[]"].includes(first)) {
      for (const line of f.body.split("\n")) {
        const t = line.replace(/^[ \t]+/, "").replace(/[ \t]+$/, "");
        if (t !== "" && !["{", "}", "[", "]"].includes(t)) return t.slice(0, 180);
      }
      return "";
    }
    return first;
  })();
  return { ...f, editsFiles, editedPaths, outputLanguage, activityVerb, preview };
}

function takeWhileNotNewline(s: string): string {
  let i = 0;
  while (i < s.length && !isNewline(s[i])) i++;
  return s.slice(0, i);
}
function firstNonNewlineIndex(s: string): number {
  for (let i = 0; i < s.length; i++) if (!isNewline(s[i])) return i;
  return s.length;
}

/** A patch as numbered diff lines (DiffPreview in ToolPresentation.swift). */
export type DiffKind = "context" | "added" | "removed" | "hunk" | "header";
export interface DiffLine {
  id: number; text: string; kind: DiffKind; old: number | null; new: number | null;
}
export interface DiffPreview {
  lines: DiffLine[]; truncated: boolean; changeStarts: number[]; readonly added: number; readonly removed: number;
}

export function diffPreview(patch: string): DiffPreview {
  let old: number | null = null; let nw: number | null = null; let inside = false;
  const out: DiffLine[] = [];
  const changeStarts: number[] = [];
  let pendingHunk = false;
  const bounded = patch.slice(0, 160_000);
  const split = bounded.split("\n");
  const window = split.slice(0, 4_000);
  let lastText = -1;
  for (let i = 0; i < window.length; i++) if (window[i] !== "") lastText = i;
  for (let index = 0; index < window.length; index++) {
    const line = window[index];
    if (["*** Begin Patch", "*** End Patch", "*** End of File"].includes(line)) continue;
    if (inside && line.startsWith("\\")) continue;
    if (line === "" && (!inside || index > lastText)) continue;
    let kind: DiffKind;
    if (line.startsWith("@@")) {
      const parts = line.split(" ").filter((p) => p !== "");
      old = parts.length > 2 ? toIntOrNull(parts[1].slice(1).split(",")[0]) : null;
      nw = parts.length > 2 ? toIntOrNull(parts[2].slice(1).split(",")[0]) : null;
      inside = true; kind = "hunk"; pendingHunk = true;
    } else if (line.startsWith("diff --git ") || line.startsWith("*** ") || (line.startsWith("--- ") && !inside) || (line.startsWith("+++ ") && !inside)) {
      inside = line.startsWith("*** Add File:"); old = null; nw = inside ? 1 : null; kind = "header";
    } else if (inside && line.startsWith("+")) kind = "added";
    else if (inside && line.startsWith("-")) kind = "removed";
    else kind = inside && (line.startsWith(" ") || line === "") ? "context" : "header";
    if (line === "@@") continue;
    if (pendingHunk) { changeStarts.push(out.length); pendingHunk = false; }
    const display = line.replace("*** Update File: ", "").replace("*** Add File: ", "New file · ").replace("*** Delete File: ", "Deleted file · ");
    out.push({
      id: index, text: display, kind,
      old: kind === "context" || kind === "removed" ? old : null,
      new: kind === "context" || kind === "added" ? nw : null,
    });
    if (kind === "context" || kind === "removed") old = old === null ? old : old + 1;
    if (kind === "context" || kind === "added") nw = nw === null ? nw : nw + 1;
  }
  const added = out.filter((l) => l.kind === "added").length;
  const removed = out.filter((l) => l.kind === "removed").length;
  return { lines: out, truncated: patch.length > 160_000 || split.length > 4_000, changeStarts, added, removed };
}

function toIntOrNull(s: string | undefined): number | null {
  if (s === undefined) return null;
  const n = Number(s);
  return Number.isInteger(n) ? n : null;
}

/** DiffDocument: DiffPreview's rows with the sign each row draws. */
export interface DiffRow {
  id: number; text: string; display: string; kind: DiffKind; old: number | null; new: number | null;
}
export interface DiffDocument {
  rows: DiffRow[]; truncated: boolean; changeStarts: number[];
  readonly added: number; readonly removed: number;
}

export function diffDocument(patch: string): DiffDocument {
  const preview = diffPreview(patch);
  const rows: DiffRow[] = preview.lines.map((l) => ({ ...l, display: displayFor(l) }));
  return { rows, truncated: preview.truncated, changeStarts: preview.changeStarts, added: preview.added, removed: preview.removed };
}

function displayFor(l: DiffLine): string {
  switch (l.kind) {
    case "removed": return "−" + l.text.replace(/^-/, "");
    case "added": return l.text;
    case "context": return l.text.startsWith(" ") ? l.text : " " + l.text;
    default: return l.text;
  }
}

export interface WordRange { start: number; end: number }
export interface DiffWordsResult { old: WordRange[]; new: WordRange[]; matched: number }

interface Token { text: string; start: number; end: number }

function tokenize(text: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < text.length) {
    if (/\s/.test(text[i])) { i++; continue; }
    const start = i;
    while (i < text.length && !/\s/.test(text[i])) i++;
    out.push({ text: text.slice(start, i), start, end: i });
  }
  return out;
}

/** Word-level highlighting of a changed pair (DiffWords.highlight). */
export function diffWords(oldText: string, newText: string): DiffWordsResult {
  const a = tokenize(oldText); const b = tokenize(newText);
  const n = a.length; const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i].text === b[j].text ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const matchedA = new Array<boolean>(n).fill(false);
  const matchedB = new Array<boolean>(m).fill(false);
  let i = 0; let j = 0;
  while (i < n && j < m) {
    if (a[i].text === b[j].text) { matchedA[i] = true; matchedB[j] = true; i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return { old: unmatchedRuns(a, matchedA), new: unmatchedRuns(b, matchedB), matched: dp[0][0] };
}

function unmatchedRuns(tokens: Token[], matched: boolean[]): WordRange[] {
  const out: WordRange[] = [];
  let i = 0;
  while (i < tokens.length) {
    if (matched[i]) { i++; continue; }
    const start = tokens[i].start;
    let k = i;
    while (k < tokens.length && !matched[k]) k++;
    out.push({ start, end: tokens[k - 1].end });
    i = k;
  }
  return out;
}

export const DiffWords = { highlight: diffWords };

/** The first lines of a tool output, bounded (ToolOutputPreview). */
export interface ToolOutputPreview { readonly text: string; readonly truncated: boolean }

export function toolOutputPreview(text: string, lines = 6, characters = 2_000): ToolOutputPreview {
  const all = text.split("\n");
  const kept = all.slice(0, lines);
  let truncated = all.length > lines;
  const rendered = kept.map((line) => {
    if (line.length > characters) { truncated = true; return line.slice(0, characters) + "…"; }
    return line;
  });
  if (all.length > lines && rendered.length > 0) rendered[rendered.length - 1] += "…";
  return { text: rendered.join("\n"), truncated };
}

/** Shared routing for provider tool names (AgentToolClassification). */
export type ToolKind = "phren" | "todos" | "patch" | "agent" | "web" | "skill" | "generic";

export namespace AgentToolClassification {
  export const Kind = {
    PHREN: "phren", TODOS: "todos", PATCH: "patch", AGENT: "agent", WEB: "web", SKILL: "skill", GENERIC: "generic",
  } as const;

  export function kind(name: string | null, _input = "{}"): ToolKind {
    if (PhrenToolPresentation.recognizes(name)) return Kind.PHREN;
    if (AgentTodoPresentation.recognizes(name)) return Kind.TODOS;
    if (AgentSubagentPresentation.recognizes(name)) return Kind.AGENT;
    const tool = AgentToolCardJSON.tool(name).toLowerCase();
    if (["edit", "write", "multiedit", "apply_patch"].includes(tool)) return Kind.PATCH;
    if (WebToolPresentation.recognizes(name)) return Kind.WEB;
    if (SkillCallPresentation.recognizes(name)) return Kind.SKILL;
    return Kind.GENERIC;
  }
}
