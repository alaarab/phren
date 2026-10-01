import * as fs from "fs";
import * as path from "path";
import type { AgentTool, AgentToolResult } from "./types.js";
import { checkSensitivePath, validatePath } from "../permissions/sandbox.js";
import { capLine, MAX_LINE_CHARS, ripgrepPath, runRipgrep, walkTree } from "./search-support.js";

function searchFile(filePath: string, regex: RegExp, contextBefore: number, contextAfter: number): { line: number; text: string }[] {
  let content: string;
  try { content = fs.readFileSync(filePath, "utf-8"); } catch { return []; }
  const lines = content.split("\n");
  const matches: { line: number; text: string }[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (regex.test(lines[i])) {
      const start = Math.max(0, i - contextBefore);
      const end = Math.min(lines.length - 1, i + contextAfter);
      for (let j = start; j <= end; j++) {
        matches.push({ line: j + 1, text: capLine(lines[j]) });
      }
      if (end < lines.length - 1) matches.push({ line: -1, text: "--" });
    }
  }
  return matches;
}

function searchFileMultiline(filePath: string, regex: RegExp): { line: number; text: string }[] {
  let content: string;
  try { content = fs.readFileSync(filePath, "utf-8"); } catch { return []; }
  const matches: { line: number; text: string }[] = [];
  // matchAll advances after empty matches (anchors/lookarounds), unlike exec.
  // It also leaves the shared expression ready for the next file.
  for (const match of content.matchAll(regex)) {
    const beforeMatch = content.slice(0, match.index);
    const lineNo = beforeMatch.split("\n").length;
    matches.push({ line: lineNo, text: capLine(match[0]) });
  }
  return matches;
}

const FILE_TYPE_EXTENSIONS: Record<string, string[]> = {
  js: [".js", ".jsx", ".mjs", ".cjs"],
  ts: [".ts", ".tsx", ".mts", ".cts"],
  py: [".py", ".pyw"],
  rust: [".rs"],
  go: [".go"],
  java: [".java"],
  rb: [".rb"],
  css: [".css", ".scss", ".sass", ".less"],
  html: [".html", ".htm"],
  json: [".json"],
  yaml: [".yaml", ".yml"],
  md: [".md", ".mdx"],
  sh: [".sh", ".bash", ".zsh"],
  sql: [".sql"],
};

const MAX_WALK_FILES = 5000;

/** `*.ts` style filter against a file name; `*` spans anything, the rest is literal. */
function globToRegex(glob: string): RegExp {
  return new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
}

interface RipgrepSearch {
  pattern: string;
  root: string;
  isFile: boolean;
  searchPath: string;
  contextA: number;
  contextB: number;
  fileGlob?: string;
  fileType?: string;
  outputMode: string;
  multiline: boolean;
  headLimit: number;
  offset: number;
  caseInsensitive: boolean;
}

interface RgFile { rel: string; lines: { line: number; text: string }[]; matches: number }

/** Lines of one file as `N<tab>text`, with `--` between groups that do not touch. */
function formatRgLines(lines: RgFile["lines"]): string {
  const out: string[] = [];
  let last = -2;
  for (const l of lines) {
    if (last >= 0 && l.line > last + 1) out.push("--");
    out.push(`${l.line}\t${l.text}`);
    last = l.line;
  }
  return out.join("\n");
}

/**
 * Search with ripgrep's --json stream: .gitignore applies, hidden directories
 * are searched (not .git), long lines are cut. Returns null when ripgrep
 * cannot start, so the caller falls back to the JS walker.
 */
