import { mkdtemp, rm } from "node:fs/promises";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BridgeError, type Json } from "./protocol.js";
import { alignmentOf, DEFAULT_SPEECH_MODEL, DEFAULT_SPEECH_VOICE, FALLBACK_HOLD_MS, FALLBACK_SPEECH_MODEL, SPEECH_AUDIO, SPEECH_SLOW_MS, SpeechState, speakableText, streamSpeech, type SpeechOptions } from "./speech.js";
import { writeSpeechModel, writeSpeechVoice } from "./speech-voice.js";

// The voice setting lives in the Hook's directory: never the developer's own.
let bridge: string;
beforeEach(async () => {
  bridge = await mkdtemp(path.join(tmpdir(), "phren-speech-"));
  vi.stubEnv("PHREN_BRIDGE_HOME", bridge);
  vi.stubEnv("PHREN_SPEECH_VOICE", "");
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(bridge, { recursive: true, force: true }); });

const KEY = "sk_test_do_not_leak_0123456789";

/** A Hook-shaped server around the speech route: its errors are answered as
 * the route handler answers them. */
async function hook(options: SpeechOptions): Promise<{ server: Server; post: (body: unknown) => Promise<{ status: number; headers: Record<string, unknown>; bytes: Buffer }> }> {
  // Each server learns formats and model health on its own, not the module's.
  const state = new SpeechState(options.now);
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    try {
      await streamSpeech(JSON.parse(Buffer.concat(chunks).toString() || "{}") as Json, res, { state, ...options });
    } catch (error) {
      res.statusCode = error instanceof BridgeError ? error.status : 400;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : "failed", ...(error instanceof BridgeError ? error.details as object : {}) }));
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const post = (body: unknown) => new Promise<{ status: number; headers: Record<string, unknown>; bytes: Buffer }>((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = request({ host: "127.0.0.1", port, method: "POST", path: "/v1/speech", headers: { "Content-Type": "application/json" } }, res => {
      const chunks: Buffer[] = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, bytes: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(payload);
  });
  return { server, post };
}

function audioStream(chunks: Uint8Array[], failAfter?: number): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (failAfter !== undefined && index === failAfter) { controller.error(new Error("socket hang up")); return; }
      if (index < chunks.length) controller.enqueue(chunks[index++]); else controller.close();
    },
  });
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))));
});

