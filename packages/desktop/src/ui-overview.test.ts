import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Computer, OverviewHub } from "./contract.js";
import { hookWebSocket } from "./hook-client.js";
import { createOverviewHub } from "./overview.js";
import { startFakeHook, type FakeHook } from "./testing/fake-hook.js";

let hook: FakeHook;
let hub: OverviewHub;
let dir: string;
const previous = process.env.PHREN_BRIDGE_HOME;
const computer: Computer = { name: "Desk", local: true, username: "me", server: "tmux-work" };
beforeEach(async () => {
  await mkdir(".scratch", { recursive: true });
  dir = await mkdtemp(path.resolve(".scratch/overview-"));
  process.env.PHREN_BRIDGE_HOME = dir;
  hook = await startFakeHook({ dir });
  hub = createOverviewHub([computer], hookWebSocket);
});
afterEach(async () => {
  hub?.stop();
  await hook?.close();
  if (previous === undefined) delete process.env.PHREN_BRIDGE_HOME; else process.env.PHREN_BRIDGE_HOME = previous;
  await rm(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function online() {
  await vi.waitFor(() => expect(hub.current().computers[0].state).toBe("online"));
}

describe.skipIf(process.platform === "win32")("overview connection", () => {
  it("selects the configured server", async () => {
    hub.start();
    await online();
    expect(new URL(hook.calls[0].path, "http://hook").searchParams.get("server")).toBe("tmux-work");
  });

  it.each([{ username: "other" }, { server: "default" }])("reconnects when identity changes: %j", async change => {
    hub.start();
    await online();
    hub.setComputers([{ ...computer, ...change }]);
    await vi.waitFor(() => expect(hook.calls).toHaveLength(2));
    await online();
    expect(new URL(hook.calls[1].path, "http://hook").searchParams.get("server")).toBe(change.server ?? computer.server);
  });

  it("refreshes the UI's version and capability cache from heartbeats without losing sessions", async () => {
    let receive: (ev: { data: string }) => void = () => {};
    class Socket {
      addEventListener(type: string, fn: typeof receive) { if (type === "message") receive = fn; }
    }
    vi.stubGlobal("WebSocket", Socket);
    vi.stubGlobal("location", { protocol: "http:", host: "desktop" });
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    // @ts-expect-error plain browser module without types
    const { connectStore, store } = await import("../ui/shell/store.js");
    connectStore();
    hub.on("change", merged => receive({ data: JSON.stringify({ type: "overview", merged }) }));
    hub.start();
    await online();
    await vi.waitFor(() => expect(store.version("Desk")).toBe("0.3.33"));
    const groups = hub.current().computers[0].overview!.groups;
    hook.pushOverview({ type: "heartbeat", phren: { version: "0.3.46", capabilities: { fileWrite: false, code: true } } });
    await vi.waitFor(() => expect(store.version("Desk")).toBe("0.3.46"));
    expect(await store.capabilities("Desk")).toEqual({ fileWrite: false, code: true });
    expect(hub.current().computers[0].overview!.groups).toEqual(groups);
    expect(fetch).not.toHaveBeenCalled();
  });
});
