/**
 * Inline diff renderer — produces colored ANSI output for file edits.
 *
 * Uses a simple line-based diff (longest common subsequence) with no
 * external dependencies. Output is capped at 30 lines.
 */

// ── ANSI helpers ─────────────────────────────────────────────────────────────

const ESC = "\x1b[";
const red = (t: string) => `${ESC}31m${t}${ESC}0m`;
const green = (t: string) => `${ESC}32m${t}${ESC}0m`;
const dim = (t: string) => `${ESC}2m${t}${ESC}0m`;
const cyan = (t: string) => `${ESC}36m${t}${ESC}0m`;

// ── Line diff (Myers-like, simple O(ND) for small inputs) ────────────────────

type DiffOp = "equal" | "insert" | "delete";
interface DiffEntry {
  op: DiffOp;
  line: string;
  oldLineNo?: number;
  newLineNo?: number;
}

/**
 * Compute a line-level diff between two arrays of strings.
 * Uses the LCS (Longest Common Subsequence) approach for correctness.
 */
function computeLineDiff(oldLines: string[], newLines: string[]): DiffEntry[] {
  const m = oldLines.length;
  const n = newLines.length;

  // Build LCS table
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to produce diff entries
  const result: DiffEntry[] = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      result.push({ op: "equal", line: oldLines[i - 1], oldLineNo: i, newLineNo: j });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.push({ op: "insert", line: newLines[j - 1], newLineNo: j });
      j--;
    } else {
      result.push({ op: "delete", line: oldLines[i - 1], oldLineNo: i });
      i--;
    }
  }
  result.reverse();
  return result;
}

// ── Renderer ─────────────────────────────────────────────────────────────────

const MAX_OUTPUT_LINES = 30;
const MAX_FIRST_CHUNK = 20;
const CONTEXT_LINES = 3;

/**
 * Render a colored inline diff between old and new file content.
 *
 * Output format:
 *   ─── path/to/file ───
 *   (context lines in gray, removed in red, added in green)
 *   Collapsed unchanged sections shown as "... (N unchanged lines) ..."
 *
 * Capped at 30 output lines. If the diff is larger, shows the first 20
 * lines plus a "... (N more changes)" trailer.
 */
export function renderInlineDiff(oldContent: string, newContent: string, filePath: string): string {
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  const diff = computeLineDiff(oldLines, newLines);

  // Identify which diff entries have changes nearby (within CONTEXT_LINES)
  const hasChange = diff.map((d) => d.op !== "equal");
  const visible = new Array(diff.length).fill(false);

  for (let i = 0; i < diff.length; i++) {
    if (hasChange[i]) {
      for (let c = Math.max(0, i - CONTEXT_LINES); c <= Math.min(diff.length - 1, i + CONTEXT_LINES); c++) {
        visible[c] = true;
      }
    }
  }

  // Build output lines
  const outputLines: string[] = [];
  let inCollapsed = false;
  let collapsedCount = 0;

  for (let i = 0; i < diff.length; i++) {
    if (!visible[i]) {
      if (!inCollapsed) {
        inCollapsed = true;
        collapsedCount = 0;
      }
      collapsedCount++;
      continue;
    }

    // Emit collapsed marker if we just exited a collapsed section
    if (inCollapsed) {
      outputLines.push(dim(`  ... (${collapsedCount} unchanged lines) ...`));
      inCollapsed = false;
      collapsedCount = 0;
    }

    const d = diff[i];
    const lineNo = d.oldLineNo ?? d.newLineNo ?? 0;
    const lineNoStr = dim(String(lineNo).padStart(4) + " ");

    switch (d.op) {
      case "equal":
        outputLines.push(lineNoStr + dim(d.line));
        break;
      case "delete":
        outputLines.push(lineNoStr + red(`- ${d.line}`));
        break;
      case "insert":
        outputLines.push(lineNoStr + green(`+ ${d.line}`));
        break;
    }
  }

  // Trailing collapsed section
  if (inCollapsed) {
    outputLines.push(dim(`  ... (${collapsedCount} unchanged lines) ...`));
  }

  // If no changes found
  if (outputLines.length === 0) {
    return "";
  }

  // Cap output
  let body: string;
  if (outputLines.length > MAX_OUTPUT_LINES) {
    const truncated = outputLines.slice(0, MAX_FIRST_CHUNK);
    const remaining = outputLines.length - MAX_FIRST_CHUNK;
    truncated.push(dim(`  ... (${remaining} more lines) ...`));
    body = truncated.join("\n");
  } else {
    body = outputLines.join("\n");
  }

  const header = cyan(`─── ${filePath} ───`);
  return `${header}\n${body}`;
}

/** Diff marker used in tool output to separate normal output from diff data. */
export const DIFF_MARKER = "\n---DIFF---\n";

/**
 * Encode old + new content after the diff marker for downstream rendering.
 * Format: `---DIFF---\nFILE:path\nOLD_LEN:N\n<old content>\nNEW_LEN:N\n<new content>`
 */
export function encodeDiffPayload(filePath: string, oldContent: string, newContent: string): string {
  return `${DIFF_MARKER}FILE:${filePath}\nOLD_LEN:${oldContent.length}\n${oldContent}\nNEW_LEN:${newContent.length}\n${newContent}`;
}

/**
 * Detect and decode a diff payload from tool output.
 * Returns null if no diff marker is found.
 */
export function decodeDiffPayload(output: string): { filePath: string; oldContent: string; newContent: string } | null {
  const idx = output.indexOf(DIFF_MARKER);
  if (idx === -1) return null;

  const payload = output.slice(idx + DIFF_MARKER.length);
  const fileMatch = payload.match(/^FILE:(.+)\n/);
  if (!fileMatch) return null;

  const filePath = fileMatch[1];
  const rest = payload.slice(fileMatch[0].length);

  const oldLenMatch = rest.match(/^OLD_LEN:(\d+)\n/);
  if (!oldLenMatch) return null;

  const oldLen = parseInt(oldLenMatch[1], 10);
  const afterOldHeader = rest.slice(oldLenMatch[0].length);
  const oldContent = afterOldHeader.slice(0, oldLen);

  const afterOld = afterOldHeader.slice(oldLen);
  const newLenMatch = afterOld.match(/^\nNEW_LEN:(\d+)\n/);
  if (!newLenMatch) return null;

  const newLen = parseInt(newLenMatch[1], 10);
  const newContent = afterOld.slice(newLenMatch[0].length, newLenMatch[0].length + newLen);

  return { filePath, oldContent, newContent };
}
