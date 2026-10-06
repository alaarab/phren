import { type Json } from "./protocol.js";
export declare function opencodeApprovalFile(session: string, kind: "request" | "answer", store?: string): string | undefined;
export declare function directoryNames(directory: string, limit: number): AsyncGenerator<string>;
export declare function opencodeRequest(session: string): Json | undefined;
/** `opencodeRequest` without blocking the event loop, for the background sweep. */
export declare function readOpencodeRequest(session: string, store?: string): Promise<Json | undefined>;
