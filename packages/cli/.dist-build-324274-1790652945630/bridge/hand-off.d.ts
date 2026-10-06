import { z } from "zod";
import { type Target } from "./protocol.js";
import { computerLabel, type PeerFacts } from "./computer-identity.js";
export { computerLabel };
export declare const handOffSchema: z.ZodObject<{
    computer: z.ZodOptional<z.ZodString>;
    target: z.ZodOptional<z.ZodObject<{
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
    }, z.core.$strip>>;
    session: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString]>>;
    project: z.ZodOptional<z.ZodString>;
    account: z.ZodOptional<z.ZodString>;
    text: z.ZodString;
}, z.core.$strict>;
export type HandOffInput = z.infer<typeof handOffSchema>;
/** `deliveryId` names this one message on the receiving Hook, which then types
 * it at most once however often it is sent (the Hook's own callers retry;
 * the MCP tool does not take one). */
export declare function handOff(input: unknown, options?: {
    deliveryId?: string;
}): Promise<{
    ok: boolean;
    delivered: boolean;
    target: Target;
    deliveryUncertain?: boolean;
    unsubmitted?: boolean;
    label?: string;
    granted?: string;
}>;
/** One live agent pane, on this computer or an enrolled one. */
export interface LiveSession {
    computer: string;
    local: boolean;
    project?: string;
    label?: string;
    title?: string;
    agent?: string;
    status?: string;
    role?: string;
    branch?: string;
    model?: string;
    target?: Target;
    /** Claude account id, when the Hook knows it; absent means the default account or an unknown one. */
    account?: string;
    /** Seconds since the tab last changed, when the Hook has seen it change. */
    idleFor?: number;
    /** Set when the main turn ended and this many background tasks keep the session `working`. */
    backgroundTasks?: number;
}
/** A registered computer this Hook cannot see, with the other names the store
 * registers it under. */
export interface NotLinkedComputer {
    name: string;
    aliases?: string[];
}
/** Computers the store registers (machines.yaml) that this Hook has no
 * verified connection to, so their sessions cannot be listed from here: the
 * unlinked rows of `foldComputers`, which folds names by first label and by
 * shared profile into the computers it can see. */
export declare function notLinkedFrom(store: string | null, here: string, peers: readonly PeerFacts[]): NotLinkedComputer[];
/** As `notLinkedFrom` for a flat list of names the linked computers answer
 * to, each standing for its own computer. */
export declare function notLinkedComputers(store: string | null, here: string, linked: readonly string[]): NotLinkedComputer[];
export interface LiveSessions {
    sessions: LiveSession[];
    unreachable: {
        computer: string;
        error: string;
        code?: string;
    }[];
    /** Registered in the store but not linked in hooks.yaml: unknown, not idle. */
    notLinked: NotLinkedComputer[];
    enrolled: number;
    peerError?: string;
}
/** Every live agent the conductor could hand work to: this computer's Herdr
 * overview plus each enrolled computer's, read through its verified Hook.
 * An unreachable computer is reported, never silently dropped. */
export declare function listLiveSessions(options?: {
    store?: string | null;
}): Promise<LiveSessions>;
