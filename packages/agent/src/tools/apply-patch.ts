/**
 * apply_patch: the Codex CLI patch format, which GPT/Codex models are trained
 * to emit.
 *
 *   *** Begin Patch
 *   *** Add File: path          (+ lines follow)
 *   *** Delete File: path
 *   *** Update File: path
 *   *** Move to: new/path       (optional, after Update File)
 *   @@ optional anchor line
 *    context
 *   -removed
 *   +added
 *   *** End of File             (optional: hunk is anchored at end of file)
 *   *** End Patch
 *
 * The whole patch is validated and computed in memory before anything is
 * written, so a hunk that fails to apply leaves every file untouched.
 * Context is located exactly, then ignoring trailing whitespace, then
 * ignoring surrounding whitespace, then with typographic punctuation folded
 * to ASCII (the same fallbacks Codex uses).
 */
import * as fs from "fs";
import * as path from "path";
import type { AgentTool } from "./types.js";
import { checkSensitivePath, validatePath } from "../permissions/sandbox.js";
import { describeNotFound } from "./edit-engine.js";

export interface PatchChunk {
  /** Text after `@@ `, used to seek before matching the chunk. */
  anchor?: string;
  oldLines: string[];
  newLines: string[];
  /** The hunk in order, so context lines can keep the file's own text. */
  diff: Array<{ tag: " " | "-" | "+"; text: string }>;
  endOfFile: boolean;
}

export type PatchOp =
  | { kind: "add"; path: string; lines: string[] }
  | { kind: "delete"; path: string }
  | { kind: "update"; path: string; moveTo?: string; chunks: PatchChunk[] };

const BEGIN = "*** Begin Patch";
const END = "*** End Patch";
const ADD = "*** Add File: ";
const DELETE = "*** Delete File: ";
const UPDATE = "*** Update File: ";
const MOVE = "*** Move to: ";
const EOF_MARK = "*** End of File";

export class PatchError extends Error {}

