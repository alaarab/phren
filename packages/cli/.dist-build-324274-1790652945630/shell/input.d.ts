import { ShellState } from "../data/access.js";
import { type DoctorResultLike, type ShellDeps, type ShellView } from "./types.js";
import type { GraphController } from "./graph/controller.js";
/** Interface for the shell methods that executePalette needs */
interface PaletteHost {
    phrenPath: string;
    profile: string;
    state: ShellState;
    deps: ShellDeps;
    showHelp: boolean;
    healthCache: {
        at: number;
        result: DoctorResultLike;
    } | undefined;
    setMessage(msg: string): void;
    setView(view: ShellState["view"]): void;
    confirmThen(label: string, action: () => void): void;
    snapshotForUndo(label: string, file: string): void;
    ensureProjectSelected(): string | null;
    invalidateSubsectionsCache(): void;
    popUndo(): string;
}
/** Extended host interface for navigation and view-action methods */
export interface NavigationHost extends PaletteHost {
    currentCursor(): number;
    setCursor(n: number): void;
    moveCursor(delta: number): void;
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
    inputMqId: string;
    prevHealthView: ShellView | undefined;
    filter: string | undefined;
    setFilter(value: string): void;
    /** The knowledge-graph view's controller (created on first use). */
    graph(): GraphController;
    /** Run something with the terminal released; false when the host cannot. */
    suspend(fn: () => Promise<void> | void): Promise<boolean>;
    /** Open a file in the shell's own modal editor. */
    openEditor(filePath: string, label: string, kind: "skill" | "claude", scope?: string): boolean;
}
/**
 * The file `e` and `E` edit for the current view. Skills edit their own
 * markdown; a project edits the AGENTS.md the store owns and symlinks into the
 * repo, so editing here reaches every linked checkout.
 */
export declare function editTargetFor(host: NavigationHost, item: {
    name?: string;
    path?: string;
    storePath?: string;
} | undefined): {
    path: string;
    label: string;
    kind: "skill" | "claude";
} | null;
export declare function executePalette(host: PaletteHost, input: string): Promise<void>;
export declare function completeInput(line: string, phrenPath: string, profile: string, state: ShellState): string[];
export declare function getListItems(phrenPath: string, profile: string, state: ShellState, healthLineCount: number): {
    id?: string;
    name?: string;
    text?: string;
    line?: string;
    path?: string;
    scopeType?: string;
    storePath?: string;
}[];
/**
 * Handle p/b/l/m/s/k/h shortcut keys that switch the active view.
 * Returns true if the key was handled.
 */
export declare function applyViewShortcut(host: NavigationHost, key: string): boolean;
export declare function handleNavigateKey(host: NavigationHost, rawKey: string): Promise<boolean>;
export {};
