/**
 * Drawing for the shell's modal editor.
 *
 * The frame is painted whole on every key, so there is no real terminal cursor
 * to move: the character under the cursor is drawn inverted instead.
 */
import type { EditorState } from "../editor/buffer.js";
export declare function renderEditor(state: EditorState, width: number, height: number): string[];
