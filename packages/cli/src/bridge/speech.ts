import { once } from "node:events";
import { readFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import path from "node:path";
import { z } from "zod";
import { homeDir } from "../home-paths.js";
import { BridgeError, type Json } from "./protocol.js";

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

export const speechRequest = z.object({ text: z.string().trim().min(1).max(MAX_TEXT) });

export interface SpeechOptions {
  fetch?: typeof fetch;
  /** Resolves the ElevenLabs key; defaults to ~/.config/mina-trailer.json. */
  key?: () => Promise<string | undefined>;
  voice?: string;
}

export function speechKeyFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(homeDir(env), ".config", "mina-trailer.json");
}

export async function readSpeechKey(file = speechKeyFile()): Promise<string | undefined> {
  try {
    const key = (JSON.parse(await readFile(file, "utf8")) as { elevenlabs_api_key?: unknown }).elevenlabs_api_key;
    return typeof key === "string" && key.trim() ? key.trim() : undefined;
  } catch {
    return undefined;
  }
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
  const key = await (options.key ?? (() => readSpeechKey()))();
  if (!key) throw new BridgeError(503, "Spoken replies aren't set up on this computer: it has no ElevenLabs key.", { code: "speech-unconfigured" });
  const voice = options.voice ?? process.env.PHREN_SPEECH_VOICE ?? DEFAULT_SPEECH_VOICE;
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}/stream?output_format=${OUTPUT_FORMAT}`;
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
  if (!upstream.ok || !upstream.body) throw await speechError(upstream);
  return upstream.body;
}

/** POST /v1/speech: writes the audio to the phone as ElevenLabs produces it.
 * Failures before the first byte are thrown for the route's JSON error; a
 * failure mid-stream cuts the response off, which the phone treats as an
 * error. The phone hanging up cancels the ElevenLabs request. */
export async function streamSpeech(data: Json, response: ServerResponse, options: SpeechOptions = {}): Promise<void> {
  const { text } = speechRequest.parse(data);
  const abort = new AbortController();
  response.once("close", () => { if (!response.writableEnded) abort.abort(); });
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
