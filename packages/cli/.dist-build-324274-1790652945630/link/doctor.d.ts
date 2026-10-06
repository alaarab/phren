import type { DoctorResult } from "./link.js";
import { type ConfirmStoreRemoval } from "../sync/auth-doctor.js";
/**
 * Where `tool` stands relative to its ~/.local/bin wrapper, as far as this
 * process can tell. Doctor often runs without the user's shell setup (over
 * SSH, from a hook or a LaunchAgent), where ~/.local/bin is added only by
 * .zshrc; then PATH says nothing about what the user's shell runs, and an
 * installed wrapper is reported as unconfirmed rather than missing.
 */
export type WrapperState = {
    state: "active" | "missing" | "off-path";
} | {
    state: "shadowed";
    by: string;
};
export declare function wrapperState(tool: string, env?: NodeJS.ProcessEnv, resolve?: (tool: string) => string): WrapperState;
/** One doctor line per wrapper. The phren wrapper works off PATH too: hooks call it by its full path. */
export declare function wrapperCheck(tool: string, state: WrapperState): {
    name: string;
    ok: boolean;
    detail: string;
};
export declare function runDoctor(phrenPath: string, fix?: boolean, checkData?: boolean, confirmStoreRemoval?: ConfirmStoreRemoval): Promise<DoctorResult>;
