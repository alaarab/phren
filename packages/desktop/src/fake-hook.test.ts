import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Computer, MergedOverview, OverviewHub } from "./contract.js";
import { hookRequest, hookWebSocket } from "./hook-client.js";
import { createOverviewHub } from "./overview.js";
import { startFakeHook, type FakeHook } from "./testing/fake-hook.js";

const LOCAL: Computer = { name: "This computer", local: true, server: "default" };

let dir: string;
let hook: FakeHook;
const previous = process.env.PHREN_BRIDGE_HOME;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "fake-hook-"));
  process.env.PHREN_BRIDGE_HOME = dir;
  hook = await startFakeHook({ dir });
});

afterEach(async () => {
  process.env.PHREN_BRIDGE_HOME = previous;
  await hook.close();
  await rm(dir, { recursive: true, force: true });
});

/** The next message on a socket, parsed as JSON. */
function nextMessage(socket: WebSocket): Promise<Record<string, any>> {
  return new Promise((resolve) => socket.once("message", (data) => resolve(JSON.parse(data.toString()))));
}

describe("startFakeHook", () => {
  it("answers /v1/health with capabilities", async () => {
    const response = await hookRequest(LOCAL, "GET", "/v1/health");
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body.toString("utf8"));
    expect(body.ok).toBe(true);
    expect(body.capabilities.fileWrite).toBe(true);
    expect(body.capabilities.fileSearch).toBe(true);
    expect(hook.calls[0]).toMatchObject({ method: "GET", path: "/v1/health" });
  });

  it("sends the first overview frame on the overview socket", async () => {
    const socket = await hookWebSocket(LOCAL, "/v1/overview?watchApprovals=1");
    try {
      const frame = await nextMessage(socket);
      expect(frame.type).toBe("overview");
      expect(frame.groups[0].children[0].title).toBe("Fix login");
    } finally {
      socket.close();
    }
  });

  it("merges the fake overview through the hub", async () => {
    const hub: OverviewHub = createOverviewHub([LOCAL], hookWebSocket);
    try {
      const merged = await new Promise<MergedOverview>((resolve) => {
        hub.on("change", (value) => { if (value.computers[0]?.overview) resolve(value); });
        hub.start();
      });
      const child = merged.computers[0].overview?.groups[0].children[0];
      expect(merged.computers[0].state).toBe("online");
      expect(child?.title).toBe("Fix login");
    } finally {
      hub.stop();
    }
  });

  it("enforces compare-and-swap on file writes", async () => {
    const write = (version: string) => hookRequest(LOCAL, "POST", "/v1/files/write", { path: "src/app.ts", content: "next", version });
    expect((await write("v1")).status).toBe(200);
    const stale = await write("v1");
    expect(stale.status).toBe(409);
    expect(JSON.parse(stale.body.toString("utf8")).code).toBe("file-changed");
  });
});
