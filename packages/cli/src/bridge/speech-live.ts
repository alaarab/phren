import { WebSocket } from "ws";
import { SPEECH_FORMAT_INFO, SPEECH_FORMATS, type SpeechFormat, type SpeechState, sharedSpeechState, speakableText } from "./speech.js";
import { readSpeechKey } from "./speech-key.js";
import { FALLBACK_SPEECH_MODEL, resolveSpeechModel, resolveSpeechRegion, resolveSpeechVoice, voiceId } from "./speech-voice.js";

/** WS /v1/speech/live: a reply voiced while it is still being written. The
 * phone (or, later, the Hook from the agent's partial reply) sends the text
 * as it arrives; this computer streams it into one ElevenLabs WebSocket with
 * its own key and sends the audio back as ElevenLabs makes it, so speech
 * starts with the first sentence instead of after each whole one.
 *
 * Query: `voice` (an ElevenLabs voice id; else this computer's) and `format`,
 * repeated, the SPEECH_FORMATS names the phone plays (else pcm_24000).
 * Phone frames: `{"text": "<more of the reply>"}` and `{"done": true}` once
 * the reply is complete. Hook frames: `{"type": "start", model, format,
 * audioFormat, sampleRate}`, then `{"type": "audio", audio, alignment}` (audio
 * base64; alignment `{characters, starts, ends}` in seconds from the start of
 * this socket's audio, or null), then `{"type": "done"}`, or `{"type":
 * "error", code, error}`. One socket voices one reply.
 *
 * v4 models are refused on ElevenLabs' text-to-speech stream-input
 * ("unsupported_model": checked 2026-10-01) and served on text-to-dialogue
 * stream-input, which in turn refuses Flash; so the model picks the endpoint.
 * When the model is refused or failing, the reply falls back to Flash v2.5. */

const OPEN = 1;
/** A reply is voiced within ten minutes; the phone opens a fresh socket after. */
const MAX_SESSION_MS = 10 * 60_000;
/** Text-to-dialogue closes a socket quiet for 20 s; an agent may think longer. */
const KEEP_ALIVE_MS = 15_000;
/** ElevenLabs' socket opens in well under a second; one still connecting
 * after this is given up on, for Flash or an error. */
const HANDSHAKE_MS = 5_000;
/** The first audio came about 140 ms after ElevenLabs had a sentence
 * (2026-10-01). It is awaited once ElevenLabs must be voicing: the reply is
 * done, or FORCED_TEXT of it is in. A shorter piece may sit in ElevenLabs'
 * buffer until more text comes, which can be minutes of the agent thinking. */
const FIRST_AUDIO_MS = 5_000;
const FORCED_TEXT = 300;
/** Audio queued for a phone that isn't reading it: about 45 s of pcm_44100. */
const MAX_BUFFERED = 4 * 1024 * 1024;
/** The phone's frames held while this computer's settings are read. */
const MAX_EARLY_BYTES = 1024 * 1024;
const MAX_TEXT = 100_000;
const VOICE_SETTINGS = { stability: 0.6, similarity_boost: 0.75 };

