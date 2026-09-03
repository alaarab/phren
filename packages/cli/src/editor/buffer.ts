/**
 * A small modal text editor, as a pure state machine.
 *
 * `applyEditorKey(state, key) -> state` holds every behaviour, so the whole
 * editor is testable without a terminal — the same shape `handleMenuKey` in
 * shell/render-api.ts uses. Rendering and file IO live elsewhere.
 *
 * This is deliberately a subset of vim: the motions and edits reached for
 * without thinking, and nothing else. An unrecognised key does nothing rather
 * than approximating something. Anyone wanting the real thing presses `e`.
 */

export type EditorMode = "normal" | "insert" | "command";

export interface Cursor {
  line: number;
  col: number;
}

export interface EditorState {
  /** File being edited, and how to name it on the status line. */
  path: string;
  label: string;
  lines: string[];
  cursor: Cursor;
  mode: EditorMode;
  /** The `:` or `/` line being typed, including its leading character. */
  command: string;
  /** A half-finished multi-key command: "d", "y" or "g". */
  pending: string;
  /** Yanked or deleted lines, for p and P. */
  register: string[];
  undo: Array<{ lines: string[]; cursor: Cursor }>;
  dirty: boolean;
  /** Shown on the status line: an error, or a confirmation. */
  message: string;
  /** Last search, for n and N. */
  search: string;
  /** Set when the buffer should be written; the host clears it. */
  wantSave: boolean;
  /** Set when the editor should close; the host clears it. */
  wantClose: boolean;
}

const UNDO_DEPTH = 100;

export function createEditorState(path: string, label: string, content: string): EditorState {
  // A trailing newline is a line terminator, not an empty last line.
  const body = content.endsWith("\n") ? content.slice(0, -1) : content;
  return {
    path,
    label,
    lines: body.length ? body.split("\n") : [""],
    cursor: { line: 0, col: 0 },
    mode: "normal",
    command: "",
    pending: "",
    register: [],
    undo: [],
    dirty: false,
    message: "",
    search: "",
    wantSave: false,
    wantClose: false,
  };
}

/** Text as it should be written: one trailing newline, always. */
export function editorText(state: EditorState): string {
  return `${state.lines.join("\n")}\n`;
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(v, hi));

/** In normal mode the cursor sits on a character, so it stops one before the end. */
function clampCursor(state: EditorState, cursor: Cursor, mode = state.mode): Cursor {
  const line = clamp(cursor.line, 0, state.lines.length - 1);
  const text = state.lines[line] ?? "";
  const max = mode === "insert" ? text.length : Math.max(0, text.length - 1);
  return { line, col: clamp(cursor.col, 0, max) };
}

function snapshot(state: EditorState): EditorState["undo"] {
  return [...state.undo, { lines: [...state.lines], cursor: { ...state.cursor } }].slice(-UNDO_DEPTH);
}

/** Apply an edit: records undo, marks dirty, clears any half-typed command. */
function mutate(state: EditorState, lines: string[], cursor: Cursor, message = ""): EditorState {
  const next: EditorState = { ...state, undo: snapshot(state), lines, dirty: true, pending: "", message };
  return { ...next, cursor: clampCursor(next, cursor) };
}

function move(state: EditorState, cursor: Cursor): EditorState {
  return { ...state, cursor: clampCursor(state, cursor), pending: "" };
}

const WORD = /[A-Za-z0-9_]/;

/** Start of the next word, wrapping onto following lines. */
function nextWord(state: EditorState): Cursor {
  let { line, col } = state.cursor;
  const text = () => state.lines[line] ?? "";
  const inWord = WORD.test(text()[col] ?? "");
  // Leave the current word, then any gap.
  while (col < text().length && WORD.test(text()[col] ?? "") === inWord && (inWord || !WORD.test(text()[col] ?? ""))) {
    col++;
    if (col >= text().length) break;
    if (inWord && !WORD.test(text()[col] ?? "")) break;
    if (!inWord && WORD.test(text()[col] ?? "")) break;
  }
  while (col < text().length && !WORD.test(text()[col] ?? "")) col++;
  while (col >= text().length && line < state.lines.length - 1) {
    line++;
    col = 0;
    while (col < text().length && !WORD.test(text()[col] ?? "")) col++;
    if (col < text().length) break;
  }
  return { line, col };
}

