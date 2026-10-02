/**
 * A syntax check after each edit, so a dropped brace or a broken indent shows
 * up in the edit's own result instead of three tool calls later in a test run.
 * OpenCode feeds LSP diagnostics back the same way; this is the cheap part of
 * that: parse errors only, no type checking, nothing that needs a server.
 *
 * - TypeScript and JavaScript: Node's own TypeScript parser
 *   (`module.stripTypeScriptTypes`, Node 22.13 and later), in-process. Syntax
 *   it parses but won't strip (enums, namespaces) counts as fine; JSX files
 *   are skipped, since the parser doesn't take JSX.
 * - Python: `python3` parses it with `ast` (no .pyc is written).
 * - JSON: JSON.parse, skipped for files with comments (tsconfig and friends).
 *
 * Anything else, a missing parser, or a parser that fails is silent. Errors the
 * file already had before the edit are not blamed on it.
 */
import { execFileSync } from "child_process";
import * as nodeModule from "module";
import * as path from "path";

const MAX_ERRORS = 5;
const SCRIPT_EXTENSIONS = new Set([".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"]);

interface SyntaxError {
  line?: number;
  column?: number;
  message: string;
}

type StripTypes = (code: string) => string;

function scriptErrors(content: string): SyntaxError[] | null {
  const strip = (nodeModule as unknown as { stripTypeScriptTypes?: StripTypes }).stripTypeScriptTypes;
  if (typeof strip !== "function") return null;
  // JSX in a .js file: the parser would call it an error.
  if (/<\/[A-Za-z]|\/>/.test(content)) return null;
  // The first call prints an ExperimentalWarning; keep it out of the TUI.
  const emitWarning = process.emitWarning;
  process.emitWarning = (() => {}) as typeof process.emitWarning;
  try {
    strip(content);
    return [];
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (code !== "ERR_INVALID_TYPESCRIPT_SYNTAX") return null;
    return [{ message: err instanceof Error ? err.message.split("\n")[0] : String(err) }];
  } finally {
    process.emitWarning = emitWarning;
  }
}

function pythonErrors(content: string): SyntaxError[] | null {
  const script = [
    "import ast, json, sys",
    "try:",
    "    ast.parse(sys.stdin.read())",
    "    print('[]')",
    "except SyntaxError as e:",
    "    print(json.dumps([{'line': e.lineno or 1, 'column': e.offset or 1, 'message': e.msg}]))",
  ].join("\n");
  try {
    const out = execFileSync("python3", ["-c", script], { input: content, encoding: "utf-8", timeout: 5_000, stdio: ["pipe", "pipe", "ignore"] });
    return JSON.parse(out) as SyntaxError[];
  } catch {
    return null;
  }
}

function jsonErrors(content: string): SyntaxError[] | null {
  try {
    JSON.parse(content);
    return [];
  } catch (err) {
    // JSONC (tsconfig.json, .vscode settings) is not JSON; don't flag it.
    if (/\/\/|\/\*/.test(content)) return null;
    const message = err instanceof Error ? err.message : String(err);
    const pos = Number(/position (\d+)/.exec(message)?.[1] ?? "0");
    const before = content.slice(0, pos).split("\n");
    return [{ line: before.length, column: before[before.length - 1].length + 1, message }];
  }
}

function errorsFor(filePath: string, content: string): SyntaxError[] | null {
  const ext = path.extname(filePath).toLowerCase();
  if (SCRIPT_EXTENSIONS.has(ext)) return scriptErrors(content);
  if (ext === ".py") return pythonErrors(content);
  if (ext === ".json") return jsonErrors(content);
  return null;
}

/**
 * A note for the edit result when the edit left the file with syntax errors,
 * or null. `before` is the content the edit started from (null for a new file).
 */
export function syntaxCheckNote(filePath: string, before: string | null, after: string): string | null {
  if (process.env.PHREN_AGENT_SYNTAX_CHECK === "off") return null;
  let errors: SyntaxError[] | null;
  try {
    errors = errorsFor(filePath, after);
  } catch {
    return null;
  }
  if (!errors || errors.length === 0) return null;
  let preexisting = false;
  if (before !== null) {
    try {
      preexisting = (errorsFor(filePath, before)?.length ?? 0) >= errors.length;
    } catch { /* treat as clean before */ }
  }
  if (preexisting) return null;
  const shown = errors.slice(0, MAX_ERRORS).map((e) => `  ${filePath}${e.line ? `:${e.line}:${e.column ?? 1}` : ""} ${e.message}`);
  const more = errors.length > MAX_ERRORS ? `\n  … ${errors.length - MAX_ERRORS} more` : "";
  return `Syntax check: the file no longer parses.\n${shown.join("\n")}${more}`;
}
