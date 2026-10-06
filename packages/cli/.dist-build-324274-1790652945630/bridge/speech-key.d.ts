/** The ElevenLabs key for spoken replies and Scribe dictation. It is machine
 * config, like apns.json: it lives in the Hook's own directory, mode 600, and
 * never in the synced store. ELEVENLABS_API_KEY, ElevenLabs' own convention
 * that its SDKs and MCP server read, wins when set. The Hook runs as a service
 * that doesn't see shell env, so the file is the durable source. */
export declare const SPEECH_KEY_ENV = "ELEVENLABS_API_KEY";
export type SpeechKeySource = "environment" | "file";
export declare function speechKeyFile(): string;
/** Where the key lived before phren kept its own: the mina trailer config. It
 * is read once to migrate and never written or deleted. */
export declare function legacySpeechKeyFile(env?: NodeJS.ProcessEnv): string;
export declare function writeSpeechKey(key: string, file?: string): Promise<void>;
export interface SpeechKeyPaths {
    env?: NodeJS.ProcessEnv;
    file?: string;
    legacy?: string;
}
/** ELEVENLABS_API_KEY, else the stored key. When nothing is stored yet and the
 * mina trailer config has a key, it is copied here once and read from here
 * after. */
export declare function resolveSpeechKey(paths?: SpeechKeyPaths): Promise<{
    key: string;
    source: SpeechKeySource;
} | undefined>;
export declare function readSpeechKey(): Promise<string | undefined>;
export interface SpeechKeyStatus {
    configured: boolean;
    detail: string;
    problem?: boolean;
}
/** Whether this computer has a key, for doctor. Never the key itself, and it
 * doesn't migrate: a read-only check. */
export declare function speechKeyStatus(paths?: SpeechKeyPaths): Promise<SpeechKeyStatus>;