export interface LiveSocket {
  readonly readyState: number;
  /** Bytes queued to send; the phone's socket has it, ElevenLabs' need not. */
  readonly bufferedAmount?: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "message", listener: (data: Buffer, isBinary: boolean) => void): unknown;
  on(event: "open", listener: () => void): unknown;
  on(event: "close", listener: (code?: number, reason?: Buffer) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

/** ElevenLabs' side: a socket that also reports a refused handshake with its
 * HTTP status and ElevenLabs' `detail.status`. */
export interface LiveUpstream extends LiveSocket {
  on(event: "message", listener: (data: Buffer, isBinary: boolean) => void): unknown;
  on(event: "open", listener: () => void): unknown;
  on(event: "close", listener: (code?: number, reason?: Buffer) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "refused", listener: (status: number, code: string) => void): unknown;
}

export interface LiveSpeechOptions {
  key?: () => Promise<string | undefined>;
  connect?: (url: string, key: string) => LiveUpstream;
  /** Defaults to this computer's model and region settings. */
  model?: string;
  origin?: string;
  state?: SpeechState;
  maxSessionMs?: number;
  handshakeMs?: number;
  firstAudioMs?: number;
}

function connectElevenLabs(url: string, key: string): LiveUpstream {
  const socket = new WebSocket(url, { headers: { "xi-api-key": key }, perMessageDeflate: false });
  socket.on("unexpected-response", (request, response) => {
    let body = "";
    response.on("data", (bytes: Buffer) => { body += bytes; });
    response.on("end", () => {
      let code = "";
      try { code = String((JSON.parse(body) as { detail?: { status?: unknown } }).detail?.status ?? ""); } catch { /* not JSON */ }
      socket.emit("refused", response.statusCode ?? 0, code);
      request.destroy();
    });
  });
  return socket as unknown as LiveUpstream;
}

/** Text-to-dialogue serves v3 and v4; text-to-speech stream-input the rest. */
export function liveEndpoint(model: string): "dialogue" | "speech" {
  return /^eleven_v[34]/.test(model) ? "dialogue" : "speech";
}

/** The longest unfinished sentence held for more text. */
const MAX_PENDING = 2_048;

/** Markdown arriving a piece at a time, released a sentence or line at a time
 * as the words speakableText leaves of it. A code block is skipped until it
 * closes; the unfinished sentence waits for more text or `end`. */
export class SpeakableStream {
  private pending = "";
  private inFence = false;

  push(text: string): string {
    this.pending += text;
    // The last line end, or sentence end followed by a space, so far.
    let cut = this.pending.lastIndexOf("\n") + 1;
    for (const match of this.pending.matchAll(/[.!?:;](?=\s)/g)) cut = Math.max(cut, match.index + 1);
    // Text that never ends a sentence is cut at a space past MAX_PENDING, so
    // the held text (and the rescan of it on each piece) stays small.
    if (!cut && this.pending.length > MAX_PENDING) cut = this.pending.lastIndexOf(" ", MAX_PENDING) + 1 || MAX_PENDING;
    if (!cut) return "";
    const ready = this.pending.slice(0, cut);
    this.pending = this.pending.slice(cut);
    return this.speak(ready);
  }

  end(): string {
    const rest = this.pending;
    this.pending = "";
    return this.speak(rest);
  }

  private speak(text: string): string {
    const spoken: string[] = [];
    for (const line of text.split("\n")) {
      if (/^\s{0,3}(```|~~~)/.test(line)) { this.inFence = !this.inFence; continue; }
      if (this.inFence) continue;
      const words = speakableText(line);
      if (words) spoken.push(words);
    }
    return spoken.join(" ");
  }
}

/** The characters of `text` that are not whitespace. */
function nonSpace(text: string): number {
  return text.replace(/\s+/g, "").length;
}

/** Seconds of audio in a chunk of the given format. */
function seconds(format: SpeechFormat, bytes: number): number {
  const mp3 = /^mp3_\d+_(\d+)$/.exec(format);
  return mp3 ? bytes * 8 / (Number(mp3[1]) * 1_000) : bytes / (SPEECH_FORMAT_INFO[format].sampleRate * 2);
}

function liveError(text: string): { code: string; error: string } {
  if (/quota/i.test(text)) return { code: "speech-quota", error: "The ElevenLabs quota on this computer's account is used up." };
  if (/auth|api_key|unauthori[sz]ed/i.test(text)) return { code: "speech-rejected", error: "ElevenLabs refused this computer's key." };
  return { code: "speech-failed", error: "ElevenLabs couldn't voice this reply." };
}

/** A failure Flash would share: the key, the quota or the rate limit. */
function accountFailure(status: number, code: string): boolean {
  return status === 401 || status === 429 || /quota|auth|api_key|unauthori[sz]ed|rate_limit|too_many/i.test(code);
}

/** The HTTP status an error frame's code stands for, so a frame is judged as
 * a refused handshake would be: a refused format or model, or the request,
 * is a 400; anything else (internal_error, overloaded) ElevenLabs failing. */
function frameStatus(code: string): number {
  return /output_format|model|invalid|validation/.test(code) ? 400 : 500;
}

export function relayLiveSpeech(client: LiveSocket, query: URLSearchParams, options: LiveSpeechOptions = {}): Promise<void> {
  const connect = options.connect ?? connectElevenLabs;
  const state = options.state ?? sharedSpeechState;
  // Attached before the first await: frames the phone sends while this
  // computer's settings are read wait here, and a phone that hangs up by
  // then never opens ElevenLabs' socket.
  let early: Buffer[] = [], earlyBytes = 0, overflow = false, hungUp = false;
  let receive = (data: Buffer) => {
    earlyBytes += data.length;
    if (earlyBytes > MAX_EARLY_BYTES) overflow = true; else early.push(data);
  };
  let gone = () => { hungUp = true; };
  client.on("message", (data, isBinary) => { if (!isBinary) receive(data); });
  client.on("close", () => gone());
  client.on("error", () => gone());
  return (async () => {
    const tell = (frame: Record<string, unknown>) => { if (client.readyState === OPEN) client.send(JSON.stringify(frame)); };
    const key = await (options.key ?? readSpeechKey)();
    if (!key) {
      tell({ type: "error", code: "speech-unconfigured", error: "Spoken replies aren't set up on this computer: it has no ElevenLabs key." });
      client.close(1008, "No ElevenLabs key");
      return;
    }
    const requested = voiceId.safeParse(query.get("voice") ?? undefined);
    const { voice } = await resolveSpeechVoice(requested.success ? requested.data : undefined);
    const chosen = options.model ?? (await resolveSpeechModel()).model;
    const origin = (options.origin ?? (await resolveSpeechRegion()).origin).replace(/^http/, "ws");
    if (hungUp || client.readyState !== OPEN) return;
    const accepted = new Set(query.getAll("format"));
    const formats = SPEECH_FORMATS.filter(format => format === "pcm_24000" || (accepted.has(format) && state.formatAllowed(format)));
    let models = chosen === FALLBACK_SPEECH_MODEL || state.benchedReason(chosen) ? [FALLBACK_SPEECH_MODEL] : [chosen, FALLBACK_SPEECH_MODEL];

    const text = new SpeakableStream();
    let saidLength = 0, done = false, closed = false, started = false;
    let upstream: LiveUpstream | undefined, endpoint: "dialogue" | "speech" = "speech", format: SpeechFormat = "pcm_24000", elapsed = 0;
    /** The current socket's handshake and first-audio timers. */
    let watch: { voicing(): void; stop(): void } | undefined;
    /** Hands words to the current socket, which sends them once open. */
    let put: ((words: string) => void) | undefined;
    /** Set when a socket ended its audio before the reply was done: the words it never voiced, for the next
     * socket, opened when they are there (at once, or with the reply's next text or its end). */
    let resume: string[] | undefined;
    const finish = (code = 1000, reason = "") => {
      if (closed) return;
      closed = true;
      clearTimeout(limit); clearInterval(keepAlive); watch?.stop();
      try { upstream?.close(); } catch { /* already closed */ }
      if (client.readyState === OPEN) client.close(code, reason);
    };
    const fail = (frame: { code: string; error: string }, code = 1011) => { tell({ type: "error", ...frame }); finish(code); };
    const limit = setTimeout(() => fail({ code: "speech-limit", error: "This reply ran past the ten minutes one spoken reply can take." }, 1000),
      options.maxSessionMs ?? MAX_SESSION_MS);
    limit.unref?.();
    const keepAlive = setInterval(() => { if (upstream?.readyState === OPEN && endpoint === "dialogue") upstream.send(JSON.stringify({ keep_alive: true })); }, KEEP_ALIVE_MS);
    keepAlive.unref?.();

    const textFrame = (words: string) => JSON.stringify(endpoint === "dialogue" ? { inputs: [{ text: `${words} `, voice_id: voice }] } : { text: `${words} ` });
    const closeFrame = () => JSON.stringify(endpoint === "dialogue" ? { close_socket: true } : { text: "" });
    const send = (words: string) => {
      if (!words) return;
      saidLength += words.length;
      if (saidLength > MAX_TEXT) { fail({ code: "speech-invalid", error: "This reply is too long to voice." }); return; }
      if (resume) { resume.push(words); reopen(); return; }
      put?.(words);
    };
    /** The next socket for a reply whose last one ended early, with the words that one never voiced. */
    const reopen = () => {
      const words = resume ?? [];
      resume = undefined;
      open(words, true);
    };

    /** One ElevenLabs socket, given the words it is to voice first: every word so far for the reply's first
     * socket, what a failed one carried for its fallback, what an ended one never voiced for its successor. */
    const open = (replay: string[] = [], resumed = false): void => {
      const model = models[0];
      endpoint = liveEndpoint(model);
      format = formats[0];
      // Stream-input times its alignment from its own stream's start; this socket's starts here.
      const base = elapsed;
      const sent: string[] = [];
      let sentLength = 0, voicedChars = 0, sentAtFirstAudio = -1;
      const params = new URLSearchParams({ model_id: model, output_format: format, sync_alignment: "true" });
      if (endpoint === "speech") { params.set("auto_mode", "true"); params.set("inactivity_timeout", "180"); }
      const path = endpoint === "dialogue" ? "/v1/text-to-dialogue/stream-input" : `/v1/text-to-speech/${encodeURIComponent(voice)}/stream-input`;
      const socket = connect(`${origin}${path}?${params}`, key);
      upstream = socket;
      const current = () => upstream === socket && !closed;
      let voiced = false, firstAudio: ReturnType<typeof setTimeout> | undefined;
      const handshake = setTimeout(() => { if (current()) refused(504, "handshake_timeout"); }, options.handshakeMs ?? HANDSHAKE_MS);
      handshake.unref?.();
      watch = {
        voicing: () => {
          if (voiced || firstAudio || !current()) return;
          firstAudio = setTimeout(() => { if (current() && !voiced) refused(504, "first_audio_timeout"); }, options.firstAudioMs ?? FIRST_AUDIO_MS);
          firstAudio.unref?.();
        },
        stop: () => { clearTimeout(handshake); clearTimeout(firstAudio); },
      };
      const carry = (words: string) => {
        sent.push(words); sentLength += words.length;
        if (socket.readyState === OPEN) {
          socket.send(textFrame(words));
          if (sentLength >= FORCED_TEXT) watch?.voicing();
        }
      };
      for (const words of replay) carry(words);
      put = words => { if (current()) carry(words); };
      /** What this socket was sent and never voiced, by the characters its alignment covered, spaces left out
       * on both sides (ElevenLabs may or may not time the spaces); a chunk short of at most two of its own
       * characters counts as voiced. Without alignment: what came after its first audio, or nothing once the
       * reply is done (its close was sent with it). */
      const unvoiced = (): string[] => {
        if (!voicedChars) return done ? [] : sent.slice(Math.max(0, sentAtFirstAudio));
        let covered = 0;
        for (const [index, words] of sent.entries()) {
          const length = nonSpace(words);
          covered += length;
          if (voicedChars < covered - Math.min(2, Math.floor(length / 2))) return sent.slice(index);
        }
        return [];
      };
      const detach = () => {
        clearTimeout(handshake); clearTimeout(firstAudio);
        // Detached first, so its closing is not taken for a failure.
        upstream = undefined;
        try { socket.close(); } catch { /* already closed */ }
      };
      // Before the first audio, the next model (Flash) takes the reply over;
      // with none left, the phone gets `failure`.
      const fallBack = (failure: { code: string; error: string }) => {
        detach();
        if (models.length > 1) { state.bench(model, "failed"); models = models.slice(1); open([...sent], resumed); return; }
        fail(failure);
      };
      // A refused format or model: ElevenLabs answers some in the handshake
      // (v4 on stream-input) and the rest in an error frame once open. A
      // stalled socket is refused here too, as a 504.
      const refused = (status: number, code: string) => {
        if (format !== "pcm_24000" && (status === 400 || status === 403 || status === 422) && /output_format/.test(code)) {
          detach(); state.refuseFormat(format); formats.shift(); open([...sent], resumed); return;
        }
        if (!accountFailure(status, code) && (status >= 500 || /model/.test(code))) {
          fallBack(status === 504 ? { code: "speech-failed", error: "ElevenLabs didn't answer." } : liveError(`${status} ${code}`));
          return;
        }
        detach();
        fail(liveError(`${status} ${code}`));
      };
      socket.on("refused", (status, code) => { if (current()) refused(status, code); });
      socket.on("open", () => {
        if (!current()) return;
        clearTimeout(handshake);
        socket.send(JSON.stringify(endpoint === "dialogue" ? { voices: [voice], voice_settings: VOICE_SETTINGS } : { text: " ", voice_settings: VOICE_SETTINGS }));
        for (const words of sent) socket.send(textFrame(words));
        if (done) socket.send(closeFrame());
        if (sent.length && (done || sentLength >= FORCED_TEXT)) watch?.voicing();
      });
      socket.on("message", data => {
        if (!current()) return;
        let message: Record<string, unknown>;
        try { message = JSON.parse(data.toString("utf8")) as Record<string, unknown>; } catch { return; }
        if (message.error && !voiced) { refused(frameStatus(String(message.error)), String(message.error)); return; }
        if (typeof message.audio === "string" && message.audio) {
          // A phone that stopped reading would hold the rest of the reply in this computer's memory.
          if ((client.bufferedAmount ?? 0) > MAX_BUFFERED) { fail({ code: "speech-failed", error: "The phone stopped taking the audio." }); return; }
          // Announced with the first audio, so a fallback before it is never seen.
          if (!started) {
            const info = SPEECH_FORMAT_INFO[format];
            tell({ type: "start", model, format, audioFormat: info.audio, sampleRate: info.sampleRate });
            started = true;
          }
          if (!voiced) sentAtFirstAudio = sent.length;
          voiced = true;
          clearTimeout(firstAudio);
          const audio = message.audio, length = Buffer.from(audio, "base64").length;
          const timed = alignment(message.alignment, endpoint === "dialogue" ? elapsed : base);
          voicedChars += nonSpace(timed?.characters.join("") ?? "");
          tell({ type: "audio", audio, alignment: timed });
          elapsed += seconds(format, length);
        }
        if (message.isFinal === true || message.is_final === true) {
          // Text-to-dialogue (v4) ends a socket after the text it had, though the reply goes on: what it never
          // voiced, and the reply's next text, go to a fresh socket, timed on from this one's audio.
          // A socket given words that voiced none of them falls back, the phone's done or not: a fresh socket
          // ending just after that done would otherwise end the reply with its words never spoken.
          if (!voiced) {
            if (done && !sent.length) { tell({ type: "done" }); finish(); } else fallBack({ code: "speech-failed", error: "ElevenLabs ended without voicing the reply." });
            return;
          }
          // Stream-input ends only after the close sent with the phone's done; text-to-dialogue may end after
          // the text it had, done or not, with the reply's last words never voiced.
          let left = done && endpoint === "speech" ? [] : unvoiced();
          // The same words left again by a socket given only them (their one retry): its alignment and the
          // text disagree, so they are taken as voiced rather than sent round again.
          const again = resumed && left.length > 0 && left.length === replay.length && left.every((words, index) => words === replay[index]);
          if (again) left = [];
          if (done && !left.length) { tell({ type: "done" }); finish(); return; }
          detach(); put = undefined; resume = left;
          if (left.length) reopen();
          return;
        }
        if (message.error) fail(liveError(String(message.error)));
      });
      socket.on("error", () => { if (current()) { detach(); fail({ code: "speech-unreachable", error: "Couldn't reach ElevenLabs from this computer." }); } });
      socket.on("close", (_code, reason) => {
        if (!current()) return;
        if (voiced) { detach(); fail({ code: "speech-failed", error: "ElevenLabs stopped before the reply was voiced." }); return; }
        // Closed before any audio: the reason is read only to tell the
        // account's failures (which Flash shares) from the model's.
        const why = reason?.toString("utf8") ?? "";
        if (accountFailure(0, why)) { detach(); fail(liveError(why)); return; }
        fallBack({ code: "speech-failed", error: "ElevenLabs didn't answer." });
      });
    };

    /** In seconds from the start of this socket's audio, `offset` on from where the reply's audio stood:
     * stream-input counts from the start of its own stream, text-to-dialogue from each chunk. */
    const alignment = (raw: unknown, offset: number): { characters: string[]; starts: number[]; ends: number[] } | null => {
      const value = raw as { chars?: unknown; charStartTimesMs?: unknown; charDurationsMs?: unknown; char_start_times_ms?: unknown; char_durations_ms?: unknown } | null;
      const characters = value?.chars, starts = value?.charStartTimesMs ?? value?.char_start_times_ms, durations = value?.charDurationsMs ?? value?.char_durations_ms;
      if (!Array.isArray(characters) || !Array.isArray(starts) || !Array.isArray(durations) || !characters.length) return null;
      if (characters.length !== starts.length || characters.length !== durations.length) return null;
      if (!characters.every(c => typeof c === "string") || ![...starts, ...durations].every(t => typeof t === "number" && Number.isFinite(t))) return null;
      const round = (t: number) => Math.round(t * 1_000) / 1_000;
      return { characters, starts: starts.map(t => round(offset + t / 1_000)), ends: starts.map((t, i) => round(offset + (t + durations[i]) / 1_000)) };
    };

    const handle = (data: Buffer) => {
      if (closed || done) return;
      let frame: { text?: unknown; done?: unknown };
      try { frame = JSON.parse(data.toString("utf8")) as typeof frame; } catch { return; }
      if (typeof frame.text === "string") send(text.push(frame.text));
      if (frame.done === true && !closed) {
        done = true;
        send(text.end());
        if (closed) return;
        // Nothing speakable (a reply of only code, say): no audio is coming.
        if (!saidLength) { tell({ type: "done" }); finish(); return; }
        // The last socket ended and nothing it left, or came since, is waiting to be voiced.
        if (resume) { if (resume.length) reopen(); else { tell({ type: "done" }); finish(); } return; }
        if (upstream?.readyState === OPEN) { upstream.send(closeFrame()); watch?.voicing(); }
      }
    };
    receive = handle;
    gone = () => finish();
    if (overflow) { fail({ code: "speech-invalid", error: "This reply is too long to voice." }); return; }
    // The words of the phone's early frames, for the first socket.
    const before: string[] = [];
    put = words => { before.push(words); };
    for (const data of early) handle(data);
    early = [];
    if (!closed) open(before);
  })();
}
