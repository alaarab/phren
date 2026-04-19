/**
 * Inline diff renderer — produces colored ANSI output for file edits.
 *
 * Uses a simple line-based diff (longest common subsequence) with no
 * external dependencies. Output is capped at 30 lines.
 */
// ── ANSI helpers ─────────────────────────────────────────────────────────────
import { hostname } from "os";
const ESC = "\x1b[";
const red = (t) => `${ESC}31m${t}${ESC}0m`;
const green = (t) => `${ESC}32m${t}${ESC}0m`;
const dim = (t) => `${ESC}2m${t}${ESC}0m`;
const cyan = (t) => `${ESC}36m${t}${ESC}0m`;
/**
 * Wrap an absolute file path in an OSC 8 file:// hyperlink.
 * Returns the path unchanged when it is not absolute.
 */
function fileHyperlink(filePath) {
    if (!filePath.startsWith("/"))
        return filePath;
    const host = hostname();
    return `\x1b]8;;file://${host}${filePath}\x07${filePath}\x1b]8;;\x07`;
}
/**
 * Compute a line-level diff between two arrays of strings.
 * Uses the LCS (Longest Common Subsequence) approach for correctness.
 */
function computeLineDiff(oldLines, newLines) {
    const m = oldLines.length;
    const n = newLines.length;
    // Build LCS table
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            if (oldLines[i - 1] === newLines[j - 1]) {
                dp[i][j] = dp[i - 1][j - 1] + 1;
            }
            else {
                dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
            }
        }
    }
    // Backtrack to produce diff entries
    const result = [];
    let i = m;
    let j = n;
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
            result.push({ op: "equal", line: oldLines[i - 1], oldLineNo: i, newLineNo: j });
            i--;
            j--;
        }
        else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
            result.push({ op: "insert", line: newLines[j - 1], newLineNo: j });
            j--;
        }
        else {
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
export function renderInlineDiff(oldContent, newContent, filePath, colors) {
    const termWidth = process.stdout.columns || 80;
    if (termWidth >= SBS_MIN_WIDTH) {
        return renderSideBySideDiff(oldContent, newContent, filePath ?? "", termWidth, colors);
    }
    return renderInlineDiffCore(oldContent, newContent, filePath ?? "", colors);
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
export function renderSideBySideDiff(oldContent, newContent, filePath, termWidth, colors) {
    const width = termWidth ?? process.stdout.columns ?? 80;
    if (width < SBS_MIN_WIDTH) {
        return renderInlineDiffCore(oldContent, newContent, filePath, colors);
    }
    const oldLines = oldContent.split("\n");
    const newLines = newContent.split("\n");
    const diff = computeLineDiff(oldLines, newLines);
    if (diff.length === 0)
        return "";
    // Each side gets half the width minus the separator (" │ " = 3 chars)
    const halfWidth = Math.floor((width - 3) / 2);
    const lineNoWidth = 4; // e.g. "  42 "
    const contentWidth = halfWidth - lineNoWidth - 1; // -1 for the space after lineNo
    const pairs = [];
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
    const truncStr = (s, max) => s.length > max ? s.slice(0, max - 1) + "…" : s;
    const padRight = (s, len) => {
        // Pad based on visible length (strip ANSI)
        const visible = s.replace(/\x1b\[[0-9;]*m/g, "");
        const pad = Math.max(0, len - visible.length);
        return s + " ".repeat(pad);
    };
    // Color helpers — use theme values when provided, else fall back to module-level functions
    const rst = colors?.reset ?? `${ESC}0m`;
    const applyAdded = (t) => colors ? `${colors.added}${t}${rst}` : green(t);
    const applyRemoved = (t) => colors ? `${colors.removed}${t}${rst}` : red(t);
    const applyContext = (t) => colors ? `${colors.context}${t}${rst}` : dim(t);
    const applySep = (t) => colors ? `${colors.separator}${t}${rst}` : dim(t);
    const applyHeader = (t) => colors ? `${colors.header}${t}${rst}` : cyan(t);
    const applyLineNo = (t) => colors ? `${colors.lineNumber}${t}${rst}` : dim(t);
    const formatHalf = (lineNo, text, cWidth, colorFn) => {
        if (lineNo === undefined && text === undefined) {
            return " ".repeat(lineNoWidth + 1 + cWidth);
        }
        const ln = lineNo !== undefined ? String(lineNo).padStart(lineNoWidth) : " ".repeat(lineNoWidth);
        const content = text !== undefined ? truncStr(text, cWidth) : "";
        const colored = colorFn ? colorFn(content) : applyContext(content);
        return padRight(`${applyLineNo(ln)} ${colored}`, halfWidth);
    };
    const rows = [];
    let equalRun = [];
    const flushEqualRun = () => {
        if (equalRun.length === 0)
            return;
        if (equalRun.length <= SBS_COLLAPSE_THRESHOLD) {
            // Show them as normal lines
            for (const p of equalRun) {
                rows.push({
                    type: "line",
                    left: formatHalf(p.leftLineNo, p.leftText, contentWidth),
                    right: formatHalf(p.rightLineNo, p.rightText, contentWidth),
                });
            }
        }
        else {
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
        }
        else {
            flushEqualRun();
            rows.push({
                type: "line",
                left: formatHalf(pair.leftLineNo, pair.leftText, contentWidth, pair.leftText !== undefined ? applyRemoved : undefined),
                right: formatHalf(pair.rightLineNo, pair.rightText, contentWidth, pair.rightText !== undefined ? applyAdded : undefined),
            });
        }
    }
    flushEqualRun();
    // Build final output lines
    const outputLines = [];
    const sep = "│";
    for (const row of rows) {
        if (outputLines.length >= SBS_MAX_OUTPUT_LINES) {
            const remaining = rows.length - rows.indexOf(row);
            outputLines.push(applyContext(`  ... (${remaining} more rows) ...`));
            break;
        }
        if (row.type === "collapse") {
            const msg = applyContext(`... (${row.collapseCount} unchanged) ...`);
            outputLines.push(`${padRight(msg, halfWidth)} ${applySep(sep)} ${msg}`);
        }
        else {
            outputLines.push(`${row.left} ${applySep(sep)} ${row.right}`);
        }
    }
    if (outputLines.length === 0)
        return "";
    const linkedPath = fileHyperlink(filePath);
    const header = applyHeader(`─── ${linkedPath} ───`);
    return `${header}\n${outputLines.join("\n")}`;
}
/**
 * Core inline diff logic (always inline, no side-by-side switch).
 * Used as the fallback when the terminal is too narrow.
 */
function renderInlineDiffCore(oldContent, newContent, filePath, colors) {
    const rst = colors?.reset ?? `${ESC}0m`;
    const applyAdded = (t) => colors ? `${colors.added}${t}${rst}` : green(t);
    const applyRemoved = (t) => colors ? `${colors.removed}${t}${rst}` : red(t);
    const applyContext = (t) => colors ? `${colors.context}${t}${rst}` : dim(t);
    const applyHeader = (t) => colors ? `${colors.header}${t}${rst}` : cyan(t);
    const applyLineNo = (t) => colors ? `${colors.lineNumber}${t}${rst}` : dim(t);
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
    const outputLines = [];
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
            outputLines.push(applyContext(`  ... (${collapsedCount} unchanged lines) ...`));
            inCollapsed = false;
            collapsedCount = 0;
        }
        const d = diff[i];
        const lineNo = d.oldLineNo ?? d.newLineNo ?? 0;
        const lineNoStr = applyLineNo(String(lineNo).padStart(4) + " ");
        switch (d.op) {
            case "equal":
                outputLines.push(lineNoStr + applyContext(d.line));
                break;
            case "delete":
                outputLines.push(lineNoStr + applyRemoved(`- ${d.line}`));
                break;
            case "insert":
                outputLines.push(lineNoStr + applyAdded(`+ ${d.line}`));
                break;
        }
    }
    if (inCollapsed) {
        outputLines.push(applyContext(`  ... (${collapsedCount} unchanged lines) ...`));
    }
    if (outputLines.length === 0)
        return "";
    let body;
    if (outputLines.length > MAX_OUTPUT_LINES) {
        const truncated = outputLines.slice(0, MAX_FIRST_CHUNK);
        const remaining = outputLines.length - MAX_FIRST_CHUNK;
        truncated.push(applyContext(`  ... (${remaining} more lines) ...`));
        body = truncated.join("\n");
    }
    else {
        body = outputLines.join("\n");
    }
    const linkedPath = fileHyperlink(filePath);
    const header = applyHeader(`─── ${linkedPath} ───`);
    return `${header}\n${body}`;
}
/** Diff marker used in tool output to separate normal output from diff data. */
export const DIFF_MARKER = "\n---DIFF---\n";
/**
 * Encode old + new content after the diff marker for downstream rendering.
 * Format: `---DIFF---\nFILE:path\nOLD_LEN:N\n<old content>\nNEW_LEN:N\n<new content>`
 */
export function encodeDiffPayload(filePath, oldContent, newContent) {
    return `${DIFF_MARKER}FILE:${filePath}\nOLD_LEN:${oldContent.length}\n${oldContent}\nNEW_LEN:${newContent.length}\n${newContent}`;
}
/**
 * Detect and decode a diff payload from tool output.
 * Returns null if no diff marker is found.
 */
export function decodeDiffPayload(output) {
    const idx = output.indexOf(DIFF_MARKER);
    if (idx === -1)
        return null;
    const payload = output.slice(idx + DIFF_MARKER.length);
    const fileMatch = payload.match(/^FILE:(.+)\n/);
    if (!fileMatch)
        return null;
    const filePath = fileMatch[1];
    const rest = payload.slice(fileMatch[0].length);
    const oldLenMatch = rest.match(/^OLD_LEN:(\d+)\n/);
    if (!oldLenMatch)
        return null;
    const oldLen = parseInt(oldLenMatch[1], 10);
    const afterOldHeader = rest.slice(oldLenMatch[0].length);
    const oldContent = afterOldHeader.slice(0, oldLen);
    const afterOld = afterOldHeader.slice(oldLen);
    const newLenMatch = afterOld.match(/^\nNEW_LEN:(\d+)\n/);
    if (!newLenMatch)
        return null;
    const newLen = parseInt(newLenMatch[1], 10);
    const newContent = afterOld.slice(newLenMatch[0].length, newLenMatch[0].length + newLen);
    return { filePath, oldContent, newContent };
}
