import { once } from "node:events";
import { Agent as HttpAgent, request as httpRequest, type ServerResponse } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import { z } from "zod";
import { BridgeError, type Json } from "./protocol.js";
import { readSpeechKey } from "./speech-key.js";
import { FALLBACK_SPEECH_MODEL, resolveSpeechModel, resolveSpeechRegion, resolveSpeechVoice, voiceId } from "./speech-voice.js";

export { DEFAULT_SPEECH_MODEL, DEFAULT_SPEECH_VOICE, FALLBACK_SPEECH_MODEL } from "./speech-voice.js";

/** Spoken replies for the phone's talk mode. The phone sends a sentence; the
 * Hook voices it with ElevenLabs and streams the audio back. The API key is
 * read on this computer, used only in the request to ElevenLabs, and never
 * appears in a response, including errors. */

/** What a phone that names no `formats` gets, as every phone did before
 * `speechFormats`: raw signed 16-bit little-endian mono PCM at 24 kHz, which
 * it queues straight into its audio engine without decoding. */
export const SPEECH_AUDIO = "pcm_s16le;rate=24000;channels=1";

/** ElevenLabs output formats the Hook can serve, best first. Each account
 * plan allows some of them (pcm_44100 is Pro and above, mp3_44100_192 is
 * Creator and above); the Hook learns which from ElevenLabs' refusal rather
 * than a hard-coded plan table. pcm_24000 works on every plan and every
 * phone, so it is the base every request falls back to. */
export const SPEECH_FORMATS = ["pcm_44100", "mp3_44100_192", "mp3_44100_128", "pcm_24000"] as const;
export type SpeechFormat = typeof SPEECH_FORMATS[number];
const BASE_FORMAT: SpeechFormat = "pcm_24000";
/** How each format is described to the phone: `audioFormat` in the JSON reply
 * and `X-Phren-Audio` on the streamed one, plus the sample rate on its own. */
export const SPEECH_FORMAT_INFO: Record<SpeechFormat, { audio: string; sampleRate: number; contentType: string }> = {
  pcm_44100: { audio: "pcm_s16le;rate=44100;channels=1", sampleRate: 44_100, contentType: "application/octet-stream" },
  mp3_44100_192: { audio: "mp3;rate=44100;bitrate=192000;channels=1", sampleRate: 44_100, contentType: "audio/mpeg" },
  mp3_44100_128: { audio: "mp3;rate=44100;bitrate=128000;channels=1", sampleRate: 44_100, contentType: "audio/mpeg" },
  pcm_24000: { audio: SPEECH_AUDIO, sampleRate: 24_000, contentType: "application/octet-stream" },
};

/** Talk mode waits for the whole sentence on the timestamped path, so a model
 * whose recent replies took longer than this to start playing is set aside
 * for FALLBACK_HOLD_MS. Measured 2026-09-28 on a 95-character reply with the
 * owner's voice: v4 Turbo ~200-400 ms to first streamed byte and ~1.1 s for
 * the timestamped reply; Flash v2.5 ~180-460 ms and ~0.4 s. 1.5 s leaves v4
 * Turbo headroom on a normal day and catches a slow one. */
export const SPEECH_SLOW_MS = 1_500;
/** Only replies this short are timed: a long one is slow for its length, not
 * because the model is. */
const TIMED_TEXT = 200;
/** How long a failing or slow model, or a refused format, is set aside. */
export const FALLBACK_HOLD_MS = 10 * 60_000;
const FORMAT_HOLD_MS = 6 * 60 * 60_000;
const MAX_TEXT = 2_000;

export const speechRequest = z.object({
  text: z.string().trim().min(1).max(MAX_TEXT),
  /** Answer JSON with the audio and when each character is spoken, so the
   * phone can highlight the word being read (talk mode's karaoke). */
  timestamps: z.boolean().optional(),
  /** With `timestamps`, stream the audio and alignment as ElevenLabs makes
   * them, one JSON line per chunk, instead of one JSON reply once the whole
   * sentence is voiced (about 0.6 s later with v4 Turbo). */
  stream: z.boolean().optional(),
  /** A voice the phone picked; otherwise this computer's setting. */
  voice: voiceId.optional(),
  /** The output formats the phone plays (`SPEECH_FORMATS` names). Without
   * it, pcm_24000, which older phones assume. Names this Hook doesn't know
   * (a newer phone's) are dropped before validation, never refused. */
  formats: z.preprocess(
    value => Array.isArray(value) ? [...new Set(value)].filter(name => (SPEECH_FORMATS as readonly unknown[]).includes(name)) : undefined,
    z.array(z.enum(SPEECH_FORMATS)).max(SPEECH_FORMATS.length).optional(),
  ),
});

