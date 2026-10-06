import type { ShellState } from "../data/access.js";
import type { runDoctor } from "../link/link.js";
export declare const SUB_VIEWS: readonly ["Tasks", "Findings", "Review Queue", "Skills", "Hooks"];
export declare const TAB_ICONS: Record<string, string>;
export interface UndoEntry {
    label: string;
    file: string;
    content: string;
}
export declare const MAX_UNDO_STACK = 10;
export type ShellView = ShellState["view"];
export interface ShellDeps {
    runDoctor: typeof runDoctor;
    runRelink: (phrenPath: string) => Promise<string>;
    runHooks: (phrenPath: string) => Promise<string>;
    runUpdate: () => Promise<string>;
}
interface DoctorCheck {
    name: string;
    ok: boolean;
    detail: string;
}
export interface DoctorResultLike {
    ok: boolean;
    machine?: string;
    profile?: string;
    checks: DoctorCheck[];
}
export declare function enabledSubViews(store: string, profile?: string): readonly typeof SUB_VIEWS[number][];
export {};