/** Start of the previous word, wrapping onto earlier lines. */
function prevWord(state: EditorState): Cursor {
  let { line, col } = state.cursor;
  const text = () => state.lines[line] ?? "";
  col--;
  while (col < 0 && line > 0) {
    line--;
    col = Math.max(0, text().length - 1);
  }
  if (col < 0) return { line: 0, col: 0 };
  while (col > 0 && !WORD.test(text()[col] ?? "")) col--;
  while (col > 0 && WORD.test(text()[col - 1] ?? "")) col--;
  return { line, col: Math.max(0, col) };
}

/** First match at or after the cursor, wrapping to the top. */
function findNext(state: EditorState, term: string, from: Cursor, backwards = false): Cursor | null {
  if (!term) return null;
  const total = state.lines.length;
  const order: number[] = [];
  for (let i = 0; i < total; i++) {
    order.push(backwards ? (from.line - i + total * 2) % total : (from.line + i) % total);
  }
  for (const [step, line] of order.entries()) {
    const text = state.lines[line] ?? "";
    if (step === 0) {
      const idx = backwards
        ? text.lastIndexOf(term, Math.max(0, from.col - 1))
        : text.indexOf(term, from.col + 1);
      if (idx >= 0) return { line, col: idx };
      continue;
    }
    const idx = backwards ? text.lastIndexOf(term) : text.indexOf(term);
    if (idx >= 0) return { line, col: idx };
  }
  return null;
}

function runCommand(state: EditorState): EditorState {
  const raw = state.command;
  const base: EditorState = { ...state, mode: "normal", command: "", pending: "" };

  if (raw.startsWith("/")) {
    const term = raw.slice(1);
    if (!term) return base;
    const hit = findNext({ ...base, search: term }, term, base.cursor);
    if (!hit) return { ...base, search: term, message: `not found: ${term}` };
    return { ...base, search: term, cursor: clampCursor(base, hit), message: "" };
  }

  const cmd = raw.slice(1).trim();
  switch (cmd) {
    case "w":
      return { ...base, wantSave: true };
    case "wq":
    case "x":
      return { ...base, wantSave: true, wantClose: true };
    case "q":
      return base.dirty
        ? { ...base, message: "unsaved changes — :w to write, :q! to discard" }
        : { ...base, wantClose: true };
    case "q!":
      return { ...base, wantClose: true };
    default:
      return { ...base, message: cmd ? `not an editor command: ${cmd}` : "" };
  }
}

/** One key, one new state. Never mutates its argument. */
export function applyEditorKey(state: EditorState, key: string): EditorState {
  const cleared: EditorState = { ...state, message: "" };
  return state.mode === "insert"
    ? insertKey(cleared, key)
    : state.mode === "command"
      ? commandKey(cleared, key)
      : normalKey(cleared, key);
}

function commandKey(state: EditorState, key: string): EditorState {
  if (key === "\x1b") return { ...state, mode: "normal", command: "" };
  if (key === "\r" || key === "\n") return runCommand(state);
  if (key === "\x7f" || key === "\x08") {
    const next = state.command.slice(0, -1);
    // Backspacing away the leading : or / leaves command mode entirely.
    return next ? { ...state, command: next } : { ...state, mode: "normal", command: "" };
  }
  const cp = key.codePointAt(0);
  if (key.length > 0 && cp !== undefined && cp >= 32 && cp !== 0x7f && !key.startsWith("\x1b")) {
    return { ...state, command: state.command + key };
  }
  return state;
}

function insertKey(state: EditorState, key: string): EditorState {
  const { line, col } = state.cursor;
  const text = state.lines[line] ?? "";

  if (key === "\x1b") {
    // vim steps left on leaving insert; the cursor sits on a character again.
    const next = { ...state, mode: "normal" as EditorMode };
    return { ...next, cursor: clampCursor(next, { line, col: col - 1 }, "normal") };
  }
  if (key === "\r" || key === "\n") {
    const lines = [...state.lines];
    lines.splice(line, 1, text.slice(0, col), text.slice(col));
    return { ...mutate(state, lines, { line: line + 1, col: 0 }), mode: "insert" };
  }
  if (key === "\x7f" || key === "\x08") {
    if (col > 0) {
      const lines = [...state.lines];
      lines[line] = text.slice(0, col - 1) + text.slice(col);
      return { ...mutate(state, lines, { line, col: col - 1 }), mode: "insert" };
    }
    if (line === 0) return state;
    // At column zero, backspace joins this line onto the one above.
    const previous = state.lines[line - 1] ?? "";
    const lines = [...state.lines];
    lines.splice(line - 1, 2, previous + text);
    return { ...mutate(state, lines, { line: line - 1, col: previous.length }), mode: "insert" };
  }
  if (key === "\t") {
    const lines = [...state.lines];
    lines[line] = `${text.slice(0, col)}  ${text.slice(col)}`;
    return { ...mutate(state, lines, { line, col: col + 2 }), mode: "insert" };
  }
  const cp = key.codePointAt(0);
  if (cp === undefined || cp < 32 || cp === 0x7f || key.startsWith("\x1b")) return state;
  const lines = [...state.lines];
  lines[line] = text.slice(0, col) + key + text.slice(col);
  return { ...mutate(state, lines, { line, col: col + key.length }), mode: "insert" };
}