/** What the Hook learned about this account: formats its plan refused and
 * models set aside for failing or being slow, each until a time, and the
 * recent start-of-audio times per model. One per Hook process. */
export class SpeechState {
  private readonly refused = new Map<SpeechFormat, number>();
  private readonly benched = new Map<string, { until: number; reason: "failed" | "slow" }>();
  private readonly latency = new Map<string, number[]>();
  constructor(private readonly now: () => number = Date.now) {}

  formatAllowed(format: SpeechFormat): boolean { return (this.refused.get(format) ?? 0) <= this.now(); }
  refuseFormat(format: SpeechFormat): void { this.refused.set(format, this.now() + FORMAT_HOLD_MS); }

  benchedReason(model: string): "failed" | "slow" | undefined {
    const entry = this.benched.get(model);
    return entry && entry.until > this.now() ? entry.reason : undefined;
  }
  bench(model: string, reason: "failed" | "slow"): void {
    this.benched.set(model, { until: this.now() + FALLBACK_HOLD_MS, reason });
    this.latency.delete(model);
  }

  /** Records how long a reply took to start; benches the model when the median
   * of its last three is over SPEECH_SLOW_MS. */
  recordLatency(model: string, ms: number): void {
    const samples = [...(this.latency.get(model) ?? []), ms].slice(-3);
    this.latency.set(model, samples);
    const median = [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)];
    if (samples.length === 3 && median > SPEECH_SLOW_MS) this.bench(model, "slow");
  }
}

/** The Hook's own: /v1/speech and /v1/speech/live learn together. */
export const sharedSpeechState = new SpeechState();

/** When each character of the voiced text starts and ends, in seconds from
 * the start of the audio. */
export interface SpeechAlignment { characters: string[]; starts: number[]; ends: number[] }

export interface SpeechOptions {
  fetch?: typeof fetch;
  /** Resolves the ElevenLabs key; defaults to ELEVENLABS_API_KEY, then the stored key (speech-key.ts). */
  key?: () => Promise<string | undefined>;
  voice?: string;
  /** Formats the phone plays, from the request; pcm_24000 always. */
  formats?: readonly string[];
  /** Defaults to this computer's setting (speech-voice.ts). */
  model?: string;
  /** Where ElevenLabs is, e.g. https://api.elevenlabs.io. Defaults to this
   * computer's region setting (speech-voice.ts). */
  origin?: string;
  /** Defaults to the Hook's own. */
  state?: SpeechState;
  now?: () => number;
}

/** What was voiced: the model and format actually used. */
export interface SpeechResult { model: string; format: SpeechFormat }

/** Idle connections to ElevenLabs are kept this long, so the next sentence's
 * request skips the TCP and TLS handshake. fetch's own pool lets them go
 * after four seconds, shorter than talk mode's pause between replies. */
const KEEP_ALIVE_MS = 60_000;
let pool: { http: HttpAgent; https: HttpsAgent } | undefined;

/** POSTs to ElevenLabs over the Hook's kept-alive pool and answers a fetch
 * Response whose body is the upstream socket, so audio is passed on chunk by
 * chunk as it arrives. Honours HTTPS_PROXY as fetch does, when
 * NODE_USE_ENV_PROXY is set. */
export function elevenLabsFetch(url: string, init: RequestInit): Promise<Response> {
  const proxyEnv = process.env.NODE_USE_ENV_PROXY === "1" ? process.env : undefined;
  pool ??= {
    http: new HttpAgent({ keepAlive: true, timeout: KEEP_ALIVE_MS, proxyEnv }),
    https: new HttpsAgent({ keepAlive: true, timeout: KEEP_ALIVE_MS, proxyEnv }),
  };
  const target = new URL(url), secure = target.protocol === "https:";
  const body = typeof init.body === "string" ? init.body : "";
  return new Promise((resolve, reject) => {
    const request = (secure ? httpsRequest : httpRequest)(target, {
      method: init.method ?? "GET", signal: init.signal ?? undefined, agent: secure ? pool!.https : pool!.http,
      headers: { ...init.headers as Record<string, string>, "Content-Length": String(Buffer.byteLength(body)) },
    }, upstream => {
      const status = upstream.statusCode ?? 0;
      if (status < 200 || status > 599) { upstream.destroy(); reject(new Error(`HTTP ${status}`)); return; }
      resolve(new Response(Readable.toWeb(upstream) as ReadableStream<Uint8Array>, { status }));
    });
    request.on("error", reject);
    request.end(body);
  });
}

