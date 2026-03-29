/**
 * Built-in PostToolUse auto-capture — watches tool results for patterns
 * worth remembering and auto-creates phren findings.
 *
 * Captures:
 * - Test failures with file/line info
 * - New file creation (tracks project structure changes)
 * - Shell command errors with resolution context
 * - Build failures
 * - Dependency changes
 */
import type { PhrenContext } from "./context.js";

interface CapturePattern {
  /** Which tool(s) this pattern matches. */
  tools: string[];
  /** Regex to match against tool output. */
  pattern: RegExp;
  /** Template for the finding. $0 = full match, $1/$2/... = capture groups. */
  template: (match: RegExpMatchArray, input: Record<string, unknown>) => string;
  /** Min output length to check (skip short outputs). */
  minLength?: number;
}

const CAPTURE_PATTERNS: CapturePattern[] = [
  // Test failures
  {
    tools: ["shell"],
    pattern: /(\d+)\s+(?:tests?\s+)?failed/i,
    template: (m, input) => {
      const cmd = (input.command as string) || "";
      return `Test failure: ${m[1]} tests failed when running \`${cmd.slice(0, 80)}\``;
    },
  },
  // TypeScript compilation errors
  {
    tools: ["shell"],
    pattern: /error TS(\d+):\s+(.+)/,
    template: (m) => `TypeScript error TS${m[1]}: ${m[2].slice(0, 100)}`,
  },
  // Python import errors
  {
    tools: ["shell"],
    pattern: /ModuleNotFoundError:\s+No module named '([^']+)'/,
    template: (m) => `Missing Python module: ${m[1]}. Install with pip install ${m[1]}`,
  },
  // npm/pnpm install failures
  {
    tools: ["shell"],
    pattern: /ERR!\s+(?:code\s+)?(\w+).*?npm\s+ERR/s,
    template: (m, input) => {
      const cmd = (input.command as string) || "";
      return `npm error ${m[1]} when running \`${cmd.slice(0, 60)}\``;
    },
    minLength: 100,
  },
  // Port already in use
  {
    tools: ["shell"],
    pattern: /EADDRINUSE.*?(?:port\s+)?(\d+)/i,
    template: (m) => `Port ${m[1]} already in use. Check for existing processes.`,
  },
  // Permission denied
  {
    tools: ["shell", "write_file", "edit_file"],
    pattern: /EACCES|Permission denied/i,
    template: (_m, input) => {
      const path = (input.path as string) || (input.file_path as string) || (input.command as string) || "";
      return `Permission denied accessing: ${path.slice(0, 100)}`;
    },
  },
  // Git merge conflicts
  {
    tools: ["shell"],
    pattern: /CONFLICT.*?Merge conflict in\s+(.+)/,
    template: (m) => `Git merge conflict in: ${m[1]}`,
  },
];

/** Tracks what we've already captured this session to avoid duplicates. */
const capturedHashes = new Set<string>();
const MAX_CAPTURES_PER_SESSION = 8;
let captureCount = 0;

/**
 * Check a tool result for patterns worth auto-capturing as findings.
 * Returns the finding text if a pattern matches, or null.
 */
export function checkToolCapture(
  toolName: string,
  input: Record<string, unknown>,
  output: string,
  isError: boolean,
): string | null {
  // Only capture from errors or long outputs (likely verbose)
  if (!isError && output.length < 200) return null;
  if (captureCount >= MAX_CAPTURES_PER_SESSION) return null;

  for (const pattern of CAPTURE_PATTERNS) {
    if (!pattern.tools.includes(toolName)) continue;
    if (pattern.minLength && output.length < pattern.minLength) continue;

    const match = output.match(pattern.pattern);
    if (!match) continue;

    const finding = pattern.template(match, input);

    // Deduplicate
    const hash = finding.slice(0, 50);
    if (capturedHashes.has(hash)) continue;
    capturedHashes.add(hash);
    captureCount++;

    return finding;
  }

  return null;
}

/**
 * Auto-capture a tool result as a phren finding if it matches known patterns.
 */
export async function autoCaptureTool(
  ctx: PhrenContext,
  toolName: string,
  input: Record<string, unknown>,
  output: string,
  isError: boolean,
): Promise<void> {
  const finding = checkToolCapture(toolName, input, output, isError);
  if (!finding || !ctx.project) return;

  try {
    const { addFinding } = await import("@phren/cli/core/finding");
    addFinding(ctx.phrenPath, ctx.project, `${finding} <!-- auto_captured -->`);
  } catch {
    // Best effort
  }
}

/** Reset capture state for a new session. */
export function resetToolCapture(): void {
  capturedHashes.clear();
  captureCount = 0;
}