async function ripgrepSearch(rg: string, o: RipgrepSearch, signal?: AbortSignal): Promise<AgentToolResult | null> {
  const args = ["--json", "--hidden", "--no-require-git", "--glob", "!.git", "--glob", "!node_modules", "--max-columns", String(MAX_LINE_CHARS), "--max-columns-preview",
    o.caseInsensitive ? "-i" : "-s"];
  if (o.multiline) args.push("-U", "--multiline-dotall");
  if (o.outputMode === "content") args.push("-A", String(o.contextA), "-B", String(o.contextB));
  if (o.fileType) {
    for (const ext of FILE_TYPE_EXTENSIONS[o.fileType] ?? [`.${o.fileType}`]) args.push("--type-add", `phren:*${ext}`);
    args.push("--type", "phren");
  }
  if (o.fileGlob) args.push("--glob", o.fileGlob);
  // Run inside the search root and print relative paths; a lone file is its own root.
  const cwd = o.isFile ? path.dirname(o.root) : o.root;
  args.push("-e", o.pattern, "--", o.isFile ? path.basename(o.root) : ".");

  const files: RgFile[] = [];
  let current: RgFile | null = null;
  let skipFile = false;
  let kept = 0;
  const wanted = o.headLimit + o.offset;
  const onLine = (raw: string): boolean => {
    let event: { type?: string; data?: { path?: { text?: string }; lines?: { text?: string }; line_number?: number } };
    try { event = JSON.parse(raw); } catch { return false; }
    const data = event.data ?? {};
    if (event.type === "begin") {
      const rel = String(data.path?.text ?? "").replace(/^\.[\\/]/, "");
      const full = path.resolve(cwd, rel);
      const checked = validatePath(full, process.cwd(), []);
      skipFile = !checked.ok || checkSensitivePath(full).sensitive || checkSensitivePath(checked.resolved).sensitive;
      current = skipFile ? null : { rel, lines: [], matches: 0 };
    } else if ((event.type === "match" || event.type === "context") && current) {
      const text = String(data.lines?.text ?? "").replace(/\r?\n$/, "");
      // A multiline match spans lines: number each one from the match's start.
      text.split("\n").forEach((line, i) => current!.lines.push({ line: (data.line_number ?? 0) + i, text: capLine(line) }));
      if (event.type === "match") current.matches++;
    } else if (event.type === "end" && current) {
      if (current.matches > 0) { files.push(current); kept++; }
      current = null;
      return kept >= wanted;
    }
    return false;
  };

  let run;
  try {
    run = await runRipgrep(rg, args, cwd, onLine, signal);
  } catch {
    if (signal?.aborted) return { output: "Search aborted.", is_error: true };
    return null;
  }
  // A pattern ripgrep can't parse (lookaround, backreferences) may still be a
  // valid JavaScript regex: the JS walker gets it and reports it if not.
  if (run.code === 2 && files.length === 0 && run.stderr.trim()) return null;

  const page = files.slice(o.offset, o.offset + o.headLimit);
  if (page.length === 0) return { output: "No matches." };
  if (o.isFile) {
    const f = page[0];
    if (o.outputMode === "files_with_matches") return { output: o.searchPath };
    if (o.outputMode === "count") return { output: String(f.matches) };
    return { output: `${o.searchPath}:\n${formatRgLines(f.lines)}` };
  }
  if (o.outputMode === "files_with_matches") return { output: page.map((f) => f.rel).join("\n") };
  if (o.outputMode === "count") return { output: page.map((f) => `${f.rel}: ${f.matches}`).join("\n") };
  return { output: page.map((f) => `${f.rel}:\n${formatRgLines(f.lines)}`).join("\n\n") };
}

