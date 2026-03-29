/**
 * Auto-diagnostics after tool execution.
 *
 * Lightweight post-tool-use analysis that parses tool outputs for error patterns
 * and returns structured diagnostic summaries. Does not spawn heavy processes —
 * relies on parsing the tool output that already exists.
 *
 * Two modes:
 * 1. After edit_file / write_file on TS/JS files: checks the output for syntax/type errors
 *    and optionally runs a fast `tsc --noEmit` on just the edited file.
 * 2. After shell tool runs a test/lint command that fails: extracts key error lines.
 */
import { execFileSync } from "node:child_process";
import * as path from "node:path";

export interface DiagnosticResult {
  hasDiagnostics: boolean;
  summary?: string;
}

const TS_JS_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);

/** Regex patterns for common error lines in test/lint/build output. */
const ERROR_LINE_PATTERNS = [
  /^\s*error\b.*/i,
  /^\s*Error:.*/,
  /^\s*\w+Error:.*/,
  /^\s*✕.*/,             // vitest / jest failure marker
  /^\s*FAIL\b.*/,
  /^\s*×.*/,             // some test runners
  /error TS\d+:.*/,     // TypeScript errors
  /^\s*\d+\).*failing/,  // mocha-style
  /^\s*SyntaxError:.*/,
  /:\d+:\d+\s*-\s*error\b.*/,  // tsc-style file:line:col - error
  /^\s*Expected\b.*but\b.*received/i,
  /^\s*Assertion(?:Error)?:.*/,
];

/** Known test/lint command substrings that indicate the shell ran a check. */
const TEST_LINT_MARKERS = [
  "test", "jest", "vitest", "mocha", "pytest", "cargo test", "go test",
  "lint", "eslint", "biome", "tsc", "typecheck", "type-check", "check",
  "mypy", "ruff", "flake8", "clippy",
];

/**
 * Analyse a completed tool call and return diagnostics if relevant.
 *
 * This is intentionally lightweight: it parses existing output text rather than
 * spawning new processes in most cases. The one exception is a quick `tsc --noEmit`
 * for TS/JS file edits when the tool output doesn't already contain error info.
 */
export function autoRunDiagnostics(
  toolName: string,
  toolInput: Record<string, unknown>,
  toolOutput: string,
): DiagnosticResult {
  // --- Mode 1: edit_file / write_file on TS/JS files ---
  if (toolName === "edit_file" || toolName === "write_file") {
    return diagnoseFileEdit(toolInput, toolOutput);
  }

  // --- Mode 2: shell tool with test/lint command that failed ---
  if (toolName === "shell") {
    return diagnoseShellOutput(toolInput, toolOutput);
  }

  return { hasDiagnostics: false };
}

/**
 * After a file edit/write, check for syntax issues.
 * First checks the tool output itself for errors. If the edit succeeded cleanly
 * on a TS/JS file, attempts a quick `tsc --noEmit` on just that file.
 */
function diagnoseFileEdit(
  toolInput: Record<string, unknown>,
  toolOutput: string,
): DiagnosticResult {
  const filePath = (toolInput.file_path as string) || (toolInput.path as string) || "";
  const ext = path.extname(filePath).toLowerCase();

  // Only diagnose TS/JS files
  if (!TS_JS_EXTENSIONS.has(ext)) {
    return { hasDiagnostics: false };
  }

  // If the tool output already contains errors, parse those
  if (/error|Error|SyntaxError/i.test(toolOutput)) {
    const errorLines = extractErrorLines(toolOutput, 5);
    if (errorLines.length > 0) {
      return {
        hasDiagnostics: true,
        summary: `[auto-diagnostic] File edit produced errors in ${path.basename(filePath)}:\n${errorLines.join("\n")}`,
      };
    }
  }

  // Attempt a quick tsc --noEmit on just the file (TypeScript only)
  if (ext === ".ts" || ext === ".tsx" || ext === ".mts" || ext === ".cts") {
    const tscResult = runQuickTsc(filePath);
    if (tscResult) {
      return {
        hasDiagnostics: true,
        summary: tscResult,
      };
    }
  }

  return { hasDiagnostics: false };
}

/**
 * Run a fast `tsc --noEmit` scoped to a single file.
 * Returns a diagnostic summary string or null if clean / tsc unavailable.
 * Capped at 3 seconds to stay lightweight.
 */
function runQuickTsc(filePath: string): string | null {
  try {
    execFileSync("tsc", ["--noEmit", "--pretty", "false", filePath], {
      encoding: "utf-8",
      timeout: 3_000,
      maxBuffer: 50_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return null; // Clean — no errors
  } catch (err: unknown) {
    if (err && typeof err === "object" && ("stdout" in err || "stderr" in err)) {
      const e = err as { stdout?: string; stderr?: string };
      const combined = [e.stdout, e.stderr].filter(Boolean).join("\n").trim();
      if (!combined) return null;

      const errorLines = extractErrorLines(combined, 5);
      if (errorLines.length === 0) return null;

      return `[auto-diagnostic] TypeScript errors in ${path.basename(filePath)}:\n${errorLines.join("\n")}`;
    }
    // tsc not found or other spawn error — silently skip
    return null;
  }
}

/**
 * After a shell command, check if it was a test/lint command that failed
 * and extract key error lines.
 */
function diagnoseShellOutput(
  toolInput: Record<string, unknown>,
  toolOutput: string,
): DiagnosticResult {
  const command = ((toolInput.command as string) || "").toLowerCase();

  // Only process test/lint commands
  const isTestOrLint = TEST_LINT_MARKERS.some(marker => command.includes(marker));
  if (!isTestOrLint) {
    return { hasDiagnostics: false };
  }

  // Check for failure indicators in the output
  const hasFailure =
    /fail|error|FAIL|ERROR|✕|×|panic|exception/i.test(toolOutput) &&
    // Avoid false positives on success messages like "0 errors"
    !/^0\s+(errors?|failures?)/im.test(toolOutput);

  if (!hasFailure) {
    return { hasDiagnostics: false };
  }

  const errorLines = extractErrorLines(toolOutput, 5);
  if (errorLines.length === 0) {
    return { hasDiagnostics: false };
  }

  return {
    hasDiagnostics: true,
    summary: `[auto-diagnostic] Command \`${(toolInput.command as string || "").slice(0, 60)}\` errors:\n${errorLines.join("\n")}`,
  };
}

/**
 * Extract the most relevant error lines from output text.
 * Returns up to `limit` lines matching known error patterns.
 */
function extractErrorLines(output: string, limit: number): string[] {
  const lines = output.split("\n");
  const errorLines: string[] = [];

  for (const line of lines) {
    if (errorLines.length >= limit) break;
    const trimmed = line.trim();
    if (!trimmed) continue;

    for (const pattern of ERROR_LINE_PATTERNS) {
      if (pattern.test(trimmed)) {
        // Cap line length to keep summaries compact
        errorLines.push(trimmed.length > 200 ? trimmed.slice(0, 200) + "..." : trimmed);
        break;
      }
    }
  }

  return errorLines;
}
