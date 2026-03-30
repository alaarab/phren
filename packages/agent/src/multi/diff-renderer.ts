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
const SBS_MAX_OUTPUT_LINES = 40;
const SBS_COLLAPSE_THRESHOLD = 3;
const SBS_MIN_WIDTH = 70;

/**
 * Render a colored inline diff between old and new file content.
 * Automatically switches to side-by-side when the terminal is wide enough.
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
  const termWidth = process.stdout.columns || 80;
  if (termWidth >= SBS_MIN_WIDTH) {
    return renderSideBySideDiff(oldContent, newContent, filePath, termWidth);
  }
  return renderInlineDiffCore(oldContent, newContent, filePath);
}

// ── Side-by-side renderer ───────────────────────────────────────────────────

/**
 * Render a side-by-side colored diff between old and new file content.
 *
 * Falls back to inline diff when terminal width < 70 columns.
 *
 * Layout:
 *   ─── path/to/file ───
 *   <lineNo> old text          │ <lineNo> new text
 *
 * Deletions in red (left only), additions in green (right only),
 * unchanged lines in dim on both sides. Collapses unchanged runs > 3 lines.
 * Capped at 40 output lines.
 */
export function renderSideBySideDiff(
  oldContent: string,
  newContent: string,
  filePath: string,
  termWidth?: number,
): string {
  const width = termWidth ?? process.stdout.columns ?? 80;
  if (width < SBS_MIN_WIDTH) {
    return renderInlineDiffCore(oldContent, newContent, filePath);
  }

  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  const diff = computeLineDiff(oldLines, newLines);

  if (diff.length === 0) return "";

  // Each side gets half the width minus the separator (" │ " = 3 chars)
  const halfWidth = Math.floor((width - 3) / 2);
  const lineNoWidth = 4; // e.g. "  42 "
  const contentWidth = halfWidth - lineNoWidth - 1; // -1 for the space after lineNo

  // Build paired rows: each row has optional left + optional right
  interface PairRow {
    kind: "equal" | "change";
    leftLineNo?: number;
    leftText?: string;
    rightLineNo?: number;
    rightText?: string;
  }

  const pairs: PairRow[] = [];
  for (const entry of diff) {
    switch (entry.op) {
      case "equal":
        pairs.push({
          kind: "equal",
          leftLineNo: entry.oldLineNo,
          leftText: entry.line,
          rightLineNo: entry.newLineNo,
          rightText: entry.line,
        });
        break;
      case "delete":
        pairs.push({
          kind: "change",
          leftLineNo: entry.oldLineNo,
          leftText: entry.line,
        });
        break;
      case "insert":
        pairs.push({
          kind: "change",
          rightLineNo: entry.newLineNo,
          rightText: entry.line,
        });
        break;
    }
  }

  // Collapse long runs of unchanged lines (> SBS_COLLAPSE_THRESHOLD)
  interface OutputRow {
    type: "line" | "collapse";
    left?: string; // formatted left half
    right?: string; // formatted right half
    collapseCount?: number;
  }

  const truncStr = (s: string, max: number): string =>
    s.length > max ? s.slice(0, max - 1) + "…" : s;

  const padRight = (s: string, len: number): string => {
    // Pad based on visible length (strip ANSI)
    const visible = s.replace(/\x1b\[[0-9;]*m/g, "");
    const pad = Math.max(0, len - visible.length);
    return s + " ".repeat(pad);
  };

  const formatHalf = (
    lineNo: number | undefined,
    text: string | undefined,
    cWidth: number,
    colorFn?: (t: string) => string,
  ): string => {
    if (lineNo === undefined && text === undefined) {
      return " ".repeat(lineNoWidth + 1 + cWidth);
    }
    const ln = lineNo !== undefined ? String(lineNo).padStart(lineNoWidth) : " ".repeat(lineNoWidth);
    const content = text !== undefined ? truncStr(text, cWidth) : "";
    const colored = colorFn ? colorFn(content) : dim(content);
    return padRight(`${dim(ln)} ${colored}`, halfWidth);
  };

  const rows: OutputRow[] = [];
  let equalRun: PairRow[] = [];

  const flushEqualRun = () => {
    if (equalRun.length === 0) return;
    if (equalRun.length <= SBS_COLLAPSE_THRESHOLD) {
      // Show them as normal lines
      for (const p of equalRun) {
        rows.push({
          type: "line",
          left: formatHalf(p.leftLineNo, p.leftText, contentWidth),
          right: formatHalf(p.rightLineNo, p.rightText, contentWidth),
        });
      }
    } else {
      // Show first context line, collapse marker, last context line
      const first = equalRun[0];
      const last = equalRun[equalRun.length - 1];
      rows.push({
        type: "line",
        left: formatHalf(first.leftLineNo, first.leftText, contentWidth),
        right: formatHalf(first.rightLineNo, first.rightText, contentWidth),
      });
      rows.push({ type: "collapse", collapseCount: equalRun.length - 2 });
      rows.push({
        type: "line",
        left: formatHalf(last.leftLineNo, last.leftText, contentWidth),
        right: formatHalf(last.rightLineNo, last.rightText, contentWidth),
      });
    }
    equalRun = [];
  };

  for (const pair of pairs) {
    if (pair.kind === "equal") {
      equalRun.push(pair);
    } else {
      flushEqualRun();
      rows.push({
        type: "line",
        left: formatHalf(pair.leftLineNo, pair.leftText, contentWidth, pair.leftText !== undefined ? red : undefined),
        right: formatHalf(
          pair.rightLineNo,
          pair.rightText,
          contentWidth,
          pair.rightText !== undefined ? green : undefined,
        ),
      });
    }
  }
  flushEqualRun();

  // Build final output lines
  const outputLines: string[] = [];
  const sep = "│";

  for (const row of rows) {
    if (outputLines.length >= SBS_MAX_OUTPUT_LINES) {
      const remaining = rows.length - rows.indexOf(row);
      outputLines.push(dim(`  ... (${remaining} more rows) ...`));
      break;
    }
    if (row.type === "collapse") {
      const msg = dim(`... (${row.collapseCount} unchanged) ...`);
      outputLines.push(`${padRight(msg, halfWidth)} ${dim(sep)} ${msg}`);
    } else {
      outputLines.push(`${row.left} ${dim(sep)} ${row.right}`);
    }
  }

  if (outputLines.length === 0) return "";

  const header = cyan(`─── ${filePath} ───`);
  return `${header}\n${outputLines.join("\n")}`;
}

/**
 * Core inline diff logic (always inline, no side-by-side switch).
 * Used as the fallback when the terminal is too narrow.
 */
function renderInlineDiffCore(oldContent: string, newContent: string, filePath: string): string {
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  const diff = computeLineDiff(oldLines, newLines);

  const hasChange = diff.map((d) => d.op !== "equal");
  const visible = new Array(diff.length).fill(false);

  for (let i = 0; i < diff.length; i++) {
    if (hasChange[i]) {
      for (let c = Math.max(0, i - CONTEXT_LINES); c <= Math.min(diff.length - 1, i + CONTEXT_LINES); c++) {
        visible[c] = true;
      }
    }
  }

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

  if (inCollapsed) {
    outputLines.push(dim(`  ... (${collapsedCount} unchanged lines) ...`));
  }

  if (outputLines.length === 0) return "";

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
