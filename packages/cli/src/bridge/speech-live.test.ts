import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpeechState } from "./speech.js";
import { type LiveUpstream, liveEndpoint, relayLiveSpeech, SpeakableStream } from "./speech-live.js";
import { DEFAULT_SPEECH_MODEL, DEFAULT_SPEECH_VOICE, FALLBACK_SPEECH_MODEL, writeSpeechModel, writeSpeechRegion } from "./speech-voice.js";

let bridge: string;
beforeEach(async () => {
  bridge = await mkdtemp(path.join(tmpdir(), "phren-live-"));
  vi.stubEnv("PHREN_BRIDGE_HOME", bridge);
  vi.stubEnv("PHREN_SPEECH_VOICE", "");
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(bridge, { recursive: true, force: true }); });

const KEY = "sk_test_do_not_leak_0123456789";

class FakeSocket extends EventEmitter implements LiveUpstream {
  readyState = 1;
  sent: string[] = [];
  closed?: { code?: number; reason?: string };
  constructor(readonly url = "") { super(); }
  send(data: string) { this.sent.push(data); }
  close(code?: number, reason?: string) { if (this.readyState === 3) return; this.readyState = 3; this.closed = { code, reason }; this.emit("close"); }
  open() { this.readyState = 1; this.emit("open"); }
  reply(frame: unknown) { this.emit("message", Buffer.from(JSON.stringify(frame)), false); }
}
const frames = (socket: FakeSocket) => socket.sent.map(frame => JSON.parse(frame) as Record<string, unknown>);
const say = (client: FakeSocket, frame: unknown) => client.emit("message", Buffer.from(JSON.stringify(frame)), false);

/** The relay with ElevenLabs' sockets recorded, each still connecting. */
async function live(query = "", options: { model?: string; handshakeMs?: number; firstAudioMs?: number; maxSessionMs?: number } = {}) {
  const client = new FakeSocket(), upstreams: FakeSocket[] = [];
  await relayLiveSpeech(client, new URLSearchParams(query), { key: async () => KEY, state: new SpeechState(), ...options,
    connect: (url, key) => { expect(key).toBe(KEY); const socket = new FakeSocket(url); socket.readyState = 0; upstreams.push(socket); return socket; } });
  return { client, upstreams };
}

