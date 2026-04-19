import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import * as fs from "fs";
import * as nodePath from "path";
import * as os from "os";
/** Map a flat cursor offset to { line, col } within a multi-line string. */
function offsetToPos(text, offset) {
    let line = 0;
    let col = 0;
    for (let i = 0; i < offset && i < text.length; i++) {
        if (text[i] === "\n") {
            line++;
            col = 0;
        }
        else {
            col++;
        }
    }
    return { line, col };
}
/** Map { line, col } back to a flat cursor offset. */
function posToOffset(lines, line, col) {
    let offset = 0;
    for (let i = 0; i < line && i < lines.length; i++) {
        offset += lines[i].length + 1; // +1 for the \n
    }
    const targetLine = lines[line] ?? "";
    return offset + Math.min(col, targetLine.length);
}
/**
 * Custom controlled text input with full cursor and multi-line support.
 * Replaces ink-text-input to enable cursor positioning, word jump,
 * kill-line, Shift+Enter multi-line, and other readline-style keybindings.
 */
export function PhrenInput({ value, onChange, onSubmit, placeholder, focus = true }) {
    const [cursor, setCursor] = useState(value.length);
    // Keep cursor within bounds when value changes externally
    useEffect(() => {
        setCursor((c) => Math.min(c, value.length));
    }, [value]);
    const lines = value.split("\n");
    const isMultiLine = lines.length > 1;
    useInput((input, key) => {
        // Bracketed paste: strip \x1b[200~ (start) and \x1b[201~ (end) markers.
        // If markers are present, insert the cleaned text at cursor as a single paste.
        const PASTE_START = "\x1b[200~";
        const PASTE_END = "\x1b[201~";
        if (input.includes(PASTE_START) || input.includes(PASTE_END)) {
            const cleaned = input
                .replaceAll(PASTE_START, "")
                .replaceAll(PASTE_END, "")
                .replace(/\r\n?/g, "\n"); // normalize line endings
            if (cleaned.length > 0) {
                const next = value.slice(0, cursor) + cleaned + value.slice(cursor);
                onChange(next);
                setCursor(cursor + cleaned.length);
            }
            return;
        }
        // Heuristic paste detection for terminals without bracketed paste
        if (input.length > 10 && !input.startsWith("\x1b")) {
            const normalized = input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
            const before = value.slice(0, cursor);
            const after = value.slice(cursor);
            const newValue = before + normalized + after;
            const newCursor = cursor + normalized.length;
            onChange(newValue);
            setCursor(newCursor);
            return;
        }
        // Shift+Enter — insert newline (multi-line input)
        if (key.return && key.shift) {
            const next = value.slice(0, cursor) + "\n" + value.slice(cursor);
            onChange(next);
            setCursor(cursor + 1);
            return;
        }
        // Plain Enter — submit
        if (key.return) {
            onSubmit(value);
            setCursor(0);
            return;
        }
        // Up arrow — in multi-line: move cursor up; single-line: pass through
        if (key.upArrow && isMultiLine) {
            const { line, col } = offsetToPos(value, cursor);
            if (line > 0) {
                setCursor(posToOffset(lines, line - 1, col));
            }
            return;
        }
        // Down arrow — in multi-line: move cursor down; single-line: pass through
        if (key.downArrow && isMultiLine) {
            const { line, col } = offsetToPos(value, cursor);
            if (line < lines.length - 1) {
                setCursor(posToOffset(lines, line + 1, col));
            }
            return;
        }
        // Left arrow — move cursor left (with word jump modifiers)
        if (key.leftArrow || (key.ctrl && input === "b")) {
            if (key.meta || key.ctrl) {
                // Alt+Left / Ctrl+Left / Alt+B / Ctrl+B — word jump left
                setCursor((c) => wordBoundaryLeft(value, c));
            }
            else {
                setCursor((c) => Math.max(0, c - 1));
            }
            return;
        }
        // Right arrow — move cursor right (with word jump modifiers)
        if (key.rightArrow || (key.ctrl && input === "f")) {
            if (key.meta || key.ctrl) {
                // Alt+Right / Ctrl+Right / Alt+F / Ctrl+F — word jump right
                setCursor((c) => wordBoundaryRight(value, c));
            }
            else {
                setCursor((c) => Math.min(value.length, c + 1));
            }
            return;
        }
        // Alt+B — word jump left (standalone)
        if (key.meta && input === "b") {
            setCursor((c) => wordBoundaryLeft(value, c));
            return;
        }
        // Alt+F — word jump right (standalone)
        if (key.meta && input === "f") {
            setCursor((c) => wordBoundaryRight(value, c));
            return;
        }
        // Home / Ctrl+A — beginning of current line
        if (key.ctrl && input === "a") {
            const { line } = offsetToPos(value, cursor);
            setCursor(posToOffset(lines, line, 0));
            return;
        }
        // End / Ctrl+E — end of current line
        if (key.ctrl && input === "e") {
            const { line } = offsetToPos(value, cursor);
            setCursor(posToOffset(lines, line, lines[line].length));
            return;
        }
        // Alt+Backspace / Alt+Delete — delete word before cursor
        if ((key.backspace || key.delete) && key.meta) {
            const boundary = wordBoundaryLeft(value, cursor);
            onChange(value.slice(0, boundary) + value.slice(cursor));
            setCursor(boundary);
            return;
        }
        // Ctrl+Backspace / Ctrl+Delete — delete word before cursor
        if ((key.backspace || key.delete) && key.ctrl) {
            const boundary = wordBoundaryLeft(value, cursor);
            onChange(value.slice(0, boundary) + value.slice(cursor));
            setCursor(boundary);
            return;
        }
        // Backspace — delete character before cursor
        if (key.backspace || key.delete) {
            if (cursor > 0) {
                const next = value.slice(0, cursor - 1) + value.slice(cursor);
                onChange(next);
                setCursor(cursor - 1);
            }
            return;
        }
        // Ctrl+W — delete word before cursor
        if (key.ctrl && input === "w") {
            const boundary = wordBoundaryLeft(value, cursor);
            onChange(value.slice(0, boundary) + value.slice(cursor));
            setCursor(boundary);
            return;
        }
        // Ctrl+U — kill to beginning of current line
        if (key.ctrl && input === "u") {
            const { line } = offsetToPos(value, cursor);
            const lineStart = posToOffset(lines, line, 0);
            onChange(value.slice(0, lineStart) + value.slice(cursor));
            setCursor(lineStart);
            return;
        }
        // Ctrl+K — kill to end of current line
        if (key.ctrl && input === "k") {
            const { line } = offsetToPos(value, cursor);
            const lineEnd = posToOffset(lines, line, lines[line].length);
            onChange(value.slice(0, cursor) + value.slice(lineEnd));
            return;
        }
        // Tab — file path completion (slash commands handled by shortcuts hook)
        if (key.tab && !key.shift) {
            if (!value.startsWith("/")) {
                const result = completeFilePath(value, cursor);
                if (result) {
                    onChange(result.value);
                    setCursor(result.cursor);
                }
            }
            return;
        }
        // Escape, arrows already handled — skip control sequences
        if (key.escape || key.upArrow || key.downArrow) {
            return;
        }
        // Skip remaining ctrl sequences we don't handle
        if (key.ctrl || key.meta) {
            return;
        }
        // Regular character input
        if (input.length > 0) {
            const next = value.slice(0, cursor) + input + value.slice(cursor);
            onChange(next);
            setCursor(cursor + input.length);
        }
    }, { isActive: focus });
    // Render: empty with placeholder
    if (value.length === 0 && placeholder) {
        return (_jsxs(Text, { children: [_jsx(Text, { inverse: true, children: " " }), _jsx(Text, { dimColor: true, children: placeholder })] }));
    }
    // Single-line render (fast path)
    if (!isMultiLine) {
        const before = value.slice(0, cursor);
        const cursorChar = cursor < value.length ? value[cursor] : " ";
        const after = cursor < value.length ? value.slice(cursor + 1) : "";
        return (_jsxs(Text, { children: [before, _jsx(Text, { inverse: true, children: cursorChar }), after] }));
    }
    // Multi-line render: each line separately, cursor inverse on correct position
    let charsSeen = 0;
    return (_jsx(Box, { flexDirection: "column", children: lines.map((line, lineIdx) => {
            const lineStart = charsSeen;
            const lineEnd = lineStart + line.length;
            // Advance past this line's content + its \n separator (except last line)
            charsSeen = lineEnd + (lineIdx < lines.length - 1 ? 1 : 0);
            const cursorInLine = cursor >= lineStart && cursor <= lineEnd;
            if (!cursorInLine) {
                return _jsx(Text, { children: line || " " }, lineIdx);
            }
            const localCursor = cursor - lineStart;
            const before = line.slice(0, localCursor);
            const cursorChar = localCursor < line.length ? line[localCursor] : " ";
            const after = localCursor < line.length ? line.slice(localCursor + 1) : "";
            return (_jsxs(Text, { children: [before, _jsx(Text, { inverse: true, children: cursorChar }), after] }, lineIdx));
        }) }));
}
/** Find the start of the word to the left of pos (stops at newlines). */
function wordBoundaryLeft(text, pos) {
    if (pos <= 0)
        return 0;
    let i = pos - 1;
    // Skip whitespace but not newlines
    while (i > 0 && text[i] !== "\n" && /\s/.test(text[i]))
        i--;
    // Skip word characters
    while (i > 0 && text[i - 1] !== "\n" && /\S/.test(text[i - 1]))
        i--;
    return i;
}
/** Find the end of the word to the right of pos (stops at newlines). */
function wordBoundaryRight(text, pos) {
    const len = text.length;
    if (pos >= len)
        return len;
    let i = pos;
    // Skip word characters
    while (i < len && text[i] !== "\n" && /\S/.test(text[i]))
        i++;
    // Skip whitespace but not newlines
    while (i < len && text[i] !== "\n" && /\s/.test(text[i]))
        i++;
    return i;
}
/** Expand ~ to home directory. */
function expandHome(p) {
    if (p === "~" || p.startsWith("~/")) {
        return os.homedir() + p.slice(1);
    }
    return p;
}
/**
 * File path tab completion.
 * Extracts the last whitespace-delimited token before the cursor,
 * checks if it looks like a path, and completes it from the filesystem.
 * Returns null if no completion applies.
 */
