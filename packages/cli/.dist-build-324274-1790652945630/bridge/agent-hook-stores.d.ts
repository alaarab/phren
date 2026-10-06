import { type Json } from "./protocol.js";
/** Small stores the agent callback socket keeps: the recorded pane binding
 * files, push-notification answer bindings, and overview watch leases. */
export declare const localSocket: () => string;
export declare const bindingPath: (server: string, pane: string) => string;
export declare function recordedSession(server: string, pane: Json, pids: number[]): Promise<string | undefined>;
export interface PushBinding {
    action: string;
    expiresAt: number;
}
export declare class PushBindingStore {
    private now;
    private limit;
    private values;
    constructor(now?: () => number, limit?: number);
    add(binding: string, value: PushBinding): void;
    consume(binding: string): PushBinding | undefined;
    /** The binding's action without spending it: a tap that opens the app. */
    peek(binding: string): PushBinding | undefined;
    /** Keeps an action's bindings answerable until `expiresAt`: an ask its
     * agent still lists must stay answerable from its notification. */
    extendAction(action: string, expiresAt: number): void;
    dropAction(action: string): void;
    clear(): void;
    get size(): number;
}
/** An explicit foreground overview poll renews interest for a bounded interval.
 * A disconnected phone never leaves future terminal prompts waiting forever. */
export declare class ApprovalWatchLeases {
    private now;
    private servers;
    constructor(now?: () => number);
    renew(server: string): void;
    has(server: string): boolean;
}
