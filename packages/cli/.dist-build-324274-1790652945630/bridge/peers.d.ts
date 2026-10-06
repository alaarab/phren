import { z } from "zod";
import { type Json } from "./protocol.js";
declare const peerSchema: z.ZodObject<{
    name: z.ZodString;
    address: z.ZodString;
    username: z.ZodString;
    port: z.ZodDefault<z.ZodNumber>;
    hostKey: z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>;
    server: z.ZodDefault<z.ZodString>;
}, z.core.$strict>;
export type HookPeer = z.infer<typeof peerSchema>;
export declare function hookPeers(root?: string): Promise<HookPeer[]>;
/**
 * Adds one verified peer to hooks.yaml, creating the file (0600) if needed.
 * Linking again with the same details is a no-op; a different computer under
 * the same name or address is refused rather than replaced.
 */
export declare function addHookPeer(input: unknown, root?: string): Promise<{
    added: boolean;
    peer: HookPeer;
}>;
/**
 * Peers for reads that keep working without them. No hooks.yaml means no
 * peers; a broken one is logged and returned as `peerError` so the response
 * can say why remote agents are missing instead of hiding them.
 */
export declare function optionalHookPeers(root?: string): Promise<{
    peers: HookPeer[];
    peerError?: string;
}>;
export declare function peerSSHArgs(peer: HookPeer, knownHosts: string, key: string): string[];
/** Keeps ssh's own first stderr line (one line, bounded) and its exit code. */
export declare function peerOfflineMessage(diagnostic: string, exitCode: number | null | undefined): string;
/** A pin is supplied out of band; dispatch never learns or replaces host keys. */
export declare function peerRequest(peer: HookPeer, route: string, data?: Json, timeout?: number): Promise<Json>;
export {};