/** ElevenLabs' machine-readable reason (`detail.status`), never its text. */
async function upstreamCode(upstream: Response): Promise<string> {
  try { return String(((await upstream.json()) as { detail?: { status?: unknown } }).detail?.status ?? ""); } catch { return ""; }
}

/** A fixed message per ElevenLabs failure: its own response text is never
 * passed on. */
export async function speechError(upstream: Response): Promise<BridgeError> {
  return speechErrorFor(upstream.status, await upstreamCode(upstream));
}

function speechErrorFor(status: number, detail: string): BridgeError {
  if (detail === "quota_exceeded") return new BridgeError(402, "The ElevenLabs quota on this computer's account is used up.", { code: "speech-quota" });
  switch (status) {
    case 401: case 403: return new BridgeError(502, "ElevenLabs refused this computer's key.", { code: "speech-rejected" });
    case 404: return new BridgeError(502, "ElevenLabs doesn't know the configured voice.", { code: "speech-voice" });
    case 400: case 422: return new BridgeError(400, "ElevenLabs couldn't voice this text.", { code: "speech-invalid" });
    case 429: return new BridgeError(429, "ElevenLabs is busy. Try again shortly.", { code: "speech-busy" });
    default: return new BridgeError(502, `ElevenLabs failed (HTTP ${status}).`, { code: "speech-failed" });
  }
}

/** A reply as it should sound: markdown the agent wrote for the chat bubble
 * (emphasis, headings, bullets, links, inline code, tables) is read aloud
 * literally by ElevenLabs, so it is reduced to its words. A code block is
 * skipped, a link keeps its text and a bare URL becomes "a link". Empty when
 * nothing speakable is left. */
