import { WebSocket } from "ws";
import { readSpeechKey } from "./speech-key.js";

/** Dictation through ElevenLabs Scribe v2 Realtime, for the phone's opt-in
 * Scribe input. The phone streams 16 kHz mono PCM as binary frames; this
 * computer forwards it to ElevenLabs with its own key, which never leaves
 * here, and sends back `{type: "partial"|"committed", text}` frames. Errors
 * are fixed messages by code: ElevenLabs' own text is never passed on. */

export const TRANSCRIBE_MODEL = "scribe_v2_realtime";
export const TRANSCRIBE_RATE = 16_000;
const ENDPOINT = "wss://api.elevenlabs.io/v1/speech-to-text/realtime";
/** Ten minutes of dictation per socket; the phone opens a fresh one after. */
const MAX_SESSION_MS = 10 * 60_000;
/** Audio held while the upstream socket opens: about eight seconds. */
const MAX_PENDING_BYTES = TRANSCRIBE_RATE * 2 * 8;
const MAX_KEYTERMS = 50;

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

const OPEN = 1;

/** The upstream URL: VAD commits, the phone's language and its vocabulary as keyterms. */
export function transcribeURL(query: URLSearchParams): string {
  const url = new URL(ENDPOINT);
  url.searchParams.set("model_id", TRANSCRIBE_MODEL);
  url.searchParams.set("audio_format", "pcm_16000");
  url.searchParams.set("commit_strategy", "vad");
  const language = query.get("language") ?? "";
  if (/^[a-z]{2,3}$/.test(language)) url.searchParams.set("language_code", language);
  const terms = query.getAll("keyterm").map(term => term.trim()).filter(term => term.length > 0 && term.length <= 50);
  for (const term of [...new Set(terms)].slice(0, MAX_KEYTERMS)) url.searchParams.append("keyterms", term);
  return url.toString();
}

const ERRORS: Record<string, { code: string; message: string }> = {
  auth_error: { code: "transcribe-rejected", message: "ElevenLabs refused this computer's key." },
  quota_exceeded: { code: "transcribe-quota", message: "The ElevenLabs quota on this computer's account is used up." },
  rate_limited: { code: "transcribe-busy", message: "ElevenLabs is busy. Try again shortly." },
  resource_exhausted: { code: "transcribe-busy", message: "ElevenLabs is busy. Try again shortly." },
  queue_overflow: { code: "transcribe-busy", message: "ElevenLabs is busy. Try again shortly." },
  session_time_limit_exceeded: { code: "transcribe-limit", message: "This dictation reached ElevenLabs' time limit." },
};

export function relayTranscription(client: RelaySocket, query: URLSearchParams, options: TranscribeOptions = {}): Promise<void> {
  const connect = options.connect ?? ((url, key) => new WebSocket(url, { headers: { "xi-api-key": key } }) as unknown as RelaySocket);
  return (async () => {
    const key = await (options.key ?? readSpeechKey)();
    const tell = (frame: Record<string, unknown>) => { if (client.readyState === OPEN) client.send(JSON.stringify(frame)); };
    if (!key) {
      tell({ type: "error", code: "transcribe-unconfigured", error: "This computer has no ElevenLabs key." });
      client.close(1008, "No ElevenLabs key");
      return;
    }
    const upstream = connect(transcribeURL(query), key);
    let pending: Buffer[] = [], pendingBytes = 0, closed = false;
    const finish = (code = 1000, reason = "") => {
      if (closed) return;
      closed = true;
      clearTimeout(limit);
      try { upstream.close(); } catch { /* already closed */ }
      if (client.readyState === OPEN) client.close(code, reason);
    };
    const limit = setTimeout(() => finish(1000, "Session limit"), options.maxSessionMs ?? MAX_SESSION_MS);
    limit.unref?.();
    const chunk = (audio: Buffer, commit = false) => JSON.stringify({
      message_type: "input_audio_chunk", audio_base_64: audio.toString("base64"), commit, sample_rate: TRANSCRIBE_RATE });

    client.on("message", (data, isBinary) => {
      if (closed) return;
      if (!isBinary) {
        // The phone's only text frame: the person stopped, commit what's left.
        if (upstream.readyState === OPEN) upstream.send(chunk(Buffer.alloc(0), true));
        return;
      }
      if (upstream.readyState === OPEN) { upstream.send(chunk(data)); return; }
      pendingBytes += data.length;
      if (pendingBytes > MAX_PENDING_BYTES) { tell({ type: "error", code: "transcribe-failed", error: "ElevenLabs didn't answer." }); finish(1011); return; }
      pending.push(data);
    });
    client.on("close", () => finish());
    client.on("error", () => finish());

    upstream.on("open", () => {
      for (const audio of pending) upstream.send(chunk(audio));
      pending = []; pendingBytes = 0;
    });
    upstream.on("message", data => {
      let message: { message_type?: unknown; text?: unknown };
      try { message = JSON.parse(data.toString("utf8")); } catch { return; }
      const type = String(message.message_type ?? "");
      const text = typeof message.text === "string" ? message.text : "";
      if (type === "partial_transcript") tell({ type: "partial", text });
      else if (type === "committed_transcript") tell({ type: "committed", text });
      else if (type in ERRORS || /error|exceeded|invalid|throttled/.test(type)) {
        const known = ERRORS[type] ?? { code: "transcribe-failed", message: "ElevenLabs couldn't transcribe this audio." };
        // Too little speech is not a failure worth stopping for.
        if (type === "insufficient_audio_activity" || type === "commit_throttled") return;
        tell({ type: "error", code: known.code, error: known.message });
        finish(1011);
      }
    });
    upstream.on("error", () => { tell({ type: "error", code: "transcribe-failed", error: "Couldn't reach ElevenLabs." }); finish(1011); });
    upstream.on("close", () => finish());
  })();
}