function completeFilePath(value, cursor) {
    // Extract the text before cursor and find the last token
    const before = value.slice(0, cursor);
    const tokenMatch = before.match(/(\S+)$/);
    if (!tokenMatch)
        return null;
    const token = tokenMatch[1];
    const tokenStart = cursor - token.length;
    // Only complete tokens that look like paths
    if (!/[/.~]/.test(token))
        return null;
    const expanded = expandHome(token);
    const resolved = nodePath.resolve(expanded);
    const dir = expanded.endsWith("/") ? resolved : nodePath.dirname(resolved);
    const partial = expanded.endsWith("/") ? "" : nodePath.basename(resolved);
    let entries;
    try {
        entries = fs.readdirSync(dir);
    }
    catch {
        return null;
    }
    const matches = entries.filter((e) => e.startsWith(partial));
    if (matches.length === 0)
        return null;
    let completion;
    if (matches.length === 1) {
        completion = matches[0];
        // Append / for directories
        try {
            const stat = fs.statSync(nodePath.join(dir, completion));
            if (stat.isDirectory())
                completion += "/";
        }
        catch { /* leave as is */ }
    }
    else {
        // Find longest common prefix among matches
        let prefix = matches[0];
        for (let i = 1; i < matches.length; i++) {
            const m = matches[i];
            let j = 0;
            while (j < prefix.length && j < m.length && prefix[j] === m[j])
                j++;
            prefix = prefix.slice(0, j);
        }
        if (prefix.length <= partial.length)
            return null; // no progress
        completion = prefix;
    }
    // Build the completed token: keep the original prefix up to partial, append completion
    const suffix = completion.slice(partial.length);
    if (suffix.length === 0)
        return null;
    const after = value.slice(cursor);
    const newValue = before + suffix + after;
    const newCursor = cursor + suffix.length;
    return { value: newValue, cursor: newCursor };
}