export function speakableText(text: string): string {
  return text
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "a link")
    .replace(/`([^`]*)`/g, "$1")
    .split(/\r?\n/)
    .map(line => {
      // A heading, bullet or table row ends where its line does; a
      // paragraph's soft-wrapped lines run on.
      const block = /^\s{0,3}(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|\|)/.test(line);
      const words = line
        .replace(/^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/, "")
        .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+(?:\[[ xX]\]\s+)?)/, "")
        .replace(/\s*\|\s*/g, (bar: string, offset: number, whole: string) => offset === 0 || offset + bar.length === whole.length ? "" : ", ")
        .replace(/(\*\*|__|~~)(.+?)\1/g, "$2")
        .replace(/(^|[^\w*])[*_](\S(?:.*?\S)?)[*_](?![\w*])/g, "$1$2")
        .trim();
      return block && words && !/[.!?:;,]$/.test(words) ? `${words}.` : words;
    })
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Starts ElevenLabs' streaming synthesis and returns its body: the audio,
 * or with `stream/with-timestamps` JSON lines of audio and alignment. */
export async function synthesizeSpeech(text: string, signal: AbortSignal, options: SpeechOptions = {}, endpoint: "stream" | "stream/with-timestamps" = "stream"): Promise<SpeechResult & { body: ReadableStream<Uint8Array> }> {
  const { upstream, model, format, started } = await elevenLabs(endpoint, text, signal, options);
  if (!upstream.body) throw await speechError(upstream);
  timed(text, model, started, options);
  return { body: upstream.body, model, format };
}

/** Voices the text in one piece with ElevenLabs' character alignment. */
export async function synthesizeTimedSpeech(text: string, signal: AbortSignal, options: SpeechOptions = {}): Promise<SpeechResult & { audio: string; alignment: SpeechAlignment | null }> {
  const { upstream, model, format, started } = await elevenLabs("with-timestamps", text, signal, options);
  let body: { audio_base64?: unknown; alignment?: { characters?: unknown; character_start_times_seconds?: unknown; character_end_times_seconds?: unknown } | null };
  try {
    body = (await upstream.json()) as typeof body;
  } catch {
    throw new BridgeError(502, "ElevenLabs sent an unreadable reply.", { code: "speech-failed" });
  }
  if (typeof body.audio_base64 !== "string") throw new BridgeError(502, "ElevenLabs sent an unreadable reply.", { code: "speech-failed" });
  // Talk mode plays nothing until this whole reply is in.
  timed(text, model, started, options);
  return { audio: body.audio_base64, alignment: alignmentOf(body.alignment), model, format };
}

/** Times a short reply from the chosen model (never the fallback, which has
 * nothing to fall back to). */
function timed(text: string, model: string, started: number, options: SpeechOptions): void {
  if (model === FALLBACK_SPEECH_MODEL || text.length > TIMED_TEXT) return;
  (options.state ?? sharedSpeechState).recordLatency(model, (options.now ?? Date.now)() - started);
}

/** ElevenLabs' alignment, kept only when its three lists line up. */
export function alignmentOf(raw: { characters?: unknown; character_start_times_seconds?: unknown; character_end_times_seconds?: unknown } | null | undefined): SpeechAlignment | null {
  const characters = raw?.characters, starts = raw?.character_start_times_seconds, ends = raw?.character_end_times_seconds;
  if (!Array.isArray(characters) || !Array.isArray(starts) || !Array.isArray(ends)) return null;
  if (characters.length !== starts.length || characters.length !== ends.length) return null;
  if (!characters.every(c => typeof c === "string") || ![...starts, ...ends].every(t => typeof t === "number" && Number.isFinite(t))) return null;
  return { characters: characters as string[], starts: starts as number[], ends: ends as number[] };
}

/** ElevenLabs' streamed timestamps, one JSON object per line, as the phone's
 * lines: `{audio, alignment}`, the alignment's times in seconds from the
 * start of the whole reply (as ElevenLabs counts them) and null for a chunk
 * with no characters. A chunk without audio is dropped. */
async function* timedLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let pending = "";
  for await (const bytes of body) {
    pending += decoder.decode(bytes, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop()!;
    for (const line of lines) { const out = timedLine(line); if (out) yield out; }
  }
  const out = timedLine(pending + decoder.decode());
  if (out) yield out;
}

function timedLine(line: string): string | undefined {
  if (!line.trim()) return undefined;
  const raw = JSON.parse(line) as { audio_base64?: unknown; alignment?: Parameters<typeof alignmentOf>[0] };
  if (typeof raw.audio_base64 !== "string" || !raw.audio_base64) return undefined;
  const alignment = alignmentOf(raw.alignment);
  return JSON.stringify({ audio: raw.audio_base64, alignment: alignment?.characters.length ? alignment : null }) + "\n";
}

/** The plan doesn't allow this output format (Creator: "Output format
 * 'pcm_44100' is only available on the Pro tier and above", 403
 * `output_format_not_allowed`). */
function formatRefused(status: number, code: string): boolean {
  return (status === 400 || status === 403 || status === 422) && /output_format/.test(code);
}

/** A failure another model may not have: the model itself refused or
 * unknown, or ElevenLabs erroring. Not the key, quota, voice or rate limit. */
function modelFailed(status: number, code: string): boolean {
  if (status === 429 || code === "quota_exceeded" || code === "invalid_api_key") return false;
  return status >= 500 || /model/.test(code);
}

/** Asks ElevenLabs for the best format the phone plays and the plan allows,
 * with the chosen model, then Flash v2.5 when that model fails or has been
 * slow. A refused format is skipped for FORMAT_HOLD_MS, a failed or slow
 * model for FALLBACK_HOLD_MS. */
async function elevenLabs(endpoint: "stream" | "stream/with-timestamps" | "with-timestamps", text: string, signal: AbortSignal, options: SpeechOptions): Promise<SpeechResult & { upstream: Response; started: number }> {
  const key = await (options.key ?? readSpeechKey)();
  if (!key) throw new BridgeError(503, "Spoken replies aren't set up on this computer: it has no ElevenLabs key.", { code: "speech-unconfigured" });
  const { voice } = await resolveSpeechVoice(options.voice);
  const state = options.state ?? sharedSpeechState, now = options.now ?? Date.now;
  const chosen = options.model ?? (await resolveSpeechModel()).model;
  const origin = options.origin ?? (await resolveSpeechRegion()).origin;
  const models = chosen === FALLBACK_SPEECH_MODEL ? [chosen] : state.benchedReason(chosen) ? [FALLBACK_SPEECH_MODEL] : [chosen, FALLBACK_SPEECH_MODEL];
  const accepted = new Set(options.formats ?? []);
  let failure: BridgeError | undefined;
  models: for (const model of models) {
    // Per model, so a format refused under one isn't tried again under the next.
    const formats = SPEECH_FORMATS.filter(format => format === BASE_FORMAT || (accepted.has(format) && state.formatAllowed(format)));
    for (const format of formats) {
      const url = `${origin}/v1/text-to-speech/${encodeURIComponent(voice)}/${endpoint}?output_format=${format}`;
      const started = now();
      let upstream: Response;
      try {
        upstream = await (options.fetch ?? elevenLabsFetch)(url, {
          method: "POST", signal,
          headers: { "xi-api-key": key, "Content-Type": "application/json" },
          body: JSON.stringify({ text, model_id: model, voice_settings: { stability: 0.6, similarity_boost: 0.75 } }),
        });
      } catch {
        throw new BridgeError(502, "Couldn't reach ElevenLabs from this computer.", { code: "speech-unreachable" });
      }
      if (upstream.ok) return { upstream, model, format, started };
      const code = await upstreamCode(upstream);
      if (format !== BASE_FORMAT && formatRefused(upstream.status, code)) { state.refuseFormat(format); continue; }
      failure = speechErrorFor(upstream.status, code);
      if (model !== FALLBACK_SPEECH_MODEL && modelFailed(upstream.status, code)) { state.bench(model, "failed"); continue models; }
      throw failure;
    }
  }
  throw failure ?? new BridgeError(502, "ElevenLabs failed.", { code: "speech-failed" });
}

/** POST /v1/speech: writes the audio to the phone as ElevenLabs produces it.
 * With `timestamps`, answers JSON instead: `{ audio, audioFormat, sampleRate,
 * format, model, alignment }`, the audio base64 in the format served and the
 * alignment null when ElevenLabs sent none. The streamed reply names its
 * format in `X-Phren-Audio` and `X-Phren-Audio-Rate`. A phone that sends no
 * `formats` always gets pcm_24000. With `timestamps` and `stream`, the
 * streamed reply is `application/x-ndjson`, one `{audio, alignment}` line per
 * chunk (see timedLines), with the same headers.
 * Failures before the first byte are thrown for the route's JSON error; a
 * failure mid-stream cuts the response off, which the phone treats as an
 * error. The phone hanging up cancels the ElevenLabs request. */
export async function streamSpeech(data: Json, response: ServerResponse, options: SpeechOptions = {}): Promise<void> {
  const request = speechRequest.parse(data);
  const text = speakableText(request.text);
  if (!text) throw new BridgeError(400, "There is nothing to say in this reply.", { code: "speech-invalid" });
  // With timestamps, the alignment covers these spoken words, not the markdown.
  const { timestamps } = request;
  if (request.voice) options = { ...options, voice: request.voice };
  options = { ...options, formats: request.formats ?? [] };
  const abort = new AbortController();
  response.once("close", () => { if (!response.writableEnded) abort.abort(); });
  if (timestamps && !request.stream) {
    const { audio, alignment, model, format } = await synthesizeTimedSpeech(text, abort.signal, options);
    const info = SPEECH_FORMAT_INFO[format];
    response.statusCode = 200;
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ audio, audioFormat: info.audio, sampleRate: info.sampleRate, format, model, alignment }));
    return;
  }
  const { body: audio, model, format } = await synthesizeSpeech(text, abort.signal, options, timestamps ? "stream/with-timestamps" : "stream");
  const info = SPEECH_FORMAT_INFO[format];
  response.statusCode = 200;
  response.setHeader("Content-Type", timestamps ? "application/x-ndjson" : info.contentType);
  response.setHeader("X-Phren-Audio", info.audio);
  response.setHeader("X-Phren-Audio-Rate", String(info.sampleRate));
  response.setHeader("X-Phren-Speech-Model", model);
  // The phone sets up its player from these headers while the first audio is still on its way.
  response.flushHeaders();
  try {
    for await (const chunk of timestamps ? timedLines(audio) : audio) {
      if (!response.write(chunk)) await once(response, "drain", { signal: abort.signal });
    }
    response.end();
  } catch {
    response.destroy();
  }
}
