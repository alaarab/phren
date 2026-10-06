import { z } from "zod";
/** The ElevenLabs voice talk mode speaks with. A new computer uses the
 * built-in default; `phren bridge speech-voice set <id>` stores another in
 * the Hook's own directory, next to the speech key, where install and update
 * leave it alone. The phone may name a voice per request, which wins. */
/** River: relaxed, neutral and informative, ElevenLabs' premade voice. */
export declare const DEFAULT_SPEECH_VOICE = "SAz9YHcvj6GT2YYXdXww";
/** The environment override from before the setting existed. It is read only
 * when nothing is stored, and copied into the setting then. */
export declare const SPEECH_VOICE_ENV = "PHREN_SPEECH_VOICE";
/** An ElevenLabs voice id: letters and digits (20 today). */
export declare const voiceId: z.ZodString;
export declare function speechVoiceFile(): string;
export declare function readStoredVoice(file?: string): Promise<string | undefined>;
export declare function writeSpeechVoice(voice: string, file?: string): Promise<string>;
export declare function clearSpeechVoice(file?: string): Promise<void>;
/** The ElevenLabs model talk mode speaks with. It sits in the same
 * `speech.json` as the voice (`phren bridge speech-model set <id>`), so
 * install and update leave it alone too. Unset, it is v4 Turbo; speech.ts
 * drops to Flash v2.5 on its own while the chosen model fails or is slow. */
export declare const DEFAULT_SPEECH_MODEL = "eleven_v4_turbo";
/** ElevenLabs' lowest-latency model: the fallback. */
export declare const FALLBACK_SPEECH_MODEL = "eleven_flash_v2_5";
/** An ElevenLabs model id, e.g. eleven_v4_turbo or eleven_flash_v2_5. */
export declare const speechModelId: z.ZodString;
export declare function readStoredModel(file?: string): Promise<string | undefined>;
export declare function writeSpeechModel(model: string, file?: string): Promise<string>;
export declare function clearSpeechModel(file?: string): Promise<void>;
/** The stored model, else v4 Turbo. Read on every reply, so a change needs
 * no Hook restart. */
export declare function resolveSpeechModel(file?: string): Promise<{
    model: string;
    source: "setting" | "default";
}>;
export type SpeechVoiceSource = "request" | "setting" | "environment" | "default";
/** The voice to speak with: the request's own, the stored setting, the old
 * environment override (copied into the setting on first use), else the
 * default. */
export declare function resolveSpeechVoice(requested?: string, paths?: {
    env?: NodeJS.ProcessEnv;
    file?: string;
}): Promise<{
    voice: string;
    source: SpeechVoiceSource;
}>;
export interface SpeechVoiceChoice {
    id: string;
    name: string;
    category?: string;
    description?: string;
}
/** The voices this computer's ElevenLabs account can speak with, for the
 * phone's picker: id, name and a short description, never the account's
 * other details. */
export declare function listSpeechVoices(key: string, fetcher?: typeof fetch, signal?: AbortSignal): Promise<SpeechVoiceChoice[]>;
