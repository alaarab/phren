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
import { checkFindingIntegrity } from "../permissions/privacy.js";

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

/**
 * Instance-scoped tracker for tool auto-capture state.
 * Each agent gets its own tracker to avoid cross-contamination in multi-agent mode.
 */
export class ToolCaptureTracker {
  private capturedHashes = new Set<string>();
  private captureCount = 0;
  private readonly maxCaptures: number;

  constructor(maxCaptures = 8) {
    this.maxCaptures = maxCaptures;
  }

  /**
   * Check a tool result for patterns worth auto-capturing as findings.
   * Returns the finding text if a pattern matches, or null.
   */
  checkToolCapture(
    toolName: string,
    input: Record<string, unknown>,
    output: string,
    isError: boolean,
  ): string | null {
    // Only capture from errors or long outputs (likely verbose)
    if (!isError && output.length < 200) return null;
    if (this.captureCount >= this.maxCaptures) return null;

    for (const pattern of CAPTURE_PATTERNS) {
      if (!pattern.tools.includes(toolName)) continue;
      if (pattern.minLength && output.length < pattern.minLength) continue;

      const match = output.match(pattern.pattern);
      if (!match) continue;

      const finding = pattern.template(match, input);

      // Deduplicate
      const hash = finding.slice(0, 50);
      if (this.capturedHashes.has(hash)) continue;
      this.capturedHashes.add(hash);
      this.captureCount++;

      return finding;
    }

    return null;
  }

  /**
   * Auto-capture a tool result as a phren finding if it matches known patterns.
   */
  async autoCaptureTool(
    ctx: PhrenContext,
    toolName: string,
    input: Record<string, unknown>,
    output: string,
    isError: boolean,
  ): Promise<void> {
    const finding = this.checkToolCapture(toolName, input, output, isError);
    if (!finding || !ctx.project) return;

    // Integrity check: reject auto-captured findings that look adversarial
    const integrity = checkFindingIntegrity(finding);
    if (!integrity.safe) return;

    try {
      const { addFinding } = await import("@phren/cli/core/finding");
      addFinding(ctx.phrenPath, ctx.project, `${finding} <!-- auto_captured --> <!-- source:auto_capture -->`);
    } catch {
      // Best effort
    }
  }

  /** Reset capture state for a new session. */
  reset(): void {
    this.capturedHashes.clear();
    this.captureCount = 0;
  }
}

/** Factory function to create a new tracker instance. */
export function createToolCaptureTracker(maxCaptures?: number): ToolCaptureTracker {
  return new ToolCaptureTracker(maxCaptures);
}

// ── Backward-compatible module-level API ──────────────────────────────────────
// Delegates to a default instance. Prefer using ToolCaptureTracker directly.
const _defaultTracker = new ToolCaptureTracker();

/** @deprecated Use ToolCaptureTracker instance method instead. */
export function checkToolCapture(
  toolName: string,
  input: Record<string, unknown>,
  output: string,
  isError: boolean,
): string | null {
  return _defaultTracker.checkToolCapture(toolName, input, output, isError);
}

/** @deprecated Use ToolCaptureTracker instance method instead. */
export async function autoCaptureTool(
  ctx: PhrenContext,
  toolName: string,
  input: Record<string, unknown>,
  output: string,
  isError: boolean,
): Promise<void> {
  return _defaultTracker.autoCaptureTool(ctx, toolName, input, output, isError);
}

/** @deprecated Use ToolCaptureTracker instance method instead. */
export function resetToolCapture(): void {
  _defaultTracker.reset();
}
