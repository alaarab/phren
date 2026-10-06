/** Dictation through ElevenLabs Scribe v2 Realtime, for the phone's opt-in
 * Scribe input. The phone streams 16 kHz mono PCM as binary frames; this
 * computer forwards it to ElevenLabs with its own key, which never leaves
 * here, and sends back `{type: "partial"|"committed", text}` frames. Errors
 * are fixed messages by code: ElevenLabs' own text is never passed on. */
export declare const TRANSCRIBE_MODEL = "scribe_v2_realtime";
export declare const TRANSCRIBE_RATE = 16000;
/** The two sockets as the relay uses them, so tests can stand in for both. */
export interface RelaySocket {
    readonly readyState: number;
    send(data: string): void;
    close(code?: number, reason?: string): void;
    on(event: "message", listener: (data: Buffer, isBinary: boolean) => void): unknown;
    on(event: "open" | "close", listener: () => void): unknown;
    on(event: "error", listener: (error: Error) => void): unknown;
}
export interface TranscribeOptions {
    key?: () => Promise<string | undefined>;
    connect?: (url: string, key: string) => RelaySocket;
    maxSessionMs?: number;
}
/** The upstream URL: VAD commits, the phone's language and its vocabulary as keyterms. */
export declare function transcribeURL(query: URLSearchParams): string;
export declare function relayTranscription(client: RelaySocket, query: URLSearchParams, options?: TranscribeOptions): Promise<void>;