/** Parse a patch. Tolerates a heredoc wrapper and a missing End marker. */
export function parsePatch(text: string): PatchOp[] {
  let lines = text.replace(/\r\n/g, "\n").split("\n");
  // Strip an `apply_patch <<'EOF'` … `EOF` wrapper models sometimes include.
  while (lines.length > 0 && lines[0].trim() === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  if (lines.length > 0 && /^(apply_patch\s*)?<<\s*['"]?EOF['"]?\s*$/.test(lines[0].trim())) {
    lines = lines.slice(1);
    if (lines.length > 0 && lines[lines.length - 1].trim() === "EOF") lines = lines.slice(0, -1);
  }
  if (lines.length === 0 || lines[0].trim() !== BEGIN) {
    throw new PatchError(`The first line of the patch must be '${BEGIN}'.`);
  }
  let end = lines.findIndex((l, i) => i > 0 && l.trim() === END);
  if (end === -1) end = lines.length;
  const body = lines.slice(1, end);

  const ops: PatchOp[] = [];
  let i = 0;
  while (i < body.length) {
    const line = body[i];
    if (line.trim() === "") { i++; continue; }
    if (line.startsWith(ADD)) {
      const p = line.slice(ADD.length).trim();
      const added: string[] = [];
      i++;
      while (i < body.length && !body[i].startsWith("*** ")) {
        if (!body[i].startsWith("+")) {
          throw new PatchError(`Add File ${p}: every content line must start with '+' (got ${JSON.stringify(body[i])}).`);
        }
        added.push(body[i].slice(1));
        i++;
      }
      ops.push({ kind: "add", path: p, lines: added });
      continue;
    }
    if (line.startsWith(DELETE)) {
      ops.push({ kind: "delete", path: line.slice(DELETE.length).trim() });
      i++;
      continue;
    }
    if (line.startsWith(UPDATE)) {
      const p = line.slice(UPDATE.length).trim();
      i++;
      let moveTo: string | undefined;
      if (i < body.length && body[i].startsWith(MOVE)) {
        moveTo = body[i].slice(MOVE.length).trim();
        i++;
      }
      const chunks: PatchChunk[] = [];
      let current: PatchChunk | null = null;
      while (i < body.length) {
        const l = body[i];
        if (l.startsWith("*** ") && l.trim() !== EOF_MARK) break;
        if (l.trim() === EOF_MARK) {
          if (current) current.endOfFile = true;
          i++;
          continue;
        }
        if (l.startsWith("@@")) {
          const anchor = l.slice(2).trim();
          current = { ...(anchor ? { anchor } : {}), oldLines: [], newLines: [], diff: [], endOfFile: false };
          chunks.push(current);
          i++;
          continue;
        }
        if (!current) {
          // Codex allows the first hunk to omit its @@ line.
          current = { oldLines: [], newLines: [], diff: [], endOfFile: false };
          chunks.push(current);
        }
        const tag = l[0];
        const rest = l.slice(1);
        if (l === "" || tag === " ") {
          const text = l === "" ? "" : rest;
          current.oldLines.push(text);
          current.newLines.push(text);
          current.diff.push({ tag: " ", text });
        } else if (tag === "-") {
          current.oldLines.push(rest);
          current.diff.push({ tag: "-", text: rest });
        } else if (tag === "+") {
          current.newLines.push(rest);
          current.diff.push({ tag: "+", text: rest });
        } else {
          throw new PatchError(
            `Update File ${p}: unexpected line ${JSON.stringify(l)}. Hunk lines must start with ' ', '-' or '+'.`,
          );
        }
        i++;
      }
      const real = chunks.filter((c) => c.oldLines.length > 0 || c.newLines.length > 0);
      if (real.length === 0 && !moveTo) throw new PatchError(`Update File ${p}: no hunks.`);
      ops.push({ kind: "update", path: p, ...(moveTo ? { moveTo } : {}), chunks: real });
      continue;
    }
    throw new PatchError(
      `Unexpected line ${JSON.stringify(line)}. Expected '${ADD}', '${DELETE}' or '${UPDATE}'.`,
    );
  }
  if (ops.length === 0) throw new PatchError("The patch contains no file operations.");
  return ops;
}

/** Every path a patch touches (sources and move targets). */
export function patchPaths(ops: PatchOp[]): string[] {
  const out: string[] = [];
  for (const op of ops) {
    out.push(op.path);
    if (op.kind === "update" && op.moveTo) out.push(op.moveTo);
  }
  return out;
}

const PUNCT: Record<string, string> = {
  "‘": "'", "’": "'", "‚": "'", "‛": "'",
  "“": '"', "”": '"', "„": '"', "‟": '"',
  "‐": "-", "‑": "-", "‒": "-", "–": "-", "—": "-", "―": "-", "−": "-",
  " ": " ", " ": " ", " ": " ", " ": " ", " ": " ",
};
const foldPunct = (s: string) => s.trim().replace(/[‘-‟‐-―−     ]/g, (c) => PUNCT[c] ?? c);

const NORMALIZERS: Array<(s: string) => string> = [
  (s) => s,
  (s) => s.trimEnd(),
  (s) => s.trim(),
  foldPunct,
];

/** Find `pattern` in `lines` at or after `from`; with `eof`, prefer the end of file. */
export function seekSequence(lines: string[], pattern: string[], from: number, eof: boolean): number {
  if (pattern.length === 0) return from;
  if (pattern.length > lines.length) return -1;
  const last = lines.length - pattern.length;
  const start = eof ? last : Math.max(0, from);
  for (const norm of NORMALIZERS) {
    for (let i = start; i <= last; i++) {
      let ok = true;
      for (let j = 0; j < pattern.length; j++) {
        if (norm(lines[i + j]) !== norm(pattern[j])) { ok = false; break; }
      }
      if (ok) return i;
    }
  }
  // An EOF-anchored hunk whose context is not at the very end: search normally.
  return eof ? seekSequence(lines, pattern, from, false) : -1;
}

function splitFile(content: string): string[] {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Apply the chunks of one Update File to its current content. */
export function applyChunks(content: string, chunks: PatchChunk[], filePath: string): string {
  const crlf = content.includes("\r\n");
  const lines = splitFile(content);
  const replacements: Array<{ at: number; remove: number; insert: string[] }> = [];
  let cursor = 0;
  chunks.forEach((chunk, n) => {
    if (chunk.anchor) {
      const at = seekSequence(lines, [chunk.anchor], cursor, false);
      if (at === -1) {
        throw new PatchError(`${filePath}: hunk ${n + 1}: could not find the @@ anchor line ${JSON.stringify(chunk.anchor)}.`);
      }
      cursor = at + 1;
    }
    if (chunk.oldLines.length === 0) {
      // Pure insertion: at the anchor when one was given, otherwise at end of file.
      replacements.push({ at: chunk.anchor ? cursor : lines.length, remove: 0, insert: chunk.newLines });
      return;
    }
    let oldLines = chunk.oldLines;
    let diff = chunk.diff;
    let at = seekSequence(lines, oldLines, cursor, chunk.endOfFile);
    if (at === -1 && oldLines[oldLines.length - 1] === "") {
      // A trailing blank context line often stands for the file's final newline.
      oldLines = oldLines.slice(0, -1);
      const lastOld = diff.map((d) => d.tag !== "+").lastIndexOf(true);
      const dropped = diff[lastOld];
      diff = diff.filter((_, k) => k !== lastOld);
      const tail = diff[diff.length - 1];
      if (dropped.tag === "-" && tail?.tag === "+" && tail.text === "") diff = diff.slice(0, -1);
      at = seekSequence(lines, oldLines, cursor, chunk.endOfFile);
    }
    if (at === -1) {
      const detail = describeNotFound(lines.join("\n"), oldLines.join("\n"), "The hunk's context and '-' lines were");
      throw new PatchError(`${filePath}: hunk ${n + 1} did not apply.\n${detail}`);
    }
    // Context lines keep the file's own text (whitespace, typographic
    // quotes) even when the patch matched them loosely.
    const insert: string[] = [];
    let k = 0;
    for (const d of diff) {
      if (d.tag === " ") insert.push(lines[at + k++]);
      else if (d.tag === "-") k++;
      else insert.push(d.text);
    }
    replacements.push({ at, remove: oldLines.length, insert });
    cursor = at + oldLines.length;
  });
  const out = [...lines];
  for (const r of [...replacements].sort((a, b) => b.at - a.at)) out.splice(r.at, r.remove, ...r.insert);
  const joined = `${out.join("\n")}\n`;
  return crlf ? joined.replace(/\n/g, "\r\n") : joined;
}

export interface PlannedWrite {
  path: string;
  /** null deletes. */
  content: string | null;
  before: string | null;
  status: "A" | "M" | "D";
}

/** Compute every file change for a patch without writing anything. */
export function planPatch(ops: PatchOp[], cwd: string): PlannedWrite[] {
  const state = new Map<string, string | null>();
  const read = (p: string): string | null => {
    const abs = path.resolve(cwd, p);
    if (state.has(abs)) return state.get(abs)!;
    if (!fs.existsSync(abs)) return null;
    if (fs.statSync(abs).isDirectory()) throw new PatchError(`${p} is a directory.`);
    return fs.readFileSync(abs, "utf-8");
  };
  const writes: PlannedWrite[] = [];
  const record = (p: string, content: string | null, before: string | null, status: PlannedWrite["status"]) => {
    state.set(path.resolve(cwd, p), content);
    writes.push({ path: p, content, before, status });
  };
  for (const op of ops) {
    if (op.kind === "add") {
      const before = read(op.path);
      record(op.path, op.lines.length > 0 ? `${op.lines.join("\n")}\n` : "", before, before === null ? "A" : "M");
    } else if (op.kind === "delete") {
      const before = read(op.path);
      if (before === null) throw new PatchError(`Delete File ${op.path}: file does not exist.`);
      record(op.path, null, before, "D");
    } else {
      const before = read(op.path);
      if (before === null) throw new PatchError(`Update File ${op.path}: file does not exist. Use '*** Add File:' to create it.`);
      const after = op.chunks.length > 0 ? applyChunks(before, op.chunks, op.path) : before;
      if (op.moveTo) {
        record(op.path, null, before, "D");
        record(op.moveTo, after, read(op.moveTo), "A");
      } else {
        record(op.path, after, before, "M");
      }
    }
  }
  return writes;
}

export const applyPatchTool: AgentTool = {
  name: "apply_patch",
  description:
    "Apply a patch in the Codex apply_patch format to add, delete, update or move files in one atomic call. " +
    "Format: '*** Begin Patch', then per file '*** Add File: <path>' (lines prefixed '+'), '*** Delete File: <path>', " +
    "or '*** Update File: <path>' (optional '*** Move to: <path>') followed by hunks that start with '@@' (optionally " +
    "'@@ <a line to anchor on>') and contain ' ' context, '-' removed and '+' added lines; end with '*** End Patch'. " +
    "Give about 3 lines of context around each change. If any hunk fails, no file is changed.",
  input_schema: {
    type: "object",
    properties: {
      patch: { type: "string", description: "The full patch text, from '*** Begin Patch' to '*** End Patch'." },
    },
    required: ["patch"],
  },
  async execute(input) {
    const text = (input.patch ?? input.input) as unknown;
    if (typeof text !== "string" || text.trim() === "") {
      return { output: "patch is required.", is_error: true };
    }
    const cwd = process.cwd();
    let writes: PlannedWrite[];
    try {
      const ops = parsePatch(text);
      for (const p of patchPaths(ops)) {
        const sensitive = checkSensitivePath(path.resolve(cwd, p));
        if (sensitive.sensitive) return { output: `Access denied: ${p}: ${sensitive.reason}`, is_error: true };
        const sandbox = validatePath(p, cwd, []);
        if (!sandbox.ok) return { output: `Path outside sandbox: ${sandbox.error}`, is_error: true };
      }
      writes = planPatch(ops, cwd);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { output: `apply_patch failed; no files were changed.\n${msg}`, is_error: true };
    }
    for (const w of writes) {
      const abs = path.resolve(cwd, w.path);
      if (w.content === null) {
        if (fs.existsSync(abs)) fs.rmSync(abs);
      } else {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, w.content);
      }
    }
    const summary = writes.map((w) => `${w.status} ${w.path}`).join("\n");
    return { output: `Success. Updated the following files:\n${summary}` };
  },
};
