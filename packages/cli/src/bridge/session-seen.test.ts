import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./herdr.js", async importOriginal => ({ ...await importOriginal<object>(),
  snapshot: async (server: string) => server === "default" ? { panes: [{ pane_id: "w1:p1" }] } : { panes: [] } }));

const { markSessionSeen, readSessionSeen, setSessionSeen } = await import("./session-seen.js");
const { createRouteHandler } = await import("./server-routes.js");

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "phren-session-seen-")); vi.stubEnv("PHREN_BRIDGE_HOME", root); });
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

async function post(body: unknown) {
  const handler = createRouteHandler({ modules: { has: () => true }, info: {}, streams: {} } as never);
  let result = "";
  const response = { statusCode: 200, setHeader() {}, end(value: string) { result = value; } };
  const request = { url: "/v1/sessions/seen", method: "POST", headers: {},
    [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify(body)); } };
  await handler(request as unknown as IncomingMessage, response as unknown as ServerResponse);
  return { status: response.statusCode, body: JSON.parse(result) as Record<string, unknown> };
}

describe("POST /v1/sessions/seen", () => {
  it("keeps the seen completion across a reload and clears it only when unread names it", async () => {
    expect(await markSessionSeen({ server: "default", pane: "w1:p1", completion: "session-a:2" })).toEqual({ ok: true });
    expect(await readSessionSeen("default", "w1:p1")).toBe("session-a:2");
    // Another completion does not clear the mark.
    await markSessionSeen({ server: "default", pane: "w1:p1", completion: "session-a:1", unread: true });
    expect(await readSessionSeen("default", "w1:p1")).toBe("session-a:2");
    // The pane's own completion does, so the row is unread again.
    await markSessionSeen({ server: "default", pane: "w1:p1", completion: "session-a:2", unread: true });
    expect(await readSessionSeen("default", "w1:p1")).toBeUndefined();
  });

  it("does not let a stale unread clear a concurrent write", async () => {
    for (let attempt = 0; attempt < 20; attempt++) {
      const seen = `session-a:${attempt}`, written = `session-b:${attempt}`;
      await setSessionSeen("default", "w1:p1", seen);
      const clear = setSessionSeen("default", "w1:p1", seen, true);
      await setSessionSeen("default", "w1:p1", written);
      await clear;
      expect(await readSessionSeen("default", "w1:p1")).toBe(written);
      await setSessionSeen("default", "w1:p1", seen);
      await Promise.all([setSessionSeen("default", "w1:p1", written), setSessionSeen("default", "w1:p1", seen, true)]);
      expect(await readSessionSeen("default", "w1:p1")).toBe(written);
    }
  });

  it("answers 400 for a malformed body and 404 for a pane this computer does not list", async () => {
    const malformed = await post({ server: "default", completion: "session-a:2" });
    expect(malformed.status).toBe(400);
    const unknown = await post({ server: "default", pane: "w9:p9", completion: "session-a:2" });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error).toBe("No pane with that id on this computer.");
  });
});