export const grepTool: AgentTool = {
  name: "grep",
  description: "Search file contents by regex. Case-sensitive unless -i is set. Honours .gitignore and searches hidden directories such as .github (not .git). Supports output modes (content, files_with_matches, count), context lines, multiline matching, file type filtering, and result pagination.",
  input_schema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regex pattern to search for." },
      path: { type: "string", description: "File or directory to search. Default: cwd." },
      context: { type: "number", description: "Lines of context around matches (-C). Default: 2." },
      "-A": { type: "number", description: "Lines to show after each match." },
      "-B": { type: "number", description: "Lines to show before each match." },
      glob: { type: "string", description: "File glob filter (e.g. '*.ts')." },
      type: { type: "string", description: "File type filter (e.g. 'js', 'py', 'ts', 'rust', 'go')." },
      output_mode: {
        type: "string",
        enum: ["content", "files_with_matches", "count"],
        description: "Output mode. 'content' shows lines, 'files_with_matches' shows paths only, 'count' shows match counts. Default: content.",
      },
      multiline: { type: "boolean", description: "Enable multiline matching (pattern can span lines). Default: false." },
      head_limit: { type: "number", description: "Max results to return. Default: 100." },
      offset: { type: "number", description: "Skip first N results before applying head_limit." },
      "-i": { type: "boolean", description: "Case insensitive search. Default: false (case-sensitive)." },
    },
    required: ["pattern"],
  },
  async execute(input, signal) {
    const pattern = input.pattern as string;
    const searchPath = (input.path as string) || process.cwd();
    const contextC = (input.context as number) ?? (input["-C"] as number) ?? 2;
    const contextA = (input["-A"] as number) ?? contextC;
    const contextB = (input["-B"] as number) ?? contextC;
    const fileGlob = input.glob as string | undefined;
    const fileType = input.type as string | undefined;
    const outputMode = (input.output_mode as string) || "content";
    const multiline = input.multiline as boolean;
    const headLimit = (input.head_limit as number) ?? 100;
    const offset = (input.offset as number) ?? 0;
    const caseInsensitive = (input["-i"] as boolean) ?? false;

    const pathResult = validatePath(searchPath, process.cwd(), []);
    if (!pathResult.ok) {
      return { output: `Path outside sandbox: ${pathResult.error}`, is_error: true };
    }

    if (checkSensitivePath(path.resolve(searchPath)).sensitive || checkSensitivePath(pathResult.resolved).sensitive) {
      return { output: "Access denied: sensitive path.", is_error: true };
    }

    const stat = fs.statSync(pathResult.resolved, { throwIfNoEntry: false });
    if (!stat) return { output: `Path not found: ${searchPath}`, is_error: true };

    const rg = ripgrepPath();
    if (rg) {
      const found = await ripgrepSearch(rg, {
        pattern, root: pathResult.resolved, isFile: stat.isFile(), searchPath, contextA, contextB, fileGlob, fileType,
        outputMode, multiline, headLimit, offset, caseInsensitive,
      }, signal);
      if (found) return found;
    }

    let regex: RegExp;
    try {
      const flags = (caseInsensitive ? "i" : "") + (multiline ? "gs" : "");
      regex = new RegExp(pattern, flags);
    } catch {
      return { output: `Invalid regex: ${pattern}`, is_error: true };
    }

    // Single file
    if (stat.isFile()) {
      const results = multiline
        ? searchFileMultiline(pathResult.resolved, regex)
        : searchFile(pathResult.resolved, regex, contextB, contextA);
      if (outputMode === "files_with_matches") return { output: results.length > 0 ? searchPath : "No matches." };
      if (outputMode === "count") return { output: `${results.filter((r) => r.line > 0).length}` };
      return { output: results.length > 0 ? `${searchPath}:\n${results.map((r) => r.line > 0 ? `${r.line}\t${r.text}` : r.text).join("\n")}` : "No matches." };
    }

    // Directory search: the JS walker, used when ripgrep is missing.
    const exts = fileType ? (FILE_TYPE_EXTENSIONS[fileType] ?? [`.${fileType}`]) : null;
    const globRegex = fileGlob ? globToRegex(fileGlob) : null;
    const walked = walkTree(searchPath, MAX_WALK_FILES, (rel) => {
      const base = path.basename(rel);
      return (!exts || exts.some((ext) => base.endsWith(ext))) && (!globRegex || globRegex.test(base));
    });
    const files = walked.files.map((rel) => path.join(searchPath, rel));
    const note = walked.truncated ? `searched the first ${files.length} files; narrow the path or glob` : "";

    const output: string[] = [];
    let skipped = 0;

    for (const file of files) {
      if (output.length >= headLimit + offset) break;

      const checked = validatePath(file, process.cwd(), []);
      if (!checked.ok || checkSensitivePath(file).sensitive || checkSensitivePath(checked.resolved).sensitive) continue;
      // Ignore devices, pipes and directories, including symlinks to them.
      try { if (!fs.statSync(checked.resolved).isFile()) continue; } catch { continue; }
      const results = multiline
        ? searchFileMultiline(checked.resolved, regex)
        : searchFile(checked.resolved, regex, contextB, contextA);

      if (results.length === 0) continue;

      if (skipped < offset) { skipped++; continue; }
      if (output.length >= headLimit) break;

      const rel = path.relative(searchPath, file);

      if (outputMode === "files_with_matches") {
        output.push(rel);
      } else if (outputMode === "count") {
        output.push(`${rel}: ${results.filter((r) => r.line > 0).length}`);
      } else {
        output.push(`${rel}:\n${results.map((r) => r.line > 0 ? `${r.line}\t${r.text}` : r.text).join("\n")}`);
      }
    }

    if (output.length === 0) return { output: note ? `No matches (${note}).` : "No matches." };
    const body = output.join(outputMode === "content" ? "\n\n" : "\n");
    return { output: note ? `${body}\n\n(${note})` : body };
  },
};
