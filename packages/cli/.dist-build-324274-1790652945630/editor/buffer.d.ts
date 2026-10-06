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
    undo: Array<{
        lines: string[];
        cursor: Cursor;
    }>;
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
export declare function createEditorState(path: string, label: string, content: string): EditorState;
/** Text as it should be written: one trailing newline, always. */
export declare function editorText(state: EditorState): string;
/** One key, one new state. Never mutates its argument. */
export declare function applyEditorKey(state: EditorState, key: string): EditorState;
