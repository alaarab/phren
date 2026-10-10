import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Computer } from "./contract.js";
import { hookRequest } from "./hook-client.js";
import { recordHttp, redactQuery, redactString, redactValue, startTrace, stopTrace } from "./trace.js";
import { startFakeHook, type FakeHook } from "./testing/fake-hook.js";

const LOCAL: Computer = { name: "This computer", local: true, server: "default" };

let bridge: string;
let traceDir: string;
let hook: FakeHook;
const previousBridge = process.env.PHREN_BRIDGE_HOME;
const previousTrace = process.env.PHREN_DESKTOP_TRACE_DIR;

beforeEach(async () => {
  bridge = await mkdtemp(path.join(tmpdir(), "trace-bridge-"));
  traceDir = await mkdtemp(path.join(tmpdir(), "trace-dir-"));
  process.env.PHREN_BRIDGE_HOME = bridge;
  process.env.PHREN_DESKTOP_TRACE_DIR = traceDir;
  stopTrace();
  hook = await startFakeHook({ dir: bridge });
});

afterEach(async () => {
  stopTrace();
  process.env.PHREN_BRIDGE_HOME = previousBridge;
  process.env.PHREN_DESKTOP_TRACE_DIR = previousTrace;
  await hook.close();
  await rm(bridge, { recursive: true, force: true });
  await rm(traceDir, { recursive: true, force: true });
});

/** Parse a hook response body as JSON. */
function json(response: { body: Buffer }): Record<string, unknown> {
  return JSON.parse(response.body.toString("utf8")) as Record<string, unknown>;
}

describe("trace redaction", () => {
  it("redacts nested sensitive keys and private-key or bearer strings", () => {
    const value = redactValue({
      ok: true,
      token: "abc",
      nested: { password: "p", api_key: "k", keep: "yes", list: [{ secret: "s" }] },
    }) as Record<string, any>;
    expect(value.ok).toBe(true);
    expect(value.token).toBe("[redacted]");
    expect(value.nested.password).toBe("[redacted]");
    expect(value.nested.api_key).toBe("[redacted]");
    expect(value.nested.keep).toBe("yes");
    expect(value.nested.list[0].secret).toBe("[redacted]");

    const privateKey = "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----";
    expect(redactString(privateKey)).toBe("[redacted]");
    expect(redactString("Bearer abc.def.ghi")).toBe("Bearer [redacted]");
    expect(redactString("just a sentence")).toBe("just a sentence");
  });

  it("redacts secrets inside longer text, query strings and secret routes", () => {
    expect(redactString("curl -H 'Authorization: Bearer abc123' https://x")).toBe("curl -H 'Authorization: Bearer [redacted]' https://x");
    expect(redactString(`push with ghp_${"a".repeat(36)} now`)).toBe("push with [redacted] now");
    expect(redactString("key:\n-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----\nend")).toBe("key:\n[redacted]\nend");
    expect(redactQuery("project=phren&token=abc&apiKey=k")).toBe("project=phren&token=%5Bredacted%5D&apiKey=%5Bredacted%5D");
  });

  it("never writes the body of a secret or sudo answer", async () => {
    startTrace({ computers: ["This computer"] });
    recordHttp({ name: "This computer", local: true, server: "default" } as never, "POST", "/v1/secret", { value: "hunter2", target: {} }, null, "x");
    recordHttp({ name: "This computer", local: true, server: "default" } as never, "POST", "/v1/sudo/answer", { reply: "hunter2" }, null, "x");
    const stopped = stopTrace();
    const text = readFileSync(stopped!.file, "utf8");
    expect(text).not.toContain("hunter2");
  });
});

describe("trace replay", () => {
  it("replays a recorded HTTP exchange with the same body", async () => {
    startTrace({ computers: ["This computer"] });
    await hookRequest(LOCAL, "GET", "/v1/health");
    const stopped = stopTrace();
    expect(stopped?.file).toBeTruthy();

    const replayDir = await mkdtemp(path.join(tmpdir(), "trace-replay-"));
    const replay = await startFakeHook({ dir: replayDir, trace: stopped!.file });
    try {
      process.env.PHREN_BRIDGE_HOME = replayDir;
      const response = await hookRequest(LOCAL, "GET", "/v1/health");
      expect(response.status).toBe(200);
      expect(json(response).ok).toBe(true);
    } finally {
      await replay.close();
      await rm(replayDir, { recursive: true, force: true });
    }
  });

  it("replays repeated requests in recorded order, then repeats the last", async () => {
    await hook.close();
    let count = 0;
    hook = await startFakeHook({ dir: bridge, routes: { "GET /v1/counter": () => ({ status: 200, json: { n: ++count } }) } });
    startTrace({ computers: ["This computer"] });
    await hookRequest(LOCAL, "GET", "/v1/counter");
    await hookRequest(LOCAL, "GET", "/v1/counter");
    await hookRequest(LOCAL, "GET", "/v1/counter");
    const stopped = stopTrace();
    expect(stopped?.file).toBeTruthy();

    const replayDir = await mkdtemp(path.join(tmpdir(), "trace-replay-"));
    const replay = await startFakeHook({ dir: replayDir, trace: stopped!.file });
    try {
      process.env.PHREN_BRIDGE_HOME = replayDir;
      const first = json(await hookRequest(LOCAL, "GET", "/v1/counter")).n;
      const second = json(await hookRequest(LOCAL, "GET", "/v1/counter")).n;
      const third = json(await hookRequest(LOCAL, "GET", "/v1/counter")).n;
      const fourth = json(await hookRequest(LOCAL, "GET", "/v1/counter")).n;
      expect([first, second, third, fourth]).toEqual([1, 2, 3, 3]);
    } finally {
      await replay.close();
      await rm(replayDir, { recursive: true, force: true });
    }
  });

  it("answers a request that was never recorded with 404 not in trace", async () => {
    startTrace({ computers: ["This computer"] });
    await hookRequest(LOCAL, "GET", "/v1/health");
    const stopped = stopTrace();

    const replayDir = await mkdtemp(path.join(tmpdir(), "trace-replay-"));
    const replay = await startFakeHook({ dir: replayDir, trace: stopped!.file });
    try {
      process.env.PHREN_BRIDGE_HOME = replayDir;
      const response = await hookRequest(LOCAL, "GET", "/v1/nothing");
      expect(response.status).toBe(404);
      expect(json(response).error).toBe("not in trace");
    } finally {
      await replay.close();
      await rm(replayDir, { recursive: true, force: true });
    }
  });
});
