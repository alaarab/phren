import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeError, type Json } from "./protocol.js";
import { DEFAULT_SPEECH_VOICE, SPEECH_AUDIO, SPEECH_MODEL, streamSpeech, type SpeechOptions } from "./speech.js";

const KEY = "sk_test_do_not_leak_0123456789";

/** A Hook-shaped server around the speech route: its errors are answered as
 * the route handler answers them. */
async function hook(options: SpeechOptions): Promise<{ server: Server; post: (body: unknown) => Promise<{ status: number; headers: Record<string, unknown>; bytes: Buffer }> }> {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    try {
      await streamSpeech(JSON.parse(Buffer.concat(chunks).toString() || "{}") as Json, res, options);
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
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({ text: "Two commits landed.", model_id: SPEECH_MODEL });
    expect(reply.bytes.toString("latin1")).not.toContain(KEY);
    expect(JSON.stringify(reply.headers)).not.toContain(KEY);
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

  it("cuts the response off when ElevenLabs fails mid-stream", async () => {
    const { server, post } = await hook({
      key: async () => KEY,
      fetch: (async () => new Response(audioStream([new Uint8Array([9, 9])], 1), { status: 200 })) as unknown as typeof fetch,
    });
    servers.push(server);
    await expect(post({ text: "Hello." })).rejects.toThrow();
  });
});
