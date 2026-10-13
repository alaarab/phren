import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules(); });

describe("startWarm", () => {
  it("mounts each section once a computer is online, after the first screen settles", async () => {
    vi.useFakeTimers();
    let onMessage: ((ev: { data: string }) => void) | undefined;
    vi.stubGlobal("WebSocket", class { addEventListener(type: string, fn: (ev: { data: string }) => void) { if (type === "message") onMessage = fn; } });
    vi.stubGlobal("location", { protocol: "http:", host: "localhost" });
    // @ts-expect-error plain JavaScript without type declarations
    const { connectStore } = await import("../ui/shell/store.js");
    // @ts-expect-error plain JavaScript without type declarations
    const { startWarm } = await import("../ui/shell/warm.js");
    connectStore();
    const mount = vi.fn();
    startWarm({ mount, settleMs: 1000 });
    const frame = (state: string) => onMessage!({ data: JSON.stringify({ type: "overview", merged: { computers: [{ computer: "mini", state }] } }) });
    frame("connecting");
    await vi.advanceTimersByTimeAsync(5000);
    expect(mount).not.toHaveBeenCalled();
    frame("online");
    await vi.advanceTimersByTimeAsync(500);
    expect(mount).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(mount.mock.calls.map(([id]) => id)).toEqual(["projects", "tasks"]);
    frame("online");
    await vi.advanceTimersByTimeAsync(5000);
    expect(mount).toHaveBeenCalledTimes(2);
  });
});