describe("live spoken replies", () => {
  it("voices v4 Turbo over text-to-dialogue: text held until ElevenLabs answers, a sentence at a time, then closed on done", async () => {
    const { client, upstreams } = await live("format=pcm_44100&format=opus_48000_192");
    const [upstream] = upstreams;
    const url = new URL(upstream.url);
    expect(url.origin + url.pathname).toBe("wss://api.elevenlabs.io/v1/text-to-dialogue/stream-input");
    expect(Object.fromEntries(url.searchParams)).toEqual({ model_id: DEFAULT_SPEECH_MODEL, output_format: "pcm_44100", sync_alignment: "true" });
    say(client, { text: "**Two commits** landed" });
    say(client, { text: " on the train. The suite" });
    expect(upstream.sent).toEqual([]);
    upstream.open();
    say(client, { text: " is green." });
    say(client, { text: " Done" });
    say(client, { done: true });
    expect(frames(upstream)).toEqual([
      { voices: [DEFAULT_SPEECH_VOICE], voice_settings: { stability: 0.6, similarity_boost: 0.75 } },
      { inputs: [{ text: "Two commits landed on the train. ", voice_id: DEFAULT_SPEECH_VOICE }] },
      { inputs: [{ text: "The suite is green. ", voice_id: DEFAULT_SPEECH_VOICE }] },
      { inputs: [{ text: "Done ", voice_id: DEFAULT_SPEECH_VOICE }] },
      { close_socket: true },
    ]);
    expect(client.sent).toEqual([]);
    upstream.reply({ audio: "AAAA", alignment: null });
    expect(frames(client)).toEqual([
      { type: "start", model: DEFAULT_SPEECH_MODEL, format: "pcm_44100", audioFormat: "pcm_s16le;rate=44100;channels=1", sampleRate: 44_100 },
      { type: "audio", audio: "AAAA", alignment: null },
    ]);
  });

  it("sends the audio as it comes, alignment counted from the start of the reply, then done", async () => {
    const { client, upstreams } = await live();
    const [upstream] = upstreams;
    upstream.open();
    // Half a second of 24 kHz PCM, its characters timed from the chunk (text-to-dialogue's way).
    const half = Buffer.alloc(24_000).toString("base64");
    upstream.reply({ audio: half, alignment: { chars: ["H", "i"], char_start_times_ms: [0, 100], char_durations_ms: [100, 200] } });
    upstream.reply({ audio: half, alignment: { chars: ["!"], char_start_times_ms: [0], char_durations_ms: [50] } });
    upstream.reply({ audio: half, alignment: null });
    upstream.reply({ is_final_audio_for_turn: true });
    upstream.reply({ is_final: true });
    expect(frames(client).slice(1)).toEqual([
      { type: "audio", audio: half, alignment: { characters: ["H", "i"], starts: [0, 0.1], ends: [0.1, 0.3] } },
      { type: "audio", audio: half, alignment: { characters: ["!"], starts: [0.5], ends: [0.55] } },
      { type: "audio", audio: half, alignment: null },
      { type: "done" },
    ]);
    expect(client.closed).toEqual({ code: 1000, reason: "" });
    expect(upstream.readyState).toBe(3);
  });

  it("voices Flash over text-to-speech stream-input with auto mode, in the stored region", async () => {
    await writeSpeechModel(FALLBACK_SPEECH_MODEL);
    await writeSpeechRegion("us");
    const { client, upstreams } = await live(`voice=S9EGwlCtMF7VXtENq79v`);
    const [upstream] = upstreams;
    const url = new URL(upstream.url);
    expect(url.origin + url.pathname).toBe("wss://api.us.elevenlabs.io/v1/text-to-speech/S9EGwlCtMF7VXtENq79v/stream-input");
    expect(url.searchParams.get("auto_mode")).toBe("true");
    expect(url.searchParams.get("model_id")).toBe(FALLBACK_SPEECH_MODEL);
    upstream.open();
    say(client, { text: "Hello there." });
    say(client, { done: true });
    expect(frames(upstream)).toEqual([{ text: " ", voice_settings: { stability: 0.6, similarity_boost: 0.75 } }, { text: "Hello there. " }, { text: "" }]);
    // Stream-input already counts from the start of the stream.
    upstream.reply({ audio: "AAAA", alignment: { chars: ["x"], charStartTimesMs: [1200], charDurationsMs: [100] }, isFinal: null });
    upstream.reply({ audio: null, isFinal: true, alignment: null });
    expect(frames(client).slice(1)).toEqual([{ type: "audio", audio: "AAAA", alignment: { characters: ["x"], starts: [1.2], ends: [1.3] } }, { type: "done" }]);
  });

  it("falls back to Flash on stream-input when ElevenLabs refuses the model, replaying the text, and remembers it", async () => {
    const state = new SpeechState();
    const client = new FakeSocket(), upstreams: FakeSocket[] = [];
    const connect = (url: string) => { const socket = new FakeSocket(url); socket.readyState = 0; upstreams.push(socket); return socket; };
    await relayLiveSpeech(client, new URLSearchParams(), { key: async () => KEY, state, connect });
    say(client, { text: "First sentence. " });
    upstreams[0].emit("refused", 400, "unsupported_model");
    expect(liveEndpoint(DEFAULT_SPEECH_MODEL)).toBe("dialogue");
    expect(new URL(upstreams[1].url).pathname).toBe(`/v1/text-to-speech/${DEFAULT_SPEECH_VOICE}/stream-input`);
    upstreams[1].open();
    expect(frames(upstreams[1]).slice(1)).toEqual([{ text: "First sentence. " }]);
    upstreams[1].reply({ audio: "AAAA", alignment: null });
    expect(frames(client)[0]).toMatchObject({ type: "start", model: FALLBACK_SPEECH_MODEL });
    expect(state.benchedReason(DEFAULT_SPEECH_MODEL)).toBe("failed");
    // The next reply goes straight to Flash while v4 Turbo is set aside.
    const next = new FakeSocket(), nextUpstreams: FakeSocket[] = [];
    await relayLiveSpeech(next, new URLSearchParams(), { key: async () => KEY, state, connect: url => { const socket = new FakeSocket(url); nextUpstreams.push(socket); return socket; } });
    expect(new URL(nextUpstreams[0].url).searchParams.get("model_id")).toBe(FALLBACK_SPEECH_MODEL);
  });

  it("skips a format or model ElevenLabs refuses once the socket is open, replaying what was said, before any audio reaches the phone", async () => {
    const { client, upstreams } = await live("format=pcm_44100&format=mp3_44100_192");
    upstreams[0].open();
    say(client, { text: "Two commits landed. " });
    // Creator plan, as ElevenLabs answered on 2026-10-01: an error frame, then close 1008.
    upstreams[0].reply({ message: "Output format 'pcm_44100' is only available on the Pro tier and above.", error: "output_format_not_allowed", code: 1008 });
    upstreams[0].close(1008);
    expect(Object.fromEntries(new URL(upstreams[1].url).searchParams)).toMatchObject({ model_id: DEFAULT_SPEECH_MODEL, output_format: "mp3_44100_192" });
    upstreams[1].open();
    upstreams[1].reply({ message: "A model with model ID eleven_v4_turbo does not exist", error: "model_not_found", code: 1008 });
    expect(new URL(upstreams[2].url).searchParams.get("model_id")).toBe(FALLBACK_SPEECH_MODEL);
    expect(new URL(upstreams[2].url).searchParams.get("output_format")).toBe("mp3_44100_192");
    upstreams[2].open();
    expect(frames(upstreams[2]).slice(1)).toEqual([{ text: "Two commits landed. " }]);
    expect(client.sent).toEqual([]);
    expect(client.closed).toBeUndefined();
  });

  it("answers fixed errors: no key, a refused key, ElevenLabs failing mid-reply, never its text or the key", async () => {
    const bare = new FakeSocket();
    await relayLiveSpeech(bare, new URLSearchParams(), { key: async () => undefined });
    expect(frames(bare)[0]).toMatchObject({ type: "error", code: "speech-unconfigured" });
    expect(bare.closed?.code).toBe(1008);

    const refused = await live();
    refused.upstreams[0].emit("refused", 401, "invalid_api_key");
    expect(refused.upstreams).toHaveLength(1);
    expect(frames(refused.client)).toEqual([{ type: "error", code: "speech-rejected", error: "ElevenLabs refused this computer's key." }]);

    const mid = await live();
    mid.upstreams[0].open();
    mid.upstreams[0].reply({ message: `bad ${KEY}`, error: "quota_exceeded", code: 1008 });
    expect(frames(mid.client).at(-1)).toEqual({ type: "error", code: "speech-quota", error: "The ElevenLabs quota on this computer's account is used up." });
    expect(mid.client.closed?.code).toBe(1011);

    // Closed before any audio: Flash takes the reply over; when it closes too, the phone hears why.
    const dropped = await live();
    dropped.upstreams[0].open();
    dropped.upstreams[0].close();
    expect(new URL(dropped.upstreams[1].url).searchParams.get("model_id")).toBe(FALLBACK_SPEECH_MODEL);
    dropped.upstreams[1].open();
    dropped.upstreams[1].close();
    expect(frames(dropped.client)).toEqual([{ type: "error", code: "speech-failed", error: "ElevenLabs didn't answer." }]);
    for (const socket of [refused.client, mid.client, dropped.client]) expect(socket.sent.join()).not.toContain(KEY);
  });

  it("keeps the phone's frames sent while settings are read, and opens nothing for a phone gone by then", async () => {
    const client = new FakeSocket(), upstreams: FakeSocket[] = [];
    const connect = (url: string) => { const socket = new FakeSocket(url); socket.readyState = 0; upstreams.push(socket); return socket; };
    const relay = relayLiveSpeech(client, new URLSearchParams(), { key: async () => KEY, state: new SpeechState(), connect });
    say(client, { text: "Said early. And" });
    say(client, { text: " more." });
    say(client, { done: true });
    await relay;
    upstreams[0].open();
    expect(frames(upstreams[0]).slice(1)).toEqual([
      { inputs: [{ text: "Said early. ", voice_id: DEFAULT_SPEECH_VOICE }] },
      { inputs: [{ text: "And more. ", voice_id: DEFAULT_SPEECH_VOICE }] },
      { close_socket: true },
    ]);

    const leaving = new FakeSocket(), opened: string[] = [];
    const pending = relayLiveSpeech(leaving, new URLSearchParams(), { key: async () => KEY, state: new SpeechState(), connect: url => { opened.push(url); return new FakeSocket(url); } });
    leaving.close();
    await pending;
    expect(opened).toEqual([]);
  });

  it("falls back to Flash when ElevenLabs never opens or never voices, and errors when Flash stalls too", async () => {
    vi.useFakeTimers();
    try {
      const { client, upstreams } = await live("", { handshakeMs: 1_000, firstAudioMs: 2_000 });
      say(client, { text: "Hello there. " });
      vi.advanceTimersByTime(1_000);
      expect(upstreams[0].readyState).toBe(3);
      expect(new URL(upstreams[1].url).searchParams.get("model_id")).toBe(FALLBACK_SPEECH_MODEL);
      upstreams[1].open();
      // A sentence with more to come may wait in ElevenLabs' buffer: not a stall yet.
      vi.advanceTimersByTime(10_000);
      expect(client.sent).toEqual([]);
      say(client, { done: true });
      vi.advanceTimersByTime(2_000);
      expect(upstreams).toHaveLength(2);
      expect(frames(client)).toEqual([{ type: "error", code: "speech-failed", error: "ElevenLabs didn't answer." }]);
      expect(client.closed?.code).toBe(1011);
    } finally { vi.useRealTimers(); }
  });

  it("falls back to Flash on a generic error frame or a bare close before any audio, not after", async () => {
    const generic = await live();
    generic.upstreams[0].open();
    say(generic.client, { text: "One. " });
    generic.upstreams[0].reply({ message: "Something went wrong", error: "internal_error" });
    expect(new URL(generic.upstreams[1].url).searchParams.get("model_id")).toBe(FALLBACK_SPEECH_MODEL);
    generic.upstreams[1].open();
    expect(frames(generic.upstreams[1]).slice(1)).toEqual([{ text: "One. " }]);
    expect(generic.client.sent).toEqual([]);

    const closed = await live();
    closed.upstreams[0].open();
    closed.upstreams[0].emit("close", 1011, Buffer.from("upstream failure"));
    expect(closed.upstreams).toHaveLength(2);

    // An account failure in the close reason is Flash's too: no fallback.
    const quota = await live();
    quota.upstreams[0].open();
    quota.upstreams[0].emit("close", 1008, Buffer.from("quota_exceeded"));
    expect(quota.upstreams).toHaveLength(1);
    expect(frames(quota.client)).toEqual([{ type: "error", code: "speech-quota", error: "The ElevenLabs quota on this computer's account is used up." }]);

    const voiced = await live();
    voiced.upstreams[0].open();
    voiced.upstreams[0].reply({ audio: "AAAA", alignment: null });
    voiced.upstreams[0].emit("close", 1011, Buffer.from(""));
    expect(voiced.upstreams).toHaveLength(1);
    expect(frames(voiced.client).at(-1)).toEqual({ type: "error", code: "speech-failed", error: "ElevenLabs stopped before the reply was voiced." });
  });

  it("ends a reply with nothing to say with done, and the session limit with an error frame", async () => {
    const empty = await live();
    say(empty.client, { text: "```sh\nls\n```\n" });
    say(empty.client, { done: true });
    expect(frames(empty.client)).toEqual([{ type: "done" }]);
    expect(empty.client.closed?.code).toBe(1000);
    expect(empty.upstreams[0].readyState).toBe(3);

    vi.useFakeTimers();
    try {
      const long = await live("", { maxSessionMs: 1_000 });
      long.upstreams[0].open();
      vi.advanceTimersByTime(1_000);
      expect(frames(long.client)).toEqual([{ type: "error", code: "speech-limit", error: "This reply ran past the ten minutes one spoken reply can take." }]);
      expect(long.client.closed?.code).toBe(1000);
    } finally { vi.useRealTimers(); }
  });

  it("stops voicing for a phone that stopped reading the audio", async () => {
    const { client, upstreams } = await live();
    upstreams[0].open();
    upstreams[0].reply({ audio: "AAAA", alignment: null });
    (client as unknown as { bufferedAmount: number }).bufferedAmount = 5 * 1024 * 1024;
    upstreams[0].reply({ audio: "BBBB", alignment: null });
    expect(frames(client).map(frame => frame.type)).toEqual(["start", "audio", "error"]);
    expect(frames(client).at(-1)).toMatchObject({ code: "speech-failed" });
    expect(upstreams[0].readyState).toBe(3);
  });

  it("closes ElevenLabs' socket when the phone hangs up", async () => {
    const { client, upstreams } = await live();
    upstreams[0].open();
    client.close();
    expect(upstreams[0].readyState).toBe(3);
  });
});

describe("speakable stream", () => {
  it("releases whole sentences and lines as words, skipping code blocks across pieces", () => {
    const stream = new SpeakableStream();
    expect(stream.push("## Status\nThe build")).toBe("Status.");
    expect(stream.push(" passed, see `make test`. Then")).toBe("The build passed, see make test.");
    expect(stream.push(":\n```ts\nconst a = 1;")).toBe("Then:");
    expect(stream.push("\n```\n- one [link](https://x.y)\n- tw")).toBe("one link.");
    expect(stream.push("o")).toBe("");
    expect(stream.end()).toBe("two.");
  });

  it("cuts text that never ends a sentence at a space past 2 KB", () => {
    const stream = new SpeakableStream();
    const words = "word ".repeat(500);
    const spoken = stream.push(words);
    expect(spoken.length).toBeGreaterThan(1_900);
    expect(spoken.length).toBeLessThanOrEqual(2_048);
    expect(spoken.endsWith("word")).toBe(true);
    expect(`${spoken} ${stream.end()}`).toBe(words.trim());
  });
});