function normalKey(state: EditorState, key: string): EditorState {
  const { line, col } = state.cursor;
  const text = state.lines[line] ?? "";

  // Half-finished commands: dd, yy, gg.
  if (state.pending) {
    const pending = state.pending;
    const cleared = { ...state, pending: "" };
    if (pending === "d" && key === "d") {
      const lines = [...state.lines];
      const [cut] = lines.splice(line, 1);
      if (!lines.length) lines.push("");
      return { ...mutate(cleared, lines, { line, col: 0 }), register: [cut ?? ""] };
    }
    if (pending === "y" && key === "y") {
      return { ...cleared, register: [text], message: "1 line yanked" };
    }
    if (pending === "g" && key === "g") return move(cleared, { line: 0, col: 0 });
    return cleared;
  }

  switch (key) {
    // ── Motion
    case "h": case "\x1b[D": return move(state, { line, col: col - 1 });
    case "l": case "\x1b[C": return move(state, { line, col: col + 1 });
    case "j": case "\x1b[B": return move(state, { line: line + 1, col });
    case "k": case "\x1b[A": return move(state, { line: line - 1, col });
    case "0": case "\x1b[H": return move(state, { line, col: 0 });
    case "$": case "\x1b[F": return move(state, { line, col: text.length });
    case "w": return move(state, nextWord(state));
    case "b": return move(state, prevWord(state));
    case "G": return move(state, { line: state.lines.length - 1, col: 0 });
    case "g": case "d": case "y": return { ...state, pending: key };

    // ── Entering insert
    case "i": return { ...state, mode: "insert" };
    case "a": return { ...state, mode: "insert", cursor: clampCursor(state, { line, col: col + 1 }, "insert") };
    case "I": return { ...state, mode: "insert", cursor: { line, col: 0 } };
    case "A": return { ...state, mode: "insert", cursor: { line, col: text.length } };
    case "o": {
      const lines = [...state.lines];
      lines.splice(line + 1, 0, "");
      return { ...mutate(state, lines, { line: line + 1, col: 0 }), mode: "insert" };
    }
    case "O": {
      const lines = [...state.lines];
      lines.splice(line, 0, "");
      return { ...mutate(state, lines, { line, col: 0 }), mode: "insert" };
    }

    // ── Edits
    case "x": {
      if (!text.length) return state;
      const lines = [...state.lines];
      lines[line] = text.slice(0, col) + text.slice(col + 1);
      return mutate(state, lines, { line, col });
    }
    case "p": case "P": {
      if (!state.register.length) return state;
      const at = key === "p" ? line + 1 : line;
      const lines = [...state.lines];
      lines.splice(at, 0, ...state.register);
      return mutate(state, lines, { line: at, col: 0 });
    }
    case "u": {
      const previous = state.undo[state.undo.length - 1];
      if (!previous) return { ...state, message: "nothing to undo" };
      const next: EditorState = { ...state, lines: previous.lines, undo: state.undo.slice(0, -1), dirty: true };
      return { ...next, cursor: clampCursor(next, previous.cursor) };
    }

    // ── Search and commands
    case "/": return { ...state, mode: "command", command: "/" };
    case ":": return { ...state, mode: "command", command: ":" };
    case "n": case "N": {
      if (!state.search) return { ...state, message: "no search — press / first" };
      const hit = findNext(state, state.search, state.cursor, key === "N");
      return hit ? move(state, hit) : { ...state, message: `not found: ${state.search}` };
    }
    default:
      return state;
  }
}
