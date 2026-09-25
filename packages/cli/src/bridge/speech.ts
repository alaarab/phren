import { once } from "node:events";
import type { ServerResponse } from "node:http";
import { z } from "zod";
import { BridgeError, type Json } from "./protocol.js";
import { readSpeechKey } from "./speech-key.js";

/** Spoken replies for the phone's talk mode. The phone sends a sentence; the
 * Hook voices it with ElevenLabs and streams the audio back. The API key is
 * read on this computer, used only in the request to ElevenLabs, and never
 * appears in a response, including errors. */

/** Raw signed 16-bit little-endian mono PCM, so the phone can queue it
 * straight into its audio engine without decoding. */
export const SPEECH_AUDIO = "pcm_s16le;rate=24000;channels=1";
const OUTPUT_FORMAT = "pcm_24000";
/** ElevenLabs' lowest-latency model. */
export const SPEECH_MODEL = "eleven_flash_v2_5";
/** River: relaxed, neutral and informative. PHREN_SPEECH_VOICE overrides it. */
export const DEFAULT_SPEECH_VOICE = "SAz9YHcvj6GT2YYXdXww";
const MAX_TEXT = 2_000;

export const speechRequest = z.object({
  text: z.string().trim().min(1).max(MAX_TEXT),
  /** Answer JSON with the audio and when each character is spoken, so the
   * phone can highlight the word being read (talk mode's karaoke). */
  timestamps: z.boolean().optional(),
});

/** When each character of the voiced text starts and ends, in seconds from
 * the start of the audio. */
export interface SpeechAlignment { characters: string[]; starts: number[]; ends: number[] }

export interface SpeechOptions {
  fetch?: typeof fetch;
  /** Resolves the ElevenLabs key; defaults to ELEVENLABS_API_KEY, then the stored key (speech-key.ts). */
  key?: () => Promise<string | undefined>;
  voice?: string;
}

/** A fixed message per ElevenLabs failure: its own response text is never
 * passed on. */
export async function speechError(upstream: Response): Promise<BridgeError> {
  let detail = "";
  try { detail = String(((await upstream.json()) as { detail?: { status?: unknown } }).detail?.status ?? ""); } catch { /* not JSON */ }
  if (detail === "quota_exceeded") return new BridgeError(402, "The ElevenLabs quota on this computer's account is used up.", { code: "speech-quota" });
  switch (upstream.status) {
    case 401: case 403: return new BridgeError(502, "ElevenLabs refused this computer's key.", { code: "speech-rejected" });
    case 404: return new BridgeError(502, "ElevenLabs doesn't know the configured voice.", { code: "speech-voice" });
    case 400: case 422: return new BridgeError(400, "ElevenLabs couldn't voice this text.", { code: "speech-invalid" });
    case 429: return new BridgeError(429, "ElevenLabs is busy. Try again shortly.", { code: "speech-busy" });
    default: return new BridgeError(502, `ElevenLabs failed (HTTP ${upstream.status}).`, { code: "speech-failed" });
  }
}

/** Starts ElevenLabs' streaming synthesis and returns its audio body. */
export async function synthesizeSpeech(text: string, signal: AbortSignal, options: SpeechOptions = {}): Promise<ReadableStream<Uint8Array>> {
  const upstream = await elevenLabs("stream", text, signal, options);
  if (!upstream.body) throw await speechError(upstream);
  return upstream.body;
}

/** Voices the text in one piece with ElevenLabs' character alignment. */
export async function synthesizeTimedSpeech(text: string, signal: AbortSignal, options: SpeechOptions = {}): Promise<{ audio: string; alignment: SpeechAlignment | null }> {
  const upstream = await elevenLabs("with-timestamps", text, signal, options);
  let body: { audio_base64?: unknown; alignment?: { characters?: unknown; character_start_times_seconds?: unknown; character_end_times_seconds?: unknown } | null };
  try {
    body = (await upstream.json()) as typeof body;
  } catch {
    throw new BridgeError(502, "ElevenLabs sent an unreadable reply.", { code: "speech-failed" });
  }
  if (typeof body.audio_base64 !== "string") throw new BridgeError(502, "ElevenLabs sent an unreadable reply.", { code: "speech-failed" });
  return { audio: body.audio_base64, alignment: alignmentOf(body.alignment) };
}

/** ElevenLabs' alignment, kept only when its three lists line up. */
export function alignmentOf(raw: { characters?: unknown; character_start_times_seconds?: unknown; character_end_times_seconds?: unknown } | null | undefined): SpeechAlignment | null {
  const characters = raw?.characters, starts = raw?.character_start_times_seconds, ends = raw?.character_end_times_seconds;
  if (!Array.isArray(characters) || !Array.isArray(starts) || !Array.isArray(ends)) return null;
  if (characters.length !== starts.length || characters.length !== ends.length) return null;
  if (!characters.every(c => typeof c === "string") || ![...starts, ...ends].every(t => typeof t === "number" && Number.isFinite(t))) return null;
  return { characters: characters as string[], starts: starts as number[], ends: ends as number[] };
}

async function elevenLabs(endpoint: "stream" | "with-timestamps", text: string, signal: AbortSignal, options: SpeechOptions): Promise<Response> {
  const key = await (options.key ?? readSpeechKey)();
  if (!key) throw new BridgeError(503, "Spoken replies aren't set up on this computer: it has no ElevenLabs key.", { code: "speech-unconfigured" });
  const voice = options.voice ?? process.env.PHREN_SPEECH_VOICE ?? DEFAULT_SPEECH_VOICE;
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}/${endpoint}?output_format=${OUTPUT_FORMAT}`;
  let upstream: Response;
  try {
    upstream = await (options.fetch ?? fetch)(url, {
      method: "POST", signal,
      headers: { "xi-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ text, model_id: SPEECH_MODEL, voice_settings: { stability: 0.6, similarity_boost: 0.75 } }),
    });
  } catch {
    throw new BridgeError(502, "Couldn't reach ElevenLabs from this computer.", { code: "speech-unreachable" });
  }
  if (!upstream.ok) throw await speechError(upstream);
  return upstream;
}

/** POST /v1/speech: writes the audio to the phone as ElevenLabs produces it.
 * With `timestamps`, answers JSON instead: `{ audio, audioFormat, alignment }`,
 * the audio base64 in the same PCM format and the alignment null when
 * ElevenLabs sent none.
 * Failures before the first byte are thrown for the route's JSON error; a
 * failure mid-stream cuts the response off, which the phone treats as an
 * error. The phone hanging up cancels the ElevenLabs request. */
export async function streamSpeech(data: Json, response: ServerResponse, options: SpeechOptions = {}): Promise<void> {
  const { text, timestamps } = speechRequest.parse(data);
  const abort = new AbortController();
  response.once("close", () => { if (!response.writableEnded) abort.abort(); });
  if (timestamps) {
    const { audio, alignment } = await synthesizeTimedSpeech(text, abort.signal, options);
    response.statusCode = 200;
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ audio, audioFormat: SPEECH_AUDIO, alignment }));
    return;
  }
  const audio = await synthesizeSpeech(text, abort.signal, options);
  response.statusCode = 200;
  response.setHeader("Content-Type", "application/octet-stream");
  response.setHeader("X-Phren-Audio", SPEECH_AUDIO);
  try {
    for await (const chunk of audio) {
      if (!response.write(chunk)) await once(response, "drain", { signal: abort.signal });
    }
    response.end();
  } catch {
    response.destroy();
  }
}
