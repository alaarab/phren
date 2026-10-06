import { type ShellView, type ShellDeps, type DoctorResultLike } from "./types.js";
export type { ShellView, ShellDeps } from "./types.js";
import type { ShellStartup } from "./startup.js";
import { GraphController } from "./graph/controller.js";
import { type EditorState } from "../editor/buffer.js";
import { type EditKind } from "../editor/save.js";
export declare class PhrenShell {
    readonly phrenPath: string;
    readonly profile: string;
    readonly deps: ShellDeps;
    private state;
    private message;
    healthCache?: {
        at: number;
        result: DoctorResultLike;
    };
    prevHealthView: ShellView | undefined;
    showHelp: boolean;
    private pendingConfirm?;
    private undoStack;
    private navMode;
    private editor?;
    private inputBuf;
    private inputCtx;
    inputMqId: string;
    private cursorMap;
    private viewScrollMap;
    private healthLineCount;
    private helpScroll;
    private _subsectionsCache;
    private _graph?;
    private repaintHandler;
    private suspendHandler;
    /** `--live` / `--no-live`; undefined leaves watch mode at its default. */
    private graphLive?;
    get mode(): "navigate" | "input" | "editor";
    get editorState(): EditorState | undefined;
    get inputBuffer(): string;
    get filter(): string | undefined;
    constructor(phrenPath: string, profile: string, deps?: ShellDeps, startup?: ShellStartup);
    close(): void;
    setMessage(msg: string): void;
    /**
     * Let the host (entry.ts) hand over a way to repaint on the shell's own
     * initiative — the graph view uses it to animate its layout settling and
     * to show a build that finished while nothing was typed.
     */
    setRepaintHandler(handler: (() => void) | null): void;
    /**
     * Let the host lend the terminal to a child process. Without one — a non-TTY
     * host, or an embedder — callers fall back to telling the user the path.
     */
    /**
     * The Graph view wants the mouse (drag to orbit, wheel to zoom, click to
     * select); every other view wants the terminal's own text selection. The
     * entry point supplies what turning it on and off means for this terminal.
     */
    setMouseHandler(handler: ((on: boolean) => void) | null): void;
    private mouseHandler;
    /** Apply the mouse state for the current view (after grabbing the terminal). */
    syncMouse(): void;
    setSuspendHandler(handler: ((run: () => Promise<void> | void) => Promise<void>) | null): void;
    get canSuspend(): boolean;
    /** Run `fn` with the terminal released. Resolves false when that is impossible. */
    suspend(fn: () => Promise<void> | void): Promise<boolean>;
    graph(): GraphController;
    confirmThen(label: string, action: () => void): void;
    setView(view: ShellView): void;
    setFilter(value: string): void;
    snapshotForUndo(label: string, file: string): void;
    popUndo(): string;
    ensureProjectSelected(): string | null;
    invalidateSubsectionsCache(): void;
    currentCursor(): number;
    setCursor(n: number): void;
    moveCursor(delta: number): void;
    private currentScroll;
    private setScroll;
    getListItems(): {
        id?: string;
        name?: string;
        text?: string;
        line?: string;
        path?: string;
        scopeType?: string;
        storePath?: string;
    }[];
    startInput(ctx: string, initial: string): void;
    private cancelInput;
    private submitInput;
    /** Open a file in the built-in editor. Returns false if it cannot be read. */
    openEditor(filePath: string, label: string, kind: EditKind, scope?: string): boolean;
    private closeEditor;
    private saveEditor;
    private handleEditorKey;
    handleRawKey(key: string): Promise<boolean>;
    private handleInputKey;
    private doctorSnapshot;
    render(): Promise<string>;
    private asNavigationHost;
    private runPalette;
    handleInput(raw: string): Promise<boolean>;
    completeInput(line: string): string[];
}
export { startShell } from "./entry.js";
export type { ShellStartup } from "./startup.js";
