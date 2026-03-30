import React, { useState, useEffect } from "react";
import { Text, useInput } from "ink";

export interface PhrenInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  placeholder?: string;
  focus?: boolean;
}

/**
 * Custom controlled text input with full cursor support.
 * Replaces ink-text-input to enable cursor positioning, word jump,
 * kill-line, and other readline-style keybindings.
 */
export function PhrenInput({ value, onChange, onSubmit, placeholder, focus = true }: PhrenInputProps) {
  const [cursor, setCursor] = useState(value.length);

  // Keep cursor within bounds when value changes externally
  useEffect(() => {
    setCursor((c) => Math.min(c, value.length));
  }, [value]);

  useInput(
    (input, key) => {
      // Bracketed paste: strip \x1b[200~ (start) and \x1b[201~ (end) markers.
      // If markers are present, insert the cleaned text at cursor as a single paste.
      const PASTE_START = "\x1b[200~";
      const PASTE_END = "\x1b[201~";
      if (input.includes(PASTE_START) || input.includes(PASTE_END)) {
        const cleaned = input
          .replaceAll(PASTE_START, "")
          .replaceAll(PASTE_END, "")
          .replace(/\r\n?/g, "\n")  // normalize line endings
          .replace(/\n/g, " ");     // flatten newlines to spaces (single-line input)
        if (cleaned.length > 0) {
          const next = value.slice(0, cursor) + cleaned + value.slice(cursor);
          onChange(next);
          setCursor(cursor + cleaned.length);
        }
        return;
      }

      // Submit
      if (key.return) {
        onSubmit(value);
        setCursor(0);
        return;
      }

      // Left arrow / Ctrl+B — move cursor left
      if (key.leftArrow || (key.ctrl && input === "b")) {
        if (key.meta) {
          // Alt+Left / Alt+B — word jump left
          setCursor((c) => wordBoundaryLeft(value, c));
        } else {
          setCursor((c) => Math.max(0, c - 1));
        }
        return;
      }

      // Right arrow / Ctrl+F — move cursor right
      if (key.rightArrow || (key.ctrl && input === "f")) {
        if (key.meta) {
          // Alt+Right / Alt+F — word jump right
          setCursor((c) => wordBoundaryRight(value, c));
        } else {
          setCursor((c) => Math.min(value.length, c + 1));
        }
        return;
      }

      // Alt+B — word jump left (standalone, not combined with arrow)
      if (key.meta && input === "b") {
        setCursor((c) => wordBoundaryLeft(value, c));
        return;
      }

      // Alt+F — word jump right (standalone)
      if (key.meta && input === "f") {
        setCursor((c) => wordBoundaryRight(value, c));
        return;
      }

      // Home / Ctrl+A — beginning of line
      if (key.ctrl && input === "a") {
        setCursor(0);
        return;
      }

      // End / Ctrl+E — end of line
      if (key.ctrl && input === "e") {
        setCursor(value.length);
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

      // Ctrl+U — kill line (delete everything before cursor)
      if (key.ctrl && input === "u") {
        onChange(value.slice(cursor));
        setCursor(0);
        return;
      }

      // Ctrl+K — kill to end of line (delete everything after cursor)
      if (key.ctrl && input === "k") {
        onChange(value.slice(0, cursor));
        return;
      }

      // Tab, escape, arrows already handled — skip control sequences
      if (key.tab || key.escape || key.upArrow || key.downArrow) {
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
    },
    { isActive: focus },
  );

  // Render: text with inverse cursor
  if (value.length === 0 && placeholder) {
    return (
      <Text>
        <Text inverse> </Text>
        <Text dimColor>{placeholder}</Text>
      </Text>
    );
  }

  const before = value.slice(0, cursor);
  const cursorChar = cursor < value.length ? value[cursor] : " ";
  const after = cursor < value.length ? value.slice(cursor + 1) : "";

  return (
    <Text>
      {before}
      <Text inverse>{cursorChar}</Text>
      {after}
    </Text>
  );
}

/** Find the start of the word to the left of pos. */
function wordBoundaryLeft(text: string, pos: number): number {
  if (pos <= 0) return 0;
  let i = pos - 1;
  // Skip whitespace
  while (i > 0 && /\s/.test(text[i]!)) i--;
  // Skip word characters
  while (i > 0 && /\S/.test(text[i - 1]!)) i--;
  return i;
}

/** Find the end of the word to the right of pos. */
function wordBoundaryRight(text: string, pos: number): number {
  const len = text.length;
  if (pos >= len) return len;
  let i = pos;
  // Skip word characters
  while (i < len && /\S/.test(text[i]!)) i++;
  // Skip whitespace
  while (i < len && /\s/.test(text[i]!)) i++;
  return i;
}
