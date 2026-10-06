import { z } from "zod";
export declare const PROTOCOL = 1;
export declare const MAX_FRAME: number;
export declare const id: z.ZodString;
export declare const serverName: z.ZodString;
export declare const computerName: z.ZodString;
export declare const provider: z.ZodEnum<{
    claude: "claude";
    codex: "codex";
    copilot: "copilot";
    opencode: "opencode";
    phren: "phren";
}>;
export type Provider = z.infer<typeof provider>;
export declare const sessionId: z.ZodUnion<readonly [z.ZodString, z.ZodString]>;
export declare const targetSchema: z.ZodObject<{
    server: z.ZodString;
    workspace: z.ZodString;
    tab: z.ZodString;
    pane: z.ZodString;
    source: z.ZodEnum<{
        claude: "claude";
        codex: "codex";
        copilot: "copilot";
        opencode: "opencode";
        phren: "phren";
    }>;
    session: z.ZodUnion<readonly [z.ZodString, z.ZodString]>;
}, z.core.$strip>;
export type Target = z.infer<typeof targetSchema>;
export declare const startingTargetSchema: z.ZodObject<{
    server: z.ZodString;
    workspace: z.ZodString;
    tab: z.ZodString;
    pane: z.ZodString;
    source: z.ZodEnum<{
        claude: "claude";
        codex: "codex";
        copilot: "copilot";
        opencode: "opencode";
        phren: "phren";
    }>;
    starting: z.ZodLiteral<true>;
    startingToken: z.ZodString;
}, z.core.$strip>;
export type StartingTarget = z.infer<typeof startingTargetSchema>;
export type Json = Record<string, unknown>;
/** `value` when it is a plain object, else an empty one. */
export declare function object(value: unknown): Json;
export declare function objects(value: unknown): Json[];
export declare function bridgeRoot(): string;
export declare function socketPath(): string;
export declare class BridgeError extends Error {
    status: number;
    details?: Json | undefined;
    constructor(status: number, message: string, details?: Json | undefined);
}
/**
 * Why a computer's Herdr or a linked peer could not be reached, as a stable
 * `code` beside the human `error` text, so a client can explain the offline
 * state without matching sentences. See docs/phren-hook.md#offline-reasons.
 */
export type OfflineCode = "herdr-not-running" | "herdr-stale-socket" | "herdr-permission" | "herdr-unreachable" | "herdr-timeout" | "ssh-unavailable" | "dispatch-key-missing" | "peer-offline" | "peer-timeout" | "peer-key-not-enrolled" | "peer-host-key-mismatch";
/** The machine-readable `code` an error carries, if any. */
export declare function errorCode(error: unknown): string | undefined;
/** A BridgeError that keeps `error`'s status and text and adds `code` when it has none yet. */
export declare function withErrorCode(error: BridgeError, code: OfflineCode): BridgeError;
export declare const requestID: () => `${string}-${string}-${string}-${string}-${string}`;
/**
 * Write a file atomically: serialize to a fresh temp name, then rename it over
 * the target so a reader never observes a partial file. `value` may be
 * pre-serialized text or any JSON-serializable value. The default mode is 0600
 * because every caller writes per-user state.
 */
export declare function atomic(file: string, value: unknown, mode?: number): Promise<void>;
/** {@link atomic}, first creating the file's directory (0700 where it is new). */
export declare function atomicInPrivateDir(file: string, value: unknown, mode?: number): Promise<void>;
export declare function targetFromURL(url: URL): Target;
/** The reasoning efforts a launch or a dispatch may ask a harness for. */
export declare const launchEfforts: readonly ["minimal", "low", "medium", "high", "xhigh", "max"];