describe("speech route", () => {
  it("streams ElevenLabs audio with the key only in the upstream request", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const { server, post } = await hook({
      key: async () => KEY,
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(audioStream([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])]), { status: 200 });
      }) as typeof fetch,
    });
    servers.push(server);
    const reply = await post({ text: "  Two commits landed.  " });
    expect(reply.status).toBe(200);
    expect(reply.headers["x-phren-audio"]).toBe(SPEECH_AUDIO);
    expect([...reply.bytes]).toEqual([1, 2, 3, 4, 5]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`https://api.elevenlabs.io/v1/text-to-speech/${DEFAULT_SPEECH_VOICE}/stream?output_format=pcm_24000`);
    expect((calls[0].init.headers as Record<string, string>)["xi-api-key"]).toBe(KEY);
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({ text: "Two commits landed.", model_id: DEFAULT_SPEECH_MODEL });
    expect(reply.bytes.toString("latin1")).not.toContain(KEY);
    expect(JSON.stringify(reply.headers)).not.toContain(KEY);
  });

  it("speaks with the phone's voice, else this computer's setting, else the default", async () => {
    const calls: string[] = [];
    const { server, post } = await hook({
      key: async () => KEY,
      fetch: (async (url: string) => { calls.push(url); return new Response(audioStream([new Uint8Array([1])]), { status: 200 }); }) as typeof fetch,
    });
    servers.push(server);
    const voiceOf = (url: string) => url.split("/text-to-speech/")[1].split("/")[0];
    expect((await post({ text: "Hello." })).status).toBe(200);
    await writeSpeechVoice("S9EGwlCtMF7VXtENq79v");
    expect((await post({ text: "Hello." })).status).toBe(200);
    expect((await post({ text: "Hello.", voice: "UgBBYS2sOqTuMpoF3BR0" })).status).toBe(200);
    expect(calls.map(voiceOf)).toEqual([DEFAULT_SPEECH_VOICE, "S9EGwlCtMF7VXtENq79v", "UgBBYS2sOqTuMpoF3BR0"]);
    // A voice that is not an ElevenLabs id is refused before any request.
    expect((await post({ text: "Hello.", voice: "../../v1/user" })).status).toBe(400);
    expect(calls).toHaveLength(3);
  });

  it("maps ElevenLabs failures to fixed messages that never carry the key or ElevenLabs' text", async () => {
    const cases: [number, unknown, number, string][] = [
      [401, { detail: { status: "invalid_api_key", message: `Invalid key ${KEY}` } }, 502, "speech-rejected"],
      [401, { detail: { status: "quota_exceeded", message: `Key ${KEY} is over quota` } }, 402, "speech-quota"],
      [404, { detail: { status: "voice_not_found" } }, 502, "speech-voice"],
      [422, { detail: [{ msg: "bad text" }] }, 400, "speech-invalid"],
      [429, { detail: { status: "too_many_concurrent_requests" } }, 429, "speech-busy"],
      [500, "upstream exploded " + KEY, 502, "speech-failed"],
    ];
    for (const [status, body, expected, code] of cases) {
      const { server, post } = await hook({
        key: async () => KEY,
        fetch: (async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status })) as unknown as typeof fetch,
      });
      servers.push(server);
      const reply = await post({ text: "Hello." });
      expect(reply.status, `ElevenLabs ${status}`).toBe(expected);
      const json = JSON.parse(reply.bytes.toString());
      expect(json.code).toBe(code);
      expect(reply.bytes.toString()).not.toContain(KEY);
      expect(reply.bytes.toString()).not.toMatch(/Invalid key|exploded|bad text/);
    }
  });

  it("refuses without a key, when ElevenLabs is unreachable, and for empty or oversized text", async () => {
    let fetched = 0;
    const unreachable = (async () => { fetched++; throw new TypeError(`fetch failed for ${KEY}`); }) as unknown as typeof fetch;
    const none = await hook({ key: async () => undefined, fetch: unreachable });
    servers.push(none.server);
    const unconfigured = await none.post({ text: "Hello." });
    expect(unconfigured.status).toBe(503);
    expect(JSON.parse(unconfigured.bytes.toString()).code).toBe("speech-unconfigured");
    expect(fetched).toBe(0);

    const offline = await hook({ key: async () => KEY, fetch: unreachable });
    servers.push(offline.server);
    const failed = await offline.post({ text: "Hello." });
    expect(failed.status).toBe(502);
    expect(JSON.parse(failed.bytes.toString()).code).toBe("speech-unreachable");
    expect(failed.bytes.toString()).not.toContain(KEY);

    expect((await offline.post({ text: "   " })).status).toBe(400);
    expect((await offline.post({ text: "a".repeat(2_001) })).status).toBe(400);
    expect((await offline.post({})).status).toBe(400);
    expect(fetched).toBe(1);
  });

  it("answers the audio and the character alignment as JSON with timestamps", async () => {
    const calls: string[] = [];
    const { server, post } = await hook({
      key: async () => KEY,
      fetch: (async (url: string) => {
        calls.push(url);
        return new Response(JSON.stringify({
          audio_base64: Buffer.from([1, 2, 3, 4]).toString("base64"),
          alignment: { characters: ["H", "i", "."], character_start_times_seconds: [0, 0.1, 0.2], character_end_times_seconds: [0.1, 0.2, 0.3] },
        }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    servers.push(server);
    const reply = await post({ text: "Hi.", timestamps: true });
    expect(reply.status).toBe(200);
    expect(calls[0]).toBe(`https://api.elevenlabs.io/v1/text-to-speech/${DEFAULT_SPEECH_VOICE}/with-timestamps?output_format=pcm_24000`);
    const json = JSON.parse(reply.bytes.toString());
    expect([...Buffer.from(json.audio, "base64")]).toEqual([1, 2, 3, 4]);
    expect(json.audioFormat).toBe(SPEECH_AUDIO);
    expect(json.alignment).toEqual({ characters: ["H", "i", "."], starts: [0, 0.1, 0.2], ends: [0.1, 0.2, 0.3] });
    expect(reply.bytes.toString()).not.toContain(KEY);
  });

  it("drops an alignment whose lists don't line up", () => {
    expect(alignmentOf({ characters: ["a", "b"], character_start_times_seconds: [0], character_end_times_seconds: [0.1, 0.2] })).toBeNull();
    expect(alignmentOf(null)).toBeNull();
  });

  it("cuts the response off when ElevenLabs fails mid-stream", async () => {
    const { server, post } = await hook({
      key: async () => KEY,
      fetch: (async () => new Response(audioStream([new Uint8Array([9, 9])], 1), { status: 200 })) as unknown as typeof fetch,
    });
    servers.push(server);
    await expect(post({ text: "Hello." })).rejects.toThrow();
  });
});

/** An ElevenLabs stand-in: `answer` decides each call from its format and
 * model; every call is recorded. */
function upstream(answer: (format: string, model: string) => Response | undefined) {
  const calls: { format: string; model: string; endpoint: string }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const parsed = new URL(url);
    const format = parsed.searchParams.get("output_format")!, model = JSON.parse(String(init.body)).model_id as string;
    calls.push({ format, model, endpoint: parsed.pathname.split("/").at(-1)! });
    return answer(format, model) ?? new Response(audioStream([new Uint8Array([1, 2])]), { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetch };
}
const refusal = (status: number, code: string) => new Response(JSON.stringify({ detail: { status: code, message: `no ${KEY}` } }), { status });
const timedReply = () => new Response(JSON.stringify({ audio_base64: Buffer.from([7, 7]).toString("base64"), alignment: null }), { status: 200 });

describe("speech output format", () => {
  it("serves pcm_24000 to a phone that names no formats, whatever the plan allows", async () => {
    const eleven = upstream(() => undefined);
    const { server, post } = await hook({ key: async () => KEY, fetch: eleven.fetch });
    servers.push(server);
    const reply = await post({ text: "Hello." });
    expect(reply.headers["x-phren-audio"]).toBe(SPEECH_AUDIO);
    expect(reply.headers["x-phren-audio-rate"]).toBe("24000");
    expect(reply.headers["x-phren-speech-model"]).toBe(DEFAULT_SPEECH_MODEL);
    expect(eleven.calls.map(call => call.format)).toEqual(["pcm_24000"]);
  });

  it("serves 44.1 kHz PCM when the phone plays it and the plan allows it, and reports the rate", async () => {
    const eleven = upstream(() => undefined);
    const { server, post } = await hook({ key: async () => KEY, fetch: eleven.fetch });
    servers.push(server);
    const reply = await post({ text: "Hello.", formats: ["pcm_44100", "pcm_24000", "opus_48000_192"] });
    expect(reply.headers["x-phren-audio"]).toBe("pcm_s16le;rate=44100;channels=1");
    expect(reply.headers["x-phren-audio-rate"]).toBe("44100");
    expect(eleven.calls.map(call => call.format)).toEqual(["pcm_44100"]);
  });

  it("falls back from a format the plan refuses, remembers the refusal, and never passes ElevenLabs' text on", async () => {
    // Creator: pcm_44100 is Pro and above; mp3_44100_192 is allowed.
    const eleven = upstream(format => format === "pcm_44100" ? refusal(403, "output_format_not_allowed") : format === "mp3_44100_192" ? timedReply() : undefined);
    const { server, post } = await hook({ key: async () => KEY, fetch: eleven.fetch });
    servers.push(server);
    const pcmOnly = await post({ text: "Hello.", formats: ["pcm_44100", "pcm_24000"] });
    expect(pcmOnly.status).toBe(200);
    expect(pcmOnly.headers["x-phren-audio-rate"]).toBe("24000");
    expect(eleven.calls.map(call => call.format)).toEqual(["pcm_44100", "pcm_24000"]);
    expect(JSON.stringify(pcmOnly.headers)).not.toContain(KEY);

    // The refusal is remembered: the next reply goes straight to what works.
    eleven.calls.length = 0;
    const mp3 = await post({ text: "Hi.", timestamps: true, formats: ["pcm_44100", "mp3_44100_192", "pcm_24000"] });
    expect(eleven.calls.map(call => call.format)).toEqual(["mp3_44100_192"]);
    expect(JSON.parse(mp3.bytes.toString())).toMatchObject({ audioFormat: "mp3;rate=44100;bitrate=192000;channels=1", sampleRate: 44_100, format: "mp3_44100_192", model: DEFAULT_SPEECH_MODEL });
  });

  it("ignores format names it doesn't know, however many, instead of refusing the request", async () => {
    const eleven = upstream(() => undefined);
    const { server, post } = await hook({ key: async () => KEY, fetch: eleven.fetch });
    servers.push(server);
    const unknown = Array.from({ length: 40 }, (_, i) => `opus_48000_${i}`);
    const reply = await post({ text: "Hello.", formats: [...unknown, 7, null, "pcm_44100", "pcm_44100"] });
    expect(reply.status).toBe(200);
    expect(reply.headers["x-phren-audio-rate"]).toBe("44100");
    expect((await post({ text: "Hello.", formats: "pcm_44100" })).headers["x-phren-audio-rate"]).toBe("24000");
    expect((await post({ text: "Hello.", formats: ["flac_96000"] })).headers["x-phren-audio-rate"]).toBe("24000");
  });

  it("doesn't retry a format refused under v4 Turbo when the same reply falls back to Flash", async () => {
    const eleven = upstream((format, model) => format === "mp3_44100_192" ? refusal(403, "output_format_not_allowed")
      : model === DEFAULT_SPEECH_MODEL ? refusal(400, "model_not_found") : undefined);
    const { server, post } = await hook({ key: async () => KEY, fetch: eleven.fetch });
    servers.push(server);
    const reply = await post({ text: "Hello.", formats: ["mp3_44100_192", "pcm_24000"] });
    expect(reply.status).toBe(200);
    expect(eleven.calls.map(call => `${call.model}/${call.format}`)).toEqual([
      `${DEFAULT_SPEECH_MODEL}/mp3_44100_192`, `${DEFAULT_SPEECH_MODEL}/pcm_24000`, `${FALLBACK_SPEECH_MODEL}/pcm_24000`,
    ]);
  });

  it("reports the sample rate in the timestamped reply, 24 kHz for an older phone", async () => {
    const eleven = upstream(() => timedReply());
    const { server, post } = await hook({ key: async () => KEY, fetch: eleven.fetch });
    servers.push(server);
    const json = JSON.parse((await post({ text: "Hi.", timestamps: true })).bytes.toString());
    expect(json).toMatchObject({ audioFormat: SPEECH_AUDIO, sampleRate: 24_000, format: "pcm_24000", alignment: null });
    const hifi = JSON.parse((await post({ text: "Hi.", timestamps: true, formats: ["pcm_44100"] })).bytes.toString());
    expect(hifi).toMatchObject({ audioFormat: "pcm_s16le;rate=44100;channels=1", sampleRate: 44_100 });
  });
});

describe("speech model", () => {
  it("speaks with v4 Turbo by default and with the stored model once set", async () => {
    const eleven = upstream(() => undefined);
    const { server, post } = await hook({ key: async () => KEY, fetch: eleven.fetch });
    servers.push(server);
    await post({ text: "Hello." });
    await writeSpeechModel("eleven_v4");
    await post({ text: "Hello." });
    expect(eleven.calls.map(call => call.model)).toEqual(["eleven_v4_turbo", "eleven_v4"]);
  });

  it("falls back to Flash v2.5 when v4 Turbo errors, and keeps using it for a while", async () => {
    let clock = 1_000_000;
    const eleven = upstream((_format, model) => model === DEFAULT_SPEECH_MODEL ? refusal(400, "model_not_found") : undefined);
    const { server, post } = await hook({ key: async () => KEY, fetch: eleven.fetch, now: () => clock });
    servers.push(server);
    const first = await post({ text: "Hello." });
    expect(first.status).toBe(200);
    expect(first.headers["x-phren-speech-model"]).toBe(FALLBACK_SPEECH_MODEL);
    expect(eleven.calls.map(call => call.model)).toEqual([DEFAULT_SPEECH_MODEL, FALLBACK_SPEECH_MODEL]);
    eleven.calls.length = 0;
    await post({ text: "Hello." });
    expect(eleven.calls.map(call => call.model)).toEqual([FALLBACK_SPEECH_MODEL]);
    // After the hold, v4 Turbo is tried again.
    clock += FALLBACK_HOLD_MS + 1;
    eleven.calls.length = 0;
    await post({ text: "Hello." });
    expect(eleven.calls[0].model).toBe(DEFAULT_SPEECH_MODEL);
  });

  it("does not fall back for the key, the quota, the voice or a rate limit", async () => {
    for (const [status, code] of [[401, "invalid_api_key"], [401, "quota_exceeded"], [404, "voice_not_found"], [429, "too_many_concurrent_requests"]] as const) {
      const eleven = upstream(() => refusal(status, code));
      const { server, post } = await hook({ key: async () => KEY, fetch: eleven.fetch });
      servers.push(server);
      expect((await post({ text: "Hello." })).status).not.toBe(200);
      expect(eleven.calls.map(call => call.model), code).toEqual([DEFAULT_SPEECH_MODEL]);
    }
  });

  it("sets v4 Turbo aside while its replies take longer than SPEECH_SLOW_MS to start", async () => {
    let clock = 0;
    const eleven = upstream((_format, model) => { if (model === DEFAULT_SPEECH_MODEL) clock += SPEECH_SLOW_MS + 500; else clock += 300; return timedReply(); });
    const { server, post } = await hook({ key: async () => KEY, fetch: eleven.fetch, now: () => clock });
    servers.push(server);
    for (let i = 0; i < 3; i++) await post({ text: "Hi.", timestamps: true });
    const json = JSON.parse((await post({ text: "Hi.", timestamps: true })).bytes.toString());
    expect(json.model).toBe(FALLBACK_SPEECH_MODEL);
    expect(eleven.calls.map(call => call.model)).toEqual([DEFAULT_SPEECH_MODEL, DEFAULT_SPEECH_MODEL, DEFAULT_SPEECH_MODEL, FALLBACK_SPEECH_MODEL]);
  });

  it("judges speed on the median of the last three replies, so one slow reply is not enough", () => {
    const state = new SpeechState(() => 0);
    for (let i = 0; i < 5; i++) state.recordLatency(DEFAULT_SPEECH_MODEL, 1_100);
    state.recordLatency(DEFAULT_SPEECH_MODEL, 9_000);
    expect(state.benchedReason(DEFAULT_SPEECH_MODEL)).toBeUndefined();
    state.recordLatency(DEFAULT_SPEECH_MODEL, 9_000);
    expect(state.benchedReason(DEFAULT_SPEECH_MODEL)).toBe("slow");
  });
});

describe("speakable text", () => {
  it("reads a markdown reply as its words: no symbols, code blocks or URLs", () => {
    const reply = "## Status\n\n**Two** commits landed in `main`:\n- PR #12 merged\n- see [the run](https://x.y/z)\n\n"
      + "```ts\nconst a = 1\n```\n| Lane | State |\n|---|---|\n| bridge | done |\nThis sentence\nwraps here. Check https://github.com/a/b now.";
    expect(speakableText(reply)).toBe("Status. Two commits landed in main: PR #12 merged. see the run. Lane, State. bridge, done. This sentence wraps here. Check a link now.");
    expect(speakableText("Two commits landed.")).toBe("Two commits landed.");
    expect(speakableText("```\nonly code\n```")).toBe("");
  });

  it("refuses a reply with nothing left to say", async () => {
    const { server, post } = await hook({ key: async () => KEY, fetch: (async () => { throw new Error("not called"); }) as typeof fetch });
    servers.push(server);
    expect((await post({ text: "```\nconst a = 1\n```" })).status).toBe(400);
  });
});
