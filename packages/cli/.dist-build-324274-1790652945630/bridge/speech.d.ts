import type { ServerResponse } from "node:http";
import { z } from "zod";
import { BridgeError, type Json } from "./protocol.js";
export { DEFAULT_SPEECH_MODEL, DEFAULT_SPEECH_VOICE, FALLBACK_SPEECH_MODEL } from "./speech-voice.js";
/** Spoken replies for the phone's talk mode. The phone sends a sentence; the
 * Hook voices it with ElevenLabs and streams the audio back. The API key is
 * read on this computer, used only in the request to ElevenLabs, and never
 * appears in a response, including errors. */
/** What a phone that names no `formats` gets, as every phone did before
 * `speechFormats`: raw signed 16-bit little-endian mono PCM at 24 kHz, which
 * it queues straight into its audio engine without decoding. */
export declare const SPEECH_AUDIO = "pcm_s16le;rate=24000;channels=1";
/** ElevenLabs output formats the Hook can serve, best first. Each account
 * plan allows some of them (Creator refuses pcm_44100, which is Pro and
 * above); the Hook learns which from ElevenLabs' refusal rather than a
 * hard-coded plan table. pcm_24000 works on every plan and every phone. */
export declare const SPEECH_FORMATS: readonly ["pcm_44100", "mp3_44100_192", "pcm_24000"];
export type SpeechFormat = typeof SPEECH_FORMATS[number];
/** How each format is described to the phone: `audioFormat` in the JSON reply
 * and `X-Phren-Audio` on the streamed one, plus the sample rate on its own. */
export declare const SPEECH_FORMAT_INFO: Record<SpeechFormat, {
    audio: string;
    sampleRate: number;
    contentType: string;
}>;
/** Talk mode waits for the whole sentence on the timestamped path, so a model
 * whose recent replies took longer than this to start playing is set aside
 * for FALLBACK_HOLD_MS. Measured 2026-09-28 on a 95-character reply with the
 * owner's voice: v4 Turbo ~200-400 ms to first streamed byte and ~1.1 s for
 * the timestamped reply; Flash v2.5 ~180-460 ms and ~0.4 s. 1.5 s leaves v4
 * Turbo headroom on a normal day and catches a slow one. */
export declare const SPEECH_SLOW_MS = 1500;
/** How long a failing or slow model, or a refused format, is set aside. */
export declare const FALLBACK_HOLD_MS: number;
export declare const speechRequest: z.ZodObject<{
    text: z.ZodString;
    timestamps: z.ZodOptional<z.ZodBoolean>;
    voice: z.ZodOptional<z.ZodString>;
    formats: z.ZodPreprocess<z.ZodOptional<z.ZodArray<z.ZodEnum<{
        mp3_44100_192: "mp3_44100_192";
        pcm_24000: "pcm_24000";
        pcm_44100: "pcm_44100";
    }>>>, unknown>;
}, z.core.$strip>;
/** What the Hook learned about this account: formats its plan refused and
 * models set aside for failing or being slow, each until a time, and the
 * recent start-of-audio times per model. One per Hook process. */
export declare class SpeechState {
    private readonly now;
    private readonly refused;
    private readonly benched;
    private readonly latency;
    constructor(now?: () => number);
    formatAllowed(format: SpeechFormat): boolean;
    refuseFormat(format: SpeechFormat): void;
    benchedReason(model: string): "failed" | "slow" | undefined;
    bench(model: string, reason: "failed" | "slow"): void;
    /** Records how long a reply took to start; benches the model when the median
     * of its last three is over SPEECH_SLOW_MS. */
    recordLatency(model: string, ms: number): void;
}
/** When each character of the voiced text starts and ends, in seconds from
 * the start of the audio. */
export interface SpeechAlignment {
    characters: string[];
    starts: number[];
    ends: number[];
}
export interface SpeechOptions {
    fetch?: typeof fetch;
    /** Resolves the ElevenLabs key; defaults to ELEVENLABS_API_KEY, then the stored key (speech-key.ts). */
    key?: () => Promise<string | undefined>;
    voice?: string;
    /** Formats the phone plays, from the request; pcm_24000 always. */
    formats?: readonly string[];
    /** Defaults to this computer's setting (speech-voice.ts). */
    model?: string;
    /** Defaults to the Hook's own. */
    state?: SpeechState;
    now?: () => number;
}
/** What was voiced: the model and format actually used. */
export interface SpeechResult {
    model: string;
    format: SpeechFormat;
}
/** A fixed message per ElevenLabs failure: its own response text is never
 * passed on. */
export declare function speechError(upstream: Response): Promise<BridgeError>;
/** A reply as it should sound: markdown the agent wrote for the chat bubble
 * (emphasis, headings, bullets, links, inline code, tables) is read aloud
 * literally by ElevenLabs, so it is reduced to its words. A code block is
 * skipped, a link keeps its text and a bare URL becomes "a link". Empty when
 * nothing speakable is left. */
export declare function speakableText(text: string): string;
/** Starts ElevenLabs' streaming synthesis and returns its audio body. */
export declare function synthesizeSpeech(text: string, signal: AbortSignal, options?: SpeechOptions): Promise<SpeechResult & {
    body: ReadableStream<Uint8Array>;
}>;
/** Voices the text in one piece with ElevenLabs' character alignment. */
export declare function synthesizeTimedSpeech(text: string, signal: AbortSignal, options?: SpeechOptions): Promise<SpeechResult & {
    audio: string;
    alignment: SpeechAlignment | null;
}>;
/** ElevenLabs' alignment, kept only when its three lists line up. */
export declare function alignmentOf(raw: {
    characters?: unknown;
    character_start_times_seconds?: unknown;
    character_end_times_seconds?: unknown;
} | null | undefined): SpeechAlignment | null;
/** POST /v1/speech: writes the audio to the phone as ElevenLabs produces it.
 * With `timestamps`, answers JSON instead: `{ audio, audioFormat, sampleRate,
 * format, model, alignment }`, the audio base64 in the format served and the
 * alignment null when ElevenLabs sent none. The streamed reply names its
 * format in `X-Phren-Audio` and `X-Phren-Audio-Rate`. A phone that sends no
 * `formats` always gets pcm_24000.
 * Failures before the first byte are thrown for the route's JSON error; a
 * failure mid-stream cuts the response off, which the phone treats as an
 * error. The phone hanging up cancels the ElevenLabs request. */
export declare function streamSpeech(data: Json, response: ServerResponse, options?: SpeechOptions): Promise<void>;
