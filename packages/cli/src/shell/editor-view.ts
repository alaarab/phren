/**
 * Drawing for the shell's modal editor.
 *
 * The frame is painted whole on every key, so there is no real terminal cursor
 * to move: the character under the cursor is drawn inverted instead.
 */

import { displayWidth, lineViewport, padToWidth, style, truncateLine } from "./render.js";
import type { EditorState } from "../editor/buffer.js";

const GUTTER = 5;

function modeBadge(state: EditorState): string {
  switch (state.mode) {
    case "insert": return style.boldGreen(" INSERT ");
    case "command": return style.boldYellow(" COMMAND ");
    default: return style.boldCyan(" NORMAL ");
  }
}

/** The line with the cursor drawn on it, as inverse video. */
function withCursor(text: string, col: number, active: boolean): string {
  if (!active) return text;
  const chars = [...text];
  const at = Math.min(col, chars.length);
  const before = chars.slice(0, at).join("");
  const under = chars[at] ?? " ";
  const after = chars.slice(at + 1).join("");
  return `${before}${style.invert(under)}${after}`;
}

export function renderEditor(state: EditorState, width: number, height: number): string[] {
  const out: string[] = [];
  const bodyHeight = Math.max(1, height - 2);

  // Header: what is open, which mode, and whether it is unsaved.
  const dirty = state.dirty ? style.boldYellow(" ●") : "";
  const header = `  ${style.bold(state.label)}${dirty}  ${modeBadge(state)}`;
  out.push(padToWidth(truncateLine(header, width), width));

  // Body, scrolled to keep the cursor in view.
  const numbered = state.lines.map((text, i) => {
    const active = i === state.cursor.line;
    const gutter = active
      ? style.boldCyan(String(i + 1).padStart(GUTTER - 1) + " ")
      : style.dim(String(i + 1).padStart(GUTTER - 1) + " ");
    const shown = withCursor(text, state.cursor.col, active && state.mode !== "command");
    return `${gutter}${shown}`;
  });
  const vp = lineViewport(numbered, state.cursor.line, state.cursor.line, bodyHeight, 0);
  for (const line of vp.lines) out.push(padToWidth(truncateLine(line, width), width));
  while (out.length < height - 1) out.push(padToWidth("", width));

  // Status: the command being typed wins, then a message, then position.
  const position = `${state.cursor.line + 1},${state.cursor.col + 1}`;
  let status: string;
  if (state.mode === "command") {
    status = `  ${style.boldCyan(state.command)}${style.cyan("█")}`;
  } else if (state.message) {
    status = `  ${style.yellow(state.message)}`;
  } else {
    const hint = state.mode === "insert"
      ? style.dim("esc  normal mode")
      : style.dim(":w write  ·  :q quit  ·  i insert  ·  / search");
    status = `  ${hint}`;
  }
  const right = style.dim(position);
  const pad = Math.max(1, width - displayWidth(status) - displayWidth(right) - 2);
  out.push(padToWidth(truncateLine(`${status}${" ".repeat(pad)}${right}`, width), width));

  return out.slice(0, height);
}
